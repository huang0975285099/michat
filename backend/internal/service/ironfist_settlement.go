package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"e2eechat/internal/ironfistengine"
	"e2eechat/internal/model"
)

type storedAuthorityRound struct {
	Round             int
	ActionA           ironfistengine.Action
	ActionB           ironfistengine.Action
	DamageA           int
	DamageB           int
	EnvironmentDamage int
	State             ironfistengine.State
}

type authorityAchievementFacts struct {
	CounterSuccesses int
	LowHPWin         bool
	HighHPWin        bool
}

type wagerSettlement struct {
	Result       ironfistengine.Outcome
	WinnerAmount int64
	RefundA      int64
	RefundB      int64
	FeeBurn      int64
	FeeTreasury  int64
}

func calculateWagerSettlement(stake int64, outcome ironfistengine.Outcome) (wagerSettlement, error) {
	settlement := wagerSettlement{Result: outcome}
	totalPool := stake * 2
	switch outcome {
	case ironfistengine.WinA, ironfistengine.WinB:
		totalFee := totalPool * 5 / 100
		settlement.WinnerAmount = totalPool - totalFee
		settlement.FeeBurn = totalFee / 2
		settlement.FeeTreasury = totalFee - settlement.FeeBurn
	case ironfistengine.Draw, ironfistengine.DoubleLose:
		nominalFee := totalPool * 25 / 1000
		refund := (totalPool - nominalFee) / 2
		settlement.RefundA, settlement.RefundB = refund, refund
		actualFee := totalPool - refund*2
		settlement.FeeBurn = actualFee / 2
		settlement.FeeTreasury = actualFee - settlement.FeeBurn
	default:
		return wagerSettlement{}, fmt.Errorf("unsupported authoritative wager outcome %q", outcome)
	}
	return settlement, nil
}

func pveRewardFor(priorWins int, outcome ironfistengine.Outcome) (base, bonus int64, wins int) {
	wins = priorWins
	if outcome != ironfistengine.WinA || priorWins >= PvEDailyMaxWins {
		return 0, 0, wins
	}
	wins++
	base = PvERewardAmount
	if wins == PvEDailyMaxWins {
		bonus = PvEDailyBonusAmount
	}
	return base, bonus, wins
}

func settlementChangesBalance(mode string, outcome ironfistengine.Outcome) bool {
	return mode == "pve" && outcome == ironfistengine.WinA
}

func authorityFactsForSeat(rounds []storedAuthorityRound, seat ironfistengine.Seat, finalHP int, outcome ironfistengine.Outcome) authorityAchievementFacts {
	facts := authorityAchievementFacts{}
	win := (seat == ironfistengine.SeatA && outcome == ironfistengine.WinA) ||
		(seat == ironfistengine.SeatB && outcome == ironfistengine.WinB)
	for _, round := range rounds {
		ownAction, opponentAction, opponentDamage := round.ActionA, round.ActionB, round.DamageB
		if seat == ironfistengine.SeatB {
			ownAction, opponentAction, opponentDamage = round.ActionB, round.ActionA, round.DamageA
		}
		if ownAction == ironfistengine.Counter && opponentAction == ironfistengine.Attack && opponentDamage > 0 {
			facts.CounterSuccesses++
		}
	}
	facts.LowHPWin = win && finalHP < 10
	facts.HighHPWin = win && finalHP > 90
	return facts
}

