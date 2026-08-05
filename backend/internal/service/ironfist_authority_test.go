package service

import (
	"errors"
	"testing"
	"time"

	"e2eechat/internal/ironfistengine"
)

const (
	authorityRequestID1 = "6e7060d4-0c83-49fc-815a-800ad3b84a2e"
	authorityRequestID2 = "f1c52a55-b732-42ff-b344-42d67a84531a"
)

var authorityFixedTime = time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC)

func TestGameViewHidesUnresolvedOpponentAction(t *testing.T) {
	opponentAction := ironfistengine.Counter
	game := &lockedGame{
		GameID: "game-1", Mode: "pvp", Status: "active",
		PlayerAUserID: 7, PlayerBUserID: 8,
		CurrentRound: 1, StateVersion: 1, State: ironfistengine.InitialState(),
		PendingActions: map[ironfistengine.Seat]lockedAction{
			ironfistengine.SeatB: {Action: opponentAction, Source: "player"},
		},
	}

	view := gameViewForSeat(game, ironfistengine.SeatA, authorityFixedTime)
	if view.OpponentAction != nil || !view.OpponentLocked {
		t.Fatalf("unresolved action leaked: %#v", view)
	}
	if view.MyAction != nil {
		t.Fatalf("unexpected own action: %#v", view.MyAction)
	}
}

func TestSubmitAuthoritativeActionValidation(t *testing.T) {
	game := &lockedGame{
		GameID: "game-1", Mode: "pvp", Status: "active",
		PlayerAUserID: 7, PlayerBUserID: 8,
		CurrentRound: 1, StateVersion: 1, State: ironfistengine.InitialState(),
		ExpiresAt:      sqlNullTime(authorityFixedTime.Add(time.Hour)),
		PendingActions: map[ironfistengine.Seat]lockedAction{},
	}
	tests := []struct {
		name     string
		userID   uint64
		command  ActionCommand
		wantCode string
	}{
		{"non participant", 99, validAuthorityCommand(1, 1), "forbidden"},
		{"stale version", 7, validAuthorityCommand(1, 0), "stale_state"},
		{"future round", 7, validAuthorityCommand(2, 1), "stale_state"},
		{"invalid action", 7, ActionCommand{Round: 1, Action: "heal", RequestID: authorityRequestID1, ExpectedVersion: 1}, "invalid_action"},
		{"invalid request id", 7, ActionCommand{Round: 1, Action: ironfistengine.Attack, RequestID: "not-a-uuid", ExpectedVersion: 1}, "invalid_request_id"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := validateActionCommand(game, test.userID, test.command, authorityFixedTime)
			assertAuthorityErrorCode(t, err, test.wantCode)
		})
	}
}

func TestSubmitAuthoritativeActionCannotReplaceLockedAction(t *testing.T) {
	game := &lockedGame{
		GameID: "game-1", Mode: "pvp", Status: "active",
		PlayerAUserID: 7, PlayerBUserID: 8,
		CurrentRound: 1, StateVersion: 1, State: ironfistengine.InitialState(),
		PendingActions: map[ironfistengine.Seat]lockedAction{
			ironfistengine.SeatA: {Action: ironfistengine.Attack, Source: "player", UserID: 7, RequestID: authorityRequestID1},
		},
	}
	command := validAuthorityCommand(1, 1)
	command.RequestID = authorityRequestID2
	_, err := validateActionCommand(game, 7, command, authorityFixedTime)
	assertAuthorityErrorCode(t, err, "action_locked")
}

func TestSubmitAuthoritativeActionSameRequestIsIdempotent(t *testing.T) {
	game := &lockedGame{
		GameID: "game-1", Mode: "pvp", Status: "active",
		PlayerAUserID: 7, PlayerBUserID: 8,
		CurrentRound: 1, StateVersion: 1, State: ironfistengine.InitialState(),
		PendingActions: map[ironfistengine.Seat]lockedAction{
			ironfistengine.SeatA: {Action: ironfistengine.Attack, Source: "player", UserID: 7, RequestID: authorityRequestID1},
		},
	}
	seat, err := validateActionCommand(game, 7, validAuthorityCommand(1, 1), authorityFixedTime)
	if err != nil {
		t.Fatal(err)
	}
	if seat != ironfistengine.SeatA {
		t.Fatalf("seat=%q, want a", seat)
	}
}

func TestExpiredPVESessionReturnsGone(t *testing.T) {
	game := &lockedGame{
		GameID: "pve-1", Mode: "pve", Status: "active", PlayerAUserID: 7,
		CurrentRound: 1, StateVersion: 1, State: ironfistengine.InitialState(),
		ExpiresAt:      sqlNullTime(authorityFixedTime.Add(-time.Millisecond)),
		PendingActions: map[ironfistengine.Seat]lockedAction{},
	}
	_, err := validateActionCommand(game, 7, validAuthorityCommand(1, 1), authorityFixedTime)
	assertAuthorityErrorCode(t, err, "session_expired")
}

func TestPVEActionStoresPrivateAIActionAndResolvedRound(t *testing.T) {
	game := &lockedGame{
		GameID: "pve-1", Mode: "pve", Status: "active", PlayerAUserID: 7,
		CurrentRound: 1, StateVersion: 1, State: ironfistengine.InitialState(),
		AISeed: make([]byte, 32), PendingActions: map[ironfistengine.Seat]lockedAction{},
	}
	resolution, err := resolvePVERound(game, ironfistengine.Attack)
	if err != nil {
		t.Fatal(err)
	}
	if resolution.PlayerAction.Source != "player" || resolution.AIAction.Source != "ai" {
		t.Fatalf("sources=(%q,%q), want (player,ai)", resolution.PlayerAction.Source, resolution.AIAction.Source)
	}
	if resolution.AIAction.Action != ironfistengine.DecideAI(game.AISeed, 1, game.State) {
		t.Fatal("stored AI action does not match deterministic private-seed decision")
	}
}

func TestAuthorityStateDecodeRejectsUnknownAndTrailingJSON(t *testing.T) {
	valid := `{"hp_a":100,"hp_b":100,"charged_a":false,"charged_b":false,"charge_unused_a":0,"charge_unused_b":0,"consecutive_no_damage_rounds":0,"total_rounds":0,"both_charged_stalemate":0,"ai_charge_interrupted":0}`
	for _, raw := range []string{
		valid[:len(valid)-1] + `,"client_result":"win"}`,
		valid + `{}`,
	} {
		if _, err := decodeAuthorityState([]byte(raw)); err == nil {
			t.Fatalf("accepted non-canonical authoritative state %s", raw)
		}
	}
}

func validAuthorityCommand(round int, version uint64) ActionCommand {
	return ActionCommand{
		Round: round, Action: ironfistengine.Attack,
		RequestID: authorityRequestID1, ExpectedVersion: version,
	}
}

func assertAuthorityErrorCode(t *testing.T, err error, want string) {
	t.Helper()
	var authorityError *AuthorityError
	if !errors.As(err, &authorityError) {
		t.Fatalf("error=%v, want AuthorityError(%s)", err, want)
	}
	if authorityError.Code != want {
		t.Fatalf("code=%q, want %q", authorityError.Code, want)
	}
}
