import json
import pathlib
import sys
import threading
import unittest
from unittest import mock
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from omazy import IDEMPOTENT, RETRYABLE, ROUTES, WEBSOCKET, Omazy, OmazyError, ResponseInfo, sign, verify_signature  # noqa: E402
from omazy import client as omazy_client  # noqa: E402

# hmac-sha256('s3cret', '{"a":1}') in hex, computed with openssl. The three SDKs
# test against the same vector.
SIG_VECTOR = "5910e62016ef5034272c926c27071992a465c2335cecf41851bda071577f4f6d"
# The contract sits beside the SDKs: two levels up in the public repository,
# three in the platform's own.
CONTRACT = next(
    p
    for p in (
        pathlib.Path(__file__).resolve().parents[n] / "contracts" / "core-api.routes.json" for n in (2, 3)
    )
    if p.exists()
)


class FakeAPI:
    """A real HTTP server on a free port that answers from a queue."""

    def __init__(self):
        self.seen = []
        self.answers = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                outer.seen.append({"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body})
                answer = outer.answers.pop(0) if len(outer.answers) > 1 else outer.answers[0]
                if callable(answer):
                    answer = answer(self.path)
                status, headers, payload = answer
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                if isinstance(payload, list):  # a stream: chunks, then close
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for chunk in payload:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    self.close_connection = True
                    return
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/core"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def ok(data, **headers):
    return 200, {"Content-Type": "application/json", **headers}, json.dumps({"success": True, "data": data}).encode()


def fail(status, code, message, **headers):
    return status, headers, json.dumps({"success": False, "error": {"code": code, "message": message}}).encode()


def rpc(result=None, error=None):
    body = {"jsonrpc": "2.0", "id": 1}
    body.update({"error": error} if error else {"result": result})
    return 200, {}, json.dumps(body).encode()


class Base(unittest.TestCase):
    def setUp(self):
        self.api = FakeAPI()
        self.addCleanup(self.api.close)
        self.slept = []

    def client(self, **kw):
        return Omazy("cai_abc.def", base_url=self.api.base, sleep=self.slept.append, **kw)


class ContractTest(Base):
    def test_websocket_routes_are_the_ones_the_contract_marks(self):
        contract = json.loads(CONTRACT.read_text())["routes"]
        self.assertEqual(WEBSOCKET, {r["sdk"] for r in contract if r.get("websocket")})
        self.assertFalse(WEBSOCKET & (RETRYABLE | IDEMPOTENT))

    def test_route_table_is_the_contract(self):
        contract = json.loads(CONTRACT.read_text())["routes"]
        want = {r["sdk"]: (r["method"], r["path"]) for r in contract}
        self.assertEqual(ROUTES, want)

    def test_every_route_is_reachable_through_a_client_method(self):
        self.api.answers = [lambda path: rpc({"tools": []}) if path.endswith("/mcp") else ok({"passages": []})]
        o = self.client()
        o.whoami()
        o.contract()
        o.ai.complete([{"role": "user", "content": "hi"}])
        o.ai.embed("hi")
        o.ai.models()
        o.ai.roles.list()
        o.ai.roles.set("c1", "openai/gpt-4o")
        o.ai.roles.delete("c1")
        o.knowledge.search("q")
        o.knowledge.documents.list()
        o.knowledge.documents.create("t", "c")
        o.knowledge.documents.get("c1")
        o.knowledge.documents.update("c1", title="t2")
        o.knowledge.documents.delete("c1")
        o.knowledge.import_file(b"\x01\x02", "a.pdf")
        o.knowledge.sources.list()
        o.knowledge.sources.create("https://x.test")
        o.knowledge.sources.crawl("c1")
        o.knowledge.export()
        o.agent.turn("hi")
        o.agent.settings.get()
        o.agent.settings.update(stream=True)
        o.agent.mcp_servers.list()
        o.agent.mcp_servers.create("a", "https://a.test/mcp", "none")
        o.agent.mcp_servers.get("c1")
        o.agent.mcp_servers.update("c1", is_active=False)
        o.agent.mcp_servers.delete("c1")
        o.voice.speak("hi")
        o.voice.transcribe(b"\x01\x02")
        o.voice.calls.place("+8801712345678", "reminder", "customer")
        o.voice.calls.get("r1")
        o.voice.jobs.create("transcribe", source_url="https://x.test/a.mp3")
        o.voice.jobs.get("j1")
        o.customers.get("c1")
        o.customers.update("c1", {"tier": "gold"})
        o.conversations.post_message("s1", [{"type": "text", "markdown": "hi"}])
        o.channels.linkedin_publish("hi")
        o.sessions.bind_credential("s1", "erp", "t", "2027-01-01T00:00:00Z", {})
        o.sessions.unbind_credential("s1", "erp")
        o.usage.get()
        o.budgets.list()
        o.budgets.set("day", 5)
        o.budgets.delete("c1")
        o.mcp.list_tools()

        used = {(s["method"], s["path"].split("?")[0].replace("/core", "", 1)) for s in self.api.seen}
        fill = {"{ref}": "r1", "{sid}": "s1", "{server}": "erp", "{name}": "c1"}
        for name, (method, path) in ROUTES.items():
            if name in WEBSOCKET:
                continue  # opened on a real socket in test_transcribe_stream.py
            for k, v in fill.items():
                path = path.replace(k, v)
            path = path.replace("{id}", "j1" if name.startswith("voice.jobs") else "s1" if name.startswith("conv") else "c1")
            self.assertIn((method, path), used, f"{name} was never called")

    def test_nothing_that_changes_the_world_is_retried(self):
        for name in (
            "voice.calls.place", "conversations.post_message", "channels.linkedin_publish", "agent.turn", "customers.update",
            "voice.jobs.create", "mcp", "knowledge.documents.create",
            "knowledge.import_file", "knowledge.sources.create", "knowledge.sources.crawl",
        ):
            self.assertNotIn(name, RETRYABLE)


class LiveContractTest(Base):
    def test_contract_reads_the_route_contract_or_the_openapi_document(self):
        self.api.answers = [ok({"base": "/api/v1/core", "routes": [{"method": "GET", "path": "/whoami", "scope": "", "sdk": "whoami"}]})]
        got = self.client().contract()
        self.assertEqual(got["routes"][0]["sdk"], "whoami")
        self.client().contract(format="openapi")
        self.assertEqual(self.api.seen[0]["path"], "/core/contract")
        self.assertEqual(self.api.seen[1]["path"], "/core/contract?format=openapi")


class KnowledgeTest(Base):
    def test_a_document_is_created_in_the_default_app_and_none_fields_are_left_out(self):
        self.api.answers = [ok({"id": "01A", "index": {"status": "queued"}})]
        doc = self.client(app="desk").knowledge.documents.create("Hours", "9 to 5", language="en", source_url=None)
        self.assertEqual(doc["index"]["status"], "queued")
        seen = self.api.seen[0]
        self.assertEqual((seen["method"], seen["path"]), ("POST", "/core/knowledge/documents"))
        self.assertEqual(json.loads(seen["body"]), {"title": "Hours", "content": "9 to 5", "language": "en", "app": "desk"})

    def test_a_patch_can_switch_a_document_off(self):
        self.api.answers = [ok({"id": "01A", "is_active": False})]
        self.client().knowledge.documents.update("01A", is_active=False)
        seen = self.api.seen[0]
        self.assertEqual((seen["method"], seen["path"]), ("PATCH", "/core/knowledge/documents/01A"))
        self.assertEqual(json.loads(seen["body"]), {"is_active": False})

    def test_a_file_is_sent_as_the_raw_body_with_its_name_and_type(self):
        self.api.answers = [ok({"id": "01F"})]
        self.client().knowledge.import_file(b"%PDF-1.7", "hand book.pdf", content_type="application/pdf")
        seen = self.api.seen[0]
        self.assertEqual(seen["path"], "/core/knowledge/import?filename=hand+book.pdf")
        self.assertEqual(seen["headers"]["Content-Type"], "application/pdf")
        self.assertEqual(seen["body"], b"%PDF-1.7")

    def test_an_export_sends_since_even_when_it_is_0(self):
        self.api.answers = [ok({"version": 12, "documents": [], "deleted": [], "resync": False, "next_cursor": ""})]
        o = self.client()
        self.assertEqual(o.knowledge.export()["version"], 12)
        self.assertEqual(self.api.seen[0]["path"], "/core/knowledge/export")
        o.knowledge.export(since=0, cursor="12.4.01A", limit=20)
        self.assertEqual(self.api.seen[1]["path"], "/core/knowledge/export?since=0&cursor=12.4.01A&limit=20")

    def test_a_write_that_is_refused_is_not_sent_again(self):
        self.api.answers = [fail(503, "UPSTREAM_UNAVAILABLE", "try later")]
        with self.assertRaises(OmazyError):
            self.client().knowledge.sources.crawl("s1")
        self.assertEqual(len(self.api.seen), 1)

    def test_a_change_and_a_delete_are_sent_again(self):
        self.api.answers = [fail(503, "UPSTREAM_UNAVAILABLE", "busy", **{"Retry-After": "1"}), ok({"id": "01A", "is_active": False})]
        self.assertEqual(self.client().knowledge.documents.update("01A", is_active=False)["id"], "01A")
        self.assertEqual([s["method"] for s in self.api.seen], ["PATCH", "PATCH"])
        self.api.seen.clear()
        self.api.answers = [fail(502, "BAD_GATEWAY", "lost", **{"Retry-After": "1"}), fail(404, "NOT_FOUND", "document not found")]
        with self.assertRaises(OmazyError) as cm:
            self.client().knowledge.documents.delete("01A")
        self.assertEqual(cm.exception.code, "NOT_FOUND")
        self.assertEqual([s["method"] for s in self.api.seen], ["DELETE", "DELETE"])

    def test_a_rate_limited_read_is_sent_again(self):
        self.api.answers = [fail(429, "RATE_LIMITED", "slow down", **{"Retry-After": "1"}), ok({"documents": [], "next_cursor": "", "version": 3})]
        self.assertEqual(self.client().knowledge.documents.list(limit=10)["version"], 3)
        self.assertEqual(len(self.api.seen), 2)


class RequestTest(Base):
    def test_token_envelope_and_default_app(self):
        self.api.answers = [ok({"text": "pong", "stop_reason": "stop", "model": "openai/gpt-4o", "usage": {}})]
        res = self.client(app="kiosk").ai.complete([{"role": "user", "content": "ping"}], max_tokens=8)
        self.assertEqual(res["text"], "pong")
        seen = self.api.seen[0]
        self.assertEqual(seen["headers"]["Authorization"], "Bearer cai_abc.def")
        self.assertEqual(json.loads(seen["body"]), {"messages": [{"role": "user", "content": "ping"}], "max_tokens": 8, "stream": False, "app": "kiosk"})

    def test_path_arguments_are_escaped_into_one_segment(self):
        self.api.answers = [ok({})]
        self.client().voice.calls.get("a/../b", app="kiosk")
        self.assertEqual(self.api.seen[0]["path"], "/core/voice/calls/a%2F..%2Fb?app=kiosk")

    def test_transcribe_sends_terms_as_one_comma_separated_parameter(self):
        self.api.answers = [ok({"text": "hi", "language": "en"})]
        self.client().voice.transcribe(b"\x01", lang="en", terms=["Rashed Karim", "Joya"])
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.api.seen[0]["path"]).query)
        self.assertEqual(query["terms"], ["Rashed Karim,Joya"])

    def test_a_refusal_becomes_an_error_with_code_status_and_request_id(self):
        self.api.answers = [fail(403, "FORBIDDEN", "missing scope: ai:complete", **{"X-Request-Id": "req_1"})]
        with self.assertRaises(OmazyError) as cm:
            self.client().ai.complete([{"role": "user", "content": "x"}])
        e = cm.exception
        self.assertEqual((e.status, e.code, e.message, e.request_id), (403, "FORBIDDEN", "missing scope: ai:complete", "req_1"))

    def test_response_headers_are_read_into_last(self):
        self.api.answers = [ok({}, **{"X-Request-Id": "req_9", "X-RateLimit-Limit": "600", "X-RateLimit-Remaining": "12", "X-RateLimit-Reset": "3", "X-Omazy-Token-Use": "previous", "X-Omazy-Token-Expires-At": "2026-12-01T00:00:00Z"})]
        o = self.client()
        o.whoami()
        self.assertEqual((o.last.request_id, o.last.rate_limit, o.last.rate_remaining, o.last.rate_reset_seconds), ("req_9", 600, 12, 3))
        self.assertTrue(o.last.token_is_previous)
        self.assertEqual(o.last.token_expires_at, "2026-12-01T00:00:00Z")

    def test_with_response_keeps_each_threads_own_headers(self):
        # The slow call is answered after the fast one, so last ends on it while
        # each thread's block keeps the answer to its own call.
        slow_started = threading.Event()

        def answer(path):
            name = path.rsplit("/", 1)[-1]
            if name == "slow":
                slow_started.set()
                fast_done.wait(5)
            return ok({"id": name}, **{"X-Request-Id": "req_" + name, "X-RateLimit-Limit": "600", "X-RateLimit-Remaining": "9" if name == "slow" else "8"})

        fast_done = threading.Event()
        self.api.answers = [answer]
        o = self.client()
        got = {}

        def call(name):
            with o.with_response() as response:
                if name == "fast":
                    slow_started.wait(5)
                o.knowledge.documents.get(name)
                if name == "fast":
                    fast_done.set()
            got[name] = response

        threads = [threading.Thread(target=call, args=(n,)) for n in ("slow", "fast")]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual((got["slow"].request_id, got["slow"].rate_remaining), ("req_slow", 9))
        self.assertEqual((got["fast"].request_id, got["fast"].rate_remaining), ("req_fast", 8))
        self.assertEqual(o.last.request_id, "req_slow")

    def test_with_response_sees_only_its_own_client_and_refusals(self):
        self.api.answers = [ok({}, **{"X-Request-Id": "req_a"}), fail(403, "FORBIDDEN", "no", **{"X-Request-Id": "req_b"})]
        a, b = self.client(), self.client()
        with a.with_response() as response:
            a.whoami()
            with self.assertRaises(OmazyError):
                b.whoami()
        self.assertEqual(response.request_id, "req_a")
        self.assertEqual(b.last.request_id, "req_b")

    def test_a_stream_error_carries_its_own_request_id(self):
        self.api.answers = [(200, {"X-Request-Id": "req_s1"}, [b'event: error\ndata: {"code":"UPSTREAM_REJECTED","message":"no"}\n\n'])]
        o = self.client()
        # Another thread's response replaces last as soon as this one lands.
        other = lambda c, info: setattr(c, "last", ResponseInfo(request_id="someone_else"))  # noqa: E731
        with mock.patch.object(omazy_client, "_record", other), self.assertRaises(OmazyError) as cm:
            list(o.ai.stream([{"role": "user", "content": "x"}]))
        self.assertEqual((cm.exception.code, cm.exception.request_id), ("UPSTREAM_REJECTED", "req_s1"))

    def test_speak_returns_audio_and_language(self):
        self.api.answers = [(200, {"Content-Type": "audio/wav", "X-Omazy-Speech-Lang": "bn"}, b"RIFFdata")]
        audio, lang = self.client().voice.speak("hello")
        self.assertEqual((audio, lang), (b"RIFFdata", "bn"))


