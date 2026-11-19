"""Client for the Omazy Core API. Standard library only."""

import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Tuple, Union

from .errors import OmazyError
from .routes import IDEMPOTENT, RETRYABLE, ROUTES

DEFAULT_BASE_URL = "https://mw.omazy.ai/api/v1/core"
VERSION = "0.3.0"

Json = Dict[str, Any]


@dataclass
class ResponseInfo:
    """What the API said about limits and the token on the last response."""

    request_id: Optional[str] = None
    rate_limit: Optional[int] = None
    rate_remaining: Optional[int] = None
    rate_reset_seconds: Optional[int] = None
    token_expires_at: Optional[str] = None
    #: True while the caller is still on a token a rotation replaced.
    token_is_previous: bool = False
    #: True when the answer is the remembered answer of an earlier request
    #: with the same idempotency key.
    replayed: bool = False


@dataclass
class _Response:
    status: int
    headers: Mapping[str, str]
    raw: Any  # the open urllib response, for a stream

    def read(self) -> bytes:
        try:
            return self.raw.read()
        finally:
            self.raw.close()


def _int(v: Optional[str]) -> Optional[int]:
    try:
        return int(v) if v is not None else None
    except ValueError:
        return None


def _drop_none(d: Mapping[str, Any]) -> Json:
    return {k: v for k, v in d.items() if v is not None}


