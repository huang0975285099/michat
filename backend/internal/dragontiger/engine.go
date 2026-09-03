package dragontiger

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
)

const (
	RulesVersion = uint16(1)
	InitialHP    = 100
	MaxRounds    = 10
)

type Action string

const (
	Attack  Action = "attack"
	Defend  Action = "defend"
	Charge  Action = "charge"
	Counter Action = "counter"
)

type fighterState struct {
	HP                int
	Charged           bool
	ChargeUnused      int
	ChargeInterrupted int
}

type BattleRound struct {
	Round             int    `json:"round"`
	RandomIndexDragon uint64 `json:"random_index_dragon"`
	RandomIndexTiger  uint64 `json:"random_index_tiger"`
	DragonAction      Action `json:"dragon_action"`
	TigerAction       Action `json:"tiger_action"`
	DragonDamage      int    `json:"dragon_damage"`
	TigerDamage       int    `json:"tiger_damage"`
	EnvironmentDamage int    `json:"environment_damage"`
	DragonHP          int    `json:"dragon_hp"`
	TigerHP           int    `json:"tiger_hp"`
	DragonCharged     bool   `json:"dragon_charged"`
	TigerCharged      bool   `json:"tiger_charged"`
}

type Battle struct {
	RulesVersion uint16        `json:"rules_version"`
	Rounds       []BattleRound `json:"rounds"`
	DragonHP     int           `json:"dragon_hp"`
	TigerHP      int           `json:"tiger_hp"`
	Result       string        `json:"result"`
}

type damagePair struct{ dragon, tiger int }

var damageTable = map[Action]map[Action]damagePair{
	Attack:  {Attack: {12, 12}, Defend: {0, 5}, Charge: {0, 18}, Counter: {20, 0}},
	Defend:  {Attack: {5, 0}, Defend: {0, 0}, Charge: {0, 0}, Counter: {0, 8}},
	Charge:  {Attack: {18, 0}, Defend: {0, 0}, Charge: {0, 0}, Counter: {0, 8}},
	Counter: {Attack: {0, 20}, Defend: {8, 0}, Charge: {8, 0}, Counter: {8, 8}},
}

