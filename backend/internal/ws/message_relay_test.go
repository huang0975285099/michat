package ws

import "testing"

func TestOfflineStorableIncludesDeliveryAck(t *testing.T) {
	for _, messageType := range []string{"message", "read_receipt", "ack", "read_ack", "file_done"} {
		msg := []byte(`{"type":"` + messageType + `"}`)
		if !offlineStorable(msg) {
			t.Fatalf("%s should survive reconnect", messageType)
		}
	}
	for _, messageType := range []string{"status", "file_chunk", "call_offer", "call_media_state"} {
		msg := []byte(`{"type":"` + messageType + `"}`)
		if offlineStorable(msg) {
			t.Fatalf("transient %s should not survive reconnect", messageType)
		}
	}
	if offlineStorable([]byte(`not-json`)) {
		t.Fatal("invalid JSON must not be stored")
	}
}
