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

type IronFistOutboxEvent struct {
	EventID          string          `json:"event_id"`
	Type             string          `json:"type"`
	GameID           string          `json:"game_id"`
	StateVersion     uint64          `json:"state_version"`
	ServerTime       time.Time       `json:"server_time"`
	RecipientChatIDs []string        `json:"recipient_chat_ids"`
	Payload          json.RawMessage `json:"payload"`
}

func (s *IronFistService) SetIronFistOutboxPublisher(publish func(context.Context, string) error) {
	s.outboxPublish = publish
}

func authorityEventPayload(eventType string, game *lockedGame, lockedSeat ironfistengine.Seat, now time.Time) ([]byte, error) {
	payload := map[string]any{
		"game_id": game.GameID, "state_version": game.StateVersion,
		"server_time": now.UTC(), "status": game.Status,
	}
	switch eventType {
	case "ironfist_player_locked":
		payload["locked_seat"] = lockedSeat
	case "ironfist_round_resolved":
		if game.LastRound != nil {
			payload["round"] = game.LastRound.Round
			payload["action_a"] = game.LastRound.Result.ActionA
			payload["action_b"] = game.LastRound.Result.ActionB
			payload["damage_a"] = game.LastRound.Result.DamageA
			payload["damage_b"] = game.LastRound.Result.DamageB
			payload["environment_damage"] = game.LastRound.Result.EnvironmentDamage
			payload["state"] = game.LastRound.Result.State
			payload["outcome"] = game.LastRound.Result.Outcome
		}
	case "ironfist_game_finished":
		payload["state"] = game.State
		payload["outcome"] = game.Result
		if game.FinishReason.Valid {
			payload["finish_reason"] = game.FinishReason.String
		}
	case "ironfist_presence_changed":
		payload["seat"] = lockedSeat
	}
	return json.Marshal(payload)
}

func (s *IronFistService) enqueueIronFistOutboxTx(ctx context.Context, tx *sql.Tx, game *lockedGame, eventType string, seat ironfistengine.Seat, now time.Time) error {
	payload, err := authorityEventPayload(eventType, game, seat, now)
	if err != nil {
		return err
	}
	recipients := make([]string, 0, 2)
	for _, userID := range []uint64{game.PlayerAUserID, game.PlayerBUserID} {
		if userID == 0 {
			continue
		}
		var chatID string
		if err := tx.QueryRowContext(ctx, `SELECT chat_id FROM users WHERE id = ?`, userID).Scan(&chatID); err != nil {
			return err
		}
		recipients = append(recipients, chatID)
	}
	eventID, err := generateAuthorityUUID(s.random)
	if err != nil {
		return err
	}
	envelope, err := json.Marshal(IronFistOutboxEvent{
		EventID: eventID, Type: eventType, GameID: game.GameID,
		StateVersion: game.StateVersion, ServerTime: now.UTC(),
		RecipientChatIDs: recipients, Payload: payload,
	})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ironfist_outbox (event_id, game_id, state_version, event_type, payload, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`, eventID, game.GameID, game.StateVersion, eventType, envelope, now)
	return err
}

func (s *IronFistService) PublishIronFistOutbox(ctx context.Context, limit int) (int, error) {
	if s.outboxPublish == nil {
		return 0, errors.New("IronFist outbox publisher is not configured")
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	published := 0
	for published < limit {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return published, err
		}
		var id uint64
		var payload string
		err = tx.QueryRowContext(ctx, `
			SELECT id, CAST(payload AS CHAR) FROM ironfist_outbox
			WHERE published_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id, &payload)
		if errors.Is(err, sql.ErrNoRows) {
			tx.Rollback()
			break
		}
		if err != nil {
			tx.Rollback()
			return published, err
		}
		if err := s.outboxPublish(ctx, payload); err != nil {
			tx.Rollback()
			_, _ = s.db.ExecContext(ctx, `UPDATE ironfist_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND published_at IS NULL`, truncateAuthorityError(err), id)
			return published, err
		}
		result, err := tx.ExecContext(ctx, `UPDATE ironfist_outbox SET published_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ? AND published_at IS NULL`, s.authorityNow(), id)
		if err != nil {
			tx.Rollback()
			return published, err
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			tx.Rollback()
			return published, fmt.Errorf("outbox event %d was concurrently published", id)
		}
		if err := tx.Commit(); err != nil {
			return published, err
		}
		published++
	}
	return published, nil
}

func truncateAuthorityError(err error) string {
	message := err.Error()
	if len(message) > 255 {
		return message[:255]
	}
	return message
}
