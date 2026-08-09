package ws

import (
	"context"
	"encoding/json"
	"testing"
)

const (
	testCallerChatID = "1111-AAAA"
	testPeerChatID   = "2222-BBBB"
	testCallID       = "11111111-1111-4111-8111-111111111111"
)

type fakeFriendChecker struct {
	friends bool
	err     error
}

func (f fakeFriendChecker) GetFriendChatIDs(context.Context, uint64) ([]string, error) {
	return nil, f.err
}

func (f fakeFriendChecker) AreFriends(context.Context, uint64, string) (bool, error) {
	return f.friends, f.err
}

func TestParseCallRelayPayloadValidatesMediaStateBoolean(t *testing.T) {
	tests := []struct {
		name string
		kind string
		body string
		ok   bool
	}{
		{"media true", "call_media_state", `{"to":"2222-BBBB","call_id":"11111111-1111-4111-8111-111111111111","video_enabled":true}`, true},
		{"media false", "call_media_state", `{"to":"2222-BBBB","call_id":"11111111-1111-4111-8111-111111111111","video_enabled":false}`, true},
		{"media missing state", "call_media_state", `{"to":"2222-BBBB","call_id":"11111111-1111-4111-8111-111111111111"}`, false},
		{"media string state", "call_media_state", `{"to":"2222-BBBB","call_id":"11111111-1111-4111-8111-111111111111","video_enabled":"false"}`, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, ok := parseCallRelayPayload(tt.kind, json.RawMessage(tt.body))
			if ok != tt.ok {
				t.Fatalf("parse validity = %v, want %v", ok, tt.ok)
			}
		})
	}
}

func TestBuildCallRelayPayloadPreservesVideoBoolean(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		enabled := enabled
		for _, kind := range []string{"call_answer", "call_media_state"} {
			inner := buildCallRelayPayload(testCallerChatID, kind, callRelayPayload{
				CallID:       testCallID,
				VideoEnabled: &enabled,
			})
			if got, ok := inner["video_enabled"].(bool); !ok || got != enabled {
				t.Fatalf("%s video_enabled = %#v, want %v", kind, inner["video_enabled"], enabled)
			}
		}
	}
}

func TestHandleCallRelayAuthorizesMediaState(t *testing.T) {
	tests := []struct {
		name      string
		friends   bool
		forwarded bool
	}{
		{"friends may update camera state", true, true},
		{"non-friends cannot update camera state", false, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recipient := &Client{ChatID: testPeerChatID, send: make(chan []byte, 1)}
			hub := &Hub{
				clients:   map[string]*Client{testPeerChatID: recipient},
				friendSvc: fakeFriendChecker{friends: tt.friends},
			}
			from := &Client{ChatID: testCallerChatID, UserID: 7}

			hub.handleCallRelay(from, "call_media_state", json.RawMessage(
				`{"to":"2222-BBBB","call_id":"11111111-1111-4111-8111-111111111111","video_enabled":false}`,
			))

			select {
			case raw := <-recipient.send:
				if !tt.forwarded {
					t.Fatal("unauthorized media state was forwarded")
				}
				var message Message
				if err := json.Unmarshal(raw, &message); err != nil {
					t.Fatalf("decode forwarded message: %v", err)
				}
				var payload struct {
					From         string `json:"from"`
					CallID       string `json:"call_id"`
					VideoEnabled *bool  `json:"video_enabled"`
				}
				if err := json.Unmarshal(message.Payload, &payload); err != nil {
					t.Fatalf("decode forwarded payload: %v", err)
				}
				if payload.From != testCallerChatID || payload.CallID != testCallID ||
					payload.VideoEnabled == nil || *payload.VideoEnabled {
					t.Fatalf("unexpected forwarded payload: %+v", payload)
				}
			default:
				if tt.forwarded {
					t.Fatal("authorized media state was not forwarded")
				}
			}
		})
	}
}

func TestDispatchRoutesMediaStateThroughCallAuthorization(t *testing.T) {
	recipient := &Client{ChatID: testPeerChatID, send: make(chan []byte, 1)}
	hub := &Hub{
		clients:   map[string]*Client{testPeerChatID: recipient},
		friendSvc: fakeFriendChecker{friends: true},
	}
	from := &Client{ChatID: testCallerChatID, UserID: 7}
	message := &Message{
		Type: "call_media_state",
		Payload: json.RawMessage(
			`{"to":"2222-BBBB","call_id":"11111111-1111-4111-8111-111111111111","video_enabled":false}`,
		),
	}

	hub.dispatch(from, message, nil)

	select {
	case <-recipient.send:
	default:
		t.Fatal("dispatch did not route call_media_state")
	}
}

func TestHandleCallOfferPreservesDisabledCameraState(t *testing.T) {
	recipient := &Client{ChatID: testPeerChatID, send: make(chan []byte, 1)}
	hub := &Hub{
		clients:   map[string]*Client{testPeerChatID: recipient},
		friendSvc: fakeFriendChecker{friends: true},
	}
	from := &Client{ChatID: testCallerChatID, UserID: 7}

	hub.handleCallOffer(from, json.RawMessage(
		`{"to":"2222-BBBB","call_id":"11111111-1111-4111-8111-111111111111","sdp":{"type":"offer","sdp":"v=0"},"media":"video","video_enabled":false}`,
	))

	raw := <-recipient.send
	var message Message
	if err := json.Unmarshal(raw, &message); err != nil {
		t.Fatalf("decode forwarded offer: %v", err)
	}
	var payload struct {
		VideoEnabled *bool `json:"video_enabled"`
	}
	if err := json.Unmarshal(message.Payload, &payload); err != nil {
		t.Fatalf("decode forwarded offer payload: %v", err)
	}
	if payload.VideoEnabled == nil || *payload.VideoEnabled {
		t.Fatalf("video_enabled = %v, want literal false", payload.VideoEnabled)
	}
}
