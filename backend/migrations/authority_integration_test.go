package migrations

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/go-sql-driver/mysql"

	"e2eechat/internal/service"
)

var authorityTestDatabasePattern = regexp.MustCompile(`^michat_authority_test_[0-9a-f]{16}$`)

func TestAuthorityMigrationRegistered(t *testing.T) {
	if strings.TrimSpace(ironfistAuthoritySQL) == "" {
		t.Fatal("authority migration is not embedded")
	}
}

func TestAuthorityMigrationCreatesConstraints(t *testing.T) {
	dsn := os.Getenv("MYSQL_TEST_DSN")
	if dsn == "" {
		t.Skip("MYSQL_TEST_DSN is required for MySQL integration")
	}
	db := openIsolatedAuthorityTestDatabase(t, dsn)
	if err := AutoMigrate(db); err != nil {
		t.Fatal(err)
	}
	if err := AutoMigrate(db); err != nil {
		t.Fatalf("authority migration is not idempotent: %v", err)
	}

	for _, table := range []string{
		"ironfist_games",
		"ironfist_game_actions",
		"ironfist_game_rounds",
		"ironfist_active_pve",
		"ironfist_outbox",
		"system_migration_markers",
		"attachments",
		"attachment_chunks",
	} {
		assertTableExists(t, db, table)
	}
	assertUniqueIndex(t, db, "ironfist_game_actions", "uq_ifga_round_seat")
	assertUniqueIndex(t, db, "ironfist_game_actions", "uq_ifga_request")
	assertUniqueIndex(t, db, "ironfist_game_rounds", "uq_ifgr_round")
	assertUniqueIndex(t, db, "ironfist_matches", "uq_im_authoritative_game")
	assertUniqueIndex(t, db, "fist_transactions", "uq_ft_settlement_ref")
	assertIndex(t, db, "ironfist_outbox", "idx_ifo_unpublished")
	assertIndex(t, db, "attachments", "idx_attachments_owner_quota")
	assertIndex(t, db, "attachments", "idx_attachments_recipient")
	assertIndex(t, db, "attachments", "idx_attachments_cleanup")
	assertForeignKey(t, db, "ironfist_game_actions", "ironfist_games", "CASCADE")
	assertForeignKey(t, db, "ironfist_game_rounds", "ironfist_games", "CASCADE")
	assertForeignKey(t, db, "ironfist_active_pve", "ironfist_games", "CASCADE")
	assertForeignKey(t, db, "attachments", "users", "CASCADE")
	assertForeignKey(t, db, "attachment_chunks", "attachments", "CASCADE")
	for _, column := range []string{"encrypted_envelope", "envelope_size", "recipient_applied_at", "recalled_at", "recall_applied_at"} {
		assertColumnExists(t, db, "message_deliveries", column)
	}
	for _, column := range []string{"file_key", "filename", "mime_type"} {
		assertColumnMissing(t, db, "attachments", column)
	}
	assertReliableInboxRoundTrip(t, db)
}

