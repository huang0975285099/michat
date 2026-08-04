package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"e2eechat/internal/model"
)

const (
	PvERewardAmount     = int64(500)
	PvEDailyMaxWins     = 10
	PvEDailyBonusAmount = int64(1000) //Additional rewards for reaching 10 games per day

	// StatsDailyWindowDays The number of historical trend window days in the public transparency statistics interface (/api/fist/stats)
	StatsDailyWindowDays = 30
)

var (
	ErrPvEDailyLimitReached = errors.New("daily PvE win limit reached")
	ErrNoEligiblePvEWin     = errors.New("no unclaimed PvE win")
)

type FistService struct {
	db *sql.DB
}

func NewFistService(db *sql.DB) *FistService {
	return &FistService{db: db}
}

// FistAccountView returns an account overview to the front end
type FistAccountView struct {
	Balance      int64  `json:"balance"`
	TotalEarned  uint64 `json:"total_earned"`
	TodayWins    int    `json:"today_wins"`
	TodayMax     int    `json:"today_max"`
	TodayEarned  int64  `json:"today_earned"`
	BonusAwarded bool   `json:"bonus_awarded"` //Will this reward trigger the reward for reaching 10 games per day?
	BonusAmount  int64  `json:"bonus_amount"`  //Full reward amount (1000 when triggered)
}

// ensureAccount ensures that the user's fist_accounts row exists (silently created on first access)
func (s *FistService) ensureAccount(ctx context.Context, ex interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, userID uint64) error {
	_, err := ex.ExecContext(ctx,
		`INSERT IGNORE INTO fist_accounts (user_id, balance, total_earned) VALUES (?, 0, 0)`,
		userID,
	)
	return err
}

// GetAccount Check balance and today's PvE progress
func (s *FistService) GetAccount(ctx context.Context, userID uint64) (*FistAccountView, error) {
	if err := s.ensureAccount(ctx, s.db, userID); err != nil {
		return nil, err
	}
	view := &FistAccountView{TodayMax: PvEDailyMaxWins}
	err := s.db.QueryRowContext(ctx, `
		SELECT fa.balance, fa.total_earned,
		       COALESCE(pdp.wins_count, 0),
		       COALESCE(pdp.earned_today, 0)
		FROM fist_accounts fa
		LEFT JOIN pve_daily_progress pdp
		       ON pdp.user_id = fa.user_id AND pdp.date = UTC_DATE()
		WHERE fa.user_id = ?
	`, userID).Scan(&view.Balance, &view.TotalEarned, &view.TodayWins, &view.TodayEarned)
	if err != nil {
		return nil, err
	}
	return view, nil
}

