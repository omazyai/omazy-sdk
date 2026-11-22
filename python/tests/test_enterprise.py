import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from omazy import ENTERPRISE_REPEATABLE, ENTERPRISE_ROUTES, Omazy, OmazyEnterprise, OmazyError  # noqa: E402
from test_client import FakeAPI, fail, ok  # noqa: E402

# The contract sits beside the SDKs: two levels up in the public repository,
# three in the platform's own.
CONTRACT = next(
    p
    for p in (
        pathlib.Path(__file__).resolve().parents[n] / "contracts" / "enterprise-api.routes.json" for n in (2, 3)
    )
    if p.exists()
)

WORKSPACE = {"id": "w1", "external_id": "cust-1", "handle": "acme", "name": "Acme", "status": "active"}


def page(ids, next_cursor=None):
    body = {"success": True, "data": [dict(WORKSPACE, id=i) for i in ids]}
    if next_cursor:
        body["meta"] = {"next_cursor": next_cursor}
    return 200, {"Content-Type": "application/json"}, json.dumps(body).encode()


class EnterpriseTest(unittest.TestCase):
    def setUp(self):
        self.api = FakeAPI()
        self.addCleanup(self.api.close)
        self.base = self.api.base[: -len("/core")] + "/enterprise"
        self.slept = []

    def account(self, **kw):
        return OmazyEnterprise("eak_abc.def", base_url=self.base, sleep=self.slept.append, **kw)

    def test_the_route_table_and_the_repeatable_set_are_the_contract(self):
        routes = json.loads(CONTRACT.read_text())["routes"]
        self.assertEqual(ENTERPRISE_ROUTES, {r["sdk"]: (r["method"], r["path"]) for r in routes})
        self.assertEqual(set(ENTERPRISE_REPEATABLE), {r["sdk"] for r in routes if r["repeatable"]})

    def test_every_route_is_reachable_through_a_method(self):
        self.api.answers = [ok({})]
        a = self.account()
        a.account()
        a.workspaces.list()
        a.workspaces.create("cust-1", "Acme")
        a.workspaces.get("w1")
        a.workspaces.update("w1", name="Acme Ltd")
        a.workspaces.close("w1")
        a.workspaces.rotate_install("w1")
        a.usage()
        used = {(s["method"], s["path"].split("?")[0].replace("/enterprise", "", 1).replace("/w1", "/{id}")) for s in self.api.seen}
        self.assertEqual(used, set(ENTERPRISE_ROUTES.values()))

    def test_usage_sends_the_range_and_keeps_the_cursor(self):
        data = {"from": "2026-11-21", "to": "2026-11-23", "totals": {"model_calls": 9}, "workspaces": []}
        self.api.answers = [(200, {"Content-Type": "application/json"}, json.dumps({"success": True, "data": data, "meta": {"next_cursor": "c2"}}).encode())]
        got = self.account().usage(from_="2026-11-21", to="2026-11-23", limit=2)
        self.assertEqual(got["totals"]["model_calls"], 9)
        self.assertEqual(got["next_cursor"], "c2")
        self.assertEqual(self.api.seen[0]["path"], "/enterprise/usage?from=2026-11-21&to=2026-11-23&limit=2")

    def test_create_sends_the_account_key_and_the_body(self):
        self.api.answers = [ok({"created": True, "workspace": WORKSPACE, "install": None, "token": "cai_x.y"}, **{"X-Request-Id": "req_1", "X-Omazy-Token-Expires-At": "2027-01-01T00:00:00Z"})]
        a = self.account()
        made = a.workspaces.create("cust-1", "Acme", brand_color="#0A3D62")
        self.assertTrue(made["created"])
        self.assertEqual(made["token"], "cai_x.y")
        seen = self.api.seen[0]
        self.assertEqual((seen["method"], seen["path"]), ("POST", "/enterprise/workspaces"))
        self.assertEqual(seen["headers"]["Authorization"], "Bearer eak_abc.def")
        # Fields that were not given are left out, not sent as null.
        self.assertEqual(json.loads(seen["body"]), {"external_id": "cust-1", "name": "Acme", "brand_color": "#0A3D62"})
        self.assertEqual(a.last.request_id, "req_1")
        self.assertEqual(a.last.token_expires_at, "2027-01-01T00:00:00Z")

    def test_create_is_sent_again_after_a_failure_and_rotate_is_not(self):
        self.api.answers = [fail(503, "UPSTREAM_UNAVAILABLE", "try again"), fail(502, "BAD_GATEWAY", "try again"), ok({"created": False, "workspace": WORKSPACE, "install": None, "token": None})]
        made = self.account().workspaces.create("cust-1", "Acme")
        self.assertFalse(made["created"])
        self.assertEqual(len(self.api.seen), 3)
        self.assertEqual(self.api.seen[0]["body"], self.api.seen[2]["body"])
        self.assertEqual(len(self.slept), 2)

        self.api.seen.clear()
        self.api.answers = [fail(503, "UPSTREAM_UNAVAILABLE", "try again"), ok({"install": {}, "token": "cai_n.new"})]
        with self.assertRaises(OmazyError):
            self.account().workspaces.rotate_install("w1")
        self.assertEqual(len(self.api.seen), 1)

    def test_list_reads_a_page_and_all_walks_every_page(self):
        self.api.answers = [page(["w3", "w2"], "c1"), page(["w1"])]
        got = [w["id"] for w in self.account().workspaces.all(status="active", limit=2)]
        self.assertEqual(got, ["w3", "w2", "w1"])
        self.assertEqual(self.api.seen[0]["path"], "/enterprise/workspaces?status=active&limit=2")
        self.assertEqual(self.api.seen[1]["path"], "/enterprise/workspaces?status=active&cursor=c1&limit=2")

        self.api.seen.clear()
        self.api.answers = [page(["w9"])]
        first = self.account().workspaces.list()
        self.assertEqual([w["id"] for w in first["workspaces"]], ["w9"])
        self.assertNotIn("next_cursor", first)
        self.assertEqual(self.api.seen[0]["path"], "/enterprise/workspaces")

    def test_find_by_external_id(self):
        self.api.answers = [page(["w1"])]
        self.assertEqual(self.account().workspaces.find_by_external_id("cust-1")["id"], "w1")
        self.assertEqual(self.api.seen[0]["path"], "/enterprise/workspaces?external_id=cust-1")
        self.api.answers = [page([])]
        self.assertIsNone(self.account().workspaces.find_by_external_id("nobody"))

    def test_suspend_resume_and_rotate_send_what_the_api_reads(self):
        self.api.answers = [ok(WORKSPACE)]
        a = self.account()
        a.workspaces.suspend("w 1")
        a.workspaces.resume("w1")
        a.workspaces.rotate_install("w1", overlap_hours=0, expires_in_days=90)
        a.workspaces.rotate_install("w1")
        s = self.api.seen
        self.assertEqual((s[0]["method"], s[0]["path"]), ("PATCH", "/enterprise/workspaces/w%201"))
        self.assertEqual(json.loads(s[0]["body"]), {"status": "suspended"})
        self.assertEqual(json.loads(s[1]["body"]), {"status": "active"})
        self.assertEqual(s[2]["path"], "/enterprise/workspaces/w1/install/rotate")
        # A zero is a value, not a missing field: it cuts the old token off.
        self.assertEqual(json.loads(s[2]["body"]), {"overlap_hours": 0, "expires_in_days": 90})
        self.assertEqual(json.loads(s[3]["body"]), {})

    def test_a_refusal_carries_the_code_a_product_branches_on(self):
        self.api.answers = [fail(409, "WORKSPACE_LIMIT_REACHED", "the account has reached its limit of managed workspaces", **{"X-Request-Id": "req_9"})]
        with self.assertRaises(OmazyError) as ctx:
            self.account().workspaces.create("c", "n")
        self.assertEqual((ctx.exception.status, ctx.exception.code, ctx.exception.request_id), (409, "WORKSPACE_LIMIT_REACHED", "req_9"))

    def test_core_gives_a_core_client_for_one_customer_on_the_same_deployment(self):
        self.api.answers = [ok({"workspace_id": "w1"})]
        a = self.account()
        tenant = a.core("cai_tenant.secret")
        self.assertIsInstance(tenant, Omazy)
        tenant.whoami()
        seen = self.api.seen[0]
        self.assertEqual(seen["path"], "/core/whoami")
        self.assertEqual(seen["headers"]["Authorization"], "Bearer cai_tenant.secret")
        a.core("cai_tenant.secret", app="desk").knowledge.search("hours")
        self.assertEqual(json.loads(self.api.seen[1]["body"])["app"], "desk")
        # The account key is never sent to the Core API.
        self.assertTrue(all("eak_" not in s["headers"]["Authorization"] for s in self.api.seen))

    def test_a_key_is_required(self):
        with self.assertRaises(ValueError):
            OmazyEnterprise("")


if __name__ == "__main__":
    unittest.main()
