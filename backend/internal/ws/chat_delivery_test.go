package ws

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"e2eechat/internal/service"
)

const (
	testMessageID  = "abc123-1-abcdef"
	testMessageID2 = "abc123-2-abcdef"
)

type fakeMessageReadStore struct {
	delivery   service.MessageDelivery
	created    bool
	acceptErr  error
	deliveries []service.MessageDelivery
	queryErr   error
	deleted    bool
}

func (f *fakeMessageReadStore) AcceptMessage(context.Context, string, string, string) (service.MessageDelivery, bool, error) {
	return f.delivery, f.created, f.acceptErr
}
func (f *fakeMessageReadStore) GetMessageDeliveries(context.Context, string, []string) ([]service.MessageDelivery, error) {
	return f.deliveries, f.queryErr
}
func (*fakeMessageReadStore) RecordMessage(context.Context, string, string, string) error { return nil }
func (f *fakeMessageReadStore) DeleteMessage(context.Context, string, string, string) error {
	f.deleted = true
	return nil
}
func (*fakeMessageReadStore) RecordReads(context.Context, []string, string, string) ([]service.ReadReceipt, error) {
	return nil, nil
}
func (*fakeMessageReadStore) GetReadReceiptsForSender(context.Context, string) (map[string][]service.ReadReceipt, error) {
	return nil, nil
}
func (*fakeMessageReadStore) MarkReadReceiptsApplied(context.Context, []string, string, string) error {
	return nil
}

func validChatPayload(msgID string) json.RawMessage {
	payload, _ := json.Marshal(ChatMessagePayload{
		To:              testPeerChatID,
		MsgID:           msgID,
		EphemeralPubKey: "key",
		IV:              "iv",
		Ciphertext:      "ciphertext",
	})
	return payload
}

func readChatAck(t *testing.T, client *Client) ChatAckPayload {
	t.Helper()
	select {
	case raw := <-client.send:
		var envelope Message
		if err := json.Unmarshal(raw, &envelope); err != nil {
			t.Fatalf("decode ACK envelope: %v", err)
		}
		if envelope.Type != "ack" {
			t.Fatalf("message type = %q, want ack", envelope.Type)
		}
		var ack ChatAckPayload
		if err := json.Unmarshal(envelope.Payload, &ack); err != nil {
			t.Fatalf("decode ACK payload: %v", err)
		}
		return ack
	default:
		t.Fatal("expected ACK")
		return ChatAckPayload{}
	}
}

func TestChatMessageFirstAcceptanceForwardsOnce(t *testing.T) {
	recipient := &Client{ChatID: testPeerChatID, send: make(chan []byte, 1)}
	sender := &Client{ChatID: testCallerChatID, UserID: 7, send: make(chan []byte, 1)}
	store := &fakeMessageReadStore{
		delivery: service.MessageDelivery{MsgID: testMessageID, MsgFrom: testCallerChatID, MsgTo: testPeerChatID, SentAt: 1234000},
		created:  true,
	}
	hub := &Hub{
		clients:        map[string]*Client{testPeerChatID: recipient},
		friendSvc:      fakeFriendChecker{friends: true},
		messageReadSvc: store,
	}

	hub.handleChatMessage(sender, validChatPayload(testMessageID))

	select {
	case <-recipient.send:
	default:
		t.Fatal("new message was not forwarded")
	}
	ack := readChatAck(t, sender)
	if ack.Status != "accepted" || ack.Timestamp != 1234000 {
		t.Fatalf("unexpected ACK: %+v", ack)
	}
}

func TestChatMessageDuplicateIsAcknowledgedWithoutForwarding(t *testing.T) {
	recipient := &Client{ChatID: testPeerChatID, send: make(chan []byte, 1)}
	sender := &Client{ChatID: testCallerChatID, UserID: 7, send: make(chan []byte, 1)}
	store := &fakeMessageReadStore{
		delivery: service.MessageDelivery{MsgID: testMessageID, MsgFrom: testCallerChatID, MsgTo: testPeerChatID, SentAt: 1234000},
		created:  false,
	}
	hub := &Hub{
		clients:        map[string]*Client{testPeerChatID: recipient},
		friendSvc:      fakeFriendChecker{friends: true},
		messageReadSvc: store,
	}

	hub.handleChatMessage(sender, validChatPayload(testMessageID))

	select {
	case <-recipient.send:
		t.Fatal("duplicate message was forwarded again")
	default:
	}
	ack := readChatAck(t, sender)
	if ack.Status != "duplicate" || ack.Timestamp != 1234000 {
		t.Fatalf("unexpected duplicate ACK: %+v", ack)
	}
}

