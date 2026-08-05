package service

import (
	"testing"

	"e2eechat/internal/ironfistengine"
)

func TestWageredPayoutTable(t *testing.T) {
	tests := []struct {
		outcome                                  ironfistengine.Outcome
		winner, refundA, refundB, burn, treasury int64
	}{
		{ironfistengine.WinA, 190, 0, 0, 5, 5},
		{ironfistengine.WinB, 190, 0, 0, 5, 5},
		{ironfistengine.Draw, 0, 97, 97, 3, 3},
		{ironfistengine.DoubleLose, 0, 97, 97, 3, 3},
	}
	for _, test := range tests {
		got, err := calculateWagerSettlement(100, test.outcome)
		if err != nil {
			t.Fatal(err)
		}
		if got.WinnerAmount != test.winner || got.RefundA != test.refundA ||
			got.RefundB != test.refundB || got.FeeBurn != test.burn || got.FeeTreasury != test.treasury {
			t.Fatalf("outcome=%s got=%+v, want winner=%d refunds=(%d,%d) fees=(%d,%d)",
				test.outcome, got, test.winner, test.refundA, test.refundB, test.burn, test.treasury)
		}
	}
}

func TestLosingPlayerCannotInfluenceAuthoritativePayout(t *testing.T) {
	game := &lockedGame{Result: ironfistengine.WinA}
	got, err := calculateWagerSettlement(100, game.Result)
	if err != nil {
		t.Fatal(err)
	}
	if got.Result != ironfistengine.WinA || got.WinnerAmount != 190 {
		t.Fatalf("settlement=%+v, want stored win_a and payout 190", got)
	}
}

func TestForfeitPaysNonForfeitingPlayer(t *testing.T) {
	got, err := calculateWagerSettlement(100, ironfistengine.WinB)
	if err != nil {
		t.Fatal(err)
	}
	if got.WinnerAmount != 190 || got.RefundA != 0 || got.RefundB != 0 {
		t.Fatalf("forfeit settlement=%+v", got)
	}
}
