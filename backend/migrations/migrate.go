package migrations

import (
	"context"
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

//go:embed 020_users_is_admin.sql
var usersIsAdminSQL string

//go:embed 021_ironfist_authority.sql
var ironfistAuthoritySQL string

//go:embed 022_reliable_message_inbox.sql
var reliableMessageInboxSQL string

//go:embed 023_encrypted_attachments.sql
var encryptedAttachmentsSQL string

//go:embed 024_ironfist_dragon_tiger.sql
var ironfistDragonTigerSQL string

//go:embed 025_robot_articles.sql
var robotArticlesSQL string

//go:embed 026_robot_article_views.sql
var robotArticleViewsSQL string

//go:embed 027_robot_discovery.sql
var robotDiscoverySQL string

//go:embed 028_robot_article_source.sql
var robotArticleSourceSQL string

//go:embed 029_intelligence_companies.sql
var intelligenceCompaniesSQL string

//go:embed 030_intelligence_company_seed.sql
var intelligenceCompanySeedSQL string

//go:embed 031_groups.sql
var groupsSQL string

//go:embed 032_group_attachments.sql
var groupAttachmentsSQL string

//go:embed 033_attachment_nullable_recipient.sql
var attachmentNullableRecipientSQL string

//go:embed 034_authenticated_control_proofs.sql
var authenticatedControlProofsSQL string

//go:embed 035_group_message_reads.sql
var groupMessageReadsSQL string

//go:embed 036_permanent_group_mutes.sql
var permanentGroupMutesSQL string

type migration struct {
	version       string
	source        string
	transactional bool
}

func AutoMigrate(db *sql.DB) (resultErr error) {
	ctx := context.Background()
	connection, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer connection.Close()
	var acquired sql.NullInt64
	if err := connection.QueryRowContext(ctx, "SELECT GET_LOCK(SHA2(CONCAT(DATABASE(), ':michat:migrations'), 256), 30)").Scan(&acquired); err != nil {
		return fmt.Errorf("migration lock: %w", err)
	}
	if !acquired.Valid || acquired.Int64 != 1 {
		return errors.New("migration lock unavailable")
	}
	defer func() {
		var released sql.NullInt64
		err := connection.QueryRowContext(ctx, "SELECT RELEASE_LOCK(SHA2(CONCAT(DATABASE(), ':michat:migrations'), 256))").Scan(&released)
		if resultErr == nil && (err != nil || !released.Valid || released.Int64 != 1) {
			resultErr = fmt.Errorf("migration lock release failed: %v", err)
		}
	}()
	if _, err := connection.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version VARCHAR(128) NOT NULL PRIMARY KEY,
		applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`); err != nil {
		return fmt.Errorf("migration version table: %w", err)
	}
	migrations := []migration{
		{"001_init", initSQL, false},
		{"002_message_reads", messageReadsSQL, false},
		{"003_device_tokens", deviceTokensSQL, false},
		{"004_fist_token", fistTokenSQL, false},
		{"005_ironfist_stats", ironfistStatsSQL, false},
		{"006_ironfist_matches", ironfistMatchesSQL, false},
		{"007_ironfist_friend_mode", ironfistFriendModeSQL, false},
		{"008_ironfist_pvp_matchmaking", ironfistPvpMatchmakingSQL, false},
		{"009_ironfist_match_pvp_room", ironfistMatchPvpRoomSQL, false},
		{"010_ironfist_pvp_reports", ironfistPvpReportsSQL, false},
		{"011_fist_tx_pvp_refund", fistTxPvpRefundSQL, false},
		{"015_ironfist_pve_reward_claim", ironfistPveRewardClaimSQL, false},
		{"017_message_deliveries", messageDeliveriesSQL, false},
		{"018_message_read_tombstones", messageReadTombstonesSQL, false},
		{"019_drop_slg_tables", dropSlgTablesSQL, false},
		{"020_users_is_admin", usersIsAdminSQL, false},
		{"021_ironfist_authority", ironfistAuthoritySQL, false},
		{"022_reliable_message_inbox", reliableMessageInboxSQL, false},
		{"023_encrypted_attachments", encryptedAttachmentsSQL, false},
		{"024_ironfist_dragon_tiger", ironfistDragonTigerSQL, false},
		{"025_robot_articles", robotArticlesSQL, false},
		{"026_robot_article_views", robotArticleViewsSQL, false},
		{"027_robot_discovery", robotDiscoverySQL, false},
		{"028_robot_article_source", robotArticleSourceSQL, false},
		{"029_intelligence_companies", intelligenceCompaniesSQL, false},
		{"030_intelligence_company_seed", intelligenceCompanySeedSQL, false},
		{"031_groups", groupsSQL, false},
		{"032_group_attachments", groupAttachmentsSQL, false},
		{"033_attachment_nullable_recipient", attachmentNullableRecipientSQL, false},
		{"034_authenticated_control_proofs", authenticatedControlProofsSQL, false},
		{"035_group_message_reads", groupMessageReadsSQL, true},
		{"036_permanent_group_mutes", permanentGroupMutesSQL, true},
	}
	for _, item := range migrations {
		var applied bool
		if err := connection.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?)", item.version).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		if err := applyMigration(ctx, connection, item); err != nil {
			return fmt.Errorf("migration %s: %w", item.version, err)
		}
	}
	return nil
}

func applyMigration(ctx context.Context, connection *sql.Conn, item migration) error {
	statements := splitStatements(item.source)
	if item.transactional {
		for len(statements) > 0 && strings.HasPrefix(strings.ToUpper(statements[0]), "CREATE TABLE") {
			if _, err := connection.ExecContext(ctx, statements[0]); err != nil {
				return err
			}
			statements = statements[1:]
		}
		transaction, err := connection.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer transaction.Rollback()
		for _, statement := range statements {
			if _, err := transaction.ExecContext(ctx, statement); err != nil {
				return err
			}
		}
		if _, err := transaction.ExecContext(ctx, "INSERT INTO schema_migrations (version) VALUES (?)", item.version); err != nil {
			return err
		}
		return transaction.Commit()
	}
	for _, stmt := range statements {
		if _, err := connection.ExecContext(ctx, stmt); err != nil {
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
	_, err := connection.ExecContext(ctx, "INSERT INTO schema_migrations (version) VALUES (?)", item.version)
	return err
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
