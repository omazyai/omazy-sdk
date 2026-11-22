import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from omazy import Omazy  # noqa: E402
from test_client import FakeAPI, ok  # noqa: E402

DAY = {"model_calls": 2, "cache_hits": 1, "errors": 0, "input_tokens": 10, "output_tokens": 2, "cached_input_tokens": 4,
       "speech_sessions": 0, "speech_seconds": 0, "cost_micros": 1500, "cost_usd": 0.0015, "estimated_cost_micros": 0,
       "unpriced_calls": 0, "conversations": 1, "ai_turns": 2, "api_calls": 3, "voice_minutes": 0}
REPORT = {"workspace_id": "w1", "from": "2026-11-22", "to": "2026-11-22", "totals": DAY, "days": [dict(DAY, date="2026-11-22")]}


class UsageTest(unittest.TestCase):
    def setUp(self):
        self.api = FakeAPI()
        self.addCleanup(self.api.close)

    def test_get_sends_the_range_and_reads_the_report(self):
        self.api.answers = [ok(REPORT)]
        o = Omazy("cai_abc.def", base_url=self.api.base, sleep=lambda s: None)
        got = o.usage.get(from_="2026-11-22", to="2026-11-22")
        self.assertEqual(got["days"][0]["cache_hits"], 1)
        self.assertEqual(got["totals"]["cost_micros"], 1500)
        seen = self.api.seen[0]
        self.assertEqual((seen["method"], seen["path"]), ("GET", "/core/usage?from=2026-11-22&to=2026-11-22"))
        o.usage.get()
        self.assertEqual(self.api.seen[1]["path"], "/core/usage")


if __name__ == "__main__":
    unittest.main()
