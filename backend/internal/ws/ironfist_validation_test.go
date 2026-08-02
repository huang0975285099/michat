package ws

import "testing"

func TestValidIronFistAction(t *testing.T) {
	for _, action := range []string{"attack", "defend", "charge", "counter"} {
		if !validIronFistAction(action) {
			t.Fatalf("valid action rejected: %s", action)
		}
	}
	for _, action := range []string{"", "Attack", "hack", "attack\n"} {
		if validIronFistAction(action) {
			t.Fatalf("invalid action accepted: %q", action)
		}
	}
}
