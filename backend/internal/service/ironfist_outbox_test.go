package service

import (
	"bytes"
	"encoding/json"
	"testing"

	"e2eechat/internal/ironfistengine"
)

func TestOutboxPlayerLockedPayloadDoesNotRevealActionOrSeed(t *testing.T) {
	game := &lockedGame{
		GameID: "game-1", Mode: "pvp", Status: "active", CurrentRound: 1, StateVersion: 1,
		AISeed: []byte("server-private-seed"), State: ironfistengine.InitialState(),
		PendingActions: map[ironfistengine.Seat]lockedAction{
			ironfistengine.SeatA: {Action: ironfistengine.Counter, Source: "player"},
		},
	}
	payload, err := authorityEventPayload("ironfist_player_locked", game, ironfistengine.SeatA, authorityFixedTime)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(payload, []byte("counter")) || bytes.Contains(payload, []byte("server-private-seed")) || bytes.Contains(payload, []byte("ai_seed")) {
		t.Fatalf("private authority data leaked: %s", payload)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["locked_seat"] != "a" || decoded["game_id"] != "game-1" {
		t.Fatalf("payload=%v", decoded)
	}
}
