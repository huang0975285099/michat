package dragontiger

import (
	"crypto/sha256"
	"encoding/json"
	"testing"
)

func TestGenerateDeterministic(t *testing.T) {
	seed := sha256.Sum256([]byte("test-seed"))
	a, err := Generate(seed[:], 42, RulesVersion)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Generate(seed[:], 42, RulesVersion)
	if err != nil {
		t.Fatal(err)
	}
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) {
		t.Fatal("same seed did not produce the same battle")
	}
	if len(a.Rounds) == 0 || len(a.Rounds) > MaxRounds {
		t.Fatalf("invalid round count %d", len(a.Rounds))
	}
	if a.Result != "dragon" && a.Result != "tiger" && a.Result != "draw" {
		t.Fatalf("invalid result %q", a.Result)
	}
}

func TestGenerateUsesFixedRandomOrder(t *testing.T) {
	seed := sha256.Sum256([]byte("order"))
	battle, err := Generate(seed[:], 7, RulesVersion)
	if err != nil {
		t.Fatal(err)
	}
	for i, round := range battle.Rounds {
		if round.RandomIndexDragon != uint64(i*2) || round.RandomIndexTiger != uint64(i*2+1) {
			t.Fatalf("round %d consumed indexes %d/%d", i+1, round.RandomIndexDragon, round.RandomIndexTiger)
		}
	}
}
