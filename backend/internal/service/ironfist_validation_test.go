package service

import (
	"encoding/json"
	"testing"
)

func validReport() *ReportMatchRequest {
	return &ReportMatchRequest{
		Mode:             "pve",
		Result:           "win",
		PlayerHP:         80,
		OpponentHP:       0,
		CounterSuccesses: 1,
		Rounds:           2,
		OpponentName:     "AI",
		Detail: json.RawMessage(`[
			{"r":1,"p":"counter","o":"attack","pd":0,"od":20},
			{"r":2,"p":"attack","o":"attack","pd":12,"od":12}
		]`),
	}
}

func TestValidateReportMatchRequest(t *testing.T) {
	if err := validateReportMatchRequest(validReport()); err != nil {
		t.Fatalf("valid report rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(*ReportMatchRequest)
	}{
		{"invalid result", func(r *ReportMatchRequest) { r.Result = "victory" }},
		{"hp out of range", func(r *ReportMatchRequest) { r.PlayerHP = 101 }},
		{"zero-round pve", func(r *ReportMatchRequest) { r.Rounds = 0; r.Detail = json.RawMessage(`[]`); r.CounterSuccesses = 0 }},
		{"invalid action", func(r *ReportMatchRequest) {
			r.Detail = json.RawMessage(`[{"r":1,"p":"hack","o":"attack","pd":0,"od":20},{"r":2,"p":"attack","o":"attack","pd":12,"od":12}]`)
		}},
		{"counter mismatch", func(r *ReportMatchRequest) { r.CounterSuccesses = 0 }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := validReport()
			tt.mutate(r)
			if err := validateReportMatchRequest(r); err == nil {
				t.Fatal("invalid report accepted")
			}
		})
	}
}

func TestValidatePVPSettleRetry(t *testing.T) {
	roomID := uint64(7)
	r := &ReportMatchRequest{Mode: "pvp", Result: "draw", RoomID: &roomID}
	if err := validateReportMatchRequest(r); err != nil {
		t.Fatalf("settle retry rejected: %v", err)
	}
}
