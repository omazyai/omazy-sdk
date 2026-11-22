package omazy

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// streamSeen is what the fake stream server was sent.
type streamSeen struct {
	mu    sync.Mutex
	path  string
	auth  string
	start map[string]any
	audio []int
	texts []string
	pong  string
}

// fakeStream is a WebSocket server playing the Core API's side of
// GET /voice/transcribe/stream. script answers each text frame after start.
func fakeStream(t *testing.T, script func(msg map[string]any) []string) (*streamSeen, *Client) {
	t.Helper()
	seen := &streamSeen{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.mu.Lock()
		seen.path, seen.auth = r.URL.RequestURI(), r.Header.Get("Authorization")
		seen.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer cai_abc.def" {
			fail(401, "UNAUTHORIZED", "bad token", "X-Request-Id", "req_401")(w, r)
			return
		}
		if r.Header.Get("Upgrade") != "websocket" {
			w.WriteHeader(426)
			return
		}
		conn, brw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
			acceptKey(r.Header.Get("Sec-WebSocket-Key")) + "\r\n\r\n")
		_ = brw.Flush()
		serveStream(conn, brw.Reader, seen, script)
	}))
	t.Cleanup(srv.Close)
	return seen, New("cai_abc.def", WithBaseURL(srv.URL+"/core"), WithApp("kiosk"))
}

func serveStream(conn net.Conn, br *bufio.Reader, seen *streamSeen, script func(map[string]any) []string) {
	send := func(op byte, b []byte) {
		hdr := []byte{0x80 | op}
		if len(b) < 126 {
			hdr = append(hdr, byte(len(b)))
		} else {
			hdr = append(hdr, 126, byte(len(b)>>8), byte(len(b)))
		}
		_, _ = conn.Write(append(hdr, b...))
	}
	for {
		var h [2]byte
		if _, err := io.ReadFull(br, h[:]); err != nil {
			return
		}
		if h[1]&0x80 == 0 {
			panic("a client frame must be masked")
		}
		n := uint64(h[1] & 0x7F)
		if n == 126 {
			var b [2]byte
			_, _ = io.ReadFull(br, b[:])
			n = uint64(binary.BigEndian.Uint16(b[:]))
		} else if n == 127 {
			var b [8]byte
			_, _ = io.ReadFull(br, b[:])
			n = binary.BigEndian.Uint64(b[:])
		}
		var mask [4]byte
		_, _ = io.ReadFull(br, mask[:])
		p := make([]byte, n)
		if _, err := io.ReadFull(br, p); err != nil {
			return
		}
		for i := range p {
			p[i] ^= mask[i%4]
		}
		switch h[0] & 0x0F {
		case opClose:
			return
		case opPong:
			seen.mu.Lock()
			seen.pong = string(p)
			seen.mu.Unlock()
			continue
		case opBinary:
			seen.mu.Lock()
			seen.audio = append(seen.audio, len(p))
			seen.mu.Unlock()
			send(opText, []byte(`{"type":"partial","text":"hel","language":"en"}`))
			continue
		}
		var msg map[string]any
		_ = json.Unmarshal(p, &msg)
		seen.mu.Lock()
		seen.texts = append(seen.texts, msg["type"].(string))
		if msg["type"] == "start" {
			seen.start = msg
		}
		seen.mu.Unlock()
		if msg["type"] == "start" {
			send(opPing, []byte("hi"))
			send(opText, []byte(`{"type":"ready","request_id":"req_1"}`))
			continue
		}
		for _, f := range script(msg) {
			if f == "close" {
				send(opClose, []byte{0x03, 0xe8})
				return
			}
			send(opText, []byte(f))
		}
	}
}

