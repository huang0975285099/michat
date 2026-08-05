package service

import (
	"database/sql"
	"testing"
	"time"

	"e2eechat/internal/ironfistengine"
)

func TestConnectedDeadlineInsertsDefend(t *testing.T) {
	game := deadlineTestGame()
	game.ActionDeadlineA = sqlNullTime(authorityFixedTime)
	decision := decideDueTransition(game, authorityFixedTime)
	if decision.DefaultA == nil || *decision.DefaultA != ironfistengine.Defend {
		t.Fatalf("decision=%+v, want A defend", decision)
	}
}

func TestSingleDisconnectExpiryForfeits(t *testing.T) {
	game := deadlineTestGame()
	game.ActionDeadlineA = timeNull()
	game.DisconnectDeadlineA = sqlNullTime(authorityFixedTime)
	decision := decideDueTransition(game, authorityFixedTime)
	if decision.Outcome != ironfistengine.WinB || decision.FinishReason != "disconnect_forfeit_a" {
		t.Fatalf("decision=%+v", decision)
	}
}

func TestBothDisconnectExpiriesDraw(t *testing.T) {
	game := deadlineTestGame()
	game.ActionDeadlineA, game.ActionDeadlineB = timeNull(), timeNull()
	game.DisconnectDeadlineA = sqlNullTime(authorityFixedTime.Add(-time.Second))
	game.DisconnectDeadlineB = sqlNullTime(authorityFixedTime)
	decision := decideDueTransition(game, authorityFixedTime)
	if decision.Outcome != ironfistengine.Draw || decision.FinishReason != "both_disconnected" {
		t.Fatalf("decision=%+v", decision)
	}
}

func TestOneExpiredDisconnectWaitsWhenOpponentAlsoDisconnected(t *testing.T) {
	game := deadlineTestGame()
	game.ActionDeadlineA, game.ActionDeadlineB = timeNull(), timeNull()
	game.DisconnectDeadlineA = sqlNullTime(authorityFixedTime)
	game.DisconnectDeadlineB = sqlNullTime(authorityFixedTime.Add(10 * time.Second))
	decision := decideDueTransition(game, authorityFixedTime)
	if decision.Outcome != ironfistengine.OutcomeNone {
		t.Fatalf("decision=%+v, want wait for both disconnect deadlines", decision)
	}
}

func TestReconnectRestoresRemainingActionTime(t *testing.T) {
	got := restoredActionDeadline(authorityFixedTime, 17*time.Second)
	if got.Sub(authorityFixedTime) != 17*time.Second {
		t.Fatalf("deadline=%v", got)
	}
}

func deadlineTestGame() *lockedGame {
	deadline := sqlNullTime(authorityFixedTime.Add(time.Minute))
	return &lockedGame{
		GameID: "game-deadline", Mode: "pvp", Status: "active",
		PlayerAUserID: 7, PlayerBUserID: 8, CurrentRound: 1, StateVersion: 1,
		State: ironfistengine.InitialState(), ActionDeadlineA: deadline, ActionDeadlineB: deadline,
		PendingActions: map[ironfistengine.Seat]lockedAction{},
	}
}

func timeNull() sql.NullTime { return sql.NullTime{} }