func assertReliableInboxRoundTrip(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO users (chat_id, nickname, public_key, is_ready) VALUES
		('1000-AAAA', 'sender', 'sender-key', 1), ('2000-BBBB', 'recipient', 'recipient-key', 1)`); err != nil {
		t.Fatal(err)
	}
	svc := service.NewMessageReadService(db)
	ctx := context.Background()
	envelope := json.RawMessage(`{"ephemeral_pub_key":"key","iv":"iv","ciphertext":"ciphertext","burn_after_read":false}`)
	delivery, created, err := svc.AcceptEncryptedMessage(ctx, "abc123-1-abcdef", "1000-AAAA", "2000-BBBB", envelope)
	if err != nil || !created || delivery.SentAt <= 0 {
		t.Fatalf("accept encrypted message: delivery=%+v created=%v err=%v", delivery, created, err)
	}
	pending, err := svc.GetPendingEncryptedMessages(ctx, "2000-BBBB", 10)
	if err != nil || len(pending) != 1 || string(pending[0].Envelope) != string(envelope) {
		t.Fatalf("load encrypted inbox: pending=%+v err=%v", pending, err)
	}
	if err = svc.MarkEncryptedMessagesApplied(ctx, []string{delivery.MsgID}, "1000-AAAA", "2000-BBBB"); err != nil {
		t.Fatal(err)
	}
	pending, err = svc.GetPendingEncryptedMessages(ctx, "2000-BBBB", 10)
	if err != nil || len(pending) != 0 {
		t.Fatalf("ciphertext was not cleared after ACK: pending=%+v err=%v", pending, err)
	}
	if _, found, recallErr := svc.RecallMessage(ctx, delivery.MsgID, "1000-AAAA", "2000-BBBB"); recallErr != nil || !found {
		t.Fatalf("persist recall: found=%v err=%v", found, recallErr)
	}
	recalls, err := svc.GetPendingRecalls(ctx, "2000-BBBB", 10)
	if err != nil || len(recalls) != 1 || recalls[0].MsgID != delivery.MsgID {
		t.Fatalf("load recall inbox: recalls=%+v err=%v", recalls, err)
	}
	if err = svc.MarkRecallsApplied(ctx, []string{delivery.MsgID}, "1000-AAAA", "2000-BBBB"); err != nil {
		t.Fatal(err)
	}
	recalls, err = svc.GetPendingRecalls(ctx, "2000-BBBB", 10)
	if err != nil || len(recalls) != 0 {
		t.Fatalf("recall was not cleared after ACK: recalls=%+v err=%v", recalls, err)
	}
}

func openIsolatedAuthorityTestDatabase(t *testing.T, dsn string) *sql.DB {
	t.Helper()
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatalf("parse MYSQL_TEST_DSN: %v", err)
	}
	adminCfg := *cfg
	if adminCfg.DBName == "" {
		adminCfg.DBName = "mysql"
	}
	admin, err := sql.Open("mysql", adminCfg.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	if err := admin.Ping(); err != nil {
		admin.Close()
		t.Fatalf("connect to MySQL test server: %v", err)
	}

	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	databaseName := "michat_authority_test_" + hex.EncodeToString(random)
	if !authorityTestDatabasePattern.MatchString(databaseName) {
		admin.Close()
		t.Fatalf("unsafe generated test database name %q", databaseName)
	}
	if _, err := admin.Exec("CREATE DATABASE `" + databaseName + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"); err != nil {
		admin.Close()
		t.Fatal(err)
	}

	t.Cleanup(func() {
		if !authorityTestDatabasePattern.MatchString(databaseName) {
			t.Errorf("refusing to drop unsafe test database name %q", databaseName)
			return
		}
		if _, err := admin.Exec("DROP DATABASE `" + databaseName + "`"); err != nil {
			t.Errorf("drop test database %s: %v", databaseName, err)
		}
		if err := admin.Close(); err != nil {
			t.Errorf("close admin database: %v", err)
		}
	})

	testCfg := *cfg
	testCfg.DBName = databaseName
	db, err := sql.Open("mysql", testCfg.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func assertTableExists(t *testing.T, db *sql.DB, table string) {
	t.Helper()
	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`, table).Scan(&count)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("table %s does not exist", table)
	}
}

func assertColumnExists(t *testing.T, db *sql.DB, table, column string) {
	t.Helper()
	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, table, column).Scan(&count)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("column %s.%s does not exist", table, column)
	}
}

func assertColumnMissing(t *testing.T, db *sql.DB, table, column string) {
	t.Helper()
	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, table, column).Scan(&count)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("column %s.%s must not exist", table, column)
	}
}

func assertUniqueIndex(t *testing.T, db *sql.DB, table, index string) {
	t.Helper()
	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? AND non_unique = 0`, table, index).Scan(&count)
	if err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatalf("unique index %s.%s does not exist", table, index)
	}
}

func assertIndex(t *testing.T, db *sql.DB, table, index string) {
	t.Helper()
	var count int
	err := db.QueryRow(`SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, table, index).Scan(&count)
	if err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatalf("index %s.%s does not exist", table, index)
	}
}

func assertForeignKey(t *testing.T, db *sql.DB, table, referencedTable, deleteRule string) {
	t.Helper()
	var count int
	err := db.QueryRow(`
		SELECT COUNT(*)
		FROM information_schema.referential_constraints
		WHERE constraint_schema = DATABASE()
		  AND table_name = ?
		  AND referenced_table_name = ?
		  AND delete_rule = ?`, table, referencedTable, deleteRule).Scan(&count)
	if err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatalf("foreign key %s -> %s with ON DELETE %s does not exist", table, referencedTable, deleteRule)
	}
}

func TestAuthorityDatabaseNameGuard(t *testing.T) {
	for _, name := range []string{"mysql", "michat_authority_test_bad-name", "michat_authority_test_1234`; DROP DATABASE mysql; --"} {
		t.Run(fmt.Sprintf("reject_%q", name), func(t *testing.T) {
			if authorityTestDatabasePattern.MatchString(name) {
				t.Fatalf("unsafe name %q passed the database guard", name)
			}
		})
	}
}
