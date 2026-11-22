import base64
import hashlib
import json
import pathlib
import socketserver
import struct
import sys
import threading
import unittest
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))

from omazy import Omazy, OmazyError  # noqa: E402

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class FakeStream:
    """A WebSocket server on a free port that plays the Core API's side of
    GET /voice/transcribe/stream. ``script(msg)`` returns the frames to send
    back for each text frame after the start frame."""

    def __init__(self, script):
        self.script = script
        self.seen = {"path": None, "auth": None, "start": None, "audio": [], "texts": []}
        outer = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                outer.serve(self.request)

        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/core"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def serve(self, sock):
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += sock.recv(4096)
        head, buf = buf.split(b"\r\n\r\n", 1)
        lines = head.decode().split("\r\n")
        headers = {k.strip().lower(): v.strip() for k, _, v in (l.partition(":") for l in lines[1:])}
        self.seen["path"] = lines[0].split(" ")[1]
        self.seen["auth"] = headers.get("authorization")
        if self.seen["auth"] != "Bearer cai_abc.def":
            body = json.dumps({"success": False, "error": {"code": "UNAUTHORIZED", "message": "bad token"}}).encode()
            sock.sendall(b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nX-Request-Id: req_401\r\nContent-Length: "
                         + str(len(body)).encode() + b"\r\n\r\n" + body)
            sock.close()
            return
        accept = base64.b64encode(hashlib.sha1(headers["sec-websocket-key"].encode() + GUID).digest()).decode()
        sock.sendall(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        state = {"buf": buf}

        def exact(n):
            while len(state["buf"]) < n:
                chunk = sock.recv(65536)
                if not chunk:
                    raise EOFError
                state["buf"] += chunk
            out, state["buf"] = state["buf"][:n], state["buf"][n:]
            return out

        def send(frame, opcode=1):
            data = json.dumps(frame).encode() if opcode == 1 else frame
            n = len(data)
            hdr = bytes([0x80 | opcode]) + (bytes([n]) if n < 126 else bytes([126]) + struct.pack("!H", n))
            sock.sendall(hdr + data)

        try:
            while True:
                b0, b1 = exact(2)
                assert b1 & 0x80, "a client frame must be masked"
                n = b1 & 0x7F
                if n == 126:
                    n = struct.unpack("!H", exact(2))[0]
                elif n == 127:
                    n = struct.unpack("!Q", exact(8))[0]
                mask = exact(4)
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(exact(n)))
                opcode = b0 & 0x0F
                if opcode == 8:
                    return
                if opcode == 10:
                    self.seen["pong"] = payload
                    continue
                if opcode == 2:
                    self.seen["audio"].append(len(payload))
                    send({"type": "partial", "text": "hel", "language": "en"})
                    continue
                msg = json.loads(payload)
                self.seen["texts"].append(msg)
                if msg["type"] == "start":
                    self.seen["start"] = msg
                    send(b"hi", 9)  # a ping the client must answer
                    send({"type": "ready", "request_id": "req_1"})
                    continue
                for frame in self.script(msg):
                    if frame == "close":
                        sock.sendall(b"\x88\x02\x03\xe8")
                        return
                    send(frame)
        except (EOFError, OSError):
            pass
        finally:
            sock.close()


class TranscribeStreamTest(unittest.TestCase):
    def test_hold_to_talk(self):
        def script(msg):
            if msg["type"] == "commit":
                return [{"type": "final", "text": "Rashed Karim", "language": "en", "committed": True}]
            if msg["type"] == "end":
                return [{"type": "done", "text": "Rashed Karim", "language": "en", "audio_ms": 1200, "request_id": "req_1"}, "close"]
            return []

        api = FakeStream(script)
        self.addCleanup(api.stop)
        seen_events = []
        o = Omazy("cai_abc.def", base_url=api.base, app="kiosk")
        with o.voice.transcribe_stream(language="bn", terms=["Rashed Karim"], audio_format="pcm_s16le",
                                       sample_rate=16000, on_event=seen_events.append) as s:
            s.send(b"\x00" * 640)
            s.send(b"\x00" * 70000)  # takes the 64-bit length form
            final = s.commit()
            self.assertEqual(final["text"], "Rashed Karim")
            self.assertTrue(final["committed"])
            s.keepalive()
            done = s.end()
            self.assertEqual(done["audio_ms"], 1200)
            self.assertEqual(done["text"], "Rashed Karim")
            self.assertEqual(s.request_id, "req_1")
            self.assertEqual([e["type"] for e in s.events(timeout=2)], ["ready", "partial", "partial", "final", "done"])

        q = urllib.parse.urlsplit(api.seen["path"])
        self.assertEqual(q.path, "/core/voice/transcribe/stream")
        self.assertEqual(urllib.parse.parse_qs(q.query), {"app": ["kiosk"]})
        self.assertEqual(api.seen["auth"], "Bearer cai_abc.def")
        self.assertEqual(api.seen["start"], {"type": "start", "language": "bn", "terms": ["Rashed Karim"],
                                             "audio_format": "pcm_s16le", "sample_rate": 16000})
        self.assertEqual(api.seen["audio"], [640, 70000])
        self.assertEqual(api.seen["pong"], b"hi")
        self.assertEqual([t["type"] for t in api.seen["texts"]], ["start", "commit", "keepalive", "end"])
        self.assertEqual([e["type"] for e in seen_events], ["ready", "partial", "partial", "final", "done"])

    def test_an_error_frame_is_an_omazy_error(self):
        api = FakeStream(lambda msg: [{"type": "error", "code": "UPSTREAM_UNAVAILABLE",
                                        "message": "speech recognition stopped", "request_id": "req_9"}, "close"]
                         if msg["type"] == "end" else [])
        self.addCleanup(api.stop)
        s = Omazy("cai_abc.def", base_url=api.base).voice.transcribe_stream()
        with self.assertRaises(OmazyError) as cm:
            s.end(timeout=5)
        self.assertEqual(cm.exception.code, "UPSTREAM_UNAVAILABLE")
        self.assertEqual(cm.exception.request_id, "req_9")
        self.assertEqual(api.seen["start"], {"type": "start"})
        with self.assertRaises(OmazyError):
            list(s.events(timeout=2))

    def test_a_refused_upgrade_carries_the_api_error(self):
        api = FakeStream(lambda msg: [])
        self.addCleanup(api.stop)
        with self.assertRaises(OmazyError) as cm:
            Omazy("cai_abc.bad", base_url=api.base).voice.transcribe_stream()
        self.assertEqual((cm.exception.status, cm.exception.code, cm.exception.request_id), (401, "UNAUTHORIZED", "req_401"))


if __name__ == "__main__":
    unittest.main()
