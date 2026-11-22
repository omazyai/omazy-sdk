package omazy

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// Live speech to text over a WebSocket (GET /voice/transcribe/stream), with a
// small RFC 6455 client: the handshake goes through net/http, whose 101
// response body is the connection.

// TranscribeStreamOptions opens a live transcription.
type TranscribeStreamOptions struct {
	// Language is the language to expect first, "en" or "bn"; the other is still heard.
	Language string
	// Terms are names and words to expect, such as staff names. At most 200
	// of at most 100 bytes.
	Terms []string
	// AudioFormat is "auto" (WebM/Opus, Ogg or WAV, the default), "pcm_s16le",
	// "mulaw" or "alaw".
	AudioFormat string
	// SampleRate is required for raw audio: 8000 to 48000.
	SampleRate int
	// NumChannels is 1 or 2 for raw audio; default 1.
	NumChannels int
	App         string
}

// TranscriptEvent is one frame from Omazy: ready, partial, final, done or error.
type TranscriptEvent struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Language string `json:"language,omitempty"`
	// Committed is set on the final that answers Commit; its text may be empty.
	Committed bool `json:"committed,omitempty"`
	// AudioMs is on done: the audio length the session is billed by.
	AudioMs   int    `json:"audio_ms,omitempty"`
	RequestID string `json:"request_id,omitempty"`
	// Code and Message are on error.
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

// TranscriptionSession is one live transcription. Send audio as it is
// captured; Commit after each utterance (a button let go) returns its final;
// End finishes the session and returns every final joined.
type TranscriptionSession struct {
	conn io.ReadWriteCloser
	br   *bufio.Reader
	wmu  sync.Mutex

	events  chan TranscriptEvent
	commits chan TranscriptEvent
	done    chan TranscriptEvent
	over    chan struct{} // closed when the reader stops

	mu        sync.Mutex
	err       error
	requestID string
}

// TranscribeStream opens a live transcription and sends its start frame.
// ctx bounds the whole session: cancelling it closes the socket. Server side
// only: the token goes on the upgrade. Never retried. Needs voice:speech.
//
//	s, err := c.Voice.TranscribeStream(ctx, omazy.TranscribeStreamOptions{
//		Language: "bn", Terms: []string{"Rashed Karim"}, AudioFormat: "pcm_s16le", SampleRate: 16000})
//	for chunk := range mic { s.Send(chunk) }
//	done, err := s.End(ctx)
func (s *VoiceService) TranscribeStream(ctx context.Context, opts TranscribeStreamOptions) (*TranscriptionSession, error) {
	c := s.c
	if c.token == "" {
		return nil, errors.New("omazy: token is required")
	}
	target := c.base + routes["voice.transcribe_stream"].path
	if app := c.appOr(opts.App); app != "" {
		target += "?" + url.Values{"app": {app}}.Encode()
	}
	key := make([]byte, 16)
	_, _ = rand.Read(key)
	nonce := base64.StdEncoding.EncodeToString(key)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("User-Agent", "omazy-sdk-go/"+Version)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", nonce)
	// The client's own timeout would end the session mid-stream: it covers
	// reading the body, and here the body is the session. ctx bounds it.
	hc := &http.Client{Transport: c.http.Transport, CheckRedirect: c.http.CheckRedirect, Jar: c.http.Jar}
	res, err := hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &Error{Code: "NETWORK_ERROR", Message: "no response from the Core API: " + err.Error()}
	}
	info := readInfo(res.Header)
	c.mu.Lock()
	c.last = info
	c.mu.Unlock()
	if res.StatusCode != http.StatusSwitchingProtocols {
		defer res.Body.Close()
		return nil, readError(res, info.RequestID)
	}
	conn, ok := res.Body.(io.ReadWriteCloser)
	if !ok || res.Header.Get("Sec-Websocket-Accept") != acceptKey(nonce) {
		res.Body.Close()
		return nil, &Error{Status: res.StatusCode, Code: "NETWORK_ERROR", Message: "the server did not complete the WebSocket upgrade", RequestID: info.RequestID}
	}
	t := &TranscriptionSession{
		conn: conn, br: bufio.NewReader(conn),
		events: make(chan TranscriptEvent, 256), commits: make(chan TranscriptEvent, 16),
		done: make(chan TranscriptEvent, 1), over: make(chan struct{}),
	}
	go t.read()
	go func() {
		select {
		case <-ctx.Done():
			_ = t.Close()
		case <-t.over:
		}
	}()
	start := map[string]any{"type": "start"}
	if opts.Language != "" {
		start["language"] = opts.Language
	}
	if len(opts.Terms) > 0 {
		start["terms"] = opts.Terms
	}
	if opts.AudioFormat != "" {
		start["audio_format"] = opts.AudioFormat
	}
	if opts.SampleRate > 0 {
		start["sample_rate"] = opts.SampleRate
	}
	if opts.NumChannels > 0 {
		start["num_channels"] = opts.NumChannels
	}
	if err := t.sendJSON(start); err != nil {
		_ = t.Close()
		return nil, err
	}
	return t, nil
}

