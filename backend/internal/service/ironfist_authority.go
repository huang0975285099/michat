package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"

	"e2eechat/internal/ironfistengine"
)

const (
	rewardedPVEInactivity = 30 * time.Minute
	authorityActionWindow = 30 * time.Second
)

var authorityUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type ActionCommand struct {
	Round           int                   `json:"round"`
	Action          ironfistengine.Action `json:"action"`
	RequestID       string                `json:"request_id"`
	ExpectedVersion uint64                `json:"expected_version"`
}

type AuthorityError struct {
	Code string
	Err  error
}

func (e *AuthorityError) Error() string {
	if e.Err == nil {
		return e.Code
	}
	return e.Code + ": " + e.Err.Error()
}

func (e *AuthorityError) Unwrap() error { return e.Err }

func authorityError(code string, err error) error {
	return &AuthorityError{Code: code, Err: err}
}

type GameView struct {
	GameID         string                  `json:"game_id"`
	Mode           string                  `json:"mode"`
	Status         string                  `json:"status"`
	Seat           ironfistengine.Seat     `json:"seat"`
	CurrentRound   int                     `json:"current_round"`
	StateVersion   uint64                  `json:"state_version"`
	State          ironfistengine.State    `json:"state"`
	MyAction       *ironfistengine.Action  `json:"my_action,omitempty"`
	MyLocked       bool                    `json:"my_locked"`
	OpponentLocked bool                    `json:"opponent_locked"`
	OpponentAction *ironfistengine.Action  `json:"opponent_action,omitempty"`
	LastRound      *AuthoritativeRoundView `json:"last_round,omitempty"`
	Outcome        ironfistengine.Outcome  `json:"outcome,omitempty"`
	ActionDeadline *time.Time              `json:"action_deadline,omitempty"`
	ExpiresAt      *time.Time              `json:"expires_at,omitempty"`
	ServerTime     time.Time               `json:"server_time"`
}

type AuthoritativeRoundView struct {
	Round             int                    `json:"round"`
	MyAction          ironfistengine.Action  `json:"my_action"`
	OpponentAction    ironfistengine.Action  `json:"opponent_action"`
	DamageToMe        int                    `json:"damage_to_me"`
	DamageToOpponent  int                    `json:"damage_to_opponent"`
	EnvironmentDamage int                    `json:"environment_damage"`
	State             ironfistengine.State   `json:"state"`
	Outcome           ironfistengine.Outcome `json:"outcome,omitempty"`
}

type lockedAction struct {
	Action    ironfistengine.Action
	Source    string
	UserID    uint64
	RequestID string
}

type resolvedAuthorityRound struct {
	Round  int
	Result ironfistengine.RoundResult
}

type lockedGame struct {
	GameID              string
	Mode                string
	Status              string
	PlayerAUserID       uint64
	PlayerBUserID       uint64
	PVPRoomID           sql.NullInt64
	RulesVersion        uint16
	CurrentRound        int
	StateVersion        uint64
	State               ironfistengine.State
	AISeed              []byte
	ActionDeadlineA     sql.NullTime
	ActionDeadlineB     sql.NullTime
	RemainingActionMSA  sql.NullInt64
	RemainingActionMSB  sql.NullInt64
	DisconnectDeadlineA sql.NullTime
	DisconnectDeadlineB sql.NullTime
	LastActivityAt      time.Time
	ExpiresAt           sql.NullTime
	Result              ironfistengine.Outcome
	WinnerUserID        sql.NullInt64
	FinishReason        sql.NullString
	FinishedAt          sql.NullTime
	SettledAt           sql.NullTime
	PendingActions      map[ironfistengine.Seat]lockedAction
	LastRound           *resolvedAuthorityRound
}

type pveRoundResolution struct {
	PlayerAction lockedAction
	AIAction     lockedAction
	Result       ironfistengine.RoundResult
}