class RetryTest(Base):
    def test_a_rate_limited_read_is_sent_again_after_retry_after(self):
        self.api.answers = [fail(429, "RATE_LIMIT_EXCEEDED", "slow down", **{"Retry-After": "2"}), fail(503, "UPSTREAM_UNAVAILABLE", "busy"), ok({"passages": [{"title": "t"}]})]
        self.assertEqual(len(self.client().knowledge.search("q")), 1)
        self.assertEqual(len(self.api.seen), 3)
        self.assertEqual(self.slept[0], 2)

    def test_placing_a_call_is_never_sent_twice(self):
        self.api.answers = [fail(503, "UPSTREAM_UNAVAILABLE", "busy")]
        with self.assertRaises(OmazyError):
            self.client().voice.calls.place("+8801712345678", "reminder", "customer")
        self.assertEqual(len(self.api.seen), 1)

    def test_a_full_window_is_handed_back_not_waited_out(self):
        self.api.answers = [fail(429, "RATE_LIMIT_EXCEEDED", "slow down", **{"Retry-After": "540"})]
        with self.assertRaises(OmazyError) as cm:
            self.client().whoami()
        self.assertEqual((cm.exception.status, cm.exception.retry_after), (429, 540))
        self.assertEqual((len(self.api.seen), self.slept), (1, []))

    def test_a_400_is_not_retried(self):
        self.api.answers = [fail(400, "BAD_REQUEST", "messages is required")]
        with self.assertRaises(OmazyError):
            self.client().ai.complete([])
        self.assertEqual(len(self.api.seen), 1)

    def test_no_server_is_a_network_error_after_retries(self):
        o = Omazy("cai_abc.def", base_url="http://127.0.0.1:9/core", sleep=self.slept.append, max_retries=1, timeout=2)
        with self.assertRaises(OmazyError) as cm:
            o.whoami()
        self.assertEqual((cm.exception.status, cm.exception.code), (0, "NETWORK_ERROR"))
        self.assertEqual(len(self.slept), 1)