class Omazy:
    """Models, knowledge, your agent, speech and calls, with one scoped token.

    >>> omazy = Omazy(os.environ["OMAZY_CORE_TOKEN"])
    >>> omazy.ai.complete(messages=[{"role": "user", "content": "Hello"}])["text"]

    ``token`` is an install token, ``cai_<prefix>.<secret>``. Keep it on a server.
    ``app`` is the default app handle, for a workspace with more than one app.
    ``max_retries`` applies after a 429, 502, 503, 504 or a dropped connection, on
    routes that are safe to repeat and on any request sent with an
    ``idempotency_key``.

    A method that changes something takes ``idempotency_key``. With a key the
    platform runs the request once: a repeat with the same key gets the first
    answer back, so the client retries it like a read. Use a new key for each
    new request, for example ``str(uuid.uuid4())``, and the same key when you
    send one again.
    """

    def __init__(
        self,
        token: str,
        base_url: str = DEFAULT_BASE_URL,
        app: Optional[str] = None,
        max_retries: int = 2,
        timeout: float = 130.0,
        opener: Optional[Callable[..., Any]] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not token:
            raise ValueError("Omazy: token is required")
        self._token = token
        self._base = base_url.rstrip("/")
        self._app = app
        self._max_retries = max_retries
        self._timeout = timeout
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep
        #: Headers of the most recent response.
        self.last = ResponseInfo()

        self.ai = _AI(self)
        self.knowledge = _Knowledge(self)
        self.agent = _Agent(self)
        self.voice = _Voice(self)
        self.customers = _Customers(self)
        self.conversations = _Conversations(self)
        self.channels = _Channels(self)
        self.sessions = _Sessions(self)
        self.mcp = McpClient(self)

    def whoami(self) -> Json:
        """The workspace this token belongs to, its scopes and its deadline. Needs no scope."""
        return self._json("whoami")

    # -- plumbing -----------------------------------------------------------

    def _with_app(self, body: Json, app: Optional[str] = None) -> Json:
        body = _drop_none(body)
        chosen = app if app is not None else self._app
        if chosen and "app" not in body:
            body["app"] = chosen
        return body

    def _json(self, route: str, **kw: Any) -> Any:
        res = self._send(route, **kw)
        body = json.loads(res.read() or b"{}")
        return body.get("data") if isinstance(body, dict) else body

    def _send(
        self,
        route: str,
        path: Optional[Mapping[str, str]] = None,
        query: Optional[Mapping[str, Optional[str]]] = None,
        body: Optional[Json] = None,
        raw: Optional[bytes] = None,
        headers: Optional[Mapping[str, str]] = None,
        retries: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> _Response:
        method, template = ROUTES[route]
        url_path = template
        for k, v in (path or {}).items():
            url_path = url_path.replace("{" + k + "}", urllib.parse.quote(str(v), safe=""))
        q = {k: v for k, v in (query or {}).items() if v}
        url = self._base + url_path + ("?" + urllib.parse.urlencode(q) if q else "")

        hdrs = {"Authorization": "Bearer " + self._token, "User-Agent": "omazy-sdk-python/" + VERSION}
        data: Optional[bytes] = raw
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json"
        hdrs.update(headers or {})
        # A key makes a request that changes something safe to send again.
        keyed = bool(idempotency_key) and route in IDEMPOTENT
        if keyed:
            hdrs["Idempotency-Key"] = str(idempotency_key)

        attempts = (self._max_retries if retries is None else retries) if (route in RETRYABLE or keyed) else 0
        attempt = 0
        while True:
            req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
            try:
                resp = self._open(req, timeout=self._timeout)
                self.last = _info(resp.headers)
                return _Response(resp.status, resp.headers, resp)
            except urllib.error.HTTPError as e:
                self.last = _info(e.headers)
                retry_after = _int(e.headers.get("Retry-After"))
                code, message = _read_error(e)
                e.close()
                # 409 with a key: the first request is still running. Wait and ask again.
                transient = e.code in (429, 502, 503, 504) or (
                    keyed and e.code == 409 and code == "IDEMPOTENCY_IN_PROGRESS"
                )
                # A long Retry-After means the window is full. Waiting it out
                # here would hide a stalled caller, so hand that back.
                if transient and attempt < attempts and (retry_after or 0) <= 30:
                    self._sleep(retry_after if retry_after else _backoff(attempt))
                    attempt += 1
                    continue
                raise OmazyError(message, e.code, code, self.last.request_id, retry_after) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt < attempts:
                    self._sleep(_backoff(attempt))
                    attempt += 1
                    continue
                raise OmazyError(f"no response from the Core API: {e}", 0, "NETWORK_ERROR") from None


def _backoff(attempt: int) -> float:
    return min(8.0, 0.5 * (2**attempt)) * (0.5 + random.random() / 2)


def _info(h: Mapping[str, str]) -> ResponseInfo:
    return ResponseInfo(
        request_id=h.get("X-Request-Id"),
        rate_limit=_int(h.get("X-RateLimit-Limit")),
        rate_remaining=_int(h.get("X-RateLimit-Remaining")),
        rate_reset_seconds=_int(h.get("X-RateLimit-Reset")),
        token_expires_at=h.get("X-Omazy-Token-Expires-At"),
        token_is_previous=h.get("X-Omazy-Token-Use") == "previous",
        replayed=h.get("Idempotent-Replayed") == "true",
    )


def _read_error(e: urllib.error.HTTPError) -> Tuple[str, str]:
    try:
        text = e.read().decode("utf-8", "replace")
    except Exception:
        text = ""
    try:
        err = json.loads(text).get("error")
        if isinstance(err, dict):
            return err.get("code") or f"HTTP_{e.code}", err.get("message") or str(e.reason)
        if isinstance(err, str):
            return f"HTTP_{e.code}", err
    except (ValueError, AttributeError):
        pass
    return f"HTTP_{e.code}", text[:300] or str(e.reason)


def read_sse(lines: Iterator[bytes]) -> Iterator[Tuple[str, str]]:
    """Reads a server-sent event stream into (event, data) pairs."""
    event, data = "message", []
    for raw in lines:
        line = raw.decode("utf-8").rstrip("\r\n")
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = "message", []
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:][1:] if line[5:].startswith(" ") else line[5:])
    if data:
        yield event, "\n".join(data)


class _AI:
    def __init__(self, c: Omazy) -> None:
        self._c = c

    def complete(self, messages: List[Json], app: Optional[str] = None, **options: Any) -> Json:
        """One model call through the gateway. Needs ``ai:complete``.

        Options: ``system``, ``tools``, ``tool_choice``, ``model`` (with its
        provider, such as ``openai/gpt-4o-mini``), ``profile``, ``max_tokens``,
        ``temperature``. Returns ``text``, ``tool_calls``, ``stop_reason``,
        ``model`` and ``usage``.
        """
        body = self._c._with_app({"messages": messages, **options, "stream": False}, app)
        return self._c._json("ai.complete", body=body)

    def stream(self, messages: List[Json], app: Optional[str] = None, **options: Any) -> Iterator[Json]:
        """The same call as a stream.

        Yields ``{"type": "delta", "text": ...}`` as text arrives, then one
        ``{"type": "done", "result": ...}``. Raises OmazyError if the stream
        reports an error or ends before ``done``. A stream is not retried.
        """
        body = self._c._with_app({"messages": messages, **options, "stream": True}, app)
        res = self._c._send("ai.complete", body=body, headers={"Accept": "text/event-stream"}, retries=0)
        request_id = self._c.last.request_id
        try:
            for event, data in read_sse(iter(res.raw.readline, b"")):
                if event == "delta":
                    yield {"type": "delta", "text": json.loads(data).get("text", "")}
                elif event == "done":
                    yield {"type": "done", "result": json.loads(data)}
                    return
                elif event == "error":
                    e = json.loads(data)
                    raise OmazyError(e.get("message") or "the stream failed", res.status, e.get("code") or "STREAM_ERROR", request_id)
        finally:
            res.raw.close()
        raise OmazyError("the stream ended before it was done", res.status, "STREAM_ERROR", request_id)