func TestChatMessageDoesNotAcknowledgeWhenOfflineStorageFails(t *testing.T) {
	sender := &Client{ChatID: testCallerChatID, UserID: 7, send: make(chan []byte, 1)}
	store := &fakeMessageReadStore{
		delivery: service.MessageDelivery{MsgID: testMessageID, MsgFrom: testCallerChatID, MsgTo: testPeerChatID, SentAt: 1234000},
		created:  true,
	}
	hub := &Hub{
		clients:        map[string]*Client{},
		friendSvc:      fakeFriendChecker{friends: true},
		messageReadSvc: store,
	}

	hub.handleChatMessage(sender, validChatPayload(testMessageID))

	ack := readChatAck(t, sender)
	if ack.Status != "retry" || ack.Code != "temporary_failure" || !ack.Retryable {
		t.Fatalf("unexpected storage failure ACK: %+v", ack)
	}
	if !store.deleted {
		t.Fatal("undelivered attribution was not rolled back")
	}
}

func TestChatMessageReturnsStructuredFailures(t *testing.T) {
	tests := []struct {
		name      string
		friendSvc fakeFriendChecker
		store     *fakeMessageReadStore
		status    string
		code      string
		retryable bool
	}{
		{name: "not friends", friendSvc: fakeFriendChecker{friends: false}, status: "rejected", code: "not_friends"},
		{name: "friend lookup failure", friendSvc: fakeFriendChecker{err: errors.New("db unavailable")}, status: "retry", code: "temporary_failure", retryable: true},
		{name: "delivery conflict", friendSvc: fakeFriendChecker{friends: true}, store: &fakeMessageReadStore{acceptErr: service.ErrMessageIDConflict}, status: "rejected", code: "message_id_conflict"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sender := &Client{ChatID: testCallerChatID, UserID: 7, send: make(chan []byte, 1)}
			hub := &Hub{clients: map[string]*Client{}, friendSvc: tt.friendSvc, messageReadSvc: tt.store}
			hub.handleChatMessage(sender, validChatPayload(testMessageID))
			ack := readChatAck(t, sender)
			if ack.Status != tt.status || ack.Code != tt.code || ack.Retryable != tt.retryable {
				t.Fatalf("unexpected failure ACK: %+v", ack)
			}
		})
	}
}

func TestMessageStatusQueryReturnsAcceptedAndUnknown(t *testing.T) {
	sender := &Client{ChatID: testCallerChatID, send: make(chan []byte, 1)}
	store := &fakeMessageReadStore{deliveries: []service.MessageDelivery{{MsgID: testMessageID, SentAt: 1234000}}}
	hub := &Hub{messageReadSvc: store}
	payload, _ := json.Marshal(struct {
		MsgID []string `json:"msg_id"`
	}{MsgID: []string{testMessageID, testMessageID2}})

	hub.handleMessageStatusQuery(sender, payload)

	raw := <-sender.send
	var envelope Message
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	var response struct {
		Complete bool `json:"complete"`
		Results  []struct {
			MsgID  string `json:"msg_id"`
			Status string `json:"status"`
			TS     int64  `json:"ts"`
		} `json:"results"`
	}
	if err := json.Unmarshal(envelope.Payload, &response); err != nil {
		t.Fatal(err)
	}
	if !response.Complete || len(response.Results) != 2 ||
		response.Results[0].Status != "accepted" || response.Results[0].TS != 1234000 ||
		response.Results[1].Status != "unknown" {
		t.Fatalf("unexpected status response: %+v", response)
	}
}

func TestHealthPingReturnsMatchingPong(t *testing.T) {
	client := &Client{send: make(chan []byte, 1)}
	hub := &Hub{}
	hub.handleHealthPing(client, json.RawMessage(`{"nonce":"abc123"}`))

	raw := <-client.send
	var envelope Message
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Type != "health_pong" {
		t.Fatalf("message type = %q, want health_pong", envelope.Type)
	}
	var pong struct {
		Nonce      string `json:"nonce"`
		ServerTime int64  `json:"server_time"`
	}
	if err := json.Unmarshal(envelope.Payload, &pong); err != nil {
		t.Fatal(err)
	}
	if pong.Nonce != "abc123" || pong.ServerTime <= 0 {
		t.Fatalf("unexpected pong: %+v", pong)
	}
}

func TestHealthPingRejectsInvalidNonce(t *testing.T) {
	client := &Client{send: make(chan []byte, 1)}
	(&Hub{}).handleHealthPing(client, json.RawMessage(`{"nonce":"contains private data!"}`))
	select {
	case <-client.send:
		t.Fatal("invalid health ping was answered")
	default:
	}
}
