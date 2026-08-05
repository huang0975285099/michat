package ironfistengine

const (
	initialHP              = 100
	chargeMultiplier       = 2
	maximumChargedHit      = 24
	lowHPThreshold         = 30
	shieldHPThreshold      = 20
	chargeHoldLimit        = 2
	staleNoDamageLimit     = 5
	staleEnvironmentDamage = 5
	maximumRounds          = 20
	bothChargedLimit       = 2
)

type damagePair struct {
	a int
	b int
}

var damageTable = map[Action]map[Action]damagePair{
	Attack: {
		Attack: {a: 12, b: 12}, Defend: {a: 0, b: 5},
		Charge: {a: 0, b: 18}, Counter: {a: 20, b: 0},
	},
	Defend: {
		Attack: {a: 5, b: 0}, Defend: {a: 0, b: 0},
		Charge: {a: 0, b: 0}, Counter: {a: 0, b: 8},
	},
	Charge: {
		Attack: {a: 18, b: 0}, Defend: {a: 0, b: 0},
		Charge: {a: 0, b: 0}, Counter: {a: 0, b: 8},
	},
	Counter: {
		Attack: {a: 0, b: 20}, Defend: {a: 8, b: 0},
		Charge: {a: 8, b: 0}, Counter: {a: 8, b: 8},
	},
}

func ResolveRound(actionA, actionB Action, before State) (RoundResult, error) {
	row, ok := damageTable[actionA]
	if !ok {
		return RoundResult{}, ErrInvalidAction
	}
	base, ok := row[actionB]
	if !ok {
		return RoundResult{}, ErrInvalidAction
	}

	damageA, damageB := base.a, base.b
	if before.ChargedA && actionA == Attack && damageB > 0 {
		damageB = min(damageB*chargeMultiplier, maximumChargedHit)
	}
	if before.ChargedB && actionB == Attack && damageA > 0 {
		damageA = min(damageA*chargeMultiplier, maximumChargedHit)
	}

	if before.HPA < lowHPThreshold && damageB > 0 {
		damageB = ceilRatio(damageB, 11, 10)
	}
	if before.HPB < lowHPThreshold && damageA > 0 {
		damageA = ceilRatio(damageA, 11, 10)
	}

	if before.HPA < shieldHPThreshold && damageA > 0 {
		damageA = min(damageA, ceilRatio(before.HPA, 3, 5))
	}
	if before.HPB < shieldHPThreshold && damageB > 0 {
		damageB = min(damageB, ceilRatio(before.HPB, 3, 5))
	}

	aCharged := before.ChargedA
	if actionA == Attack && before.ChargedA {
		aCharged = false
	} else if actionA == Charge && damageA == 0 {
		aCharged = true
	}
	aCharged, aUnused := ageCharge(before.ChargedA, aCharged, before.ChargeUnusedA)

	bCharged := before.ChargedB
	if actionB == Attack && before.ChargedB {
		bCharged = false
	} else if actionB == Charge && damageB == 0 {
		bCharged = true
	}
	bCharged, bUnused := ageCharge(before.ChargedB, bCharged, before.ChargeUnusedB)

	noDamage := damageA == 0 && damageB == 0
	consecutiveNoDamage := 0
	if noDamage {
		consecutiveNoDamage = before.ConsecutiveNoDamageRounds + 1
	}
	environmentDamage := 0
	if consecutiveNoDamage >= staleNoDamageLimit {
		environmentDamage = staleEnvironmentDamage * (consecutiveNoDamage - staleNoDamageLimit + 1)
	}

	bothChargedStalemate := 0
	if aCharged && bCharged {
		bothChargedStalemate = before.BothChargedStalemate + 1
	}
	if bothChargedStalemate > bothChargedLimit {
		aCharged, bCharged = false, false
		aUnused, bUnused = 0, 0
		bothChargedStalemate = 0
	}

	aiChargeInterrupted := 0
	if actionB == Charge && damageB > 0 {
		aiChargeInterrupted = before.AIChargeInterrupted + 1
	}

	after := State{
		HPA:                       max(0, before.HPA-damageA-environmentDamage),
		HPB:                       max(0, before.HPB-damageB-environmentDamage),
		ChargedA:                  aCharged,
		ChargedB:                  bCharged,
		ChargeUnusedA:             aUnused,
		ChargeUnusedB:             bUnused,
		ConsecutiveNoDamageRounds: consecutiveNoDamage,
		TotalRounds:               before.TotalRounds + 1,
		BothChargedStalemate:      bothChargedStalemate,
		AIChargeInterrupted:       aiChargeInterrupted,
	}

	return RoundResult{
		ActionA: actionA, ActionB: actionB,
		DamageA: damageA, DamageB: damageB,
		EnvironmentDamage: environmentDamage,
		State:             after, Outcome: outcome(after),
	}, nil
}

func ageCharge(wasCharged, remainsCharged bool, oldUnused int) (bool, int) {
	if !remainsCharged {
		return false, 0
	}
	if !wasCharged {
		return true, 0
	}
	unused := oldUnused + 1
	if unused >= chargeHoldLimit {
		return false, 0
	}
	return true, unused
}

func outcome(state State) Outcome {
	if state.HPA <= 0 && state.HPB <= 0 {
		return Draw
	}
	if state.HPA <= 0 {
		return WinB
	}
	if state.HPB <= 0 {
		return WinA
	}
	if state.TotalRounds < maximumRounds {
		return OutcomeNone
	}
	if state.HPA <= 5 && state.HPB <= 5 {
		return DoubleLose
	}
	if state.HPA > state.HPB {
		return WinA
	}
	if state.HPB > state.HPA {
		return WinB
	}
	return Draw
}

func ceilRatio(value, numerator, denominator int) int {
	return (value*numerator + denominator - 1) / denominator
}
