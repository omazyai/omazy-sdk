package omazy

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// Sign returns the signature header value for a body. Every flow, tool,
// context and callback request Omazy sends to your server carries
//
//	X-Omazy-Signature: sha256=<hex hmac-sha256(secret, raw body)>
func Sign(secret string, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(body)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

// VerifySignature reports whether header is the platform's signature over
// exactly body. Verify the raw bytes you received, before parsing them.
func VerifySignature(secret string, body []byte, header string) bool {
	got := strings.TrimSpace(header)
	if secret == "" || got == "" {
		return false
	}
	return hmac.Equal([]byte(got), []byte(Sign(secret, body)))
}