func (s *IronFistService) settleCompletedGameTx(ctx context.Context, tx *sql.Tx, game *lockedGame) error {
	if game.Status != "completed" {
		return nil
	}
	if game.SettledAt.Valid {
		return nil
	}
	rounds, err := loadStoredAuthorityRoundsTx(ctx, tx, game.GameID)
	if err != nil {
		return err
	}
	if err := s.writeAuthoritativeMatchProjectionsTx(ctx, tx, game, rounds); err != nil {
		return err
	}
	if err := s.updateAuthoritativeStatsTx(ctx, tx, game, rounds); err != nil {
		return err
	}
	if settlementChangesBalance(game.Mode, game.Result) {
		if err := s.awardAuthoritativePVETx(ctx, tx, game.PlayerAUserID, game.GameID, game.Result); err != nil {
			return err
		}
	}
	if game.Mode == "pvp" && game.PVPRoomID.Valid {
		if err := s.settleWageredPVPTx(ctx, tx, game); err != nil {
			return err
		}
	}
	settledAt := s.authorityNow()
	result, err := tx.ExecContext(ctx, `UPDATE ironfist_games SET settled_at = ? WHERE game_id = ? AND settled_at IS NULL`, settledAt, game.GameID)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return err
	} else if affected != 1 {
		return fmt.Errorf("authoritative game %s was settled concurrently", game.GameID)
	}
	game.SettledAt = sqlNullTime(settledAt)
	return nil
}

