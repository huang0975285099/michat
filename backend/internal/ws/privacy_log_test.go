package ws

import (
	"bytes"
	"encoding/json"
	"log"
	"strings"
	"testing"
)

func TestWebSocketLogsRedactIdentifiers(t *testing.T) {
	var output bytes.Buffer
	originalWriter := log.Writer()
	originalFlags := log.Flags()
	originalPrefix := log.Prefix()
	log.SetOutput(&output)
	log.SetFlags(0)
	log.SetPrefix("")
	t.Cleanup(func() {
		log.SetOutput(originalWriter)
		log.SetFlags(originalFlags)
		log.SetPrefix(originalPrefix)
	})

	hub := NewHub(nil, nil, nil, nil)
	client := &Client{ChatID: "1234-ABCD"}

	hub.dispatch(client, &Message{Type: "private-room-99"}, nil)

	payload, err := json.Marshal(ChatMessagePayload{
		To:              "9999-ZZZZ-private",
		MsgID:           "loyw3v28-1-abc123",
		EphemeralPubKey: "public-key",
		IV:              "iv",
		Ciphertext:      "ciphertext",
	})
	if err != nil {
		t.Fatal(err)
	}
	hub.dispatch(client, &Message{Type: "message", Payload: payload}, nil)

	logged := output.String()
	for _, category := range []string{"unknown message type", "invalid recipient"} {
		if !strings.Contains(logged, category) {
			t.Fatalf("privacy log missing category %q: %s", category, logged)
		}
	}
	for _, secret := range []string{"1234-ABCD", "9999-ZZZZ-private", "private-room-99", "loyw3v28-1-abc123"} {
		if strings.Contains(logged, secret) {
			t.Fatalf("privacy log leaked %q: %s", secret, logged)
		}
	}
}