func acceptKey(nonce string) string {
	h := sha1.Sum([]byte(nonce + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h[:])
}

// Send sends audio, in the format the session was opened with.
func (t *TranscriptionSession) Send(audio []byte) error { return t.write(opBinary, audio) }

// KeepAlive holds the session while no audio flows. Omazy closes a session
// silent for 60 s.
func (t *TranscriptionSession) KeepAlive() error {
	return t.write(opText, []byte(`{"type":"keepalive"}`))
}

// Commit ends the current utterance and keeps the session open. It returns
// the utterance's final, whose text may be empty.
func (t *TranscriptionSession) Commit(ctx context.Context) (*TranscriptEvent, error) {
	if err := t.write(opText, []byte(`{"type":"commit"}`)); err != nil {
		return nil, err
	}
	return t.wait(ctx, t.commits)
}

// End says there is no more audio and returns the done frame: every final of
// the session joined, its language and the audio length it is billed by.
func (t *TranscriptionSession) End(ctx context.Context) (*TranscriptEvent, error) {
	if err := t.write(opText, []byte(`{"type":"end"}`)); err != nil {
		return nil, err
	}
	return t.wait(ctx, t.done)
}

// Events carries every frame from Omazy, in order, and closes when the
// session ends. It is for watching: a frame is dropped when 256 wait unread,
// and Commit and End get their answers either way.
func (t *TranscriptionSession) Events() <-chan TranscriptEvent { return t.events }

// RequestID is the request id of the session, from its ready frame.
func (t *TranscriptionSession) RequestID() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.requestID
}

// Err is what ended the session: an *Error for an error frame, nil after done.
func (t *TranscriptionSession) Err() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.err
}

// Close closes the socket without waiting for an answer.
func (t *TranscriptionSession) Close() error {
	_ = t.write(opClose, []byte{0x03, 0xe8})
	return t.conn.Close()
}

func (t *TranscriptionSession) wait(ctx context.Context, ch <-chan TranscriptEvent) (*TranscriptEvent, error) {
	select {
	case e := <-ch:
		return &e, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-t.over:
		select {
		case e := <-ch:
			return &e, nil
		default:
		}
		if err := t.Err(); err != nil {
			return nil, err
		}
		return nil, &Error{Code: "STREAM_ERROR", Message: "the session closed before it was done", RequestID: t.RequestID()}
	}
}

func (t *TranscriptionSession) sendJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return t.write(opText, b)
}

const (
	opCont   = 0x0
	opText   = 0x1
	opBinary = 0x2
	opClose  = 0x8
	opPing   = 0x9
	opPong   = 0xA
)