// Generate consumes exactly two deterministic random values per round: dragon, then tiger.
func Generate(seed []byte, roundID uint64, rulesVersion uint16) (Battle, error) {
	if len(seed) != 32 || rulesVersion != RulesVersion {
		return Battle{}, fmt.Errorf("unsupported dragon tiger seed or rules version")
	}
	dragon, tiger := fighterState{HP: InitialHP}, fighterState{HP: InitialHP}
	battle := Battle{RulesVersion: rulesVersion, Rounds: make([]BattleRound, 0, MaxRounds)}
	noDamageRounds, bothChargedRounds := 0, 0
	var randomIndex uint64
	for roundNum := 1; roundNum <= MaxRounds; roundNum++ {
		dragonBefore, tigerBefore := dragon, tiger
		dragonAction := decide(seed, roundID, rulesVersion, randomIndex, dragonBefore, tigerBefore)
		dragonIndex := randomIndex
		randomIndex++
		tigerAction := decide(seed, roundID, rulesVersion, randomIndex, tigerBefore, dragonBefore)
		tigerIndex := randomIndex
		randomIndex++
		pair := damageTable[dragonAction][tigerAction]
		damageDragon, damageTiger := pair.dragon, pair.tiger
		if dragonBefore.Charged && dragonAction == Attack && damageTiger > 0 {
			damageTiger = min(damageTiger*2, 24)
		}
		if tigerBefore.Charged && tigerAction == Attack && damageDragon > 0 {
			damageDragon = min(damageDragon*2, 24)
		}
		if dragonBefore.HP < 30 && damageTiger > 0 {
			damageTiger = ceilRatio(damageTiger, 11, 10)
		}
		if tigerBefore.HP < 30 && damageDragon > 0 {
			damageDragon = ceilRatio(damageDragon, 11, 10)
		}
		if dragonBefore.HP < 20 && damageDragon > 0 {
			damageDragon = min(damageDragon, ceilRatio(dragonBefore.HP, 3, 5))
		}
		if tigerBefore.HP < 20 && damageTiger > 0 {
			damageTiger = min(damageTiger, ceilRatio(tigerBefore.HP, 3, 5))
		}
		// Dragon Tiger rules double the final normal-rules damage using integers only.
		damageDragon *= 2
		damageTiger *= 2
		if damageDragon == 0 && damageTiger == 0 {
			noDamageRounds++
		} else {
			noDamageRounds = 0
		}
		environmentDamage := 0
		if noDamageRounds >= 5 {
			environmentDamage = 10 * (noDamageRounds - 4)
		}
		dragon = advanceFighter(dragonBefore, dragonAction, damageDragon)
		tiger = advanceFighter(tigerBefore, tigerAction, damageTiger)
		if dragonAction == Charge && damageDragon > 0 {
			dragon.ChargeInterrupted++
		}
		if tigerAction == Charge && damageTiger > 0 {
			tiger.ChargeInterrupted++
		}
		if dragon.Charged && tiger.Charged {
			bothChargedRounds++
		} else {
			bothChargedRounds = 0
		}
		if bothChargedRounds > 2 {
			dragon.Charged, tiger.Charged = false, false
			dragon.ChargeUnused, tiger.ChargeUnused = 0, 0
			bothChargedRounds = 0
		}
		dragon.HP = max(0, dragonBefore.HP-damageDragon-environmentDamage)
		tiger.HP = max(0, tigerBefore.HP-damageTiger-environmentDamage)
		battle.Rounds = append(battle.Rounds, BattleRound{
			Round: roundNum, RandomIndexDragon: dragonIndex, RandomIndexTiger: tigerIndex,
			DragonAction: dragonAction, TigerAction: tigerAction, DragonDamage: damageDragon,
			TigerDamage: damageTiger, EnvironmentDamage: environmentDamage,
			DragonHP: dragon.HP, TigerHP: tiger.HP, DragonCharged: dragon.Charged, TigerCharged: tiger.Charged,
		})
		if dragon.HP <= 0 || tiger.HP <= 0 {
			break
		}
	}
	battle.DragonHP, battle.TigerHP = dragon.HP, tiger.HP
	switch {
	case dragon.HP > tiger.HP:
		battle.Result = "dragon"
	case tiger.HP > dragon.HP:
		battle.Result = "tiger"
	default:
		battle.Result = "draw"
	}
	return battle, nil
}

func advanceFighter(before fighterState, action Action, damageReceived int) fighterState {
	after := before
	if action == Attack && before.Charged {
		after.Charged, after.ChargeUnused = false, 0
	} else if action == Charge && damageReceived == 0 {
		after.Charged = true
	}
	if after.Charged {
		if before.Charged {
			after.ChargeUnused++
		} else {
			after.ChargeUnused = 0
		}
		if after.ChargeUnused >= 2 {
			after.Charged, after.ChargeUnused = false, 0
		}
	} else {
		after.ChargeUnused = 0
	}
	return after
}

func decide(seed []byte, roundID uint64, version uint16, index uint64, self, opponent fighterState) Action {
	weights := []int{50, 25, 15, 10}
	if self.Charged && opponent.Charged {
		weights = []int{60, 30, 0, 10}
	} else if opponent.Charged {
		weights = []int{15, 40, 10, 35}
	} else if self.Charged {
		weights = []int{70, 20, 0, 10}
	}
	if opponent.HP < 30 {
		weights[0] += 15
	}
	if self.HP < 20 && !opponent.Charged {
		weights[2] += 10
	}
	if self.ChargeInterrupted >= 2 {
		weights[0] += 20
		weights[2] = 0
	}
	buf := make([]byte, 18)
	binary.BigEndian.PutUint64(buf[0:8], roundID)
	binary.BigEndian.PutUint16(buf[8:10], version)
	binary.BigEndian.PutUint64(buf[10:18], index)
	h := sha256.New()
	_, _ = h.Write(seed)
	_, _ = h.Write(buf)
	pick := binary.BigEndian.Uint64(h.Sum(nil)[:8]) % uint64(weights[0]+weights[1]+weights[2]+weights[3])
	actions := []Action{Attack, Defend, Charge, Counter}
	for i, weight := range weights {
		if pick < uint64(weight) {
			return actions[i]
		}
		pick -= uint64(weight)
	}
	return Counter
}

func ceilRatio(value, numerator, denominator int) int {
	return (value*numerator + denominator - 1) / denominator
}
