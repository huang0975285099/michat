package migrations

import (
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"strings"

	"github.com/go-sql-driver/mysql"
)

//go:embed 001_init.sql
var initSQL string

//go:embed 002_message_reads.sql
var messageReadsSQL string

//go:embed 003_device_tokens.sql
var deviceTokensSQL string

//go:embed 004_fist_token.sql
var fistTokenSQL string

//go:embed 005_ironfist_stats.sql
var ironfistStatsSQL string

//go:embed 006_ironfist_matches.sql
var ironfistMatchesSQL string

//go:embed 007_ironfist_friend_mode.sql
var ironfistFriendModeSQL string

//go:embed 008_ironfist_pvp_matchmaking.sql
var ironfistPvpMatchmakingSQL string

//go:embed 009_ironfist_match_pvp_room.sql
var ironfistMatchPvpRoomSQL string

//go:embed 010_ironfist_pvp_reports.sql
var ironfistPvpReportsSQL string

//go:embed 011_fist_tx_pvp_refund.sql
var fistTxPvpRefundSQL string

//go:embed 015_ironfist_pve_reward_claim.sql
var ironfistPveRewardClaimSQL string

//go:embed 016_ironfist_points_ledger_fix.sql
var ironfistPointsLedgerFixSQL string

//go:embed 017_message_deliveries.sql
var messageDeliveriesSQL string

//go:embed 018_message_read_tombstones.sql
var messageReadTombstonesSQL string

//go:embed 019_drop_slg_tables.sql
var dropSlgTablesSQL string

// AutoMigrate automatically executes table creation SQL, idempotent (IF NOT EXISTS).
// MySQL 1060 (column already exists), 1061 (index already exists) and 1091 (key to be deleted no longer exists)
// Considered completed and silently skipped.
func AutoMigrate(db *sql.DB) error {
	migrations := []string{initSQL, messageReadsSQL, deviceTokensSQL, fistTokenSQL, ironfistStatsSQL, ironfistMatchesSQL, ironfistFriendModeSQL, ironfistPvpMatchmakingSQL, ironfistMatchPvpRoomSQL, ironfistPvpReportsSQL, fistTxPvpRefundSQL, ironfistPveRewardClaimSQL, ironfistPointsLedgerFixSQL, messageDeliveriesSQL, messageReadTombstonesSQL, dropSlgTablesSQL}
	for _, sql := range migrations {
		for _, stmt := range splitStatements(sql) {
			if _, err := db.Exec(stmt); err != nil {
				var myErr *mysql.MySQLError
				if errors.As(err, &myErr) && (myErr.Number == 1060 || myErr.Number == 1061 || myErr.Number == 1091) {
					// 1060 = ER_DUP_FIELDNAME (ADD COLUMN already exists)
					// 1061 = ER_DUP_KEY_NAME (ADD INDEX already exists)
					// 1091 = ER_CANT_DROP_FIELD_OR_KEY (compatible with old foreign keys that no longer exist on the new library)
					continue
				}
				preview := stmt
				if len(preview) > 60 {
					preview = preview[:60] + "..."
				}
				return fmt.Errorf("migrate [%s]: %w", preview, err)
			}
		}
	}
	return nil
}

func splitStatements(src string) []string {
	var result []string
	// Remove line comments before splitting on semicolons. A comment may itself
	// contain a semicolon; splitting first would turn the remainder of that
	// comment into an executable SQL statement.
	var uncommented []string
	for _, line := range strings.Split(src, "\n") {
		if commentAt := strings.Index(line, "--"); commentAt >= 0 {
			line = line[:commentAt]
		}
		uncommented = append(uncommented, line)
	}

	for _, s := range strings.Split(strings.Join(uncommented, "\n"), ";") {
		var lines []string
		for _, line := range strings.Split(s, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			lines = append(lines, line)
		}
		if len(lines) == 0 {
			continue
		}
		stmt := strings.Join(lines, "\n")
		upper := strings.ToUpper(stmt)
		// Skip CREATE DATABASE and USE, already handled by pkg/mysql
		if strings.HasPrefix(upper, "CREATE DATABASE") || strings.HasPrefix(upper, "USE ") {
			continue
		}
		result = append(result, stmt)
	}
	return result
}
