package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"os"
	"regexp"
	"sync"
	"testing"
	"time"

	"e2eechat/migrations"
	"github.com/go-sql-driver/mysql"
)

var authorityServiceTestDatabasePattern = regexp.MustCompile(`^michat_service_test_[0-9a-f]{16}$`)

func TestResignAuthoritativeGameEnqueuesFinishedEvent(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	if _, err := db.Exec(`INSERT INTO users (chat_id, nickname, public_key, is_ready) VALUES ('1000-TSTA', 'seat a', 'test-key', 1)`); err != nil {
		t.Fatal(err)
	}

	service := NewIronFistService(db)
	service.now = func() time.Time { return authorityFixedTime }
	service.random = bytes.NewReader(make([]byte, 64))
	service.newGameID = func() string { return "10000000-0000-4000-8000-000000000001" }

	view, err := service.StartRewardedPVE(context.Background(), 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ResignAuthoritativeGame(context.Background(), 1, view.GameID); err != nil {
		t.Fatal(err)
	}

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM ironfist_outbox WHERE game_id = ? AND event_type = 'ironfist_game_finished'`, view.GameID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("finished outbox events = %d, want 1", count)
	}
}

func TestEnqueuePVPConcurrentCandidatesMatchWaitingPlayerOnlyOnce(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	users := []struct {
		chatID string
		name   string
	}{
		{"1000-WAIT", "waiting player"},
		{"1001-CAND", "candidate one"},
		{"1002-CAND", "candidate two"},
	}
	for _, user := range users {
		if _, err := db.Exec(`INSERT INTO users (chat_id, nickname, public_key, is_ready) VALUES (?, ?, 'test-key', 1)`, user.chatID, user.name); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO fist_accounts (user_id, balance, total_earned) VALUES (1, 300, 300), (2, 300, 300), (3, 300, 300)`); err != nil {
		t.Fatal(err)
	}

	service := NewIronFistService(db)
	waiting, err := service.EnqueuePVP(context.Background(), 1, users[0].chatID, "gold")
	if err != nil || waiting.Status != "queued" {
		t.Fatalf("waiting enqueue = %+v, %v; want queued", waiting, err)
	}

	type outcome struct {
		result *PVPMatchResult
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan outcome, 2)
	var wg sync.WaitGroup
	for index := 1; index <= 2; index++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			result, err := service.EnqueuePVP(context.Background(), uint64(index+1), users[index].chatID, "gold")
			outcomes <- outcome{result: result, err: err}
		}(index)
	}
	close(start)
	wg.Wait()
	close(outcomes)

	matched := 0
	for outcome := range outcomes {
		if outcome.err != nil {
			t.Fatal(outcome.err)
		}
		if outcome.result.Status == "matched" {
			matched++
		}
	}
	if matched != 1 {
		t.Fatalf("matched candidates = %d, want 1", matched)
	}

	var games, waitingMatches, stakeEntries int
	if err := db.QueryRow(`SELECT COUNT(*) FROM ironfist_games WHERE player_a_user_id = 1`).Scan(&games); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM ironfist_pvp_rooms WHERE player_a_user_id = 1 AND status = 'matched'`).Scan(&waitingMatches); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM fist_transactions WHERE type = 'pvp_stake'`).Scan(&stakeEntries); err != nil {
		t.Fatal(err)
	}
	if games != 1 || waitingMatches != 1 || stakeEntries != 3 {
		t.Fatalf("games=%d waitingMatches=%d stakeEntries=%d; want 1, 1, 3", games, waitingMatches, stakeEntries)
	}

	polled, err := service.GetPVPQueueStatus(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if polled.Status != "matched" || polled.RoomID != waiting.RoomID || polled.GameID == "" || polled.Opponent == nil {
		t.Fatalf("waiting-player poll = %+v; want matched room, game, and opponent", polled)
	}
}

func openIsolatedAuthorityServiceTestDatabase(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("MYSQL_TEST_DSN")
	if dsn == "" {
		t.Skip("MYSQL_TEST_DSN is required for MySQL integration")
	}
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatal(err)
	}
	adminCfg := *cfg
	adminCfg.DBName = "mysql"
	admin, err := sql.Open("mysql", adminCfg.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	if err := admin.Ping(); err != nil {
		admin.Close()
		t.Fatal(err)
	}

	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	databaseName := "michat_service_test_" + hex.EncodeToString(random)
	if !authorityServiceTestDatabasePattern.MatchString(databaseName) {
		admin.Close()
		t.Fatalf("unsafe generated test database name %q", databaseName)
	}
	if _, err := admin.Exec("CREATE DATABASE `" + databaseName + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if authorityServiceTestDatabasePattern.MatchString(databaseName) {
			if _, err := admin.Exec("DROP DATABASE `" + databaseName + "`"); err != nil {
				t.Errorf("drop test database %s: %v", databaseName, err)
			}
		}
		_ = admin.Close()
	})

	testCfg := *cfg
	testCfg.DBName = databaseName
	db, err := sql.Open("mysql", testCfg.FormatDSN())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := migrations.AutoMigrate(db); err != nil {
		t.Fatal(err)
	}
	return db
}
