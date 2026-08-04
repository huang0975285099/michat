package migrations

import (
	"reflect"
	"testing"
)

func TestSplitStatementsIgnoresSemicolonsInComments(t *testing.T) {
	src := `
-- Friend mode is separate; it is not included in total games.
USE e2eechat;
ALTER TABLE ironfist_stats
  ADD COLUMN friend_games INT NOT NULL DEFAULT 0; -- tracked separately; safe to rerun
UPDATE ironfist_stats SET friend_games = 0;
`

	want := []string{
		"ALTER TABLE ironfist_stats\nADD COLUMN friend_games INT NOT NULL DEFAULT 0",
		"UPDATE ironfist_stats SET friend_games = 0",
	}
	if got := splitStatements(src); !reflect.DeepEqual(got, want) {
		t.Fatalf("splitStatements() = %#v, want %#v", got, want)
	}
}
