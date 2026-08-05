package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"e2eechat/internal/ironfistengine"
)

type authorityQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

const authorityGameColumns = `
	game_id, mode, status, player_a_user_id, player_b_user_id, pvp_room_id,
	rules_version, current_round, state_version, state_json, ai_seed,
	action_deadline_a, action_deadline_b, disconnect_deadline_a, disconnect_deadline_b,
	last_activity_at, expires_at, result, winner_user_id, finish_reason, finished_at, settled_at`

func activePVEGameIDTx(ctx context.Context, tx *sql.Tx, userID uint64) (string, error) {
	var gameID string
	err := tx.QueryRowContext(ctx, `SELECT game_id FROM ironfist_active_pve WHERE user_id = ? FOR UPDATE`, userID).Scan(&gameID)
	return gameID, err
}

func loadAuthorityGameTx(ctx context.Context, tx *sql.Tx, gameID string, forUpdate bool) (*lockedGame, error) {
	query := `SELECT ` + authorityGameColumns + ` FROM ironfist_games WHERE game_id = ?`
	if forUpdate {
		query += ` FOR UPDATE`
	}
	game, err := scanAuthorityGame(tx.QueryRowContext(ctx, query, gameID))
	if err != nil {
		return nil, err
	}
	if err := loadPendingAuthorityActions(ctx, tx, game); err != nil {
		return nil, err
	}
	return game, nil
}

func loadAuthorityGameDB(ctx context.Context, db *sql.DB, gameID string) (*lockedGame, error) {
	game, err := scanAuthorityGame(db.QueryRowContext(ctx, `SELECT `+authorityGameColumns+` FROM ironfist_games WHERE game_id = ?`, gameID))
	if err != nil {
		return nil, err
	}
	if err := loadPendingAuthorityActions(ctx, db, game); err != nil {
		return nil, err
	}
	if err := loadLastAuthorityRound(ctx, db, game); err != nil {
		return nil, err
	}
	return game, nil
}

func scanAuthorityGame(row *sql.Row) (*lockedGame, error) {
	game := &lockedGame{PendingActions: map[ironfistengine.Seat]lockedAction{}}
	var playerB sql.NullInt64
	var rulesVersion uint64
	var stateJSON []byte
	var result sql.NullString
	err := row.Scan(
		&game.GameID, &game.Mode, &game.Status, &game.PlayerAUserID, &playerB, &game.PVPRoomID,
		&rulesVersion, &game.CurrentRound, &game.StateVersion, &stateJSON, &game.AISeed,
		&game.ActionDeadlineA, &game.ActionDeadlineB, &game.DisconnectDeadlineA, &game.DisconnectDeadlineB,
		&game.LastActivityAt, &game.ExpiresAt, &result, &game.WinnerUserID, &game.FinishReason, &game.FinishedAt, &game.SettledAt,
	)
	if err != nil {
		return nil, err
	}
	if playerB.Valid {
		game.PlayerBUserID = uint64(playerB.Int64)
	}
	game.RulesVersion = uint16(rulesVersion)
	if result.Valid {
		game.Result = ironfistengine.Outcome(result.String)
	}
	game.State, err = decodeAuthorityState(stateJSON)
	if err != nil {
		return nil, err
	}
	return game, nil
}

func loadPendingAuthorityActions(ctx context.Context, query authorityQuerier, game *lockedGame) error {
	rows, err := query.QueryContext(ctx, `SELECT seat, action, source, user_id, request_id FROM ironfist_game_actions WHERE game_id = ? AND round_num = ?`, game.GameID, game.CurrentRound)
	if err != nil {
		return err
	}
	defer rows.Close()
	game.PendingActions = map[ironfistengine.Seat]lockedAction{}
	for rows.Next() {
		var seat ironfistengine.Seat
		var action lockedAction
		var userID sql.NullInt64
		var requestID sql.NullString
		if err := rows.Scan(&seat, &action.Action, &action.Source, &userID, &requestID); err != nil {
			return err
		}
		if userID.Valid {
			action.UserID = uint64(userID.Int64)
		}
		if requestID.Valid {
			action.RequestID = requestID.String
		}
		game.PendingActions[seat] = action
	}
	return rows.Err()
}

