import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from omazy import Omazy, OmazyError  # noqa: E402
from test_client import FakeAPI, fail, ok  # noqa: E402

SERVER = {
    "id": "s1",
    "name": "front-desk",
    "endpoint_url": "https://tools.test/mcp",
    "auth_type": "bearer",
    "allowed_tools": [],
    "is_active": True,
    "write_mode": "confirm",
    "action_policy": {},
    "has_credentials": True,
}


class AgentMcpServersTest(unittest.TestCase):
    def setUp(self):
        self.api = FakeAPI()
        self.addCleanup(self.api.close)
        self.slept = []

    def client(self, **kw):
        return Omazy("cai_abc.def", base_url=self.api.base, sleep=self.slept.append, **kw)

    def test_create_sends_the_credential_once_and_reads_none_back(self):
        self.api.answers = [ok(SERVER)]
        made = self.client(app="acme").agent.mcp_servers.create(
            "front-desk", "https://tools.test/mcp", "bearer", credentials="s3cret", allowed_tools=["lookup"],
            idempotency_key="tenant-42-front-desk",
        )
        self.assertTrue(made["has_credentials"])
        self.assertNotIn("credentials", made)
        seen = self.api.seen[0]
        self.assertEqual((seen["method"], seen["path"]), ("POST", "/core/agent/mcp-servers"))
        self.assertEqual(seen["headers"]["Idempotency-Key"], "tenant-42-front-desk")
        # Arguments that were not given are left out, not sent as null.
        self.assertEqual(
            json.loads(seen["body"]),
            {"name": "front-desk", "endpoint_url": "https://tools.test/mcp", "auth_type": "bearer", "credentials": "s3cret", "allowed_tools": ["lookup"], "app": "acme"},
        )

    def test_a_server_without_whoami_is_connected_with_subject_check_host(self):
        self.api.answers = [ok(dict(SERVER, auth_type="session_bearer", subject_check="host", has_credentials=False))]
        made = self.client().agent.mcp_servers.create(
            "notion", "https://mcp.notion.com/mcp", "session_bearer", subject_check="host",
        )
        self.assertEqual(made["subject_check"], "host")
        self.assertEqual(
            json.loads(self.api.seen[0]["body"]),
            {"name": "notion", "endpoint_url": "https://mcp.notion.com/mcp", "auth_type": "session_bearer", "subject_check": "host"},
        )

    def test_a_create_is_sent_again_only_with_a_key(self):
        self.api.answers = [fail(503, "UPSTREAM_UNAVAILABLE", "try again"), ok(SERVER)]
        with self.assertRaises(OmazyError):
            self.client().agent.mcp_servers.create("a", "https://a.test/mcp", "none")
        self.assertEqual(len(self.api.seen), 1)

        self.api.seen.clear()
        self.api.answers = [fail(503, "UPSTREAM_UNAVAILABLE", "try again"), ok(SERVER)]
        self.client().agent.mcp_servers.create("a", "https://a.test/mcp", "none", idempotency_key="k1")
        self.assertEqual(len(self.api.seen), 2)
        self.assertEqual(self.api.seen[1]["headers"]["Idempotency-Key"], "k1")

    def test_list_get_and_delete_name_the_app_in_the_query(self):
        self.api.answers = [ok([SERVER]), ok(SERVER), ok({"id": "s1", "deleted": True})]
        o = self.client(app="acme")
        self.assertEqual(o.agent.mcp_servers.list()[0]["name"], "front-desk")
        o.agent.mcp_servers.get("s 1")
        self.assertTrue(o.agent.mcp_servers.delete("s1")["deleted"])
        s = self.api.seen
        self.assertEqual(s[0]["path"], "/core/agent/mcp-servers?app=acme")
        self.assertEqual(s[1]["path"], "/core/agent/mcp-servers/s%201?app=acme")
        self.assertEqual((s[2]["method"], s[2]["path"]), ("DELETE", "/core/agent/mcp-servers/s1?app=acme"))
        # An agent with no servers is an empty list.
        self.api.answers = [ok(None)]
        self.assertEqual(self.client().agent.mcp_servers.list(), [])

    def test_update_sends_only_what_changes(self):
        self.api.answers = [ok(SERVER)]
        self.client().agent.mcp_servers.update("s1", credentials="", allowed_tools=[], is_active=False)
        seen = self.api.seen[0]
        self.assertEqual((seen["method"], seen["path"]), ("PATCH", "/core/agent/mcp-servers/s1"))
        # An empty credential removes the stored one, an empty list allows every tool.
        self.assertEqual(json.loads(seen["body"]), {"credentials": "", "allowed_tools": [], "is_active": False})

    def test_a_change_and_a_removal_are_sent_again(self):
        self.api.answers = [fail(503, "UPSTREAM_UNAVAILABLE", "try again"), ok(SERVER)]
        self.client().agent.mcp_servers.update("s1", is_active=True)
        self.assertEqual(len(self.api.seen), 2)

        self.api.seen.clear()
        self.api.answers = [fail(503, "UPSTREAM_UNAVAILABLE", "try again"), ok({"id": "s1", "deleted": True})]
        self.assertTrue(self.client().agent.mcp_servers.delete("s1")["deleted"])
        self.assertEqual([s["method"] for s in self.api.seen], ["DELETE", "DELETE"])

        # The first removal went through but its answer was lost: the retry is told NOT_FOUND.
        self.api.seen.clear()
        self.api.answers = [fail(502, "BAD_GATEWAY", "lost"), fail(404, "NOT_FOUND", "MCP server not found")]
        with self.assertRaises(OmazyError) as cm:
            self.client().agent.mcp_servers.delete("s1")
        self.assertEqual(cm.exception.code, "NOT_FOUND")
        self.assertEqual(len(self.api.seen), 2)

    def test_a_name_the_app_already_uses_is_a_conflict(self):
        self.api.answers = [fail(409, "CONFLICT", "this app already has an MCP server named front-desk")]
        with self.assertRaises(OmazyError) as ctx:
            self.client().agent.mcp_servers.create("front-desk", "https://a.test/mcp", "none")
        self.assertEqual((ctx.exception.status, ctx.exception.code), (409, "CONFLICT"))


if __name__ == "__main__":
    unittest.main()
