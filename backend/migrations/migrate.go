package migrations

import (
	"database/sql"
	_ "embed"
	"fmt"
	"strings"
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

// AutoMigrate 自动执行建表 SQL，幂等（IF NOT EXISTS）。
func AutoMigrate(db *sql.DB) error {
	migrations := []string{initSQL, messageReadsSQL, deviceTokensSQL, fistTokenSQL, ironfistStatsSQL, ironfistMatchesSQL}
	for _, sql := range migrations {
		for _, stmt := range splitStatements(sql) {
			if _, err := db.Exec(stmt); err != nil {
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
