package service

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"

	"e2eechat/internal/dragontiger"
)

const (
	dragonTigerBettingDuration = 60 * time.Second
	dragonTigerDisplayDuration = 10 * time.Second
	dragonTigerRoundAnimation  = 1500 * time.Millisecond
	dragonTigerMaxStake        = int64(10_000)
)

var dragonTigerRequestIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

type DragonTigerError struct{ Code string }

func (e *DragonTigerError) Error() string { return e.Code }
func dragonTigerError(code string) error  { return &DragonTigerError{Code: code} }

type DragonTigerBet struct {
	Selection    string `json:"selection"`
	StakeAmount  int64  `json:"stake_amount"`
	PayoutAmount int64  `json:"payout_amount,omitempty"`
	Status       string `json:"status"`
}

type DragonTigerRoundView struct {
	ID               uint64                    `json:"id"`
	Status           string                    `json:"status"`
	StateVersion     uint64                    `json:"state_version"`
	RulesVersion     uint16                    `json:"rules_version"`
	SeedCommitment   string                    `json:"seed_commitment"`
	ServerSeed       string                    `json:"server_seed,omitempty"`
	Result           string                    `json:"result,omitempty"`
	VoidReason       string                    `json:"void_reason,omitempty"`
	DragonBetTotal   int64                     `json:"dragon_bet_total"`
	TigerBetTotal    int64                     `json:"tiger_bet_total"`
	DrawBetTotal     int64                     `json:"draw_bet_total"`
	WinningUserCount int                       `json:"winning_user_count"`
	BettingStartedAt time.Time                 `json:"betting_started_at"`
	BettingEndsAt    time.Time                 `json:"betting_ends_at"`
	BattleStartedAt  *time.Time                `json:"battle_started_at,omitempty"`
	BattleEndsAt     *time.Time                `json:"battle_ends_at,omitempty"`
	SettledAt        *time.Time                `json:"settled_at,omitempty"`
	DisplayEndsAt    *time.Time                `json:"display_ends_at,omitempty"`
	RevealedRounds   []dragontiger.BattleRound `json:"revealed_rounds"`
	Battle           *dragontiger.Battle       `json:"battle,omitempty"`
}

type DragonTigerCurrentView struct {
	Round      *DragonTigerRoundView `json:"round"`
	MyBet      *DragonTigerBet       `json:"my_bet"`
	Balance    int64                 `json:"balance"`
	ServerTime time.Time             `json:"server_time"`
}

type DragonTigerBetCommand struct {
	RequestID string `json:"request_id"`
	Selection string `json:"selection"`
	Amount    int64  `json:"amount"`
}

type DragonTigerBetResponse struct {
	Bet          DragonTigerBet `json:"bet"`
	Balance      int64          `json:"balance"`
	RoundID      uint64         `json:"round_id"`
	StateVersion uint64         `json:"state_version"`
	ServerTime   time.Time      `json:"server_time"`
}

type dragonTigerRoundRow struct {
	view       DragonTigerRoundView
	seed       []byte
	battleJSON []byte
}

func validDragonTigerSelection(selection string) bool {
	return selection == "dragon" || selection == "tiger" || selection == "draw"
}

func dragonTigerDBNow(ctx context.Context, tx *sql.Tx) (time.Time, error) {
	var now time.Time
	err := tx.QueryRowContext(ctx, `SELECT UTC_TIMESTAMP(3)`).Scan(&now)
	return dragonTigerUTCWallClock(now), err
}

// DATETIME has no timezone. The schema stores UTC wall-clock values, while the
// development DSN uses loc=Local, so preserve the scanned fields and attach UTC
// instead of shifting them by the host's timezone offset.
func dragonTigerUTCWallClock(value time.Time) time.Time {
	return time.Date(value.Year(), value.Month(), value.Day(), value.Hour(), value.Minute(), value.Second(), value.Nanosecond(), time.UTC)
}

func dragonTigerDBTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02 15:04:05.000")
}