def header(seen, name):
    """A request header by name, whatever case it was sent in."""
    return next((v for k, v in seen["headers"].items() if k.lower() == name.lower()), None)


class IdempotencyTest(Base):
    def test_the_routes_that_take_a_key_are_the_ones_the_contract_marks(self):
        contract = json.loads(CONTRACT.read_text())
        want = {r["sdk"] for r in contract["routes"] if r.get("idempotency_key")}
        self.assertEqual(set(IDEMPOTENT), want)
        self.assertFalse(IDEMPOTENT & RETRYABLE)

    def test_a_call_placed_with_a_key_is_sent_again_with_the_same_key(self):
        self.api.answers = [fail(503, "UPSTREAM_UNAVAILABLE", "busy"), ok({"ref": "r1"}, **{"Idempotent-Replayed": "true"})]
        o = self.client()
        res = o.voice.calls.place("+8801712345678", "reminder", "customer", idempotency_key="visit-77")
        self.assertEqual(res["ref"], "r1")
        self.assertEqual([header(s, "Idempotency-Key") for s in self.api.seen], ["visit-77", "visit-77"])
        self.assertTrue(o.last.replayed)
        # The key travels in the header and never in the body.
        self.assertNotIn("idempotency_key", json.loads(self.api.seen[0]["body"]))

    def test_a_repeat_while_the_first_still_runs_waits_and_asks_again(self):
        self.api.answers = [fail(409, "IDEMPOTENCY_IN_PROGRESS", "still running", **{"Retry-After": "2"}), ok({"text": "hi"})]
        self.assertEqual(self.client().agent.turn("hi", idempotency_key="turn-1")["text"], "hi")
        self.assertEqual((len(self.api.seen), self.slept), (2, [2]))

    def test_a_key_used_with_another_request_is_reported_not_retried(self):
        self.api.answers = [fail(422, "IDEMPOTENCY_KEY_REUSED", "used with a different request")]
        with self.assertRaises(OmazyError) as cm:
            self.client().voice.calls.place("+8801712345678", "reminder", "customer", idempotency_key="visit-77")
        self.assertEqual((cm.exception.status, cm.exception.code), (422, "IDEMPOTENCY_KEY_REUSED"))
        self.assertEqual(len(self.api.seen), 1)

    def test_without_a_key_nothing_is_added_and_nothing_is_repeated(self):
        self.api.answers = [fail(409, "IDEMPOTENCY_IN_PROGRESS", "still running")]
        with self.assertRaises(OmazyError):
            self.client().conversations.post_message("s1", [{"type": "text", "markdown": "hi"}])
        self.assertEqual(len(self.api.seen), 1)
        self.assertIsNone(header(self.api.seen[0], "Idempotency-Key"))

    def test_every_route_that_takes_a_key_sends_it(self):
        self.api.answers = [ok({})]
        o = self.client()
        k = {"idempotency_key": "k1"}
        o.knowledge.documents.create("t", "c", **k)
        o.knowledge.import_file(b"\x01", "a.pdf", **k)
        o.knowledge.sources.create("https://x.test", **k)
        o.knowledge.sources.crawl("c1", **k)
        o.agent.turn("hi", **k)
        o.agent.mcp_servers.create("a", "https://a.test/mcp", "none", **k)
        o.voice.calls.place("+8801712345678", "reminder", "customer", **k)
        o.voice.jobs.create("transcribe", source_url="https://x.test/a.mp3", **k)
        o.conversations.post_message("s1", [{"type": "text", "markdown": "hi"}], **k)
        o.channels.linkedin_publish("hi", **k)
        self.assertEqual(len(self.api.seen), len(IDEMPOTENT))
        for s in self.api.seen:
            self.assertEqual(header(s, "Idempotency-Key"), "k1", s["path"])

    def test_a_voice_job_names_its_app_in_the_query(self):
        self.api.answers = [ok({"id": "j1"})]
        self.client(app="nordwell").voice.jobs.create("transcribe", source_url="https://x.test/a.mp3")
        self.assertIn("app=nordwell", self.api.seen[0]["path"])
        self.assertEqual(json.loads(self.api.seen[0]["body"]), {"kind": "transcribe", "source_url": "https://x.test/a.mp3"})


