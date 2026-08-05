package ws

import (
	"context"
	"encoding/json"
	"testing"

	pkgredis "e2eechat/pkg/redis"
)

func TestLegacyIronFistMessagesAreNotRelayedOrStored(t *testing.T) {
	redis, err := pkgredis.NewInMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer redis.Close()
	hub := NewHub(redis, nil, nil, nil)
	from := &Client{ChatID: "1111-AAAA", UserID: 1, send: make(chan []byte, 2)}
	opponent := &Client{ChatID: "2222-BBBB", UserID: 2, send: make(chan []byte, 2)}
	hub.clients[from.ChatID] = from
	hub.clients[opponent.ChatID] = opponent

	for _, messageType := range []string{"ironfist_action", "ironfist_reconnect"} {
		payload, _ := json.Marshal(map[string]any{
			"to": opponent.ChatID, "room_id": "123", "round": 1, "action": "attack",
		})
		hub.dispatch(from, &Message{Type: messageType, Payload: payload}, nil)
	}
	select {
	case message := <-opponent.send:
		t.Fatalf("legacy message reached opponent: %s", message)
	default:
	}
	keys, err := redis.Keys(context.Background(), "ironfist:actions:*").Result()
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 0 {
		t.Fatalf("legacy action keys were created: %v", keys)
	}
}
