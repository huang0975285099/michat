package service

import (
	"testing"
	"time"
)

func TestDragonTigerPayoutUsesIntegerArithmetic(t *testing.T) {
	tests := []struct {
		stake     int64
		selection string
		result    string
		want      int64
	}{
		{20, "dragon", "dragon", 39},
		{100, "tiger", "tiger", 195},
		{100, "draw", "draw", 800},
		{100, "dragon", "tiger", 0},
	}
	for _, test := range tests {
		if got := dragonTigerPayout(test.stake, test.selection, test.result); got != test.want {
			t.Fatalf("payout(%d, %s, %s) = %d, want %d", test.stake, test.selection, test.result, got, test.want)
		}
	}
}

func TestDragonTigerSelections(t *testing.T) {
	for _, selection := range []string{"dragon", "tiger", "draw"} {
		if !validDragonTigerSelection(selection) {
			t.Fatalf("rejected %s", selection)
		}
	}
	for _, selection := range []string{"", "void", "DRAGON"} {
		if validDragonTigerSelection(selection) {
			t.Fatalf("accepted %s", selection)
		}
	}
}

func TestDragonTigerUTCWallClockDoesNotShiftDatabaseFields(t *testing.T) {
	local := time.Date(2026, 9, 3, 2, 15, 30, 123000000, time.FixedZone("PDT", -7*60*60))
	got := dragonTigerUTCWallClock(local)
	if got.Location() != time.UTC || got.Hour() != 2 || got.Minute() != 15 || got.Nanosecond() != 123000000 {
		t.Fatalf("UTC wall clock was shifted: %v", got)
	}
}

func TestDragonTigerDBTimestampIsAlwaysUTCWallClock(t *testing.T) {
	local := time.Date(2026, 9, 2, 19, 15, 30, 123000000, time.FixedZone("PDT", -7*60*60))
	if got := dragonTigerDBTimestamp(local); got != "2026-09-03 02:15:30.123" {
		t.Fatalf("database timestamp = %s", got)
	}
}
