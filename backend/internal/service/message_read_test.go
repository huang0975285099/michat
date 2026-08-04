package service

import "testing"

func TestMsgIDTimestamp(t *testing.T) {
	tests := []struct {
		name  string
		msgID string
		want  int64
		ok    bool
	}{
		{name: "generated id", msgID: "loyw3v28-1-abc123", want: 1700000000000, ok: true},
		{name: "uppercase base36 rejected", msgID: "LOYW3V28-1-abc123", ok: false},
		{name: "missing separators", msgID: "loyw3v28", ok: false},
		{name: "empty timestamp", msgID: "-1-abc123", ok: false},
		{name: "invalid base36", msgID: "not_a_time-1-abc123", ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := msgIDTimestamp(tt.msgID)
			if got != tt.want || ok != tt.ok {
				t.Fatalf("msgIDTimestamp(%q) = (%d, %v), want (%d, %v)", tt.msgID, got, ok, tt.want, tt.ok)
			}
		})
	}
}
