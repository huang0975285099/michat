package ironfistengine

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

func TestResolveRoundAttackPairs(t *testing.T) {
	tests := []struct {
		name                     string
		actionA, actionB         Action
		wantDamageA, wantDamageB int
	}{
		{"attack attack", Attack, Attack, 12, 12},
		{"attack defend", Attack, Defend, 0, 5},
		{"attack charge", Attack, Charge, 0, 18},
		{"attack counter", Attack, Counter, 20, 0},
		{"defend attack", Defend, Attack, 5, 0},
		{"defend defend", Defend, Defend, 0, 0},
		{"defend charge", Defend, Charge, 0, 0},
		{"defend counter", Defend, Counter, 0, 8},
		{"charge attack", Charge, Attack, 18, 0},
		{"charge defend", Charge, Defend, 0, 0},
		{"charge charge", Charge, Charge, 0, 0},
		{"charge counter", Charge, Counter, 0, 8},
		{"counter attack", Counter, Attack, 0, 20},
		{"counter defend", Counter, Defend, 8, 0},
		{"counter charge", Counter, Charge, 8, 0},
		{"counter counter", Counter, Counter, 8, 8},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := ResolveRound(test.actionA, test.actionB, InitialState())
			if err != nil {
				t.Fatal(err)
			}
			if got.DamageA != test.wantDamageA || got.DamageB != test.wantDamageB {
				t.Fatalf("damage=(%d,%d), want=(%d,%d)", got.DamageA, got.DamageB, test.wantDamageA, test.wantDamageB)
			}
		})
	}
}

func TestResolveRoundConsumesChargedAttack(t *testing.T) {
	before := State{HPA: 100, HPB: 100, ChargedA: true}
	got, err := ResolveRound(Attack, Attack, before)
	if err != nil {
		t.Fatal(err)
	}
	if got.DamageA != 12 || got.DamageB != 24 {
		t.Fatalf("damage=(%d,%d), want=(12,24)", got.DamageA, got.DamageB)
	}
	if got.State.ChargedA || got.State.ChargeUnusedA != 0 {
		t.Fatalf("charged A was not consumed: %+v", got.State)
	}
}

func TestResolveRoundAgesChargeAfterTwoUnusedTurns(t *testing.T) {
	before := State{HPA: 100, HPB: 100, ChargedA: true, ChargeUnusedA: 1}
	got, err := ResolveRound(Defend, Defend, before)
	if err != nil {
		t.Fatal(err)
	}
	if got.State.ChargedA || got.State.ChargeUnusedA != 0 {
		t.Fatalf("charge did not expire: %+v", got.State)
	}
}

func TestResolveRoundAppliesLowHPEnhancementBeforeShield(t *testing.T) {
	before := State{HPA: 10, HPB: 15}
	got, err := ResolveRound(Attack, Attack, before)
	if err != nil {
		t.Fatal(err)
	}
	if got.DamageA != 6 || got.DamageB != 9 || got.State.HPA != 4 || got.State.HPB != 6 {
		t.Fatalf("got damage=(%d,%d) hp=(%d,%d), want damage=(6,9) hp=(4,6)", got.DamageA, got.DamageB, got.State.HPA, got.State.HPB)
	}
}

func TestResolveRoundAppliesEscalatingEnvironmentalDamage(t *testing.T) {
	before := State{HPA: 100, HPB: 100, ConsecutiveNoDamageRounds: 6}
	got, err := ResolveRound(Defend, Defend, before)
	if err != nil {
		t.Fatal(err)
	}
	if got.EnvironmentDamage != 15 || got.State.HPA != 85 || got.State.HPB != 85 {
		t.Fatalf("environment=%d hp=(%d,%d), want environment=15 hp=(85,85)", got.EnvironmentDamage, got.State.HPA, got.State.HPB)
	}
}

func TestResolveRoundClearsBothChargesAfterStalemate(t *testing.T) {
	before := State{
		HPA: 100, HPB: 100,
		ChargedA: true, ChargedB: true,
		BothChargedStalemate: 2,
	}
	got, err := ResolveRound(Defend, Defend, before)
	if err != nil {
		t.Fatal(err)
	}
	if got.State.ChargedA || got.State.ChargedB || got.State.BothChargedStalemate != 0 {
		t.Fatalf("both-charge stalemate was not cleared: %+v", got.State)
	}
}

func TestResolveRoundSimultaneousKnockoutDraws(t *testing.T) {
	before := State{HPA: 5, HPB: 5, ConsecutiveNoDamageRounds: 4}
	got, err := ResolveRound(Defend, Defend, before)
	if err != nil {
		t.Fatal(err)
	}
	if got.State.HPA != 0 || got.State.HPB != 0 || got.Outcome != Draw {
		t.Fatalf("hp=(%d,%d) outcome=%q, want simultaneous draw", got.State.HPA, got.State.HPB, got.Outcome)
	}
}

func TestResolveRoundMaximumRoundUsesRemainingHP(t *testing.T) {
	before := State{HPA: 50, HPB: 40, TotalRounds: 19}
	got, err := ResolveRound(Defend, Defend, before)
	if err != nil {
		t.Fatal(err)
	}
	if got.State.TotalRounds != 20 || got.Outcome != WinA {
		t.Fatalf("round=%d outcome=%q, want round=20 outcome=%q", got.State.TotalRounds, got.Outcome, WinA)
	}
}

func TestResolveRoundRejectsInvalidAction(t *testing.T) {
	_, err := ResolveRound(Action("invented"), Attack, InitialState())
	if !errors.Is(err, ErrInvalidAction) {
		t.Fatalf("error=%v, want ErrInvalidAction", err)
	}
}

func TestDecideAIIsDeterministic(t *testing.T) {
	seed := make([]byte, 32)
	before := State{HPA: 100, HPB: 100}
	first := DecideAI(seed, 1, before)
	if first != Charge {
		t.Fatalf("DecideAI returned %q, want the hand-checked HMAC selection %q", first, Charge)
	}
	for i := 0; i < 10; i++ {
		if got := DecideAI(seed, 1, before); got != first {
			t.Fatalf("DecideAI returned %q after initially returning %q", got, first)
		}
	}
	if first != Attack && first != Defend && first != Charge && first != Counter {
		t.Fatalf("DecideAI returned invalid action %q", first)
	}
}

func TestRulesV1GoldenFixtures(t *testing.T) {
	type fixture struct {
		Name              string  `json:"name"`
		Before            State   `json:"before"`
		ActionA           Action  `json:"action_a"`
		ActionB           Action  `json:"action_b"`
		After             State   `json:"after"`
		DamageA           int     `json:"damage_a"`
		DamageB           int     `json:"damage_b"`
		EnvironmentDamage int     `json:"environment_damage"`
		Outcome           Outcome `json:"outcome"`
	}

	raw, err := os.ReadFile("testdata/rules-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []fixture
	if err := json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			got, err := ResolveRound(fixture.ActionA, fixture.ActionB, fixture.Before)
			if err != nil {
				t.Fatal(err)
			}
			if got.DamageA != fixture.DamageA || got.DamageB != fixture.DamageB ||
				got.EnvironmentDamage != fixture.EnvironmentDamage || got.State != fixture.After ||
				got.Outcome != fixture.Outcome {
				t.Fatalf("result=%+v, want damage=(%d,%d) environment=%d state=%+v outcome=%q",
					got, fixture.DamageA, fixture.DamageB, fixture.EnvironmentDamage, fixture.After, fixture.Outcome)
			}
		})
	}
}