func (s *IronFistService) settleWageredPVPTx(ctx context.Context, tx *sql.Tx, game *lockedGame) error {
	var status, tier string
	var stake int64
	var userA, userB uint64
	err := tx.QueryRowContext(ctx, `
		SELECT status, tier, stake_amount, player_a_user_id, player_b_user_id
		FROM ironfist_pvp_rooms WHERE id = ? FOR UPDATE`, game.PVPRoomID.Int64).Scan(
		&status, &tier, &stake, &userA, &userB,
	)
	if err != nil {
		return err
	}
	if userA != game.PlayerAUserID || userB != game.PlayerBUserID {
		return fmt.Errorf("wager room participants do not match authoritative game %s", game.GameID)
	}
	if status == "settled" {
		return nil
	}
	if status != "matched" {
		return fmt.Errorf("wager room %d has status %s", game.PVPRoomID.Int64, status)
	}
	settlement, err := calculateWagerSettlement(stake, game.Result)
	if err != nil {
		return err
	}
	if err := s.ensureFistAccountTx(ctx, tx, userA); err != nil {
		return err
	}
	if err := s.ensureFistAccountTx(ctx, tx, userB); err != nil {
		return err
	}
	roomRef := pvpRoomRef(uint64(game.PVPRoomID.Int64))
	switch game.Result {
	case ironfistengine.WinA:
		if err := creditAuthorityWagerTx(ctx, tx, userA, settlement.WinnerAmount, true, "pvp_win", roomRef, "game:"+game.GameID+":pvp-win", "Authoritative PvP win ("+tier+", "+game.GameID+")"); err != nil {
			return err
		}
	case ironfistengine.WinB:
		if err := creditAuthorityWagerTx(ctx, tx, userB, settlement.WinnerAmount, true, "pvp_win", roomRef, "game:"+game.GameID+":pvp-win", "Authoritative PvP win ("+tier+", "+game.GameID+")"); err != nil {
			return err
		}
	case ironfistengine.Draw, ironfistengine.DoubleLose:
		if err := creditAuthorityWagerTx(ctx, tx, userA, settlement.RefundA, false, "pvp_refund", roomRef, "game:"+game.GameID+":refund-a", "Authoritative PvP draw refund ("+tier+")"); err != nil {
			return err
		}
		if err := creditAuthorityWagerTx(ctx, tx, userB, settlement.RefundB, false, "pvp_refund", roomRef, "game:"+game.GameID+":refund-b", "Authoritative PvP draw refund ("+tier+")"); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE ironfist_pvp_rooms SET status = 'settled', result = ?, winner_amount = ?,
		       refund_a = ?, refund_b = ?, fee_burn = ?, fee_treasury = ?, settled_at = ?
		WHERE id = ? AND status = 'matched'`,
		settlement.Result, settlement.WinnerAmount, settlement.RefundA, settlement.RefundB,
		settlement.FeeBurn, settlement.FeeTreasury, s.authorityNow(), game.PVPRoomID.Int64,
	)
	return err
}

func creditAuthorityWagerTx(ctx context.Context, tx *sql.Tx, userID uint64, amount int64, earned bool, transactionType, refID, settlementRef, remark string) error {
	if amount <= 0 {
		return nil
	}
	earnedAmount := int64(0)
	if earned {
		earnedAmount = amount
	}
	if _, err := tx.ExecContext(ctx, `UPDATE fist_accounts SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?`, amount, earnedAmount, userID); err != nil {
		return err
	}
	var balance int64
	if err := tx.QueryRowContext(ctx, `SELECT balance FROM fist_accounts WHERE user_id = ?`, userID).Scan(&balance); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO fist_transactions (user_id, amount, balance_after, type, ref_id, settlement_ref, remark)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		userID, amount, balance, transactionType, refID, settlementRef, remark,
	)
	return err
}

func loadStoredAuthorityRoundsTx(ctx context.Context, tx *sql.Tx, gameID string) ([]storedAuthorityRound, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT round_num, action_a, action_b, damage_a, damage_b, environment_damage, state_json
		FROM ironfist_game_rounds WHERE game_id = ? ORDER BY round_num`, gameID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var rounds []storedAuthorityRound
	for rows.Next() {
		var round storedAuthorityRound
		var stateJSON []byte
		if err := rows.Scan(&round.Round, &round.ActionA, &round.ActionB, &round.DamageA, &round.DamageB, &round.EnvironmentDamage, &stateJSON); err != nil {
			return nil, err
		}
		state, err := decodeAuthorityState(stateJSON)
		if err != nil {
			return nil, err
		}
		round.State = state
		rounds = append(rounds, round)
	}
	return rounds, rows.Err()
}

func (s *IronFistService) writeAuthoritativeMatchProjectionsTx(ctx context.Context, tx *sql.Tx, game *lockedGame, rounds []storedAuthorityRound) error {
	if err := writeAuthorityProjectionForSeat(ctx, tx, game, rounds, ironfistengine.SeatA); err != nil {
		return err
	}
	if game.Mode != "pve" {
		return writeAuthorityProjectionForSeat(ctx, tx, game, rounds, ironfistengine.SeatB)
	}
	return nil
}

func writeAuthorityProjectionForSeat(ctx context.Context, tx *sql.Tx, game *lockedGame, rounds []storedAuthorityRound, seat ironfistengine.Seat) error {
	userID, opponentName := game.PlayerAUserID, "Computer"
	finalHP, opponentHP := game.State.HPA, game.State.HPB
	if seat == ironfistengine.SeatB {
		userID = game.PlayerBUserID
		finalHP, opponentHP = opponentHP, finalHP
	}
	if game.Mode != "pve" {
		opponentID := game.PlayerBUserID
		if seat == ironfistengine.SeatB {
			opponentID = game.PlayerAUserID
		}
		if err := tx.QueryRowContext(ctx, `SELECT nickname FROM users WHERE id = ?`, opponentID).Scan(&opponentName); err != nil {
			return err
		}
	}
	detail := make([]map[string]any, 0, len(rounds))
	for _, round := range rounds {
		ownAction, opponentAction := round.ActionA, round.ActionB
		damageToOwn, damageToOpponent := round.DamageA, round.DamageB
		if seat == ironfistengine.SeatB {
			ownAction, opponentAction = opponentAction, ownAction
			damageToOwn, damageToOpponent = damageToOpponent, damageToOwn
		}
		detail = append(detail, map[string]any{
			"r": round.Round, "p": ownAction, "o": opponentAction,
			"pd": damageToOwn, "od": damageToOpponent, "env": round.EnvironmentDamage,
		})
	}
	detailJSON, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	var pvpRoom any
	if game.PVPRoomID.Valid {
		pvpRoom = game.PVPRoomID.Int64
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO ironfist_matches (
			user_id, mode, result, player_hp, opponent_hp, rounds, opponent_name, detail,
			pvp_room_id, pve_reward_eligible, authoritative_game_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
		ON DUPLICATE KEY UPDATE authoritative_game_id = VALUES(authoritative_game_id)`,
		userID, game.Mode, resultForAuthoritySeat(game.Result, seat), finalHP, opponentHP,
		len(rounds), opponentName, detailJSON, pvpRoom, game.GameID,
	)
	return err
}

func (s *IronFistService) updateAuthoritativeStatsTx(ctx context.Context, tx *sql.Tx, game *lockedGame, rounds []storedAuthorityRound) error {
	if err := s.updateAuthorityStatsForSeatTx(ctx, tx, game, rounds, ironfistengine.SeatA); err != nil {
		return err
	}
	if game.Mode != "pve" {
		return s.updateAuthorityStatsForSeatTx(ctx, tx, game, rounds, ironfistengine.SeatB)
	}
	return nil
}

func (s *IronFistService) updateAuthorityStatsForSeatTx(ctx context.Context, tx *sql.Tx, game *lockedGame, rounds []storedAuthorityRound, seat ironfistengine.Seat) error {
	userID, finalHP := game.PlayerAUserID, game.State.HPA
	if seat == ironfistengine.SeatB {
		userID, finalHP = game.PlayerBUserID, game.State.HPB
	}
	if err := s.ensureStatsRow(ctx, tx, userID); err != nil {
		return err
	}
	var stats model.IronFistStats
	if err := tx.QueryRowContext(ctx, `
		SELECT pvp_wins, pvp_losses, pvp_draws, pve_wins, pve_losses, pve_draws,
		       friend_wins, friend_losses, friend_draws, current_win_streak, max_win_streak, total_battles
		FROM ironfist_stats WHERE user_id = ? FOR UPDATE`, userID).Scan(
		&stats.PvpWins, &stats.PvpLosses, &stats.PvpDraws,
		&stats.PveWins, &stats.PveLosses, &stats.PveDraws,
		&stats.FriendWins, &stats.FriendLosses, &stats.FriendDraws,
		&stats.CurrentWinStreak, &stats.MaxWinStreak, &stats.TotalBattles,
	); err != nil {
		return err
	}
	result := resultForAuthoritySeat(game.Result, seat)
	isWin, isDraw := result == "win", result == "draw" || result == "doubleLose"
	switch game.Mode {
	case "pvp":
		if isWin {
			stats.PvpWins++
		} else if isDraw {
			stats.PvpDraws++
		} else {
			stats.PvpLosses++
		}
	case "friend":
		if isWin {
			stats.FriendWins++
		} else if isDraw {
			stats.FriendDraws++
		} else {
			stats.FriendLosses++
		}
	default:
		if isWin {
			stats.PveWins++
		} else if isDraw {
			stats.PveDraws++
		} else {
			stats.PveLosses++
		}
	}
	stats.TotalBattles++
	if isWin {
		stats.CurrentWinStreak++
		if stats.CurrentWinStreak > stats.MaxWinStreak {
			stats.MaxWinStreak = stats.CurrentWinStreak
		}
	} else {
		stats.CurrentWinStreak = 0
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE ironfist_stats SET
			pvp_wins=?, pvp_losses=?, pvp_draws=?, pve_wins=?, pve_losses=?, pve_draws=?,
			friend_wins=?, friend_losses=?, friend_draws=?, current_win_streak=?, max_win_streak=?, total_battles=?
		WHERE user_id=?`,
		stats.PvpWins, stats.PvpLosses, stats.PvpDraws,
		stats.PveWins, stats.PveLosses, stats.PveDraws,
		stats.FriendWins, stats.FriendLosses, stats.FriendDraws,
		stats.CurrentWinStreak, stats.MaxWinStreak, stats.TotalBattles, userID,
	); err != nil {
		return err
	}
	facts := authorityFactsForSeat(rounds, seat, finalHP, game.Result)
	candidates := make([]string, 0, 6)
	if stats.TotalBattles >= 1 {
		candidates = append(candidates, model.AchievementFirstBattle)
	}
	if stats.TotalBattles >= 100 {
		candidates = append(candidates, model.AchievementHundredBattles)
	}
	if stats.MaxWinStreak >= 5 {
		candidates = append(candidates, model.AchievementWinStreak5)
	}
	if facts.CounterSuccesses >= 3 {
		candidates = append(candidates, model.AchievementCounterMaster)
	}
	if facts.LowHPWin {
		candidates = append(candidates, model.AchievementLowHpComeback)
	}
	if facts.HighHPWin {
		candidates = append(candidates, model.AchievementHighHpWin)
	}
	for _, code := range candidates {
		if _, err := tx.ExecContext(ctx, `INSERT IGNORE INTO ironfist_achievements (user_id, achievement_code) VALUES (?, ?)`, userID, code); err != nil {
			return err
		}
	}
	return nil
}

func (s *IronFistService) awardAuthoritativePVETx(ctx context.Context, tx *sql.Tx, userID uint64, gameID string, outcome ironfistengine.Outcome) error {
	date := s.authorityNow().Format("2006-01-02")
	if _, err := tx.ExecContext(ctx, `INSERT IGNORE INTO pve_daily_progress (user_id, date, wins_count, earned_today) VALUES (?, ?, 0, 0)`, userID, date); err != nil {
		return err
	}
	var priorWins int
	var priorEarned int64
	if err := tx.QueryRowContext(ctx, `SELECT wins_count, earned_today FROM pve_daily_progress WHERE user_id = ? AND date = ? FOR UPDATE`, userID, date).Scan(&priorWins, &priorEarned); err != nil {
		return err
	}
	base, bonus, wins := pveRewardFor(priorWins, outcome)
	if base == 0 && bonus == 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT IGNORE INTO fist_accounts (user_id, balance, total_earned) VALUES (?, 0, 0)`, userID); err != nil {
		return err
	}
	var balance int64
	if err := tx.QueryRowContext(ctx, `SELECT balance FROM fist_accounts WHERE user_id = ? FOR UPDATE`, userID).Scan(&balance); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE pve_daily_progress SET wins_count = ?, earned_today = ? WHERE user_id = ? AND date = ?`, wins, priorEarned+base+bonus, userID, date); err != nil {
		return err
	}
	if base > 0 {
		balance += base
		if err := addAuthorityRewardLedgerTx(ctx, tx, userID, gameID, "pve-base", base, balance); err != nil {
			return err
		}
	}
	if bonus > 0 {
		balance += bonus
		if err := addAuthorityRewardLedgerTx(ctx, tx, userID, gameID, "pve-bonus", bonus, balance); err != nil {
			return err
		}
	}
	_, err := tx.ExecContext(ctx, `UPDATE fist_accounts SET balance = ?, total_earned = total_earned + ? WHERE user_id = ?`, balance, base+bonus, userID)
	return err
}

func addAuthorityRewardLedgerTx(ctx context.Context, tx *sql.Tx, userID uint64, gameID, suffix string, amount, balanceAfter int64) error {
	settlementRef := "game:" + gameID + ":" + suffix
	_, err := tx.ExecContext(ctx, `
		INSERT INTO fist_transactions (user_id, amount, balance_after, type, ref_id, settlement_ref, remark)
		VALUES (?, ?, ?, 'pve_reward', ?, ?, ?)`,
		userID, amount, balanceAfter, gameID, settlementRef, "Authoritative IronFist PvE reward",
	)
	return err
}

func resultForAuthoritySeat(outcome ironfistengine.Outcome, seat ironfistengine.Seat) string {
	switch outcome {
	case ironfistengine.WinA:
		if seat == ironfistengine.SeatA {
			return "win"
		}
		return "lose"
	case ironfistengine.WinB:
		if seat == ironfistengine.SeatB {
			return "win"
		}
		return "lose"
	case ironfistengine.DoubleLose:
		return "doubleLose"
	default:
		return "draw"
	}
}
