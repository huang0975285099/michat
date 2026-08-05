package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"e2eechat/internal/ironfistengine"
)

const authorityReconnectWindow = 60 * time.Second

type dueTransition struct {
	DefaultA     *ironfistengine.Action
	DefaultB     *ironfistengine.Action
	Outcome      ironfistengine.Outcome
	FinishReason string
}

func decideDueTransition(game *lockedGame, now time.Time) dueTransition {
	decision := dueTransition{}
	aDisconnected, bDisconnected := game.DisconnectDeadlineA.Valid, game.DisconnectDeadlineB.Valid
	aDisconnectDue := aDisconnected && !now.Before(game.DisconnectDeadlineA.Time)
	bDisconnectDue := bDisconnected && !now.Before(game.DisconnectDeadlineB.Time)
	if aDisconnected && bDisconnected {
		if aDisconnectDue && bDisconnectDue {
			decision.Outcome, decision.FinishReason = ironfistengine.Draw, "both_disconnected"
		}
		return decision
	}
	if aDisconnectDue {
		decision.Outcome, decision.FinishReason = ironfistengine.WinB, "disconnect_forfeit_a"
		return decision
	}
	if bDisconnectDue {
		decision.Outcome, decision.FinishReason = ironfistengine.WinA, "disconnect_forfeit_b"
		return decision
	}
	if !aDisconnected && game.ActionDeadlineA.Valid && !now.Before(game.ActionDeadlineA.Time) {
		if _, locked := game.PendingActions[ironfistengine.SeatA]; !locked {
			action := ironfistengine.Defend
			decision.DefaultA = &action
		}
	}
	if !bDisconnected && game.ActionDeadlineB.Valid && !now.Before(game.ActionDeadlineB.Time) {
		if _, locked := game.PendingActions[ironfistengine.SeatB]; !locked {
			action := ironfistengine.Defend
			decision.DefaultB = &action
		}
	}
	return decision
}

func restoredActionDeadline(now time.Time, remaining time.Duration) time.Time {
	if remaining < 0 {
		remaining = 0
	}
	return now.Add(remaining)
}

func (s *IronFistService) advanceDueGameTx(ctx context.Context, tx *sql.Tx, game *lockedGame, now time.Time) error {
	if authorityGameExpired(game, now) && game.Status == "active" {
		if err := abandonPVEGameTx(ctx, tx, game.GameID, game.PlayerAUserID, "session_expired", now); err != nil {
			return err
		}
		game.Status = "abandoned"
		return authorityError("session_expired", nil)
	}
	if game.Status != "active" || game.Mode == "pve" {
		return nil
	}
	decision := decideDueTransition(game, now)
	if decision.Outcome != ironfistengine.OutcomeNone {
		if err := finishDueGameTx(ctx, tx, game, decision.Outcome, decision.FinishReason, now); err != nil {
			return err
		}
		if err := s.settleCompletedGameTx(ctx, tx, game); err != nil {
			return err
		}
		return s.enqueueIronFistOutboxTx(ctx, tx, game, "ironfist_game_finished", "", now)
	}
	for seat, action := range map[ironfistengine.Seat]*ironfistengine.Action{
		ironfistengine.SeatA: decision.DefaultA,
		ironfistengine.SeatB: decision.DefaultB,
	} {
		if action == nil {
			continue
		}
		locked := lockedAction{Action: *action, Source: "deadline_default"}
		if err := insertAuthorityActionTx(ctx, tx, game, seat, locked, now); err != nil {
			return err
		}
		game.PendingActions[seat] = locked
	}
	if len(game.PendingActions) == 2 {
		result, err := ironfistengine.ResolveRound(
			game.PendingActions[ironfistengine.SeatA].Action,
			game.PendingActions[ironfistengine.SeatB].Action,
			game.State,
		)
		if err != nil {
			return err
		}
		if err := persistResolvedRoundTx(ctx, tx, game, result, "deadline", now); err != nil {
			return err
		}
		if result.Outcome != ironfistengine.OutcomeNone {
			if err := s.settleCompletedGameTx(ctx, tx, game); err != nil {
				return err
			}
			return s.enqueueIronFistOutboxTx(ctx, tx, game, "ironfist_game_finished", "", now)
		}
		return s.enqueueIronFistOutboxTx(ctx, tx, game, "ironfist_round_resolved", "", now)
	}
	return nil
}

func finishDueGameTx(ctx context.Context, tx *sql.Tx, game *lockedGame, outcome ironfistengine.Outcome, reason string, now time.Time) error {
	var winner any
	if outcome == ironfistengine.WinA {
		winner = game.PlayerAUserID
		game.WinnerUserID = sql.NullInt64{Int64: int64(game.PlayerAUserID), Valid: true}
	} else if outcome == ironfistengine.WinB {
		winner = game.PlayerBUserID
		game.WinnerUserID = sql.NullInt64{Int64: int64(game.PlayerBUserID), Valid: true}
	}
	_, err := tx.ExecContext(ctx, `
		UPDATE ironfist_games SET status = 'completed', result = ?, winner_user_id = ?,
		       finish_reason = ?, finished_at = ?, last_activity_at = ?,
		       action_deadline_a = NULL, action_deadline_b = NULL,
		       disconnect_deadline_a = NULL, disconnect_deadline_b = NULL
		WHERE game_id = ? AND status = 'active'`, outcome, winner, reason, now, now, game.GameID)
	if err != nil {
		return err
	}
	game.Status, game.Result = "completed", outcome
	game.FinishReason, game.FinishedAt = sql.NullString{String: reason, Valid: true}, sqlNullTime(now)
	game.ActionDeadlineA, game.ActionDeadlineB = sql.NullTime{}, sql.NullTime{}
	game.DisconnectDeadlineA, game.DisconnectDeadlineB = sql.NullTime{}, sql.NullTime{}
	return nil
}

