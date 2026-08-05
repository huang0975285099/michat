package service

import (
	"context"
	"database/sql"
	"fmt"

	"e2eechat/internal/ironfistengine"
)

// eraseIronFistAccountTx settles any live wager as a resignation and removes
// every game/FIST row that can retain the deleted user's identity. It runs in
// the caller's account-deletion transaction.
func (s *IdentityService) eraseIronFistAccountTx(ctx context.Context, tx *sql.Tx, userID uint64, chatID string) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT game_id FROM ironfist_games
		WHERE player_a_user_id = ? OR player_b_user_id = ?
		ORDER BY game_id FOR UPDATE`, userID, userID)
	if err != nil {
		return err
	}
	var gameIDs []string
	for rows.Next() {
		var gameID string
		if err := rows.Scan(&gameID); err != nil {
			rows.Close()
			return err
		}
		gameIDs = append(gameIDs, gameID)
	}
	if err := rows.Close(); err != nil {
		return err
	}

	ironSvc := NewIronFistService(s.db)
	for _, gameID := range gameIDs {
		game, err := loadAuthorityGameTx(ctx, tx, gameID, true)
		if err != nil {
			return err
		}
		if game.Status != "active" && game.Status != "waiting" {
			continue
		}
		if game.Mode == "pvp" && game.Status == "active" {
			outcome := ironfistengine.WinB
			if game.PlayerBUserID == userID {
				outcome = ironfistengine.WinA
			}
			if err := finishDueGameTx(ctx, tx, game, outcome, "account_deleted", ironSvc.authorityNow()); err != nil {
				return err
			}
			if err := ironSvc.settleCompletedGameTx(ctx, tx, game); err != nil {
				return fmt.Errorf("settle deletion resignation %s: %w", gameID, err)
			}
		} else if _, err := tx.ExecContext(ctx, `
			UPDATE ironfist_games SET status = 'abandoned', finish_reason = 'account_deleted',
			finished_at = ?, last_activity_at = ? WHERE game_id = ?`,
			ironSvc.authorityNow(), ironSvc.authorityNow(), gameID); err != nil {
			return err
		}
	}

	statements := []struct {
		query string
		args  []any
	}{
		{`DELETE FROM ironfist_matches WHERE authoritative_game_id IN
			(SELECT game_id FROM ironfist_games WHERE player_a_user_id = ? OR player_b_user_id = ?)`, []any{userID, userID}},
		{`DELETE FROM ironfist_games WHERE player_a_user_id = ? OR player_b_user_id = ?`, []any{userID, userID}},
		{`DELETE FROM pvp_rounds WHERE match_id IN
			(SELECT match_id FROM pvp_matches WHERE player_a_id = ? OR player_b_id = ?)`, []any{userID, userID}},
		{`DELETE FROM pvp_matches WHERE player_a_id = ? OR player_b_id = ?`, []any{userID, userID}},
		{`DELETE FROM ironfist_pvp_rooms WHERE player_a_user_id = ? OR player_b_user_id = ?`, []any{userID, userID}},
		{`DELETE FROM fist_transactions WHERE user_id = ? OR remark LIKE ?`, []any{userID, "%" + chatID + "%"}},
		{`DELETE FROM pve_daily_progress WHERE user_id = ?`, []any{userID}},
		{`DELETE FROM ironfist_achievements WHERE user_id = ?`, []any{userID}},
		{`DELETE FROM ironfist_stats WHERE user_id = ?`, []any{userID}},
		{`DELETE FROM ironfist_matches WHERE user_id = ?`, []any{userID}},
		{`DELETE FROM fist_accounts WHERE user_id = ?`, []any{userID}},
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement.query, statement.args...); err != nil {
			return err
		}
	}
	return nil
}
