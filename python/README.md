# omazy (Python)

Python client for the [Omazy Core API](https://docs.omazy.ai/reference/core-api/). Standard library only. Python 3.9+.

## Install

```sh
pip install https://github.com/omazyai/omazy-sdk/releases/download/v0.5.3/omazy-0.5.3-py3-none-any.whl
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
| `agent.turn(message, history=, session_id=, context=)`, `agent.stream(...)` | `agent:run` |
| `agent.settings.get()`, `agent.settings.update(model=, max_tokens=, temperature=, harness=, stream=, redact=)` | `agent:configure` |
| `agent.mcp_servers.list()`, `.get(server_id)`, `.create(name, endpoint_url, auth_type)`, `.update(server_id, **fields)`, `.delete(server_id)` | `agent:tools` |
| `voice.speak(text)`, `voice.transcribe(audio)`, `voice.transcribe_stream()` | `voice:speech` |
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

## The agent's settings

Read and change how the agent runs: its model, the cap on a reply, the temperature and the loop switches.

```python
settings = omazy.agent.settings.get()
settings["model"]["id"]   # "openai/gpt-4o-mini"
settings["models"]        # what the plan allows

omazy.agent.settings.update(model="openai/gpt-4o", max_tokens=1200)
omazy.agent.settings.update(stream=True, redact=None)  # None: back to the default
omazy.agent.settings.update(model=None)                # back to the inherited model
```

An argument left out is left as it is. `None` puts a setting back to what the agent inherits. A new model is tested with one real call before it is saved, so allow up to 90 seconds: `MODEL_NOT_AVAILABLE` is a model off the plan, `MODEL_NOT_SERVING` one that did not answer, and in both cases nothing changes. Setting `max_tokens` or `temperature` on an agent that inherits its model pins it to the model it runs on now.

## The agent's MCP servers

Connect the tool servers the agent may call. This is the other direction from `omazy.mcp`, which is Omazy as an MCP server for your own agent.

```python
server = omazy.agent.mcp_servers.create(
    "front-desk", "https://tools.example.com/mcp", "bearer", credentials=token,
    idempotency_key=f"front-desk-{tenant_id}",
)

omazy.agent.mcp_servers.update(server["id"], credentials=new_token)  # rotate
omazy.agent.mcp_servers.update(server["id"], is_active=False)        # keep it, stop calling it
omazy.agent.mcp_servers.delete(server["id"])
```

The agent offers the server's tools to the model from its next turn, as `mcp_<name>__<tool>`. A name is unique within the app: a second server with it is `409 CONFLICT`. The endpoint must be https on a public host. The credential is stored encrypted and never returned; `has_credentials` says whether one is stored. `write_mode` defaults to `confirm`: the visitor agrees on a card before a tool that changes data runs.

## Streaming

```python
for ev in omazy.ai.stream([{"role": "user", "content": "Count to five."}]):
    if ev["type"] == "delta":
        print(ev["text"], end="", flush=True)
    else:
        print("\n", ev["result"]["usage"])
```

An agent turn streams the same way, and `context` tells the agent where the person is:

```python
for ev in omazy.agent.stream("Is my meeting today?", context={"interaction": "voice"}):
    if ev["type"] == "delta":
        speak(ev["text"])
    else:
        history.append({"role": "assistant", "text": ev["result"]["text"]})
```

The agent's own reply markup (quick replies, images) is held back from the pieces. Keep the text of the whole turn at the end: it is the one the agent finished with. When the agent's settings turn streaming off or masking of personal data on, only the whole turn arrives. An agent with connected tools sends its whole reply as one piece for now. A streamed turn is not retried, and an idempotency key does not replay it.

## Live speech to text

```python
with omazy.voice.transcribe_stream(language="bn", terms=["Rashed Karim"], audio_format="pcm_s16le", sample_rate=16000) as s:
    for chunk in mic_while_held():
        s.send(chunk)
    print(s.commit()["text"])   # the button is let go
    done = s.end()              # the conversation is over
```

Open the session when the person starts speaking, or once for a whole conversation, and send audio as it is captured. The vendor session opens while they speak, so the text is ready a few hundred milliseconds after they stop. `commit` after each utterance (a hold-to-talk button let go) returns its final, whose text may be empty; `end` finishes the session and returns every final joined with the audio length it is billed by. Voice minutes are counted once per session, rounded up with a one-minute floor, so hold one session for a conversation rather than one per utterance, and send `keepalive` between utterances: a session silent for 60 seconds is closed. `terms` (at most 200) are names and words to expect; `transcribe` takes them too. The token goes on the upgrade, so this runs on your server: a browser streams to your backend, which relays. A session is never retried. An `error` frame arrives as an error with its `code` and request id. Watch every frame with `on_event` or `for ev in s.events()`.

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

`e.status`, `e.code`, `e.message`, `e.request_id` and `e.retry_after` are set from the response. `with omazy.with_response() as response:` gives the request id, the rate limit and the token's deadline of the calls made inside the block by this thread, which other threads never change. `omazy.last` holds the same for the client's most recent response, whichever call it answered, so with threads sharing a client it can belong to another thread's call.

## One workspace per customer

For a product that serves many customers. `OmazyEnterprise` takes an account key (`eak_...`) and creates and runs a workspace for each customer. `core(token)` is the client for one of them.

```python
from omazy import OmazyEnterprise

account = OmazyEnterprise(os.environ["OMAZY_ACCOUNT_KEY"])

made = account.workspaces.create(external_id="cust_42", name="Acme Bank")
if made["token"]:
    save_token_for("cust_42", made["token"])  # shown once, on the call that minted it

acme = account.core(token_for("cust_42"))
acme.knowledge.documents.create(title="Opening hours", content="9 to 5")
```

| Method | Does | Scope |
|---|---|---|
| `account()` | The account, its limits, how many workspaces it manages, and the key | none |
| `workspaces.create(external_id, name, ...)` | The customer's workspace, agent, plan and install. Safe to repeat by `external_id` | `workspaces:manage` (the install needs `installs:manage` too) |
| `workspaces.list(...)`, `workspaces.all(...)` | One page, or every workspace page by page | `workspaces:manage` |
| `workspaces.get(id)`, `workspaces.find_by_external_id(id)` | One workspace, by its id or by your own | `workspaces:manage` |
| `workspaces.update(id, ...)`, `suspend(id)`, `resume(id)` | Name, brand and status. `resume` also reopens a closed workspace | `workspaces:manage` |
| `workspaces.close(id)` | Closes it. Nothing is erased | `workspaces:manage` |
| `workspaces.rotate_install(id, ...)` | A new install token, the old one kept for `overlap_hours` | `installs:manage` |
| `core(token, **options)` | The `Omazy` client for one customer | the customer's token |

Refusals to branch on: `HANDLE_TAKEN` (the message lists free handles), `WORKSPACE_LIMIT_REACHED`, `WORKSPACE_CLOSED` (reopen it with `resume`), `ACCOUNT_SUSPENDED`. Every call except `rotate_install` is sent again after a 429, a gateway error or a dropped connection.

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