func loadAuthorityRoundContextTx(ctx context.Context, tx *sql.Tx, game *lockedGame) error {
	if err := loadPendingAuthorityActions(ctx, tx, game); err != nil {
		return err
	}
	return loadLastAuthorityRound(ctx, tx, game)
}

func loadLastAuthorityRound(ctx context.Context, query authorityQuerier, game *lockedGame) error {
	var round int
	var actionA, actionB ironfistengine.Action
	var damageA, damageB, environmentDamage int
	var stateJSON []byte
	var outcome sql.NullString
	err := query.QueryRowContext(ctx, `
		SELECT round_num, action_a, action_b, damage_a, damage_b, environment_damage, state_json, outcome
		FROM ironfist_game_rounds WHERE game_id = ? ORDER BY round_num DESC LIMIT 1`, game.GameID).Scan(
		&round, &actionA, &actionB, &damageA, &damageB, &environmentDamage, &stateJSON, &outcome,
	)
	if errors.Is(err, sql.ErrNoRows) {
		game.LastRound = nil
		return nil
	}
	if err != nil {
		return err
	}
	state, err := decodeAuthorityState(stateJSON)
	if err != nil {
		return err
	}
	result := ironfistengine.RoundResult{
		ActionA: actionA, ActionB: actionB, DamageA: damageA, DamageB: damageB,
		EnvironmentDamage: environmentDamage, State: state,
	}
	if outcome.Valid {
		result.Outcome = ironfistengine.Outcome(outcome.String)
	}
	game.LastRound = &resolvedAuthorityRound{Round: round, Result: result}
	return nil
}