class StreamTest(Base):
    def test_frames_and_characters_split_across_chunks(self):
        whole = 'event: delta\ndata: {"text":"নমস্কার"}\n\nevent: delta\ndata: {"text":" world"}\n\nevent: done\ndata: {"text":"নমস্কার world","stop_reason":"stop","model":"m","usage":{}}\n\n'.encode()
        self.api.answers = [(200, {}, [whole[:31], whole[31:70], whole[70:]])]
        events = list(self.client().ai.stream([{"role": "user", "content": "hi"}]))
        self.assertEqual([e["text"] for e in events if e["type"] == "delta"], ["নমস্কার", " world"])
        self.assertEqual(events[-1], {"type": "done", "result": {"text": "নমস্কার world", "stop_reason": "stop", "model": "m", "usage": {}}})
        self.assertTrue(json.loads(self.api.seen[0]["body"])["stream"])

    def test_an_error_frame_is_raised(self):
        self.api.answers = [(200, {}, [b'event: delta\ndata: {"text":"a"}\n\nevent: error\ndata: {"message":"the workspace\'s AI budget is spent"}\n\n'])]
        with self.assertRaises(OmazyError) as cm:
            list(self.client().ai.stream([{"role": "user", "content": "hi"}]))
        self.assertEqual((cm.exception.code, cm.exception.message), ("STREAM_ERROR", "the workspace's AI budget is spent"))

    def test_a_stream_that_stops_before_done_is_an_error(self):
        self.api.answers = [(200, {}, [b'event: delta\ndata: {"text":"half"}\n\n'])]
        with self.assertRaises(OmazyError) as cm:
            list(self.client().ai.stream([{"role": "user", "content": "hi"}]))
        self.assertEqual(cm.exception.code, "STREAM_ERROR")

    def test_an_agent_turn_streams_and_ends_with_the_whole_turn(self):
        frames = b'event: delta\ndata: {"text":"Good "}\n\nevent: delta\ndata: {"text":"morning."}\n\nevent: done\ndata: {"session_id":"s1","text":"Good morning.","sources":0,"usage":{}}\n\n'
        self.api.answers = [(200, {}, [frames])]
        events = list(self.client().agent.stream("hello", context={"interaction": "voice"}))
        self.assertEqual([e["text"] for e in events if e["type"] == "delta"], ["Good ", "morning."])
        self.assertEqual(events[-1]["result"]["text"], "Good morning.")
        self.assertTrue(self.api.seen[0]["path"].endswith("/agent/turn"))
        body = json.loads(self.api.seen[0]["body"])
        self.assertEqual((body["stream"], body["message"], body["context"]), (True, "hello", {"interaction": "voice"}))