class _Knowledge:
    def __init__(self, c: Omazy) -> None:
        self._c = c
        self.documents = _Documents(c)
        self.sources = _Sources(c)

    def search(self, query: str, top_k: Optional[int] = None, language: Optional[str] = None, app: Optional[str] = None) -> List[Json]:
        """Passages from the agent's knowledge base. Needs ``kb:search``."""
        body = self._c._with_app({"query": query, "top_k": top_k, "language": language}, app)
        return (self._c._json("knowledge.search", body=body) or {}).get("passages") or []

    def import_file(
        self,
        file: bytes,
        filename: str,
        content_type: str = "application/octet-stream",
        app: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Json:
        """Turn a file into a document: PDF, spreadsheet, image or text, at most 20 MB. Needs ``kb:write``."""
        return self._c._json(
            "knowledge.import_file",
            raw=file,
            query={"filename": filename, "app": app or self._c._app},
            headers={"Content-Type": content_type},
            idempotency_key=idempotency_key,
        )

    def export(self, since: Optional[int] = None, cursor: Optional[str] = None, limit: Optional[int] = None, app: Optional[str] = None) -> Json:
        """What changed in the knowledge base after ``since``, with the passages search uses.

        For keeping your own copy. Without ``since`` it returns everything
        indexed. Follow ``next_cursor`` until it is empty, then keep
        ``version`` for the next call. Needs ``kb:read``.
        """
        return self._c._json(
            "knowledge.export",
            query={
                "since": None if since is None else str(since),
                "cursor": cursor,
                "limit": None if limit is None else str(limit),
                "app": app or self._c._app,
            },
        )


class _Documents:
    def __init__(self, c: Omazy) -> None:
        self._c = c

    def list(self, cursor: Optional[str] = None, limit: Optional[int] = None, app: Optional[str] = None) -> Json:
        """One page of the knowledge base, newest first, without content. Needs ``kb:read``."""
        return self._c._json(
            "knowledge.documents.list",
            query={"cursor": cursor, "limit": None if limit is None else str(limit), "app": app or self._c._app},
        )

    def get(self, document_id: str, app: Optional[str] = None) -> Json:
        """One document with its content and how its indexing stands. Needs ``kb:read``."""
        return self._c._json("knowledge.documents.get", path={"id": document_id}, query={"app": app or self._c._app})

    def create(
        self,
        title: str,
        content: Optional[str] = None,
        app: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        **fields: Any,
    ) -> Json:
        """Add a document. It is indexed in the background.

        Read it again, or wait for ``kb.updated``, to see ``index.status``
        reach ``ready``. Other fields: ``kind``, ``source_url``, ``data``,
        ``language``, ``is_active``. Sending a document that already exists in
        every field returns the existing one. Retried only with an
        ``idempotency_key``. Needs ``kb:write``.
        """
        body = self._c._with_app({"title": title, "content": content, **fields}, app)
        return self._c._json("knowledge.documents.create", body=body, idempotency_key=idempotency_key)

    def update(self, document_id: str, app: Optional[str] = None, **fields: Any) -> Json:
        """Change the fields given and index the document again. Needs ``kb:write``."""
        return self._c._json("knowledge.documents.update", path={"id": document_id}, body=self._c._with_app(fields, app))

    def delete(self, document_id: str, app: Optional[str] = None) -> Json:
        """Delete a document. The agent stops using it. Needs ``kb:write``."""
        return self._c._json("knowledge.documents.delete", path={"id": document_id}, query={"app": app or self._c._app})


class _Sources:
    def __init__(self, c: Omazy) -> None:
        self._c = c

    def list(self, app: Optional[str] = None) -> List[Json]:
        """The websites the knowledge base is crawled from. Needs ``kb:read``."""
        return (self._c._json("knowledge.sources.list", query={"app": app or self._c._app}) or {}).get("sources") or []

    def create(
        self,
        root_url: str,
        max_pages: Optional[int] = None,
        max_depth: Optional[int] = None,
        app: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Json:
        """Add a website and start crawling it. Each page becomes a document. Needs ``kb:write``."""
        body = self._c._with_app({"root_url": root_url, "max_pages": max_pages, "max_depth": max_depth}, app)
        return self._c._json("knowledge.sources.create", body=body, idempotency_key=idempotency_key)

    def crawl(self, source_id: str, app: Optional[str] = None, idempotency_key: Optional[str] = None) -> Json:
        """Crawl a source again. Needs ``kb:write``."""
        return self._c._json(
            "knowledge.sources.crawl",
            path={"id": source_id},
            query={"app": app or self._c._app},
            idempotency_key=idempotency_key,
        )


class _Agent:
    def __init__(self, c: Omazy) -> None:
        self._c = c

    def turn(
        self,
        message: str,
        history: Optional[List[Json]] = None,
        session_id: Optional[str] = None,
        language: Optional[str] = None,
        app: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        **options: Any,
    ) -> Json:
        """One turn of the workspace's own agent. Needs ``agent:run``.

        A turn may fire a tool, so it is retried only with an ``idempotency_key``.

        The caller keeps the conversation: pass earlier turns in ``history``
        (``{"role": "user"|"assistant", "text": ...}``, oldest first) and reuse
        the ``session_id`` an earlier turn returned.
        """
        body = self._c._with_app(
            {"message": message, "history": history, "session_id": session_id, "language": language, **options}, app
        )
        return self._c._json("agent.turn", body=body, idempotency_key=idempotency_key)


class _Calls:
    def __init__(self, c: Omazy) -> None:
        self._c = c

    def place(
        self,
        to: str,
        purpose: str,
        consent_basis: str,
        app: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        **options: Any,
    ) -> Json:
        """Queue an outbound call answered by the agent. Needs ``voice:calls``.

        Retried only with an ``idempotency_key``, so a phone never rings twice
        for one request.
        """
        body = self._c._with_app({"to": to, "purpose": purpose, "consent_basis": consent_basis, **options}, app)
        return self._c._json("voice.calls.place", body=body, idempotency_key=idempotency_key)

    def get(self, ref: str, app: Optional[str] = None) -> Json:
        """Where a call stands and what the person answered."""
        return self._c._json("voice.calls.get", path={"ref": ref}, query={"app": app or self._c._app})


class _Jobs:
    def __init__(self, c: Omazy) -> None:
        self._c = c

    def create(self, kind: str, app: Optional[str] = None, idempotency_key: Optional[str] = None, **options: Any) -> Json:
        """Transcribe a recording or write notes from one, in the background. Needs ``voice:tasks``."""
        # This route reads the app from the query string.
        return self._c._json(
            "voice.jobs.create",
            body=_drop_none({"kind": kind, **options}),
            query={"app": app or self._c._app},
            idempotency_key=idempotency_key,
        )

    def get(self, job_id: str, app: Optional[str] = None) -> Json:
        return self._c._json("voice.jobs.get", path={"id": job_id}, query={"app": app or self._c._app})


class _Voice:
    def __init__(self, c: Omazy) -> None:
        self._c = c
        self.calls = _Calls(c)
        self.jobs = _Jobs(c)

    def speak(self, text: str, lang: Optional[str] = None, app: Optional[str] = None) -> Tuple[bytes, str]:
        """Text to speech in the agent's voice. Returns (WAV bytes, language spoken). Needs ``voice:speech``."""
        res = self._c._send("voice.speak", body=self._c._with_app({"text": text, "lang": lang}, app))
        return res.read(), res.headers.get("X-Omazy-Speech-Lang") or ""

    def transcribe(self, audio: bytes, lang: Optional[str] = None, app: Optional[str] = None, content_type: str = "application/octet-stream") -> Json:
        """Speech to text. ``audio`` is the raw recording, at most 8 MB. Needs ``voice:speech``."""
        return self._c._json(
            "voice.transcribe",
            raw=audio,
            query={"lang": lang, "app": app or self._c._app},
            headers={"Content-Type": content_type},
        )


class _Customers:
    def __init__(self, c: Omazy) -> None:
        self._c = c

    def get(self, customer_id: str) -> Json:
        """One customer by id. Needs ``core:read``."""
        return self._c._json("customers.get", path={"id": customer_id})

    def update(self, customer_id: str, custom_fields: Json) -> Json:
        """Merge keys into a customer's custom fields. Needs ``memory:write``."""
        return self._c._json("customers.update", path={"id": customer_id}, body={"custom_fields": custom_fields})


class _Conversations:
    def __init__(self, c: Omazy) -> None:
        self._c = c

    def post_message(self, conversation_id: str, blocks: List[Json], idempotency_key: Optional[str] = None) -> Json:
        """Post 1 to 12 blocks into an existing conversation as the app. Needs ``core:write``.

        Retried only with an ``idempotency_key``.
        """
        return self._c._json(
            "conversations.post_message",
            path={"id": conversation_id},
            body={"blocks": blocks},
            idempotency_key=idempotency_key,
        )


class _Channels:
    def __init__(self, c: Omazy) -> None:
        self._c = c

    def linkedin_publish(
        self, text: str, app: Optional[str] = None, idempotency_key: Optional[str] = None, **options: Any
    ) -> Json:
        """Publish a post to the connected LinkedIn page. Needs ``channels:publish``.

        Retried only with an ``idempotency_key``.
        """
        return self._c._json(
            "channels.linkedin_publish",
            body=self._c._with_app({"text": text, **options}, app),
            idempotency_key=idempotency_key,
        )


class _Sessions:
    def __init__(self, c: Omazy) -> None:
        self._c = c

    def bind_credential(self, session_id: str, server: str, token: str, expires_at: str, subject: Json) -> Json:
        """Bind a signed-in user's own tool credential to their chat session. Needs ``sessions:credentials``."""
        return self._c._json(
            "sessions.bind_credential",
            path={"sid": session_id, "server": server},
            body={"token": token, "expires_at": expires_at, "subject": subject},
        )

    def unbind_credential(self, session_id: str, server: str) -> Json:
        return self._c._json("sessions.unbind_credential", path={"sid": session_id, "server": server})


class McpClient:
    """The Core API's MCP server (POST /mcp).

    For a caller that would sooner speak the Model Context Protocol than REST.
    The tools are the Core verbs this token's scopes allow, and a call spends
    the same limits its route does. To hand the server to an MCP client of your
    own, use ``config()``.
    """

    def __init__(self, c: Omazy) -> None:
        self._c = c
        self._id = 0

    def config(self) -> Json:
        """The URL and headers an MCP client needs to connect (Streamable HTTP)."""
        return {"type": "http", "url": self._c._base + ROUTES["mcp"][1], "headers": {"Authorization": "Bearer " + self._c._token}}

    def _rpc(self, method: str, params: Optional[Json] = None) -> Any:
        self._id += 1
        msg: Json = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            msg["params"] = params
        res = json.loads(self._c._send("mcp", body=msg).read() or b"{}")
        if isinstance(res, dict) and res.get("error"):
            raise OmazyError(res["error"].get("message", "MCP error"), 200, f"MCP_{res['error'].get('code')}")
        if not isinstance(res, dict) or "result" not in res:
            raise OmazyError("the server did not answer with a JSON-RPC result", 200, "MCP_BAD_RESPONSE")
        return res["result"]

    def initialize(self, protocol_version: str = "2025-06-18") -> Json:
        return self._rpc(
            "initialize",
            {"protocolVersion": protocol_version, "capabilities": {}, "clientInfo": {"name": "omazy-python", "version": VERSION}},
        )

    def list_tools(self) -> List[Json]:
        return self._rpc("tools/list").get("tools") or []

    def call_tool(self, name: str, arguments: Optional[Json] = None) -> Json:
        """Calls a tool. Returns ``{"text", "data", "is_error"}``.

        A refusal (a bad argument, a spent budget, a rate limit) comes back with
        ``is_error`` True, as the protocol does, and is not raised. An unknown
        tool is raised.
        """
        r = self._rpc("tools/call", {"name": name, "arguments": arguments or {}})
        text = "".join(c.get("text", "") for c in r.get("content") or [])
        return {"text": text, "data": r.get("structuredContent"), "is_error": r.get("isError") is True}
