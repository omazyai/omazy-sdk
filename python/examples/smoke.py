"""A live check against a real deployment. Reads OMAZY_CORE_TOKEN (and
OMAZY_BASE_URL, if set). Spends a few tokens. Run: python examples/smoke.py"""

import json
import os
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from omazy import DEFAULT_BASE_URL, Omazy, OmazyError  # noqa: E402

omazy = Omazy(os.environ["OMAZY_CORE_TOKEN"], base_url=os.environ.get("OMAZY_BASE_URL") or DEFAULT_BASE_URL)

me = omazy.whoami()
print("whoami      ", me["app_slug"], len(me["scopes"]), "scopes, token", me["token"], "| request", omazy.last.request_id)

done = omazy.ai.complete([{"role": "user", "content": "Reply with the single word: pong"}], max_tokens=8)
print("complete    ", json.dumps(done["text"]), done["model"], "| remaining", omazy.last.rate_remaining)

streamed, deltas = "", 0
for ev in omazy.ai.stream([{"role": "user", "content": "Count from 1 to 5."}], max_tokens=30):
    if ev["type"] == "delta":
        streamed += ev["text"]
        deltas += 1
    else:
        print("stream      ", json.dumps(streamed), f"{deltas} deltas, done matches: {ev['result']['text'] == streamed}")

passages = omazy.knowledge.search("What does the company do?", top_k=2)
print("knowledge   ", len(passages), "passages, first:", passages[0]["title"] if passages else None)

print("mcp tools   ", ", ".join(t["name"] for t in omazy.mcp.list_tools()))
via = omazy.mcp.call_tool("knowledge_search", {"query": "What does the company do?", "top_k": 1})
print("mcp call    ", "is_error", via["is_error"], "| passages", len((via["data"] or {}).get("passages") or []))

try:
    omazy.customers.get("00000000-0000-0000-0000-000000000000")
except OmazyError as e:
    print("refusal     ", e.status, e.code, "|", e.message)