class McpTest(Base):
    def test_lists_tools_and_calls_one(self):
        self.api.answers = [rpc({"tools": [{"name": "knowledge_search", "inputSchema": {}}]}), rpc({"content": [{"type": "text", "text": '{"passages":[]}'}], "structuredContent": {"passages": []}, "isError": False})]
        o = self.client()
        self.assertEqual([t["name"] for t in o.mcp.list_tools()], ["knowledge_search"])
        self.assertEqual(o.mcp.call_tool("knowledge_search", {"query": "hours"}), {"text": '{"passages":[]}', "data": {"passages": []}, "is_error": False})
        sent = json.loads(self.api.seen[1]["body"])
        self.assertEqual((sent["method"], sent["params"]), ("tools/call", {"name": "knowledge_search", "arguments": {"query": "hours"}}))
        self.assertEqual(self.api.seen[1]["path"], "/core/mcp")

    def test_a_tool_refusal_is_returned_and_an_unknown_tool_is_raised(self):
        self.api.answers = [rpc({"content": [{"type": "text", "text": "BAD_REQUEST: query is required"}], "isError": True}), rpc(error={"code": -32602, "message": "Unknown tool: nope"})]
        o = self.client()
        self.assertTrue(o.mcp.call_tool("knowledge_search")["is_error"])
        with self.assertRaises(OmazyError) as cm:
            o.mcp.call_tool("nope")
        self.assertEqual(cm.exception.code, "MCP_-32602")

    def test_config_hands_the_server_to_another_mcp_client(self):
        self.assertEqual(self.client().mcp.config(), {"type": "http", "url": self.api.base + "/mcp", "headers": {"Authorization": "Bearer cai_abc.def"}})


class SignatureTest(unittest.TestCase):
    def test_a_signature_verifies_over_the_exact_body_and_nothing_else(self):
        header = sign("s3cret", '{"a":1}')
        self.assertEqual(header, "sha256=" + SIG_VECTOR)
        self.assertTrue(verify_signature("s3cret", b'{"a":1}', header))
        self.assertFalse(verify_signature("s3cret", '{"a": 1}', header))
        self.assertFalse(verify_signature("other", '{"a":1}', header))
        self.assertFalse(verify_signature("s3cret", '{"a":1}', None))
        self.assertFalse(verify_signature("", '{"a":1}', header))


if __name__ == "__main__":
    unittest.main()
