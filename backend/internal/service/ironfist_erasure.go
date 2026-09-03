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
	if err := refundDragonTigerBetsForDeletion(ctx, tx, userID); err != nil {
		return err
	}
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

func refundDragonTigerBetsForDeletion(ctx context.Context, tx *sql.Tx, userID uint64) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT round_id, selection, stake_amount
		FROM ironfist_dragon_tiger_bets
		WHERE user_id=? AND status='active' ORDER BY round_id`, userID)
	if err != nil {
		return err
	}
	type activeBet struct {
		roundID   uint64
		selection string
		stake     int64
	}
	var bets []activeBet
	for rows.Next() {
		var bet activeBet
		if err := rows.Scan(&bet.roundID, &bet.selection, &bet.stake); err != nil {
			rows.Close()
			return err
		}
		bets = append(bets, bet)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, bet := range bets {
		var roundStatus string
		if err := tx.QueryRowContext(ctx, `SELECT status FROM ironfist_dragon_tiger_rounds WHERE id=? FOR UPDATE`, bet.roundID).Scan(&roundStatus); err != nil {
			return err
		}
		if roundStatus == "settled" || roundStatus == "voided" {
			continue
		}
		var status string
		if err := tx.QueryRowContext(ctx, `SELECT status FROM ironfist_dragon_tiger_bets WHERE round_id=? AND user_id=? FOR UPDATE`, bet.roundID, userID).Scan(&status); err != nil {
			return err
		}
		if status != "active" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `UPDATE fist_accounts SET balance=balance+? WHERE user_id=?`, bet.stake, userID); err != nil {
			return err
		}
		if err := writeDragonTigerFistTx(ctx, tx, userID, bet.stake, "dragon_tiger_refund", fmt.Sprintf("dt:refund:%d:%d", bet.roundID, userID), "账号删除前龙虎斗退款"); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_bets SET payout_amount=stake_amount,status='refunded',settled_at=UTC_TIMESTAMP(3) WHERE round_id=? AND user_id=?`, bet.roundID, userID); err != nil {
			return err
		}
		column := map[string]string{"dragon": "dragon_bet_total", "tiger": "tiger_bet_total", "draw": "draw_bet_total"}[bet.selection]
		if column == "" {
			return fmt.Errorf("invalid dragon tiger selection %q", bet.selection)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_rounds SET `+column+`=GREATEST(0,`+column+`-?),state_version=state_version+1 WHERE id=?`, bet.stake, bet.roundID); err != nil {
			return err
		}
	}
	return nil
}