func insertAuthorityGameTx(ctx context.Context, tx *sql.Tx, game *lockedGame) error {
	stateJSON, err := json.Marshal(game.State)
	if err != nil {
		return err
	}
	var playerB any
	if game.PlayerBUserID != 0 {
		playerB = game.PlayerBUserID
	}
	var pvpRoom any
	if game.PVPRoomID.Valid {
		pvpRoom = game.PVPRoomID.Int64
	}
	var seed any
	if len(game.AISeed) > 0 {
		seed = game.AISeed
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ironfist_games (
			game_id, mode, status, player_a_user_id, player_b_user_id, pvp_room_id,
			rules_version, current_round, state_version, state_json, ai_seed,
			action_deadline_a, action_deadline_b, last_activity_at, expires_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		game.GameID, game.Mode, game.Status, game.PlayerAUserID, playerB, pvpRoom,
		game.RulesVersion, game.CurrentRound, game.StateVersion, stateJSON, seed,
		nullTimeValue(game.ActionDeadlineA), nullTimeValue(game.ActionDeadlineB), game.LastActivityAt, nullTimeValue(game.ExpiresAt),
	)
	return err
}

func insertAuthorityActionTx(ctx context.Context, tx *sql.Tx, game *lockedGame, seat ironfistengine.Seat, action lockedAction, now time.Time) error {
	var userID any
	if action.UserID != 0 {
		userID = action.UserID
	}
	var requestID any
	if action.RequestID != "" {
		requestID = action.RequestID
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO ironfist_game_actions (game_id, round_num, seat, action, source, user_id, request_id, accepted_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		game.GameID, game.CurrentRound, seat, action.Action, action.Source, userID, requestID, now,
	)
	return err
}

func persistResolvedRoundTx(ctx context.Context, tx *sql.Tx, game *lockedGame, result ironfistengine.RoundResult, reason string, now time.Time) error {
	stateJSON, err := json.Marshal(result.State)
	if err != nil {
		return err
	}
	var outcome any
	if result.Outcome != ironfistengine.OutcomeNone {
		outcome = result.Outcome
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO ironfist_game_rounds (
			game_id, round_num, action_a, action_b, damage_a, damage_b, environment_damage,
			state_json, outcome, resolution_reason, resolved_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		game.GameID, game.CurrentRound, result.ActionA, result.ActionB, result.DamageA, result.DamageB,
		result.EnvironmentDamage, stateJSON, outcome, reason, now,
	); err != nil {
		return err
	}

	resolvedRound := game.CurrentRound
	game.State = result.State
	game.StateVersion++
	game.CurrentRound++
	game.LastActivityAt = now
	game.LastRound = &resolvedAuthorityRound{Round: resolvedRound, Result: result}
	game.PendingActions = map[ironfistengine.Seat]lockedAction{}

	status := "active"
	var winner any
	var finishReason any
	var finishedAt any
	if result.Outcome != ironfistengine.OutcomeNone {
		status = "completed"
		game.Status, game.Result = status, result.Outcome
		game.FinishReason = sql.NullString{String: "rules_terminal", Valid: true}
		game.FinishedAt = sqlNullTime(now)
		finishReason, finishedAt = game.FinishReason.String, now
		switch result.Outcome {
		case ironfistengine.WinA:
			winner = game.PlayerAUserID
			game.WinnerUserID = sql.NullInt64{Int64: int64(game.PlayerAUserID), Valid: true}
		case ironfistengine.WinB:
			winner = game.PlayerBUserID
			game.WinnerUserID = sql.NullInt64{Int64: int64(game.PlayerBUserID), Valid: true}
		}
	}

	expiresAt := game.ExpiresAt
	if game.Mode == "pve" && status == "active" {
		expiresAt = sqlNullTime(now.Add(rewardedPVEInactivity))
		game.ExpiresAt = expiresAt
	}
	deadlineA, deadlineB := sql.NullTime{}, sql.NullTime{}
	if game.Mode != "pve" && status == "active" {
		deadlineA, deadlineB = sqlNullTime(now.Add(authorityActionWindow)), sqlNullTime(now.Add(authorityActionWindow))
		game.ActionDeadlineA, game.ActionDeadlineB = deadlineA, deadlineB
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ironfist_games SET status = ?, current_round = ?, state_version = ?, state_json = ?,
			action_deadline_a = ?, action_deadline_b = ?, last_activity_at = ?, expires_at = ?,
			result = ?, winner_user_id = ?, finish_reason = ?, finished_at = ?
		WHERE game_id = ?`,
		status, game.CurrentRound, game.StateVersion, stateJSON,
		nullTimeValue(deadlineA), nullTimeValue(deadlineB), now, nullTimeValue(expiresAt),
		outcome, winner, finishReason, finishedAt, game.GameID,
	); err != nil {
		return err
	}
	if status == "completed" && game.Mode == "pve" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM ironfist_active_pve WHERE user_id = ? AND game_id = ?`, game.PlayerAUserID, game.GameID); err != nil {
			return err
		}
	}
	return nil
}

func loadActionResponseTx(ctx context.Context, tx *sql.Tx, gameID string, userID uint64, requestID string) (*GameView, bool, error) {
	var raw []byte
	err := tx.QueryRowContext(ctx, `SELECT response_json FROM ironfist_game_actions WHERE game_id = ? AND user_id = ? AND request_id = ?`, gameID, userID, requestID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(raw) == 0 {
		return nil, false, nil
	}
	var view GameView
	if err := json.Unmarshal(raw, &view); err != nil {
		return nil, false, fmt.Errorf("decode idempotent action response: %w", err)
	}
	return &view, true, nil
}

func abandonPVEGameTx(ctx context.Context, tx *sql.Tx, gameID string, userID uint64, reason string, now time.Time) error {
	if _, err := tx.ExecContext(ctx, `
		UPDATE ironfist_games SET status = 'abandoned', finish_reason = ?, finished_at = ?, last_activity_at = ?
		WHERE game_id = ? AND status = 'active'`, reason, now, now, gameID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM ironfist_active_pve WHERE user_id = ? AND game_id = ?`, userID, gameID)
	return err
}

func nullTimeValue(value sql.NullTime) any {
	if value.Valid {
		return value.Time.UTC()
	}
	return nil
}
