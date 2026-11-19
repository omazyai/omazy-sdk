# omazy (Python)

Python client for the [Omazy Core API](https://docs.omazy.ai/reference/core-api/). Standard library only. Python 3.9+.

## Install

```sh
pip install https://github.com/omazyai/omazy-sdk/releases/download/v0.3.0/omazy-0.3.0-py3-none-any.whl
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
| `knowledge.documents.list()`, `knowledge.documents.get(document_id)`, `knowledge.sources.list()`, `knowledge.export(since=, cursor=)` | `kb:read` |
| `knowledge.documents.create(title, content)`, `.update(document_id, **fields)`, `.delete(document_id)`, `knowledge.import_file(file, filename)`, `knowledge.sources.create(root_url)`, `.crawl(source_id)` | `kb:write` |
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

## Writing knowledge

A document is indexed in the background. `index["status"]` goes from `queued` to `ready`, or to `failed` with a reason.

```python
doc = omazy.knowledge.documents.create("Opening hours", "Open 9 to 5, Sunday to Thursday.")
omazy.knowledge.import_file(pdf_bytes, "handbook.pdf", content_type="application/pdf")

status = omazy.knowledge.documents.get(doc["id"])["index"]["status"]
```

To keep your own copy of the knowledge base, export everything once, then only what changed:

```python
cursor = None
while True:
    page = omazy.knowledge.export(since=saved, cursor=cursor)  # saved is None the first time
    for d in page["documents"]:
        store(d) if d["is_active"] else drop(d["id"])
    for d in page["deleted"]:
        drop(d["id"])
    cursor = page["next_cursor"]
    if not cursor:
        saved = page["version"]
        break
```

## Streaming

```python
for ev in omazy.ai.stream([{"role": "user", "content": "Count to five."}]):
    if ev["type"] == "delta":
        print(ev["text"], end="", flush=True)
    else:
        print("\n", ev["result"]["usage"])
```

## Sending a request again

A read is retried for you. A request that changes something is not: placing a call, posting a message, publishing, running an agent turn and adding knowledge are sent once. Give one a key and it becomes safe to repeat. The platform runs it once and answers a repeat with the first answer, so the client retries it like a read.

```python
import uuid

key = str(uuid.uuid4())  # keep it with the order, the visit, the job

omazy.voice.calls.place(
    "+447700900123", "confirmation", "transaction",
    opening="Hello, this is Nordwell.",
    idempotency_key=key,
)
```

Use a new key for each new request, and the same key when you send one again, also from another process or after a restart. A successful answer is remembered for 24 hours. A failed request is not remembered. The same key with a different request is refused with `IDEMPOTENCY_KEY_REUSED`. `omazy.last.replayed` is true when the answer was a remembered one.

The methods that take `idempotency_key`: `knowledge.documents.create`, `knowledge.import_file`, `knowledge.sources.create`, `knowledge.sources.crawl`, `agent.turn`, `voice.calls.place`, `voice.jobs.create`, `conversations.post_message` and `channels.linkedin_publish`.

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