func TestTranscribeStreamHoldToTalk(t *testing.T) {
	seen, c := fakeStream(t, func(msg map[string]any) []string {
		switch msg["type"] {
		case "commit":
			return []string{`{"type":"final","text":"Rashed Karim","language":"en","committed":true}`}
		case "end":
			return []string{`{"type":"done","text":"Rashed Karim","language":"en","audio_ms":1200,"request_id":"req_1"}`, "close"}
		}
		return nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := c.Voice.TranscribeStream(ctx, TranscribeStreamOptions{Language: "bn", Terms: []string{"Rashed Karim"}, AudioFormat: "pcm_s16le", SampleRate: 16000})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Send(make([]byte, 640)); err != nil {
		t.Fatal(err)
	}
	_ = s.Send(make([]byte, 70000)) // the 64-bit length form
	fin, err := s.Commit(ctx)
	if err != nil || fin.Text != "Rashed Karim" || !fin.Committed {
		t.Fatalf("commit = %+v, %v", fin, err)
	}
	_ = s.KeepAlive()
	done, err := s.End(ctx)
	if err != nil || done.Text != "Rashed Karim" || done.AudioMs != 1200 || done.Language != "en" {
		t.Fatalf("end = %+v, %v", done, err)
	}
	if s.RequestID() != "req_1" {
		t.Fatalf("request id %q", s.RequestID())
	}
	var types []string
	for e := range s.Events() {
		types = append(types, e.Type)
	}
	if strings.Join(types, ",") != "ready,partial,partial,final,done" {
		t.Fatalf("events %v", types)
	}
	seen.mu.Lock()
	defer seen.mu.Unlock()
	if seen.path != "/core/voice/transcribe/stream?app=kiosk" || seen.auth != "Bearer cai_abc.def" {
		t.Fatalf("upgrade %s %s", seen.path, seen.auth)
	}
	want := map[string]any{"type": "start", "language": "bn", "terms": []any{"Rashed Karim"}, "audio_format": "pcm_s16le", "sample_rate": float64(16000)}
	if !reflect.DeepEqual(seen.start, want) {
		t.Fatalf("start %v", seen.start)
	}
	if !reflect.DeepEqual(seen.audio, []int{640, 70000}) || strings.Join(seen.texts, ",") != "start,commit,keepalive,end" || seen.pong != "hi" {
		t.Fatalf("audio %v texts %v pong %q", seen.audio, seen.texts, seen.pong)
	}
}

func TestTranscribeStreamErrorFrame(t *testing.T) {
	_, c := fakeStream(t, func(msg map[string]any) []string {
		if msg["type"] == "end" {
			return []string{`{"type":"error","code":"UPSTREAM_UNAVAILABLE","message":"speech recognition stopped","request_id":"req_9"}`, "close"}
		}
		return nil
	})
	s, err := c.Voice.TranscribeStream(ctx, TranscribeStreamOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.End(ctx)
	var e *Error
	if !errors.As(err, &e) || e.Code != "UPSTREAM_UNAVAILABLE" || e.RequestID != "req_9" {
		t.Fatalf("err = %v", err)
	}
}

func TestTranscribeStreamRefusedUpgrade(t *testing.T) {
	_, c := fakeStream(t, func(map[string]any) []string { return nil })
	c.token = "cai_abc.bad"
	_, err := c.Voice.TranscribeStream(ctx, TranscribeStreamOptions{})
	var e *Error
	if !errors.As(err, &e) || e.Status != 401 || e.Code != "UNAUTHORIZED" || e.RequestID != "req_401" {
		t.Fatalf("err = %v", err)
	}
}

func TestTranscribeSendsTermsAsOneParameter(t *testing.T) {
	f, c := newFake(t, ok(`{"text":"hi","language":"en"}`))
	if _, _, err := c.Voice.Transcribe(ctx, []byte{1}, "en", "", "Rashed Karim", "Joya"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.seen[0].path, "terms=Rashed+Karim%2CJoya") {
		t.Fatalf("path %s", f.seen[0].path)
	}
}

func TestTheWebSocketRoutesAreTheOnesTheContractMarks(t *testing.T) {
	var contract struct {
		Routes []struct {
			SDK       string `json:"sdk"`
			WebSocket bool   `json:"websocket"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(readContract(t), &contract); err != nil {
		t.Fatal(err)
	}
	var want, got []string
	for _, r := range contract.Routes {
		if r.WebSocket {
			want = append(want, r.SDK)
		}
	}
	for name := range websocket {
		got = append(got, name)
		if retryable[name] || idempotent[name] {
			t.Errorf("%s is a WebSocket and must not be retried", name)
		}
	}
	sort.Strings(want)
	sort.Strings(got)
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("websocket routes %v, the contract says %v", got, want)
	}
}
