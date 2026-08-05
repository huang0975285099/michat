package service

import (
	"context"
	"errors"
	"testing"

	"e2eechat/internal/ironfistengine"
)

func TestPVEDailyRewardSchedule(t *testing.T) {
	tests := []struct {
		priorWins           int
		result              ironfistengine.Outcome
		wantBase, wantBonus int64
		wantWins            int
	}{
		{0, ironfistengine.WinA, 500, 0, 1},
		{8, ironfistengine.WinA, 500, 0, 9},
		{9, ironfistengine.WinA, 500, 1000, 10},
		{10, ironfistengine.WinA, 0, 0, 10},
		{0, ironfistengine.WinB, 0, 0, 0},
		{0, ironfistengine.Draw, 0, 0, 0},
	}
	for _, test := range tests {
		base, bonus, wins := pveRewardFor(test.priorWins, test.result)
		if base != test.wantBase || bonus != test.wantBonus || wins != test.wantWins {
			t.Fatalf("prior=%d result=%s got=(%d,%d,%d), want=(%d,%d,%d)",
				test.priorWins, test.result, base, bonus, wins,
				test.wantBase, test.wantBonus, test.wantWins)
		}
	}
}

func TestAuthoritativeProjectionUnlocksCounterMasterFromStoredRounds(t *testing.T) {
	rounds := []storedAuthorityRound{
		{ActionA: ironfistengine.Counter, ActionB: ironfistengine.Attack, DamageB: 20},
		{ActionA: ironfistengine.Counter, ActionB: ironfistengine.Attack, DamageB: 20},
		{ActionA: ironfistengine.Counter, ActionB: ironfistengine.Attack, DamageB: 20},
	}
	facts := authorityFactsForSeat(rounds, ironfistengine.SeatA, 8, ironfistengine.WinA)
	if facts.CounterSuccesses != 3 || !facts.LowHPWin {
		t.Fatalf("facts=%+v, want three counters and low-HP win", facts)
	}
}

func TestAuthorityFactsAreSeatNeutral(t *testing.T) {
	rounds := []storedAuthorityRound{{
		ActionA: ironfistengine.Attack, ActionB: ironfistengine.Counter,
		DamageA: 20, DamageB: 0,
	}}
	facts := authorityFactsForSeat(rounds, ironfistengine.SeatB, 95, ironfistengine.WinB)
	if facts.CounterSuccesses != 1 || !facts.HighHPWin {
		t.Fatalf("seat-B facts=%+v, want counter and high-HP win", facts)
	}
}

func TestCasualFriendSettlementIsNotRewardEligible(t *testing.T) {
	if settlementChangesBalance("friend", ironfistengine.WinA) {
		t.Fatal("casual friend game must not change balances")
	}
}

func TestLegacyPvEClaimIsDisabled(t *testing.T) {
	_, err := (&FistService{}).ClaimPvEReward(context.Background(), 7)
	if !errors.Is(err, ErrLegacyPvEClaimDisabled) {
		t.Fatalf("error=%v, want ErrLegacyPvEClaimDisabled", err)
	}
}
