"""Live speech to text over a WebSocket. Standard library only.

A small RFC 6455 client: enough for one session of
``GET /voice/transcribe/stream`` (text and binary frames, ping, close), with
the install token sent on the upgrade.
"""

import base64
import hashlib
import json
import os
import queue
import socket
import ssl
import struct
import threading
import urllib.parse
from typing import Any, Callable, Dict, Iterator, List, Optional

from .errors import OmazyError

Json = Dict[str, Any]

_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_TEXT, _BINARY, _CLOSE, _PING, _PONG, _CONT = 0x1, 0x2, 0x8, 0x9, 0xA, 0x0


def _accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1(key.encode() + _GUID).digest()).decode()


class _Socket:
    """One client WebSocket on a blocking socket."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._wlock = threading.Lock()
        self._buf = b""

    @classmethod
    def connect(cls, url: str, headers: Dict[str, str], timeout: float) -> "_Socket":
        u = urllib.parse.urlsplit(url)
        secure = u.scheme in ("wss", "https")
        host = u.hostname or ""
        port = u.port or (443 if secure else 80)
        try:
            raw = socket.create_connection((host, port), timeout=timeout)
            if secure:
                raw = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        except OSError as e:
            raise OmazyError(f"no response from the Core API: {e}", 0, "NETWORK_ERROR") from None
        ws = cls(raw)
        key = base64.b64encode(os.urandom(16)).decode()
        target = (u.path or "/") + (f"?{u.query}" if u.query else "")
        host_header = host if u.port is None else f"{host}:{port}"
        lines = [
            f"GET {target} HTTP/1.1",
            f"Host: {host_header}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ] + [f"{k}: {v}" for k, v in headers.items()]
        raw.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        status, resp_headers, body = ws._read_response()
        if status != 101:
            raw.close()
            raise _refusal(status, resp_headers, body)
        if resp_headers.get("sec-websocket-accept") != _accept_key(key):
            raw.close()
            raise OmazyError("the server answered the upgrade with the wrong accept key", status, "NETWORK_ERROR")
        raw.settimeout(None)
        return ws

    def _read_response(self):
        while b"\r\n\r\n" not in self._buf:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise OmazyError("the connection closed during the upgrade", 0, "NETWORK_ERROR")
            self._buf += chunk
        head, self._buf = self._buf.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        try:
            status = int(lines[0].split(" ")[1])
        except (IndexError, ValueError):
            raise OmazyError("the server did not answer the upgrade", 0, "NETWORK_ERROR") from None
        headers = {}
        for line in lines[1:]:
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
        body = b""
        if status != 101:
            n = int(headers.get("content-length", "0") or 0)
            body = self._buf
            while len(body) < n:
                chunk = self._sock.recv(4096)
                if not chunk:
                    break
                body += chunk
        return status, headers, body

    def _exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise EOFError
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def write(self, opcode: int, payload: bytes) -> None:
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 1 << 16:
            header += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack("!Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self._wlock:
            self._sock.sendall(header + mask + masked)

    def read(self):
        """One whole message: (opcode, payload). Pings are answered here."""
        message, first = b"", None
        while True:
            b0, b1 = self._exact(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._exact(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._exact(8))[0]
            mask = self._exact(4) if b1 & 0x80 else None
            payload = self._exact(n)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == _PING:
                self.write(_PONG, payload)
                continue
            if opcode == _PONG:
                continue
            if opcode == _CLOSE:
                return _CLOSE, payload
            if opcode != _CONT:
                first = opcode
            message += payload
            if fin:
                return first, message

    def close(self, code: int = 1000) -> None:
        try:
            self.write(_CLOSE, struct.pack("!H", code))
        except OSError:
            pass
        try:
            self._sock.close()
        except OSError:
            pass


def _refusal(status: int, headers: Dict[str, str], body: bytes) -> OmazyError:
    code, message = f"HTTP_{status}", body.decode("utf-8", "replace")[:300] or f"the upgrade was answered with {status}"
    try:
        err = json.loads(body).get("error")
        if isinstance(err, dict):
            code = err.get("code") or code
            message = err.get("message") or message
    except (ValueError, AttributeError):
        pass
    return OmazyError(message, status, code, headers.get("x-request-id"))


class TranscriptionSession:
    """One live transcription.

    Send audio as it is captured with ``send``; ``commit()`` after each
    utterance (a button let go) returns its final; ``end()`` finishes the
    session and returns every final joined. ``events()`` yields every frame
    from Omazy in order: ``ready``, ``partial``, ``final`` and ``done``.
    """

    def __init__(self, ws: _Socket, on_event: Optional[Callable[[Json], None]] = None) -> None:
        self._ws = ws
        self._on_event = on_event
        self._events: "queue.Queue[Optional[Json]]" = queue.Queue()
        self._cond = threading.Condition()
        self._commits: List[Json] = []
        self._done: Optional[Json] = None
        self._failure: Optional[OmazyError] = None
        self._closed = False
        #: The request id of the session, from its ``ready`` frame.
        self.request_id: Optional[str] = None
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def send(self, audio: bytes) -> None:
        """Audio, in the format the session was opened with."""
        self._ws.write(_BINARY, bytes(audio))

    def commit(self, timeout: float = 30.0) -> Json:
        """End the current utterance and keep the session open. Returns its final, whose text may be empty."""
        with self._cond:
            want = len(self._commits) + 1
            self._ws.write(_TEXT, b'{"type":"commit"}')
            self._wait(lambda: len(self._commits) >= want, timeout, "commit")
            return self._commits[want - 1]

    def keepalive(self) -> None:
        """Hold the session while no audio flows. Omazy closes a session silent for 60 s."""
        self._ws.write(_TEXT, b'{"type":"keepalive"}')

    def end(self, timeout: float = 30.0) -> Json:
        """No more audio. Returns the ``done`` frame: ``text``, ``language``, ``audio_ms``."""
        with self._cond:
            self._ws.write(_TEXT, b'{"type":"end"}')
            self._wait(lambda: self._done is not None, timeout, "end")
            return self._done  # type: ignore[return-value]

    def close(self) -> None:
        """Close the socket without waiting for an answer."""
        self._ws.close()

    def events(self, timeout: Optional[float] = None) -> Iterator[Json]:
        """Every frame from Omazy, in order. Stops after ``done``; raises OmazyError on an ``error`` frame."""
        while True:
            try:
                e = self._events.get(timeout=timeout)
            except queue.Empty:
                raise OmazyError("no frame from the session in time", 0, "STREAM_ERROR", self.request_id) from None
            if e is None:
                if self._failure:
                    raise self._failure
                return
            yield e

    def __enter__(self) -> "TranscriptionSession":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def _wait(self, ok: Callable[[], bool], timeout: float, what: str) -> None:
        if not self._cond.wait_for(lambda: ok() or self._failure is not None or self._closed, timeout):
            raise OmazyError(f"no answer to {what} in {timeout:g} s", 0, "STREAM_ERROR", self.request_id)
        if ok():
            return
        if self._failure:
            raise self._failure
        raise OmazyError("the session closed before it was done", 0, "STREAM_ERROR", self.request_id)

    def _read(self) -> None:
        try:
            while True:
                opcode, payload = self._ws.read()
                if opcode == _CLOSE:
                    break
                if opcode != _TEXT:
                    continue
                try:
                    e = json.loads(payload)
                except ValueError:
                    continue
                if self._dispatch(e):
                    break
        except (EOFError, OSError):
            pass
        finally:
            with self._cond:
                self._closed = True
                self._cond.notify_all()
            self._events.put(None)

    def _dispatch(self, e: Json) -> bool:
        """Handles one frame; True when the session is over."""
        kind = e.get("type")
        if kind == "ready":
            self.request_id = e.get("request_id")
        if self._on_event:
            self._on_event(e)
        if kind == "error":
            with self._cond:
                self._failure = OmazyError(
                    e.get("message") or "the session failed", 0, e.get("code") or "STREAM_ERROR",
                    e.get("request_id") or self.request_id,
                )
                self._cond.notify_all()
            return True
        self._events.put(e)
        with self._cond:
            if kind == "final" and e.get("committed"):
                self._commits.append(e)
            if kind == "done":
                self._done = e
            self._cond.notify_all()
        return kind == "done"


def open_transcription(
    url: str, headers: Dict[str, str], start: Json, timeout: float, on_event: Optional[Callable[[Json], None]] = None
) -> TranscriptionSession:
    ws = _Socket.connect(url, headers, timeout)
    session = TranscriptionSession(ws, on_event)
    ws.write(_TEXT, json.dumps(start).encode())
    return session
