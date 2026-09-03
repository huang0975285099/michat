package migrations

import (
	"reflect"
	"strings"
	"testing"
)

func TestReliableMessageInboxMigrationRegistered(t *testing.T) {
	if strings.TrimSpace(reliableMessageInboxSQL) == "" {
		t.Fatal("reliable message inbox migration is not embedded")
	}
	for _, required := range []string{"encrypted_envelope", "recipient_applied_at", "recalled_at", "recall_applied_at"} {
		if !strings.Contains(reliableMessageInboxSQL, required) {
			t.Fatalf("reliable inbox migration is missing %s", required)
		}
	}
}

func TestEncryptedAttachmentsMigrationRegisteredWithoutPlaintextMetadata(t *testing.T) {
	if strings.TrimSpace(encryptedAttachmentsSQL) == "" {
		t.Fatal("encrypted attachments migration is not embedded")
	}
	for _, required := range []string{"attachments", "attachment_chunks", "ciphertext_sha256", "expires_at", "acknowledged_at"} {
		if !strings.Contains(encryptedAttachmentsSQL, required) {
			t.Fatalf("encrypted attachments migration is missing %s", required)
		}
	}
	for _, forbidden := range []string{"\n  file_key ", "\n  filename ", "\n  mime_type "} {
		if strings.Contains(encryptedAttachmentsSQL, forbidden) {
			t.Fatalf("encrypted attachments migration must not store %s", forbidden)
		}
	}
}

func TestDragonTigerMigrationRegistered(t *testing.T) {
	if strings.TrimSpace(ironfistDragonTigerSQL) == "" {
		t.Fatal("dragon tiger migration is not embedded")
	}
	for _, required := range []string{
		"ironfist_dragon_tiger_rounds", "ironfist_dragon_tiger_bets",
		"ironfist_dragon_tiger_bet_commands", "ironfist_dragon_tiger_outbox",
		"dragon_tiger_bet", "dragon_tiger_payout", "dragon_tiger_refund",
	} {
		if !strings.Contains(ironfistDragonTigerSQL, required) {
			t.Fatalf("dragon tiger migration is missing %s", required)
		}
	}
}

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
