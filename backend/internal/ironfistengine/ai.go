package ironfistengine

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
)

type actionWeight struct {
	action Action
	weight int
}

func DecideAI(seed []byte, round uint8, state State) Action {
	weights := aiWeights(state)
	total := 0
	for _, entry := range weights {
		if entry.weight > 0 {
			total += entry.weight
		}
	}
	if total <= 0 {
		return Attack
	}

	stateJSON, _ := json.Marshal(state)
	message := make([]byte, 3, 3+len(stateJSON))
	binary.BigEndian.PutUint16(message[:2], RulesVersion)
	message[2] = round
	message = append(message, stateJSON...)

	mac := hmac.New(sha256.New, seed)
	_, _ = mac.Write(message)
	pick := binary.BigEndian.Uint64(mac.Sum(nil)[:8]) % uint64(total)
	for _, entry := range weights {
		if entry.weight <= 0 {
			continue
		}
		if pick < uint64(entry.weight) {
			return entry.action
		}
		pick -= uint64(entry.weight)
	}
	return Counter
}

func aiWeights(state State) []actionWeight {
	attack, defend, charge, counter := 50, 25, 15, 10
	switch {
	case state.ChargedA && state.ChargedB:
		attack, defend, charge, counter = 60, 30, 0, 10
	case state.ChargedB:
		attack, defend, charge, counter = 70, 20, 0, 10
	case state.ChargedA:
		attack, defend, charge, counter = 15, 40, 10, 35
	}
	if state.HPB < 30 {
		attack += 15
	}
	if state.HPA < 20 && !state.ChargedB {
		charge += 10
	}
	if state.AIChargeInterrupted >= 2 {
		charge = 0
		attack += 20
	}
	return []actionWeight{
		{action: Attack, weight: attack},
		{action: Defend, weight: defend},
		{action: Charge, weight: charge},
		{action: Counter, weight: counter},
	}
}
