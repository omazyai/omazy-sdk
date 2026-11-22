import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from omazy import UNSET, Omazy, OmazyError  # noqa: E402
from test_client import FakeAPI, fail, ok  # noqa: E402

SETTINGS = {
    "app_id": "a1",
    "app": "acme",
    "model": {"id": "openai/gpt-4o", "source": "app", "overridden": True, "inherited_model": "openai/gpt-4o-mini", "max_tokens": 1200, "temperature": None},
    "models": [{"id": "openai/gpt-4o", "label": "GPT-4o", "vendor": "openai", "tier": "premium", "tools": True, "source": "managed"}],
    "loop": {"harness": True, "stream": True, "redact": False, "overrides": {"harness": True}},
}


class AgentSettingsTest(unittest.TestCase):
    def setUp(self):
        self.api = FakeAPI()
        self.addCleanup(self.api.close)
        self.slept = []

    def client(self, **kw):
        return Omazy("cai_abc.def", base_url=self.api.base, sleep=self.slept.append, **kw)

    def test_get_reads_the_settings_of_the_default_app(self):
        self.api.answers = [ok(SETTINGS)]
        got = self.client(app="acme").agent.settings.get()
        self.assertEqual(got["model"]["id"], "openai/gpt-4o")
        self.assertIsNone(got["model"]["temperature"])
        seen = self.api.seen[0]
        self.assertEqual((seen["method"], seen["path"]), ("GET", "/core/agent/settings?app=acme"))
        self.client().agent.settings.get()
        self.assertEqual(self.api.seen[1]["path"], "/core/agent/settings")

    def test_update_sends_none_as_null_and_leaves_out_what_was_not_named(self):
        self.api.answers = [ok(SETTINGS)]
        o = self.client()
        o.agent.settings.update(model="openai/gpt-4o", max_tokens=None, stream=False, redact=None)
        seen = self.api.seen[0]
        self.assertEqual((seen["method"], seen["path"]), ("PATCH", "/core/agent/settings"))
        # None means "back to what the agent inherits"; an argument left out means "leave it".
        self.assertEqual(json.loads(seen["body"]), {"model": "openai/gpt-4o", "max_tokens": None, "loop": {"stream": False, "redact": None}})
        self.assertIn(b'"max_tokens": null', seen["body"])

        o.agent.settings.update(model=None)
        self.assertEqual(json.loads(self.api.seen[1]["body"]), {"model": None})
        # A zero temperature and a False switch are values.
        self.client(app="acme").agent.settings.update(temperature=0, harness=False)
        self.assertEqual(json.loads(self.api.seen[2]["body"]), {"temperature": 0, "loop": {"harness": False}, "app": "acme"})
        self.assertEqual(repr(UNSET), "UNSET")

    def test_a_change_is_sent_again_after_a_gateway_error(self):
        self.api.answers = [fail(503, "UPSTREAM_UNAVAILABLE", "try again"), ok(SETTINGS)]
        self.client().agent.settings.update(harness=True)
        self.assertEqual(len(self.api.seen), 2)
        self.assertEqual(self.api.seen[0]["body"], self.api.seen[1]["body"])

    def test_a_model_that_cannot_be_set_is_an_error_with_its_code(self):
        for status, code in ((403, "MODEL_NOT_AVAILABLE"), (422, "MODEL_NOT_SERVING")):
            self.api.seen.clear()
            self.api.answers = [fail(status, code, "no")]
            with self.assertRaises(OmazyError) as ctx:
                self.client().agent.settings.update(model="openai/o3")
            self.assertEqual((ctx.exception.status, ctx.exception.code), (status, code))
            self.assertEqual(len(self.api.seen), 1)


if __name__ == "__main__":
    unittest.main()