func scanDragonTigerRound(scanner interface{ Scan(...any) error }) (*dragonTigerRoundRow, error) {
	row := &dragonTigerRoundRow{}
	var commitment []byte
	var battle, result, voidReason []byte
	var battleStarted, battleEnds, settled, displayEnds sql.NullTime
	err := scanner.Scan(
		&row.view.ID, &row.view.Status, &row.view.StateVersion, &row.view.RulesVersion,
		&commitment, &row.seed, &battle, &result, &voidReason,
		&row.view.DragonBetTotal, &row.view.TigerBetTotal, &row.view.DrawBetTotal, &row.view.WinningUserCount,
		&row.view.BettingStartedAt, &row.view.BettingEndsAt, &battleStarted, &battleEnds, &settled, &displayEnds,
	)
	if err != nil {
		return nil, err
	}
	row.view.SeedCommitment = hex.EncodeToString(commitment)
	row.view.Result, row.view.VoidReason = string(result), string(voidReason)
	row.battleJSON = append([]byte(nil), battle...)
	if battleStarted.Valid {
		value := dragonTigerUTCWallClock(battleStarted.Time)
		row.view.BattleStartedAt = &value
	}
	if battleEnds.Valid {
		value := dragonTigerUTCWallClock(battleEnds.Time)
		row.view.BattleEndsAt = &value
	}
	if settled.Valid {
		value := dragonTigerUTCWallClock(settled.Time)
		row.view.SettledAt = &value
	}
	if displayEnds.Valid {
		value := dragonTigerUTCWallClock(displayEnds.Time)
		row.view.DisplayEndsAt = &value
	}
	row.view.BettingStartedAt = dragonTigerUTCWallClock(row.view.BettingStartedAt)
	row.view.BettingEndsAt = dragonTigerUTCWallClock(row.view.BettingEndsAt)
	return row, nil
}

const dragonTigerRoundColumns = `
 id, status, state_version, rules_version, seed_commitment, server_seed,
 battle_json, result, void_reason, dragon_bet_total, tiger_bet_total, draw_bet_total,
 winning_user_count, betting_started_at, betting_ends_at, battle_started_at,
 battle_ends_at, settled_at, display_ends_at`