// ClaimPvEReward issues a PvE victory reward (500 $FIST), with a daily limit of 10 times.
// The entire process is executed atomically within the transaction to prevent concurrent double counting.
func (s *FistService) ClaimPvEReward(ctx context.Context, userID uint64) (*FistAccountView, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	if err = s.ensureAccount(ctx, tx, userID); err != nil {
		return nil, err
	}

	// The reward must be spent on a PvE victory that has been saved by ReportMatch and has not yet been claimed.
	// FOR UPDATE + The same transaction mark guarantees that concurrent requests can only be consumed once.
	var matchID uint64
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM ironfist_matches
		WHERE user_id = ? AND pve_reward_eligible = 1
		  AND pve_reward_claimed_at IS NULL
		ORDER BY id ASC LIMIT 1 FOR UPDATE
	`, userID).Scan(&matchID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoEligiblePvEWin
	}
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `
		UPDATE ironfist_matches SET pve_reward_claimed_at = CURRENT_TIMESTAMP(3)
		WHERE id = ? AND pve_reward_claimed_at IS NULL
	`, matchID); err != nil {
		return nil, err
	}

	// Upsert daily progress row, IF condition ensures wins_count < 10 before incrementing
	// RowsAffected:
	// 1 = new row (first field)
	// 2 = There is a row and the value changes (normal increment)
	// 0 = There is a row but the value has not changed (wins_count has reached 10, cannot continue)
	res, err := tx.ExecContext(ctx, `
		INSERT INTO pve_daily_progress (user_id, date, wins_count, earned_today)
		VALUES (?, UTC_DATE(), 1, ?)
		ON DUPLICATE KEY UPDATE
		  earned_today = IF(wins_count < ?, earned_today + ?, earned_today),
		  wins_count   = IF(wins_count < ?, wins_count + 1, wins_count)
	`, userID, PvERewardAmount, PvEDailyMaxWins, PvERewardAmount, PvEDailyMaxWins)
	if err != nil {
		return nil, err
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrPvEDailyLimitReached
	}

	// Update account balance
	if _, err = tx.ExecContext(ctx, `
		UPDATE fist_accounts
		SET balance = balance + ?, total_earned = total_earned + ?
		WHERE user_id = ?
	`, PvERewardAmount, PvERewardAmount, userID); err != nil {
		return nil, err
	}

	// Read the updated complete status
	view := &FistAccountView{TodayMax: PvEDailyMaxWins}
	if err = tx.QueryRowContext(ctx, `
		SELECT fa.balance, fa.total_earned,
		       COALESCE(pdp.wins_count, 0),
		       COALESCE(pdp.earned_today, 0)
		FROM fist_accounts fa
		LEFT JOIN pve_daily_progress pdp
		       ON pdp.user_id = fa.user_id AND pdp.date = UTC_DATE()
		WHERE fa.user_id = ?
	`, userID).Scan(&view.Balance, &view.TotalEarned, &view.TodayWins, &view.TodayEarned); err != nil {
		return nil, err
	}

	// Write transaction records (balance_after = updated balance)
	remark := fmt.Sprintf("第%d场PvE胜局（今日）", view.TodayWins)
	if _, err = tx.ExecContext(ctx, `
		INSERT INTO fist_transactions (user_id, amount, balance_after, type, ref_id, remark)
		VALUES (?, ?, ?, 'pve_reward', ?, ?)
	`, userID, PvERewardAmount, view.Balance, fmt.Sprintf("ironfist_match:%d", matchID), remark); err != nil {
		return nil, err
	}

	// Additional rewards for reaching 10 games per day: This reward will be issued when wins_count reaches the upper limit (only once per day).
	// Because claiming the prize again after 10 games will return ErrPvEDailyLimitReached at the upsert above,
	// Therefore, TodayWins == PvEDailyMaxWins will only be established when the prize is successfully collected in the "10th game".
	if view.TodayWins == PvEDailyMaxWins {
		if _, err = tx.ExecContext(ctx, `
			UPDATE fist_accounts
			SET balance = balance + ?, total_earned = total_earned + ?
			WHERE user_id = ?
		`, PvEDailyBonusAmount, PvEDailyBonusAmount, userID); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, `
			UPDATE pve_daily_progress
			SET earned_today = earned_today + ?
			WHERE user_id = ? AND date = UTC_DATE()
		`, PvEDailyBonusAmount, userID); err != nil {
			return nil, err
		}
		view.Balance += PvEDailyBonusAmount
		view.TotalEarned += uint64(PvEDailyBonusAmount)
		view.TodayEarned += PvEDailyBonusAmount
		view.BonusAwarded = true
		view.BonusAmount = PvEDailyBonusAmount
		if _, err = tx.ExecContext(ctx, `
			INSERT INTO fist_transactions (user_id, amount, balance_after, type, ref_id, remark)
			VALUES (?, ?, ?, 'pve_reward', ?, ?)
		`, userID, PvEDailyBonusAmount, view.Balance, fmt.Sprintf("ironfist_match:%d", matchID), "每日满10场额外奖励"); err != nil {
			return nil, err
		}
	}

	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return view, nil
}

// GetTransactions queries the transaction details, cursor paging (before_id), latest first.
func (s *FistService) GetTransactions(ctx context.Context, userID uint64, beforeID uint64, limit int) ([]*model.FistTransaction, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	query := `
		SELECT id, user_id, amount, balance_after, type, ref_id, remark, created_at
		FROM fist_transactions
		WHERE user_id = ?`
	args := []any{userID}

	if beforeID > 0 {
		query += ` AND id < ?`
		args = append(args, beforeID)
	}
	query += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var txs []*model.FistTransaction
	for rows.Next() {
		t := &model.FistTransaction{}
		var refID, remark sql.NullString
		if err = rows.Scan(
			&t.ID, &t.UserID, &t.Amount, &t.BalanceAfter,
			&t.Type, &refID, &remark, &t.CreatedAt,
		); err != nil {
			return nil, err
		}
		if refID.Valid {
			t.RefID = &refID.String
		}
		if remark.Valid {
			t.Remark = &remark.String
		}
		txs = append(txs, t)
	}
	return txs, rows.Err()
}

// EcosystemStats public read-only $FIST ecological transparency statistics (no authentication required, for display on the international station introduction page)
type EcosystemStats struct {
	CirculatingBalance int64           `json:"circulating_balance"` //The current sum of all user balances (internal accounting caliber)
	TotalPlayers       int64           `json:"total_players"`       //Number of users who have opened $FIST accounts
	PveTotalIssued     int64           `json:"pve_total_issued"`    //Historical cumulative distribution of PvE rewards (including daily attendance rewards)
	PveTotalWins       int64           `json:"pve_total_wins"`      //PvE historical accumulated effective number of wins
	PveTodayIssued     int64           `json:"pve_today_issued"`
	PveTodayWins       int64           `json:"pve_today_wins"`
	PveDaily           []PveDailyPoint `json:"pve_daily"`         //Most recent StatsDailyWindowDays days, ascending date order
	ActivePlayers7d    int64           `json:"active_players_7d"` //The number of deduplicated users who have played any game (pve/pvp/friend) in the past 7 days
}

// PveDailyPoint PvE distribution data points aggregated by day
type PveDailyPoint struct {
	Date   string `json:"date"` // YYYY-MM-DD（UTC）
	Issued int64  `json:"issued"`
	Wins   int64  `json:"wins"`
}

// GetEcosystemStats queries the global $FIST ecological data: current circulation/number of players + PvE distribution history and recent trends.
// All are aggregated read-only queries and do not contain any identifiable information about individual users.
func (s *FistService) GetEcosystemStats(ctx context.Context) (*EcosystemStats, error) {
	st := &EcosystemStats{}

	if err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(balance), 0), COUNT(*) FROM fist_accounts
	`).Scan(&st.CirculatingBalance, &st.TotalPlayers); err != nil {
		return nil, err
	}

	if err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(earned_today), 0), COALESCE(SUM(wins_count), 0)
		FROM pve_daily_progress
	`).Scan(&st.PveTotalIssued, &st.PveTotalWins); err != nil {
		return nil, err
	}

	// Active players: distinguished from total_players (the number of people who have opened accounts) to offset the misleading of "the number of accounts opened is flooded by batch registration"
	// ironfist_matches.created_at is written with the column default value CURRENT_TIMESTAMP(3) (server session local time zone),
	// Therefore, NOW() is used instead of UTC_TIMESTAMP() for comparison to avoid time zone misalignment (the server session time zone will be offset when it is not UTC).
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(DISTINCT user_id) FROM ironfist_matches
		WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
	`).Scan(&st.ActivePlayers7d); err != nil {
		return nil, err
	}

	if err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(earned_today), 0), COALESCE(SUM(wins_count), 0)
		FROM pve_daily_progress WHERE date = UTC_DATE()
	`).Scan(&st.PveTodayIssued, &st.PveTodayWins); err != nil {
		return nil, err
	}

	// pve_daily_progress.date is explicitly written with UTC_DATE() by ClaimPvEReward, anchored with UTC_DATE() consistent with the writing side.
	var anchor time.Time
	if err := s.db.QueryRowContext(ctx, `SELECT UTC_DATE()`).Scan(&anchor); err != nil {
		return nil, err
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT date, SUM(earned_today), SUM(wins_count)
		FROM pve_daily_progress
		WHERE date >= DATE_SUB(UTC_DATE(), INTERVAL ? DAY)
		GROUP BY date
		ORDER BY date ASC
	`, StatsDailyWindowDays-1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byDate := make(map[string]PveDailyPoint, StatsDailyWindowDays)
	for rows.Next() {
		var d time.Time
		p := PveDailyPoint{}
		if err = rows.Scan(&d, &p.Issued, &p.Wins); err != nil {
			return nil, err
		}
		byDate[d.Format("2006-01-02")] = p
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}

	// Push back by the anchor date and add zeros to StatsDailyWindowDays days to ensure that there are data points on zero activity days (for the front-end to draw continuous line charts)
	st.PveDaily = make([]PveDailyPoint, StatsDailyWindowDays)
	for i := 0; i < StatsDailyWindowDays; i++ {
		ds := anchor.AddDate(0, 0, i-(StatsDailyWindowDays-1)).Format("2006-01-02")
		p := PveDailyPoint{Date: ds}
		if v, ok := byDate[ds]; ok {
			p.Issued, p.Wins = v.Issued, v.Wins
		}
		st.PveDaily[i] = p
	}
	return st, nil
}
