# omazy (Python)

Python client for the [Omazy Core API](https://docs.omazy.ai/reference/core-api/). Standard library only. Python 3.9+.

## Install

```sh
pip install https://github.com/omazyai/omazy-sdk/releases/download/v0.1.0/omazy-0.1.0-py3-none-any.whl
```

## Use

```python
import os
from omazy import Omazy

omazy = Omazy(os.environ["OMAZY_CORE_TOKEN"])

answer = omazy.ai.complete(
    [{"role": "user", "content": "What is a webhook?"}],
    system="You answer in one sentence.",
)
print(answer["text"])
```

The token is a Core API token (`cai_...`). A workspace owner creates it and chooses its scopes: see [Core API authentication](https://docs.omazy.ai/reference/core-api/authentication/). Keep it on a server.

`omazy.whoami()` says what a token is: its scopes, when it expires, and the workspace's plan with the rate per minute and the AI turns used and included.

## Calls

| Method | Scope |
|---|---|
| `whoami()` | none |
| `ai.complete(messages, **options)`, `ai.stream(messages, **options)` | `ai:complete` |
| `knowledge.search(query, top_k=, language=)` | `kb:search` |
| `agent.turn(message, history=, session_id=)` | `agent:run` |
| `voice.speak(text)`, `voice.transcribe(audio)` | `voice:speech` |
| `voice.calls.place(to, purpose, consent_basis)`, `voice.calls.get(ref)` | `voice:calls` |
| `voice.jobs.create(kind, **options)`, `voice.jobs.get(job_id)` | `voice:tasks` |
| `customers.get(customer_id)` | `core:read` |
| `customers.update(customer_id, custom_fields)` | `memory:write` |
| `conversations.post_message(conversation_id, blocks)` | `core:write` |
| `channels.linkedin_publish(text)` | `channels:publish` |
| `sessions.bind_credential(...)`, `sessions.unbind_credential(...)` | `sessions:credentials` |
| `mcp.list_tools()`, `mcp.call_tool(name, arguments)`, `mcp.config()` | the tool's own scope |

## Streaming

```python
for ev in omazy.ai.stream([{"role": "user", "content": "Count to five."}]):
    if ev["type"] == "delta":
        print(ev["text"], end="", flush=True)
    else:
        print("\n", ev["result"]["usage"])
```

## Errors

```python
from omazy import OmazyError

try:
    omazy.agent.turn("hello")
except OmazyError as e:
    if e.code in ("PLAN_LIMIT_REACHED", "PAYMENT_REQUIRED"):
        ...  # the plan's AI turns or a spend budget are used up: stop calling and tell the workspace's owner
    raise
```

`e.status`, `e.code`, `e.message`, `e.request_id` and `e.retry_after` are set from the response. After any call, `omazy.last` holds the request id, the rate limit and the token's deadline.

## Requests the platform sends to you

```python
from omazy import verify_signature

if not verify_signature(secret, raw_body, request.headers.get("X-Omazy-Signature")):
    return 401
```

## Develop

```sh
python3 -m unittest discover -s tests
OMAZY_CORE_TOKEN=cai_... python3 examples/smoke.py   # against a real deployment
```

## Author and license

Written and maintained by Mosthofa Imran. MIT license.
