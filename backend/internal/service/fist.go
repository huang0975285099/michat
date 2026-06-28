package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"e2eechat/internal/model"
)

const (
	PvERewardAmount     = int64(500)
	PvEDailyMaxWins     = 10
	PvEDailyBonusAmount = int64(1000) // 每日满 10 场额外奖励
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