// write sends one masked frame, as a client must.
func (t *TranscriptionSession) write(op byte, payload []byte) error {
	hdr := make([]byte, 0, 14)
	hdr = append(hdr, 0x80|op)
	switch n := len(payload); {
	case n < 126:
		hdr = append(hdr, 0x80|byte(n))
	case n < 1<<16:
		hdr = append(hdr, 0x80|126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 0x80|127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(n))
	}
	var mask [4]byte
	_, _ = rand.Read(mask[:])
	hdr = append(hdr, mask[:]...)
	frame := make([]byte, len(hdr)+len(payload))
	copy(frame, hdr)
	for i, b := range payload {
		frame[len(hdr)+i] = b ^ mask[i%4]
	}
	t.wmu.Lock()
	defer t.wmu.Unlock()
	if _, err := t.conn.Write(frame); err != nil {
		return &Error{Code: "NETWORK_ERROR", Message: "the session is closed: " + err.Error(), RequestID: t.RequestID()}
	}
	return nil
}

// readMessage reads one whole message, answering pings on the way.
func (t *TranscriptionSession) readMessage() (byte, []byte, error) {
	var msg []byte
	var first byte
	for {
		var h [2]byte
		if _, err := io.ReadFull(t.br, h[:]); err != nil {
			return 0, nil, err
		}
		fin, op := h[0]&0x80 != 0, h[0]&0x0F
		n := uint64(h[1] & 0x7F)
		switch n {
		case 126:
			var b [2]byte
			if _, err := io.ReadFull(t.br, b[:]); err != nil {
				return 0, nil, err
			}
			n = uint64(binary.BigEndian.Uint16(b[:]))
		case 127:
			var b [8]byte
			if _, err := io.ReadFull(t.br, b[:]); err != nil {
				return 0, nil, err
			}
			n = binary.BigEndian.Uint64(b[:])
		}
		if n > 16<<20 {
			return 0, nil, errors.New("frame too large")
		}
		var mask []byte
		if h[1]&0x80 != 0 {
			mask = make([]byte, 4)
			if _, err := io.ReadFull(t.br, mask); err != nil {
				return 0, nil, err
			}
		}
		payload := make([]byte, n)
		if _, err := io.ReadFull(t.br, payload); err != nil {
			return 0, nil, err
		}
		if mask != nil {
			for i := range payload {
				payload[i] ^= mask[i%4]
			}
		}
		switch op {
		case opPing:
			_ = t.write(opPong, payload)
			continue
		case opPong:
			continue
		case opClose:
			return opClose, payload, nil
		}
		if op != opCont {
			first = op
		}
		msg = append(msg, payload...)
		if fin {
			return first, msg, nil
		}
	}
}

func (t *TranscriptionSession) read() {
	defer func() {
		close(t.events)
		close(t.over)
		_ = t.conn.Close()
	}()
	for {
		op, payload, err := t.readMessage()
		if err != nil || op == opClose {
			return
		}
		if op != opText {
			continue
		}
		var e TranscriptEvent
		if json.Unmarshal(payload, &e) != nil {
			continue
		}
		switch e.Type {
		case "ready":
			t.mu.Lock()
			t.requestID = e.RequestID
			t.mu.Unlock()
		case "error":
			rid := e.RequestID
			if rid == "" {
				rid = t.RequestID()
			}
			code := e.Code
			if code == "" {
				code = "STREAM_ERROR"
			}
			t.mu.Lock()
			t.err = &Error{Code: code, Message: e.Message, RequestID: rid}
			t.mu.Unlock()
		}
		select {
		case t.events <- e:
		default:
		}
		switch {
		case e.Type == "error":
			return
		case e.Type == "final" && e.Committed:
			select {
			case t.commits <- e:
			default:
			}
		case e.Type == "done":
			t.done <- e
			return
		}
	}
}

// joinTerms is how terms travel on the batch route: one comma-separated value.
func joinTerms(terms []string) string { return strings.Join(terms, ",") }