func (s *IronFistService) StartRewardedPVE(ctx context.Context, userID uint64, replace bool) (*GameView, error) {
	now := s.authorityNow()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	activeID, err := activePVEGameIDTx(ctx, tx, userID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if err == nil {
		active, loadErr := loadAuthorityGameTx(ctx, tx, activeID, true)
		if loadErr != nil && !errors.Is(loadErr, sql.ErrNoRows) {
			return nil, loadErr
		}
		if loadErr == nil && active.Status == "active" && !authorityGameExpired(active, now) && !replace {
			if err := tx.Commit(); err != nil {
				return nil, err
			}
			return gameViewForSeat(active, ironfistengine.SeatA, now), nil
		}
		if loadErr == nil && active.Status == "active" {
			reason := "replaced"
			if authorityGameExpired(active, now) {
				reason = "session_expired"
			}
			if err := abandonPVEGameTx(ctx, tx, active.GameID, userID, reason, now); err != nil {
				return nil, err
			}
		} else if _, err := tx.ExecContext(ctx, `DELETE FROM ironfist_active_pve WHERE user_id = ?`, userID); err != nil {
			return nil, err
		}
	}

	gameID := s.newGameID()
	if !authorityUUIDPattern.MatchString(gameID) {
		return nil, fmt.Errorf("generate authority game id")
	}
	seed := make([]byte, 32)
	if _, err := io.ReadFull(s.random, seed); err != nil {
		return nil, fmt.Errorf("generate PvE seed: %w", err)
	}
	state := ironfistengine.InitialState()
	expiresAt := now.Add(rewardedPVEInactivity)
	if err := insertAuthorityGameTx(ctx, tx, &lockedGame{
		GameID: gameID, Mode: "pve", Status: "active", PlayerAUserID: userID,
		RulesVersion: ironfistengine.RulesVersion, CurrentRound: 1, StateVersion: 1,
		State: state, AISeed: seed, LastActivityAt: now,
		ExpiresAt: sqlNullTime(expiresAt), PendingActions: map[ironfistengine.Seat]lockedAction{},
	}); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO ironfist_active_pve (user_id, game_id, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE game_id = VALUES(game_id), updated_at = VALUES(updated_at)`, userID, gameID, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	game := &lockedGame{
		GameID: gameID, Mode: "pve", Status: "active", PlayerAUserID: userID,
		RulesVersion: ironfistengine.RulesVersion, CurrentRound: 1, StateVersion: 1,
		State: state, AISeed: seed, LastActivityAt: now, ExpiresAt: sqlNullTime(expiresAt),
		PendingActions: map[ironfistengine.Seat]lockedAction{},
	}
	return gameViewForSeat(game, ironfistengine.SeatA, now), nil
}

func (s *IronFistService) GetActiveRewardedPVE(ctx context.Context, userID uint64) (*GameView, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	gameID, err := activePVEGameIDTx(ctx, tx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, authorityError("not_found", err)
	}
	if err != nil {
		return nil, err
	}
	game, err := loadAuthorityGameTx(ctx, tx, gameID, true)
	if err != nil {
		return nil, err
	}
	now := s.authorityNow()
	if authorityGameExpired(game, now) {
		if err := abandonPVEGameTx(ctx, tx, game.GameID, userID, "session_expired", now); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return nil, authorityError("session_expired", nil)
	}
	if err := loadAuthorityRoundContextTx(ctx, tx, game); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return gameViewForSeat(game, ironfistengine.SeatA, now), nil
}

func (s *IronFistService) CreateCasualAuthoritativeGame(ctx context.Context, inviterUserID, inviteeUserID uint64) (*GameView, error) {
	if inviterUserID == 0 || inviteeUserID == 0 || inviterUserID == inviteeUserID {
		return nil, authorityError("invalid_participants", nil)
	}
	now := s.authorityNow()
	gameID := s.newGameID()
	if !authorityUUIDPattern.MatchString(gameID) {
		return nil, fmt.Errorf("generate authority game id")
	}
	deadline := sqlNullTime(now.Add(authorityActionWindow))
	game := &lockedGame{
		GameID: gameID, Mode: "friend", Status: "active",
		PlayerAUserID: inviterUserID, PlayerBUserID: inviteeUserID,
		RulesVersion: ironfistengine.RulesVersion, CurrentRound: 1, StateVersion: 1,
		State: ironfistengine.InitialState(), ActionDeadlineA: deadline, ActionDeadlineB: deadline,
		LastActivityAt: now, PendingActions: map[ironfistengine.Seat]lockedAction{},
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := insertAuthorityGameTx(ctx, tx, game); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return gameViewForSeat(game, ironfistengine.SeatA, now), nil
}

func (s *IronFistService) GetAuthoritativeGame(ctx context.Context, userID uint64, gameID string) (*GameView, error) {
	game, err := loadAuthorityGameDB(ctx, s.db, gameID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, authorityError("not_found", err)
	}
	if err != nil {
		return nil, err
	}
	seat, ok := authoritySeat(game, userID)
	if !ok {
		return nil, authorityError("forbidden", nil)
	}
	return gameViewForSeat(game, seat, s.authorityNow()), nil
}

func (s *IronFistService) SubmitAuthoritativeAction(ctx context.Context, userID uint64, gameID string, command ActionCommand) (*GameView, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	game, err := loadAuthorityGameTx(ctx, tx, gameID, true)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, authorityError("not_found", err)
	}
	if err != nil {
		return nil, err
	}
	if err := loadAuthorityRoundContextTx(ctx, tx, game); err != nil {
		return nil, err
	}
	now := s.authorityNow()
	seat, participant := authoritySeat(game, userID)
	if !participant {
		return nil, authorityError("forbidden", nil)
	}
	if authorityUUIDPattern.MatchString(command.RequestID) {
		if original, found, err := loadActionResponseTx(ctx, tx, gameID, userID, command.RequestID); err != nil {
			return nil, err
		} else if found {
			return original, tx.Commit()
		}
	}
	if err := s.advanceDueGameTx(ctx, tx, game, now); err != nil {
		var authorityErr *AuthorityError
		if errors.As(err, &authorityErr) && authorityErr.Code == "session_expired" {
			if commitErr := tx.Commit(); commitErr != nil {
				return nil, commitErr
			}
		}
		return nil, err
	}
	seat, err = validateActionCommand(game, userID, command, now)
	if err != nil {
		return nil, err
	}
	if prior, ok := game.PendingActions[seat]; ok && prior.RequestID == command.RequestID {
		view := gameViewForSeat(game, seat, now)
		return view, tx.Commit()
	}

	playerAction := lockedAction{Action: command.Action, Source: "player", UserID: userID, RequestID: command.RequestID}
	if err := insertAuthorityActionTx(ctx, tx, game, seat, playerAction, now); err != nil {
		return nil, err
	}
	game.PendingActions[seat] = playerAction

	if game.Mode == "pve" {
		resolution, err := resolvePVERound(game, command.Action)
		if err != nil {
			return nil, err
		}
		resolution.PlayerAction = playerAction
		if err := insertAuthorityActionTx(ctx, tx, game, ironfistengine.SeatB, resolution.AIAction, now); err != nil {
			return nil, err
		}
		if err := persistResolvedRoundTx(ctx, tx, game, resolution.Result, "actions", now); err != nil {
			return nil, err
		}
		if resolution.Result.Outcome != ironfistengine.OutcomeNone {
			if err := s.settleCompletedGameTx(ctx, tx, game); err != nil {
				return nil, err
			}
		}
	} else if len(game.PendingActions) == 2 {
		result, err := ironfistengine.ResolveRound(game.PendingActions[ironfistengine.SeatA].Action, game.PendingActions[ironfistengine.SeatB].Action, game.State)
		if err != nil {
			return nil, err
		}
		if err := persistResolvedRoundTx(ctx, tx, game, result, "actions", now); err != nil {
			return nil, err
		}
		if result.Outcome != ironfistengine.OutcomeNone {
			if err := s.settleCompletedGameTx(ctx, tx, game); err != nil {
				return nil, err
			}
		}
	}

	view := gameViewForSeat(game, seat, now)
	eventType := "ironfist_player_locked"
	if game.Status == "completed" {
		eventType = "ironfist_game_finished"
	} else if game.LastRound != nil && game.LastRound.Round == command.Round {
		eventType = "ironfist_round_resolved"
	}
	if err := s.enqueueIronFistOutboxTx(ctx, tx, game, eventType, seat, now); err != nil {
		return nil, err
	}
	responseJSON, err := json.Marshal(view)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ironfist_game_actions SET response_json = ? WHERE game_id = ? AND user_id = ? AND request_id = ?`, responseJSON, gameID, userID, command.RequestID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return view, nil
}

func (s *IronFistService) ResignAuthoritativeGame(ctx context.Context, userID uint64, gameID string) (*GameView, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	game, err := loadAuthorityGameTx(ctx, tx, gameID, true)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, authorityError("not_found", err)
	}
	if err != nil {
		return nil, err
	}
	seat, ok := authoritySeat(game, userID)
	if !ok {
		return nil, authorityError("forbidden", nil)
	}
	if game.Status != "active" {
		return nil, authorityError("game_finished", nil)
	}
	now := s.authorityNow()
	if game.Mode == "pve" {
		if err := abandonPVEGameTx(ctx, tx, game.GameID, userID, "abandoned", now); err != nil {
			return nil, err
		}
		game.Status, game.FinishReason, game.FinishedAt = "abandoned", sql.NullString{String: "abandoned", Valid: true}, sqlNullTime(now)
	} else {
		winner := game.PlayerBUserID
		result := ironfistengine.WinB
		reason := "resign_a"
		if seat == ironfistengine.SeatB {
			winner, result, reason = game.PlayerAUserID, ironfistengine.WinA, "resign_b"
		}
		if _, err := tx.ExecContext(ctx, `UPDATE ironfist_games SET status = 'completed', result = ?, winner_user_id = ?, finish_reason = ?, finished_at = ?, last_activity_at = ? WHERE game_id = ?`, result, winner, reason, now, now, game.GameID); err != nil {
			return nil, err
		}
		game.Status, game.Result = "completed", result
		game.WinnerUserID, game.FinishReason, game.FinishedAt = sql.NullInt64{Int64: int64(winner), Valid: true}, sql.NullString{String: reason, Valid: true}, sqlNullTime(now)
		if err := s.settleCompletedGameTx(ctx, tx, game); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return gameViewForSeat(game, seat, now), nil
}

func validateActionCommand(game *lockedGame, userID uint64, command ActionCommand, now time.Time) (ironfistengine.Seat, error) {
	seat, ok := authoritySeat(game, userID)
	if !ok {
		return "", authorityError("forbidden", nil)
	}
	if game.Mode == "pve" && authorityGameExpired(game, now) {
		return "", authorityError("session_expired", nil)
	}
	if game.Status != "active" {
		return "", authorityError("game_finished", nil)
	}
	if !command.Action.Valid() {
		return "", authorityError("invalid_action", nil)
	}
	if !authorityUUIDPattern.MatchString(command.RequestID) {
		return "", authorityError("invalid_request_id", nil)
	}
	if command.Round != game.CurrentRound || command.ExpectedVersion != game.StateVersion {
		return "", authorityError("stale_state", nil)
	}
	if prior, exists := game.PendingActions[seat]; exists && prior.RequestID != command.RequestID {
		return "", authorityError("action_locked", nil)
	}
	return seat, nil
}

func resolvePVERound(game *lockedGame, action ironfistengine.Action) (*pveRoundResolution, error) {
	aiAction := ironfistengine.DecideAI(game.AISeed, uint8(game.CurrentRound), game.State)
	result, err := ironfistengine.ResolveRound(action, aiAction, game.State)
	if err != nil {
		return nil, err
	}
	return &pveRoundResolution{
		PlayerAction: lockedAction{Action: action, Source: "player", UserID: game.PlayerAUserID},
		AIAction:     lockedAction{Action: aiAction, Source: "ai"},
		Result:       result,
	}, nil
}

func gameViewForSeat(game *lockedGame, seat ironfistengine.Seat, now time.Time) *GameView {
	view := &GameView{
		GameID: game.GameID, Mode: game.Mode, Status: game.Status, Seat: seat,
		CurrentRound: game.CurrentRound, StateVersion: game.StateVersion, State: game.State,
		Outcome: game.Result, ServerTime: now.UTC(),
	}
	if game.ExpiresAt.Valid {
		expires := game.ExpiresAt.Time.UTC()
		view.ExpiresAt = &expires
	}
	mySeat, opponentSeat := seat, ironfistengine.SeatB
	deadline := game.ActionDeadlineA
	if seat == ironfistengine.SeatB {
		opponentSeat, deadline = ironfistengine.SeatA, game.ActionDeadlineB
	}
	if deadline.Valid {
		value := deadline.Time.UTC()
		view.ActionDeadline = &value
	}
	if action, ok := game.PendingActions[mySeat]; ok {
		value := action.Action
		view.MyAction, view.MyLocked = &value, true
	}
	if _, ok := game.PendingActions[opponentSeat]; ok {
		view.OpponentLocked = true
	}
	if game.LastRound != nil {
		result := game.LastRound.Result
		actionA, actionB := result.ActionA, result.ActionB
		damageA, damageB := result.DamageA, result.DamageB
		if seat == ironfistengine.SeatB {
			actionA, actionB = actionB, actionA
			damageA, damageB = damageB, damageA
		}
		view.LastRound = &AuthoritativeRoundView{
			Round: game.LastRound.Round, MyAction: actionA, OpponentAction: actionB,
			DamageToMe: damageA, DamageToOpponent: damageB,
			EnvironmentDamage: result.EnvironmentDamage, State: result.State, Outcome: result.Outcome,
		}
		value := actionB
		view.OpponentAction = &value
	}
	return view
}

func authoritySeat(game *lockedGame, userID uint64) (ironfistengine.Seat, bool) {
	if game.PlayerAUserID == userID {
		return ironfistengine.SeatA, true
	}
	if game.PlayerBUserID != 0 && game.PlayerBUserID == userID {
		return ironfistengine.SeatB, true
	}
	return "", false
}

func authorityGameExpired(game *lockedGame, now time.Time) bool {
	return game.Mode == "pve" && game.ExpiresAt.Valid && !now.Before(game.ExpiresAt.Time)
}

func (s *IronFistService) authorityNow() time.Time {
	if s.now == nil {
		return time.Now().UTC()
	}
	return s.now().UTC()
}

func generateAuthorityUUID(reader io.Reader) (string, error) {
	if reader == nil {
		reader = rand.Reader
	}
	raw := make([]byte, 16)
	if _, err := io.ReadFull(reader, raw); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(raw)
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

func sqlNullTime(value time.Time) sql.NullTime {
	return sql.NullTime{Time: value.UTC(), Valid: true}
}

func decodeAuthorityState(raw []byte) (ironfistengine.State, error) {
	var state ironfistengine.State
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&state); err != nil {
		return state, fmt.Errorf("decode authoritative state: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("trailing JSON value")
		}
		return state, fmt.Errorf("decode authoritative state: %w", err)
	}
	return state, nil
}
