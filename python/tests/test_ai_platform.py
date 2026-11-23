import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from omazy import Omazy  # noqa: E402
from test_client import FakeAPI, ok  # noqa: E402

SCHEMA = {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"], "additionalProperties": False}


class AIPlatformTest(unittest.TestCase):
    def setUp(self):
        self.api = FakeAPI()
        self.addCleanup(self.api.close)
        self.o = Omazy("cai_abc.def", base_url=self.api.base, sleep=lambda s: None)

    def test_structured_output_images_and_a_forced_tool(self):
        self.api.answers = [ok({"text": '{"title":"Hi"}', "stop_reason": "stop", "model": "openai/gpt-4o-mini", "usage": {}, "output": {"title": "Hi"}})]
        res = self.o.ai.complete(
            [{"role": "user", "content": "read it", "images": [{"url": "https://a.b/slip.png"}, {"data": "AAAA", "media_type": "image/png"}]}],
            tools=[{"name": "lookup", "input_schema": {"type": "object"}}],
            tool_choice={"type": "tool", "name": "lookup"},
            response_format={"type": "json_schema", "json_schema": {"name": "brief", "strict": True, "schema": SCHEMA}},
        )
        self.assertEqual(res["output"], {"title": "Hi"})
        sent = json.loads(self.api.seen[0]["body"])
        self.assertEqual(sent["tool_choice"], {"type": "tool", "name": "lookup"})
        self.assertTrue(sent["response_format"]["json_schema"]["strict"])
        self.assertEqual(sent["messages"][0]["images"][1], {"data": "AAAA", "media_type": "image/png"})

    def test_embed_and_models(self):
        self.api.answers = [
            ok({"model": "@cf/baai/bge-m3", "dimensions": 2, "embeddings": [{"index": 0, "embedding": [0.1, 0.2]}], "usage": {"input_tokens": 1}}),
            ok({"default": "openai/gpt-4o", "models": [{"id": "openai/gpt-4o", "kind": "chat", "capabilities": {"vision": True}}]}),
        ]
        res = self.o.ai.embed(["a"])
        self.assertEqual(res["embeddings"][0]["embedding"], [0.1, 0.2])
        seen = self.api.seen[0]
        self.assertEqual((seen["method"], seen["path"], json.loads(seen["body"])), ("POST", "/core/ai/embeddings", {"input": ["a"]}))
        self.assertEqual(self.o.ai.models(app="kiosk")["default"], "openai/gpt-4o")
        self.assertEqual((self.api.seen[1]["method"], self.api.seen[1]["path"]), ("GET", "/core/ai/models?app=kiosk"))

    def test_model_roles(self):
        self.api.answers = [ok({"default": "openai/gpt-4o", "roles": []})]
        self.o.ai.roles.list()
        self.o.ai.roles.set("extract.fast", "openai/gpt-4.1-mini", fallbacks=["openai/gpt-4o-mini"], level="workspace")
        self.o.ai.roles.delete("extract.fast", level="workspace")
        self.assertEqual(
            [(s["method"], s["path"]) for s in self.api.seen],
            [("GET", "/core/ai/roles"), ("PUT", "/core/ai/roles/extract.fast"), ("DELETE", "/core/ai/roles/extract.fast?level=workspace")],
        )
        self.assertEqual(json.loads(self.api.seen[1]["body"]), {"model": "openai/gpt-4.1-mini", "fallbacks": ["openai/gpt-4o-mini"], "level": "workspace"})

    def test_metadata_cost_and_usage_groups(self):
        self.api.answers = [ok({"text": "hi", "usage": {"cost_micros": 42}})]
        res = self.o.ai.complete([{"role": "user", "content": "x"}], metadata={"unit": "brief_draft", "run_id": "r1"})
        self.assertEqual(res["usage"]["cost_micros"], 42)
        self.assertEqual(json.loads(self.api.seen[0]["body"])["metadata"], {"unit": "brief_draft", "run_id": "r1"})
        self.o.usage.get(group_by="run_id", unit="brief_draft")
        self.assertEqual(self.api.seen[1]["path"], "/core/usage?group_by=run_id&unit=brief_draft")

    def test_budgets(self):
        self.api.answers = [ok({"id": "b1", "limit_micros": 5000000})]
        self.assertEqual(self.o.budgets.set("day", 5, label="unit", value="*")["limit_micros"], 5000000)
        self.o.budgets.list()
        self.o.budgets.delete("b1")
        self.assertEqual([(s["method"], s["path"]) for s in self.api.seen], [("PUT", "/core/budgets"), ("GET", "/core/budgets"), ("DELETE", "/core/budgets/b1")])
        self.assertEqual(json.loads(self.api.seen[0]["body"]), {"label": "unit", "value": "*", "period": "day", "limit_usd": 5})


if __name__ == "__main__":
    unittest.main()