func (s *IronFistService) SetIronFistPresence(ctx context.Context, userID uint64, connected bool) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT game_id FROM ironfist_games
		WHERE status = 'active' AND mode IN ('pvp','friend')
		  AND (player_a_user_id = ? OR player_b_user_id = ?)
		ORDER BY game_id`, userID, userID)
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
	now := s.authorityNow()
	for _, gameID := range gameIDs {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		game, err := loadAuthorityGameTx(ctx, tx, gameID, true)
		if err != nil {
			tx.Rollback()
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return err
		}
		seat, participant := authoritySeat(game, userID)
		if !participant || game.Status != "active" {
			tx.Rollback()
			continue
		}
		if err := setPresenceForGameTx(ctx, tx, game, seat, connected, now); err != nil {
			tx.Rollback()
			return err
		}
		if err := s.enqueueIronFistOutboxTx(ctx, tx, game, "ironfist_presence_changed", seat, now); err != nil {
			tx.Rollback()
			return err
		}
		if err := s.advanceDueGameTx(ctx, tx, game, now); err != nil {
			var authorityErr *AuthorityError
			if !errors.As(err, &authorityErr) {
				tx.Rollback()
				return err
			}
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func setPresenceForGameTx(ctx context.Context, tx *sql.Tx, game *lockedGame, seat ironfistengine.Seat, connected bool, now time.Time) error {
	actionDeadline, disconnectDeadline, remaining := &game.ActionDeadlineA, &game.DisconnectDeadlineA, &game.RemainingActionMSA
	actionColumn, disconnectColumn, remainingColumn := "action_deadline_a", "disconnect_deadline_a", "remaining_action_ms_a"
	if seat == ironfistengine.SeatB {
		actionDeadline, disconnectDeadline, remaining = &game.ActionDeadlineB, &game.DisconnectDeadlineB, &game.RemainingActionMSB
		actionColumn, disconnectColumn, remainingColumn = "action_deadline_b", "disconnect_deadline_b", "remaining_action_ms_b"
	}
	if connected {
		if !disconnectDeadline.Valid {
			return nil
		}
		remainingDuration := time.Duration(remaining.Int64) * time.Millisecond
		deadline := restoredActionDeadline(now, remainingDuration)
		if _, locked := game.PendingActions[seat]; locked {
			actionDeadline.Valid = false
		} else {
			*actionDeadline = sqlNullTime(deadline)
		}
		disconnectDeadline.Valid, remaining.Valid = false, false
		query := fmt.Sprintf(`UPDATE ironfist_games SET %s = ?, %s = NULL, %s = NULL WHERE game_id = ?`, actionColumn, disconnectColumn, remainingColumn)
		_, err := tx.ExecContext(ctx, query, nullTimeValue(*actionDeadline), game.GameID)
		return err
	}
	if disconnectDeadline.Valid {
		return nil
	}
	remainingMS := int64(0)
	if actionDeadline.Valid && actionDeadline.Time.After(now) {
		remainingMS = actionDeadline.Time.Sub(now).Milliseconds()
	}
	*remaining = sql.NullInt64{Int64: remainingMS, Valid: true}
	*disconnectDeadline = sqlNullTime(now.Add(authorityReconnectWindow))
	actionDeadline.Valid = false
	query := fmt.Sprintf(`UPDATE ironfist_games SET %s = NULL, %s = ?, %s = ? WHERE game_id = ?`, actionColumn, disconnectColumn, remainingColumn)
	_, err := tx.ExecContext(ctx, query, disconnectDeadline.Time, remainingMS, game.GameID)
	return err
}

func (s *IronFistService) SweepDueAuthoritativeGames(ctx context.Context) (int, error) {
	now := s.authorityNow()
	rows, err := s.db.QueryContext(ctx, `
		SELECT game_id FROM ironfist_games WHERE status = 'active' AND (
		  (expires_at IS NOT NULL AND expires_at <= ?) OR
		  (action_deadline_a IS NOT NULL AND action_deadline_a <= ?) OR
		  (action_deadline_b IS NOT NULL AND action_deadline_b <= ?) OR
		  (disconnect_deadline_a IS NOT NULL AND disconnect_deadline_a <= ?) OR
		  (disconnect_deadline_b IS NOT NULL AND disconnect_deadline_b <= ?)
		) ORDER BY game_id`, now, now, now, now, now)
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	processed := 0
	for _, id := range ids {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return processed, err
		}
		game, err := loadAuthorityGameTx(ctx, tx, id, true)
		if err != nil {
			tx.Rollback()
			return processed, err
		}
		err = s.advanceDueGameTx(ctx, tx, game, now)
		var authorityErr *AuthorityError
		if err != nil && !errors.As(err, &authorityErr) {
			tx.Rollback()
			return processed, err
		}
		if err := tx.Commit(); err != nil {
			return processed, err
		}
		processed++
	}
	return processed, nil
}
