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

// AutoMigrate 自动执行建表 SQL，幂等（IF NOT EXISTS）。
// MySQL 1060（列已存在）和 1061（索引已存在）被视为已完成，静默跳过。
func AutoMigrate(db *sql.DB) error {
	migrations := []string{initSQL, messageReadsSQL, deviceTokensSQL, fistTokenSQL, ironfistStatsSQL, ironfistMatchesSQL, ironfistFriendModeSQL, ironfistPvpMatchmakingSQL, ironfistMatchPvpRoomSQL, ironfistPvpReportsSQL, fistTxPvpRefundSQL}
	for _, sql := range migrations {
		for _, stmt := range splitStatements(sql) {
			if _, err := db.Exec(stmt); err != nil {
				var myErr *mysql.MySQLError
				if errors.As(err, &myErr) && (myErr.Number == 1060 || myErr.Number == 1061) {
					// 1060 = ER_DUP_FIELDNAME (ADD COLUMN 已存在)
					// 1061 = ER_DUP_KEY_NAME  (ADD INDEX 已存在)
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
	for _, s := range strings.Split(src, ";") {
		var lines []string
		for _, line := range strings.Split(s, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "--") {
				continue
			}
			lines = append(lines, line)
		}
		if len(lines) == 0 {
			continue
		}
		stmt := strings.Join(lines, "\n")
		upper := strings.ToUpper(stmt)
		// 跳过 CREATE DATABASE 和 USE，已由 pkg/mysql 处理
		if strings.HasPrefix(upper, "CREATE DATABASE") || strings.HasPrefix(upper, "USE ") {
			continue
		}
		result = append(result, stmt)
	}
	return result
}
