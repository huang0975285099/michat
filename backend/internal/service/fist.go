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
	PvEDailyBonusAmount = int64(1000) // 每日满 10 场额外奖励

	// StatsDailyWindowDays 公开透明度统计接口（/api/fist/stats）的历史趋势窗口天数
	StatsDailyWindowDays = 30
)

var ErrPvEDailyLimitReached = errors.New("daily PvE win limit reached")

type FistService struct {
	db *sql.DB
}

func NewFistService(db *sql.DB) *FistService {
	return &FistService{db: db}
}

// FistAccountView 返回给前端的账户概览
type FistAccountView struct {
	Balance      int64  `json:"balance"`
	TotalEarned  uint64 `json:"total_earned"`
	TodayWins    int    `json:"today_wins"`
	TodayMax     int    `json:"today_max"`
	TodayEarned  int64  `json:"today_earned"`
	BonusAwarded bool   `json:"bonus_awarded"` // 本次领奖是否触发每日满 10 场奖励
	BonusAmount  int64  `json:"bonus_amount"`  // 满额奖励金额（触发时为 1000）
}

// ensureAccount 确保用户的 fist_accounts 行存在（首次访问时静默创建）
func (s *FistService) ensureAccount(ctx context.Context, ex interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, userID uint64) error {
	_, err := ex.ExecContext(ctx,
		`INSERT IGNORE INTO fist_accounts (user_id, balance, total_earned) VALUES (?, 0, 0)`,
		userID,
	)
	return err
}

// GetAccount 查询余额和今日 PvE 进度
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

// ClaimPvEReward 发放一次 PvE 胜局奖励（500 $FIST），每日上限 10 次。
// 全程在事务内原子执行，防止并发重复计数。
func (s *FistService) ClaimPvEReward(ctx context.Context, userID uint64) (*FistAccountView, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	if err = s.ensureAccount(ctx, tx, userID); err != nil {
		return nil, err
	}

	// Upsert 每日进度行，IF 条件确保 wins_count < 10 才递增
	// RowsAffected:
	//   1 = 新建行（第一场）
	//   2 = 已有行且值发生变化（正常递增）
	//   0 = 已有行但值未变（wins_count 已到 10，无法继续）
	res, err := tx.ExecContext(ctx, `
		INSERT INTO pve_daily_progress (user_id, date, wins_count, earned_today)
		VALUES (?, UTC_DATE(), 1, ?)
		ON DUPLICATE KEY UPDATE
		  wins_count   = IF(wins_count < ?, wins_count + 1, wins_count),
		  earned_today = IF(wins_count < ?, earned_today + ?, earned_today)
	`, userID, PvERewardAmount, PvEDailyMaxWins, PvEDailyMaxWins, PvERewardAmount)
	if err != nil {
		return nil, err
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return nil, ErrPvEDailyLimitReached
	}

	// 更新账户余额
	if _, err = tx.ExecContext(ctx, `
		UPDATE fist_accounts
		SET balance = balance + ?, total_earned = total_earned + ?
		WHERE user_id = ?
	`, PvERewardAmount, PvERewardAmount, userID); err != nil {
		return nil, err
	}

	// 读取更新后的完整状态
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

	// 写流水记录（balance_after = 已更新的余额）
	remark := fmt.Sprintf("第%d场PvE胜局（今日）", view.TodayWins)
	if _, err = tx.ExecContext(ctx, `
		INSERT INTO fist_transactions (user_id, amount, balance_after, type, remark)
		VALUES (?, ?, ?, 'pve_reward', ?)
	`, userID, PvERewardAmount, view.Balance, remark); err != nil {
		return nil, err
	}

	// 每日满 10 场额外奖励：本次领奖使 wins_count 恰好达到上限时发放（每日仅一次）。
	// 因为达 10 场后再次领奖会在上面的 upsert 处返回 ErrPvEDailyLimitReached，
	// 所以 TodayWins == PvEDailyMaxWins 只会在「第 10 场」这次成功领奖时成立。
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
			INSERT INTO fist_transactions (user_id, amount, balance_after, type, remark)
			VALUES (?, ?, ?, 'pve_reward', ?)
		`, userID, PvEDailyBonusAmount, view.Balance, "每日满10场额外奖励"); err != nil {
			return nil, err
		}
	}

	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return view, nil
}

// GetTransactions 查询流水明细，游标分页（before_id），最新在前。
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

// EcosystemStats 公开只读的 $FIST 生态透明度统计（无需鉴权，供国际站介绍页展示）
type EcosystemStats struct {
	CirculatingBalance int64           `json:"circulating_balance"` // 当前所有用户余额总和（内部核算口径）
	TotalPlayers       int64           `json:"total_players"`       // 已开通 $FIST 账户的用户数
	PveTotalIssued     int64           `json:"pve_total_issued"`    // PvE 奖励历史累计发放（含每日满勤奖励）
	PveTotalWins       int64           `json:"pve_total_wins"`      // PvE 历史累计有效胜局数
	PveTodayIssued     int64           `json:"pve_today_issued"`
	PveTodayWins       int64           `json:"pve_today_wins"`
	PveDaily           []PveDailyPoint `json:"pve_daily"` // 最近 StatsDailyWindowDays 天，按日期升序
	ActivePlayers7d    int64           `json:"active_players_7d"` // 近7天有过任意对局（pve/pvp/friend）的去重用户数
}

// PveDailyPoint 按天聚合的 PvE 发放数据点
type PveDailyPoint struct {
	Date   string `json:"date"` // YYYY-MM-DD（UTC）
	Issued int64  `json:"issued"`
	Wins   int64  `json:"wins"`
}

// GetEcosystemStats 查询全局 $FIST 生态数据：当前流通量/玩家数 + PvE 发放历史与近期趋势。
// 全部为聚合只读查询，不含任何单个用户的可识别信息。
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

	// 活跃玩家：与 total_players（已开户人数）区分，抵消"开户数被批量注册灌水"的误导
	// ironfist_matches.created_at 由列默认值 CURRENT_TIMESTAMP(3) 写入（服务端会话本地时区），
	// 故这里用 NOW() 而非 UTC_TIMESTAMP() 比较，避免时区错位（服务端会话时区非 UTC 时会偏移）。
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

	// pve_daily_progress.date 由 ClaimPvEReward 显式用 UTC_DATE() 写入，锚点用 UTC_DATE() 与写入侧一致。
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

	// 按锚点日期倒推 StatsDailyWindowDays 天补零，确保零活动日也有数据点（供前端画连续折线图）
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
