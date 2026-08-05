package ironfistengine

import "errors"

const RulesVersion uint16 = 1

type Action string

const (
	Attack  Action = "attack"
	Defend  Action = "defend"
	Charge  Action = "charge"
	Counter Action = "counter"
)

func (a Action) Valid() bool {
	switch a {
	case Attack, Defend, Charge, Counter:
		return true
	default:
		return false
	}
}

type Seat string

const (
	SeatA Seat = "a"
	SeatB Seat = "b"
)

type Outcome string

const (
	OutcomeNone Outcome = ""
	WinA        Outcome = "win_a"
	WinB        Outcome = "win_b"
	Draw        Outcome = "draw"
	DoubleLose  Outcome = "doubleLose"
)

var ErrInvalidAction = errors.New("invalid IronFist action")

type State struct {
	HPA                       int  `json:"hp_a"`
	HPB                       int  `json:"hp_b"`
	ChargedA                  bool `json:"charged_a"`
	ChargedB                  bool `json:"charged_b"`
	ChargeUnusedA             int  `json:"charge_unused_a"`
	ChargeUnusedB             int  `json:"charge_unused_b"`
	ConsecutiveNoDamageRounds int  `json:"consecutive_no_damage_rounds"`
	TotalRounds               int  `json:"total_rounds"`
	BothChargedStalemate      int  `json:"both_charged_stalemate"`
	AIChargeInterrupted       int  `json:"ai_charge_interrupted"`
}

func InitialState() State {
	return State{HPA: initialHP, HPB: initialHP}
}

type RoundResult struct {
	ActionA           Action  `json:"action_a"`
	ActionB           Action  `json:"action_b"`
	DamageA           int     `json:"damage_a"`
	DamageB           int     `json:"damage_b"`
	EnvironmentDamage int     `json:"environment_damage"`
	State             State   `json:"state"`
	Outcome           Outcome `json:"outcome"`
}