func (s *IronFistService) createDragonTigerRoundTx(ctx context.Context, tx *sql.Tx, now time.Time) (*dragonTigerRoundRow, error) {
	seed := make([]byte, 32)
	if _, err := io.ReadFull(s.random, seed); err != nil {
		return nil, err
	}
	commitment := sha256.Sum256(seed)
	result, err := tx.ExecContext(ctx, `
		INSERT INTO ironfist_dragon_tiger_rounds
		(status, state_version, rules_version, seed_commitment, server_seed, betting_started_at, betting_ends_at, created_at)
		VALUES ('betting', 1, ?, ?, ?, ?, ?, ?)`, dragontiger.RulesVersion, commitment[:], seed, dragonTigerDBTimestamp(now), dragonTigerDBTimestamp(now.Add(dragonTigerBettingDuration)), dragonTigerDBTimestamp(now))
	if err != nil {
		return nil, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_scheduler SET current_round_id = ? WHERE id = 1`, id); err != nil {
		return nil, err
	}
	row := &dragonTigerRoundRow{seed: seed, view: DragonTigerRoundView{
		ID: uint64(id), Status: "betting", StateVersion: 1, RulesVersion: dragontiger.RulesVersion,
		SeedCommitment: hex.EncodeToString(commitment[:]), BettingStartedAt: now, BettingEndsAt: now.Add(dragonTigerBettingDuration),
	}}
	if err := s.enqueueDragonTigerEventTx(ctx, tx, row, "ironfist_dragon_tiger_round_opened", now); err != nil {
		return nil, err
	}
	return row, nil
}

func (s *IronFistService) ensureDragonTigerRound(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT IGNORE INTO ironfist_dragon_tiger_scheduler (id) VALUES (1)`); err != nil {
		return err
	}
	var current sql.NullInt64
	if err = tx.QueryRowContext(ctx, `SELECT current_round_id FROM ironfist_dragon_tiger_scheduler WHERE id = 1 FOR UPDATE`).Scan(&current); err != nil {
		return err
	}
	if !current.Valid {
		now, err := dragonTigerDBNow(ctx, tx)
		if err != nil {
			return err
		}
		if _, err = s.createDragonTigerRoundTx(ctx, tx, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *IronFistService) GetDragonTigerCurrent(ctx context.Context, userID uint64) (*DragonTigerCurrentView, error) {
	if err := s.ensureDragonTigerRound(ctx); err != nil {
		return nil, err
	}
	now := s.authorityNow()
	var roundID uint64
	if err := s.db.QueryRowContext(ctx, `SELECT current_round_id FROM ironfist_dragon_tiger_scheduler WHERE id = 1`).Scan(&roundID); err != nil {
		return nil, err
	}
	row, err := scanDragonTigerRound(s.db.QueryRowContext(ctx, `SELECT `+dragonTigerRoundColumns+`
		FROM ironfist_dragon_tiger_rounds WHERE id = ?`, roundID))
	if err != nil {
		return nil, err
	}
	if err := revealDragonTigerRound(row, now, false); err != nil {
		return nil, err
	}
	view := &DragonTigerCurrentView{Round: &row.view, ServerTime: now}
	if err := s.ensureFistAccountDB(ctx, userID); err != nil {
		return nil, err
	}
	if err := s.db.QueryRowContext(ctx, `SELECT balance FROM fist_accounts WHERE user_id = ?`, userID).Scan(&view.Balance); err != nil {
		return nil, err
	}
	bet, err := queryDragonTigerBet(ctx, s.db, row.view.ID, userID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if err == nil {
		view.MyBet = bet
	}
	return view, nil
}

func (s *IronFistService) ensureFistAccountDB(ctx context.Context, userID uint64) error {
	_, err := s.db.ExecContext(ctx, `INSERT IGNORE INTO fist_accounts (user_id, balance, total_earned) VALUES (?, 0, 0)`, userID)
	return err
}

type queryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func queryDragonTigerBet(ctx context.Context, q queryRower, roundID, userID uint64) (*DragonTigerBet, error) {
	bet := &DragonTigerBet{}
	err := q.QueryRowContext(ctx, `SELECT selection, stake_amount, payout_amount, status FROM ironfist_dragon_tiger_bets WHERE round_id = ? AND user_id = ?`, roundID, userID).
		Scan(&bet.Selection, &bet.StakeAmount, &bet.PayoutAmount, &bet.Status)
	if err != nil {
		return nil, err
	}
	return bet, err
}

func revealDragonTigerRound(row *dragonTigerRoundRow, now time.Time, detail bool) error {
	row.view.RevealedRounds = []dragontiger.BattleRound{}
	if len(row.battleJSON) == 0 {
		return nil
	}
	var battle dragontiger.Battle
	if err := json.Unmarshal(row.battleJSON, &battle); err != nil {
		return err
	}
	if row.view.Status == "settled" || row.view.Status == "voided" || detail {
		row.view.ServerSeed = hex.EncodeToString(row.seed)
		row.view.Battle = &battle
		row.view.RevealedRounds = battle.Rounds
		return nil
	}
	if row.view.Status == "playing" && row.view.BattleStartedAt != nil {
		visible := int(now.Sub(*row.view.BattleStartedAt) / dragonTigerRoundAnimation)
		if visible < 0 {
			visible = 0
		}
		if visible > len(battle.Rounds) {
			visible = len(battle.Rounds)
		}
		row.view.RevealedRounds = battle.Rounds[:visible]
	}
	row.view.Result = ""
	return nil
}

func (s *IronFistService) PlaceDragonTigerBet(ctx context.Context, userID, roundID uint64, command DragonTigerBetCommand) (*DragonTigerBetResponse, error) {
	if !dragonTigerRequestIDPattern.MatchString(command.RequestID) {
		return nil, dragonTigerError("invalid_request_id")
	}
	if !validDragonTigerSelection(command.Selection) {
		return nil, dragonTigerError("invalid_selection")
	}
	if command.Amount < 20 || command.Amount%20 != 0 {
		return nil, dragonTigerError("invalid_amount")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row, err := scanDragonTigerRound(tx.QueryRowContext(ctx, `SELECT `+dragonTigerRoundColumns+` FROM ironfist_dragon_tiger_rounds WHERE id = ? FOR UPDATE`, roundID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, dragonTigerError("stale_round")
	}
	if err != nil {
		return nil, err
	}
	var savedRound, savedUser uint64
	var savedSelection string
	var savedAmount int64
	var responseJSON []byte
	err = tx.QueryRowContext(ctx, `SELECT round_id, user_id, selection, amount, response_json FROM ironfist_dragon_tiger_bet_commands WHERE request_id = ?`, command.RequestID).
		Scan(&savedRound, &savedUser, &savedSelection, &savedAmount, &responseJSON)
	if err == nil {
		if savedRound != roundID || savedUser != userID || savedSelection != command.Selection || savedAmount != command.Amount {
			return nil, dragonTigerError("idempotency_conflict")
		}
		var saved DragonTigerBetResponse
		if err := json.Unmarshal(responseJSON, &saved); err != nil {
			return nil, err
		}
		return &saved, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	now, err := dragonTigerDBNow(ctx, tx)
	if err != nil {
		return nil, err
	}
	if row.view.Status != "betting" || !now.Before(row.view.BettingEndsAt) {
		return nil, dragonTigerError("betting_closed")
	}
	if err := s.ensureFistAccountTx(ctx, tx, userID); err != nil {
		return nil, err
	}
	var balance int64
	if err := tx.QueryRowContext(ctx, `SELECT balance FROM fist_accounts WHERE user_id = ? FOR UPDATE`, userID).Scan(&balance); err != nil {
		return nil, err
	}
	if balance < command.Amount {
		return nil, dragonTigerError("insufficient_balance")
	}
	bet, err := queryDragonTigerBet(ctx, tx, roundID, userID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if err == nil && bet.Selection != command.Selection {
		return nil, dragonTigerError("selection_locked")
	}
	currentStake := int64(0)
	if bet != nil {
		currentStake = bet.StakeAmount
	}
	if currentStake+command.Amount > dragonTigerMaxStake {
		return nil, dragonTigerError("round_limit_exceeded")
	}
	if bet == nil {
		_, err = tx.ExecContext(ctx, `INSERT INTO ironfist_dragon_tiger_bets (round_id, user_id, selection, stake_amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, roundID, userID, command.Selection, command.Amount, dragonTigerDBTimestamp(now), dragonTigerDBTimestamp(now))
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_bets SET stake_amount = stake_amount + ?, updated_at = ? WHERE round_id = ? AND user_id = ?`, command.Amount, dragonTigerDBTimestamp(now), roundID, userID)
	}
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE fist_accounts SET balance = balance - ? WHERE user_id = ?`, command.Amount, userID); err != nil {
		return nil, err
	}
	ref := fmt.Sprintf("dt:bet:%d:%s", roundID, command.RequestID)
	if err = writeDragonTigerFistTx(ctx, tx, userID, -command.Amount, "dragon_tiger_bet", ref, "龙虎斗下注"); err != nil {
		return nil, err
	}
	column := map[string]string{"dragon": "dragon_bet_total", "tiger": "tiger_bet_total", "draw": "draw_bet_total"}[command.Selection]
	if _, err = tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_rounds SET `+column+` = `+column+` + ?, state_version = state_version + 1 WHERE id = ?`, command.Amount, roundID); err != nil {
		return nil, err
	}
	row.view.StateVersion++
	response := &DragonTigerBetResponse{Bet: DragonTigerBet{Selection: command.Selection, StakeAmount: currentStake + command.Amount, Status: "active"}, Balance: balance - command.Amount, RoundID: roundID, StateVersion: row.view.StateVersion, ServerTime: now}
	encoded, err := json.Marshal(response)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO ironfist_dragon_tiger_bet_commands (request_id, round_id, user_id, selection, amount, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, command.RequestID, roundID, userID, command.Selection, command.Amount, encoded, dragonTigerDBTimestamp(now)); err != nil {
		return nil, err
	}
	if err = s.enqueueDragonTigerEventTx(ctx, tx, row, "ironfist_dragon_tiger_bet_totals_changed", now); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return response, nil
}

func dragonTigerPayout(stake int64, selection, result string) int64 {
	if selection != result {
		return 0
	}
	if result == "draw" {
		return stake * 8
	}
	return stake * 195 / 100
}

func (s *IronFistService) SweepDragonTiger(ctx context.Context) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT IGNORE INTO ironfist_dragon_tiger_scheduler (id) VALUES (1)`); err != nil {
		return false, err
	}
	var current sql.NullInt64
	if err = tx.QueryRowContext(ctx, `SELECT current_round_id FROM ironfist_dragon_tiger_scheduler WHERE id = 1 FOR UPDATE`).Scan(&current); err != nil {
		return false, err
	}
	now, err := dragonTigerDBNow(ctx, tx)
	if err != nil {
		return false, err
	}
	if !current.Valid {
		_, err = s.createDragonTigerRoundTx(ctx, tx, now)
		if err != nil {
			return false, err
		}
		return true, tx.Commit()
	}
	row, err := scanDragonTigerRound(tx.QueryRowContext(ctx, `SELECT `+dragonTigerRoundColumns+` FROM ironfist_dragon_tiger_rounds WHERE id = ? FOR UPDATE`, current.Int64))
	if err != nil {
		return false, err
	}
	switch row.view.Status {
	case "betting":
		if now.Before(row.view.BettingEndsAt) {
			return false, nil
		}
		if _, err = tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_rounds SET status='locked', state_version=state_version+1 WHERE id=? AND status='betting'`, row.view.ID); err != nil {
			return false, err
		}
		row.view.Status, row.view.StateVersion = "locked", row.view.StateVersion+1
		if err = s.enqueueDragonTigerEventTx(ctx, tx, row, "ironfist_dragon_tiger_locked", now); err != nil {
			return false, err
		}
	case "locked":
		battle, generateErr := dragontiger.Generate(row.seed, row.view.ID, row.view.RulesVersion)
		if generateErr != nil {
			return s.voidDragonTigerTx(ctx, tx, row, "battle_generation_failed", now)
		}
		encoded, marshalErr := json.Marshal(battle)
		if marshalErr != nil {
			return s.voidDragonTigerTx(ctx, tx, row, "battle_generation_failed", now)
		}
		duration := time.Duration(len(battle.Rounds)) * dragonTigerRoundAnimation
		if duration > 20*time.Second {
			return s.voidDragonTigerTx(ctx, tx, row, "battle_too_long", now)
		}
		battleEnds := now.Add(duration)
		if _, err = tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_rounds SET status='playing', state_version=state_version+1, battle_json=?, result=?, battle_started_at=?, battle_ends_at=? WHERE id=? AND status='locked'`, encoded, battle.Result, dragonTigerDBTimestamp(now), dragonTigerDBTimestamp(battleEnds), row.view.ID); err != nil {
			return false, err
		}
		row.view.Status, row.view.StateVersion, row.view.Result, row.battleJSON = "playing", row.view.StateVersion+1, battle.Result, encoded
		if err = s.enqueueDragonTigerEventTx(ctx, tx, row, "ironfist_dragon_tiger_battle_started", now); err != nil {
			return false, err
		}
	case "playing", "settling":
		if row.view.Status == "playing" && (row.view.BattleEndsAt == nil || now.Before(*row.view.BattleEndsAt)) {
			return false, nil
		}
		if err = s.settleDragonTigerTx(ctx, tx, row, now); err != nil {
			return false, err
		}
	case "settled", "voided":
		if row.view.DisplayEndsAt == nil || now.Before(*row.view.DisplayEndsAt) {
			return false, nil
		}
		if _, err = s.createDragonTigerRoundTx(ctx, tx, now); err != nil {
			return false, err
		}
	default:
		return false, fmt.Errorf("unknown dragon tiger status %q", row.view.Status)
	}
	return true, tx.Commit()
}

func (s *IronFistService) settleDragonTigerTx(ctx context.Context, tx *sql.Tx, row *dragonTigerRoundRow, now time.Time) error {
	if !validDragonTigerSelection(row.view.Result) {
		return fmt.Errorf("invalid result")
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_rounds SET status='settling', state_version=state_version+1 WHERE id=? AND status IN ('playing','settling')`, row.view.ID); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT user_id, selection, stake_amount FROM ironfist_dragon_tiger_bets WHERE round_id=? AND status='active' ORDER BY user_id FOR UPDATE`, row.view.ID)
	if err != nil {
		return err
	}
	type wager struct {
		userID    uint64
		selection string
		stake     int64
	}
	var bets []wager
	for rows.Next() {
		var bet wager
		if err := rows.Scan(&bet.userID, &bet.selection, &bet.stake); err != nil {
			rows.Close()
			return err
		}
		bets = append(bets, bet)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	winners := 0
	for _, bet := range bets {
		if err := s.ensureFistAccountTx(ctx, tx, bet.userID); err != nil {
			return err
		}
		var balance int64
		if err := tx.QueryRowContext(ctx, `SELECT balance FROM fist_accounts WHERE user_id=? FOR UPDATE`, bet.userID).Scan(&balance); err != nil {
			return err
		}
		payout := dragonTigerPayout(bet.stake, bet.selection, row.view.Result)
		status := "lost"
		if payout > 0 {
			status = "won"
			winners++
			if _, err := tx.ExecContext(ctx, `UPDATE fist_accounts SET balance=balance+?, total_earned=total_earned+? WHERE user_id=?`, payout, payout, bet.userID); err != nil {
				return err
			}
			if err := writeDragonTigerFistTx(ctx, tx, bet.userID, payout, "dragon_tiger_payout", fmt.Sprintf("dt:payout:%d:%d", row.view.ID, bet.userID), "龙虎斗中奖返还"); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_bets SET payout_amount=?, status=?, settled_at=? WHERE round_id=? AND user_id=?`, payout, status, dragonTigerDBTimestamp(now), row.view.ID, bet.userID); err != nil {
			return err
		}
	}
	displayEnds := now.Add(dragonTigerDisplayDuration)
	if _, err := tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_rounds SET status='settled', state_version=state_version+1, winning_user_count=?, settled_at=?, display_ends_at=? WHERE id=?`, winners, dragonTigerDBTimestamp(now), dragonTigerDBTimestamp(displayEnds), row.view.ID); err != nil {
		return err
	}
	row.view.Status, row.view.StateVersion, row.view.WinningUserCount = "settled", row.view.StateVersion+2, winners
	return s.enqueueDragonTigerEventTx(ctx, tx, row, "ironfist_dragon_tiger_settled", now)
}

func (s *IronFistService) voidDragonTigerTx(ctx context.Context, tx *sql.Tx, row *dragonTigerRoundRow, reason string, now time.Time) (bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT user_id, stake_amount FROM ironfist_dragon_tiger_bets WHERE round_id=? AND status='active' ORDER BY user_id FOR UPDATE`, row.view.ID)
	if err != nil {
		return false, err
	}
	type refund struct {
		userID uint64
		stake  int64
	}
	var refunds []refund
	for rows.Next() {
		var refund refund
		if err := rows.Scan(&refund.userID, &refund.stake); err != nil {
			rows.Close()
			return false, err
		}
		refunds = append(refunds, refund)
	}
	if err := rows.Close(); err != nil {
		return false, err
	}
	for _, refund := range refunds {
		if _, err := tx.ExecContext(ctx, `UPDATE fist_accounts SET balance=balance+? WHERE user_id=?`, refund.stake, refund.userID); err != nil {
			return false, err
		}
		if err := writeDragonTigerFistTx(ctx, tx, refund.userID, refund.stake, "dragon_tiger_refund", fmt.Sprintf("dt:refund:%d:%d", row.view.ID, refund.userID), "龙虎斗无效局退款"); err != nil {
			return false, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_bets SET payout_amount=stake_amount, status='refunded', settled_at=? WHERE round_id=? AND status='active'`, dragonTigerDBTimestamp(now), row.view.ID); err != nil {
		return false, err
	}
	displayEnds := now.Add(dragonTigerDisplayDuration)
	if _, err := tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_rounds SET status='voided', state_version=state_version+1, result='void', void_reason=?, settled_at=?, display_ends_at=? WHERE id=?`, reason, dragonTigerDBTimestamp(now), dragonTigerDBTimestamp(displayEnds), row.view.ID); err != nil {
		return false, err
	}
	row.view.Status, row.view.Result, row.view.VoidReason, row.view.StateVersion = "voided", "void", reason, row.view.StateVersion+1
	if err := s.enqueueDragonTigerEventTx(ctx, tx, row, "ironfist_dragon_tiger_voided", now); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

func writeDragonTigerFistTx(ctx context.Context, tx *sql.Tx, userID uint64, amount int64, txType, ref, remark string) error {
	var balanceAfter int64
	if err := tx.QueryRowContext(ctx, `SELECT balance FROM fist_accounts WHERE user_id=?`, userID).Scan(&balanceAfter); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO fist_transactions (user_id, amount, balance_after, type, ref_id, settlement_ref, remark)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, userID, amount, balanceAfter, txType, ref, ref, remark)
	return err
}

func (s *IronFistService) ListDragonTigerRounds(ctx context.Context, userID, beforeID uint64, limit int) ([]DragonTigerRoundView, map[uint64]*DragonTigerBet, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	query := `SELECT ` + dragonTigerRoundColumns + ` FROM ironfist_dragon_tiger_rounds WHERE status IN ('settled','voided')`
	args := []any{}
	if beforeID > 0 {
		query += ` AND id < ?`
		args = append(args, beforeID)
	}
	query += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	rounds := make([]DragonTigerRoundView, 0, limit)
	ids := make([]uint64, 0, limit)
	for rows.Next() {
		row, err := scanDragonTigerRound(rows)
		if err != nil {
			return nil, nil, err
		}
		if err := revealDragonTigerRound(row, s.authorityNow(), true); err != nil {
			return nil, nil, err
		}
		rounds = append(rounds, row.view)
		ids = append(ids, row.view.ID)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	bets := make(map[uint64]*DragonTigerBet)
	for _, id := range ids {
		bet, err := queryDragonTigerBet(ctx, s.db, id, userID)
		if err == nil {
			bets[id] = bet
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, nil, err
		}
	}
	return rounds, bets, nil
}

func (s *IronFistService) GetDragonTigerRound(ctx context.Context, userID, roundID uint64) (*DragonTigerRoundView, *DragonTigerBet, error) {
	row, err := scanDragonTigerRound(s.db.QueryRowContext(ctx, `SELECT `+dragonTigerRoundColumns+` FROM ironfist_dragon_tiger_rounds WHERE id=?`, roundID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, dragonTigerError("not_found")
	}
	if err != nil {
		return nil, nil, err
	}
	if err := revealDragonTigerRound(row, s.authorityNow(), row.view.Status == "settled" || row.view.Status == "voided"); err != nil {
		return nil, nil, err
	}
	bet, err := queryDragonTigerBet(ctx, s.db, roundID, userID)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
		bet = nil
	}
	return &row.view, bet, err
}

func (s *IronFistService) enqueueDragonTigerEventTx(ctx context.Context, tx *sql.Tx, row *dragonTigerRoundRow, eventType string, now time.Time) error {
	eventID, err := generateAuthorityUUID(s.random)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{"event_id": eventID, "type": eventType, "round_id": row.view.ID, "state_version": row.view.StateVersion, "server_time": now.UTC()})
	if err != nil {
		return err
	}
	envelope, err := json.Marshal(IronFistOutboxEvent{EventID: eventID, Type: eventType, RoundID: row.view.ID, StateVersion: row.view.StateVersion, ServerTime: now.UTC(), Audience: "all", Payload: payload})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO ironfist_dragon_tiger_outbox (event_id, round_id, state_version, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`, eventID, row.view.ID, row.view.StateVersion, eventType, envelope, dragonTigerDBTimestamp(now))
	return err
}

func (s *IronFistService) PublishDragonTigerOutbox(ctx context.Context, limit int) (int, error) {
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
		err = tx.QueryRowContext(ctx, `SELECT id, CAST(payload AS CHAR) FROM ironfist_dragon_tiger_outbox WHERE published_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id, &payload)
		if errors.Is(err, sql.ErrNoRows) {
			tx.Rollback()
			break
		}
		if err != nil {
			tx.Rollback()
			return published, err
		}
		if err = s.outboxPublish(ctx, payload); err != nil {
			tx.Rollback()
			_, _ = s.db.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_outbox SET attempts=attempts+1,last_error=? WHERE id=?`, truncateAuthorityError(err), id)
			return published, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE ironfist_dragon_tiger_outbox SET published_at=?,attempts=attempts+1,last_error=NULL WHERE id=?`, dragonTigerDBTimestamp(s.authorityNow()), id); err != nil {
			tx.Rollback()
			return published, err
		}
		if err = tx.Commit(); err != nil {
			return published, err
		}
		published++
	}
	return published, nil
}
