package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"e2eechat/internal/model"
)

// IronFistService 铁拳对战统计与成就服务
type IronFistService struct {
	db *sql.DB
}

func NewIronFistService(db *sql.DB) *IronFistService {
	return &IronFistService{db: db}
}

// StatsView 返回给前端的统计概览
type StatsView struct {
	PvpWins          int      `json:"pvp_wins"`
	PvpLosses        int      `json:"pvp_losses"`
	PvpDraws         int      `json:"pvp_draws"`
	PveWins          int      `json:"pve_wins"`
	PveLosses        int      `json:"pve_losses"`
	PveDraws         int      `json:"pve_draws"`
	FriendWins       int      `json:"friend_wins"`
	FriendLosses     int      `json:"friend_losses"`
	FriendDraws      int      `json:"friend_draws"`
	CurrentWinStreak int      `json:"current_win_streak"`
	MaxWinStreak     int      `json:"max_win_streak"`
	TotalBattles     int      `json:"total_battles"`
	Achievements     []string `json:"achievements"`     // 已解锁成就代号列表
	NewAchievements  []string `json:"new_achievements"` // 本次新解锁（仅上报接口返回）
}

// ReportMatchRequest 上报对局结果
type ReportMatchRequest struct {
	Mode             string          `json:"mode"`              // "pve" | "pvp"
	Result           string          `json:"result"`            // "win" | "lose" | "draw" | "doubleLose"
	PlayerHP         int             `json:"player_hp"`         // 玩家最终 HP
	CounterSuccesses int             `json:"counter_successes"` // 单场反击成功次数
	Rounds           int             `json:"rounds"`            // 总回合数
	OpponentHP       int             `json:"opponent_hp"`       // 对手最终 HP
	OpponentName     string          `json:"opponent_name"`     // 对手昵称（PvP）/「电脑」
	Detail           json.RawMessage `json:"detail"`            // 逐回合明细 JSON 数组
}

// MatchLogView 逐局对战明细（返回给前端）
type MatchLogView struct {
	ID           uint64          `json:"id"`
	Mode         string          `json:"mode"`
	Result       string          `json:"result"`
	PlayerHP     int             `json:"player_hp"`
	OpponentHP   int             `json:"opponent_hp"`
	Rounds       int             `json:"rounds"`
	OpponentName string          `json:"opponent_name"`
	Detail       json.RawMessage `json:"detail"`
	CreatedAt    string          `json:"created_at"`
}

// ensureStatsRow 确保用户的 ironfist_stats 行存在
func (s *IronFistService) ensureStatsRow(ctx context.Context, ex interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, userID uint64) error {
	_, err := ex.ExecContext(ctx,
		`INSERT IGNORE INTO ironfist_stats (user_id) VALUES (?)`, userID)
	return err
}

// GetStats 查询当前用户统计与已解锁成就
func (s *IronFistService) GetStats(ctx context.Context, userID uint64) (*StatsView, error) {
	if err := s.ensureStatsRow(ctx, s.db, userID); err != nil {
		return nil, err
	}
	view := &StatsView{Achievements: []string{}}
	err := s.db.QueryRowContext(ctx, `
		SELECT pvp_wins, pvp_losses, pvp_draws,
		       pve_wins, pve_losses, pve_draws,
		       friend_wins, friend_losses, friend_draws,
		       current_win_streak, max_win_streak, total_battles
		FROM ironfist_stats WHERE user_id = ?
	`, userID).Scan(
		&view.PvpWins, &view.PvpLosses, &view.PvpDraws,
		&view.PveWins, &view.PveLosses, &view.PveDraws,
		&view.FriendWins, &view.FriendLosses, &view.FriendDraws,
		&view.CurrentWinStreak, &view.MaxWinStreak, &view.TotalBattles,
	)
	if err != nil {
		return nil, err
	}
	unlocked, err := s.queryAchievements(ctx, s.db, userID)
	if err != nil {
		return nil, err
	}
	view.Achievements = unlocked
	return view, nil
}

// queryAchievements 查询已解锁成就代号列表（保序，按 AllAchievements 顺序）
func (s *IronFistService) queryAchievements(ctx context.Context, ex interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, userID uint64) ([]string, error) {
	rows, err := ex.QueryContext(ctx,
		`SELECT achievement_code FROM ironfist_achievements WHERE user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	set := make(map[string]struct{})
	for rows.Next() {
		var code string
		if err = rows.Scan(&code); err != nil {
			return nil, err
		}
		set[code] = struct{}{}
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// 按 AllAchievements 定义顺序输出
	out := make([]string, 0, len(set))
	for _, code := range model.AllAchievements {
		if _, ok := set[code]; ok {
			out = append(out, code)
		}
	}
	return out, nil
}

// ReportMatch 上报对局结果，更新统计并判定成就解锁。
// 全程在事务内原子执行，返回更新后的统计 + 本次新解锁的成就。
func (s *IronFistService) ReportMatch(ctx context.Context, userID uint64, req *ReportMatchRequest) (*StatsView, error) {
	if req.Mode != "pve" && req.Mode != "pvp" && req.Mode != "friend" {
		return nil, fmt.Errorf("invalid mode: %s", req.Mode)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	if err = s.ensureStatsRow(ctx, tx, userID); err != nil {
		return nil, err
	}

	// 读取当前统计并加行锁，防止并发上报导致计数错乱
	var st model.IronFistStats
	err = tx.QueryRowContext(ctx, `
		SELECT pvp_wins, pvp_losses, pvp_draws,
		       pve_wins, pve_losses, pve_draws,
		       friend_wins, friend_losses, friend_draws,
		       current_win_streak, max_win_streak, total_battles
		FROM ironfist_stats WHERE user_id = ? FOR UPDATE
	`, userID).Scan(
		&st.PvpWins, &st.PvpLosses, &st.PvpDraws,
		&st.PveWins, &st.PveLosses, &st.PveDraws,
		&st.FriendWins, &st.FriendLosses, &st.FriendDraws,
		&st.CurrentWinStreak, &st.MaxWinStreak, &st.TotalBattles,
	)
	if err != nil {
		return nil, err
	}

	// === 更新胜负计数 ===
	isWin := req.Result == "win"
	isDraw := req.Result == "draw"
	// "lose" 与 "doubleLose" 均计为负
	switch req.Mode {
	case "pvp":
		switch {
		case isWin:
			st.PvpWins++
		case isDraw:
			st.PvpDraws++
		default:
			st.PvpLosses++
		}
	case "friend":
		// 好友娱乐局：独立计数，不影响 total_battles / 连胜 / 成就
		switch {
		case isWin:
			st.FriendWins++
		case isDraw:
			st.FriendDraws++
		default:
			st.FriendLosses++
		}
	default: // pve
		switch {
		case isWin:
			st.PveWins++
		case isDraw:
			st.PveDraws++
		default:
			st.PveLosses++
		}
	}

	// === 连胜 & 总场次（好友局不计入）===
	if req.Mode != "friend" {
		if isWin {
			st.CurrentWinStreak++
			if st.CurrentWinStreak > st.MaxWinStreak {
				st.MaxWinStreak = st.CurrentWinStreak
			}
		} else {
			st.CurrentWinStreak = 0
		}
		st.TotalBattles++
	}

	if _, err = tx.ExecContext(ctx, `
		UPDATE ironfist_stats
		SET pvp_wins=?, pvp_losses=?, pvp_draws=?,
		    pve_wins=?, pve_losses=?, pve_draws=?,
		    friend_wins=?, friend_losses=?, friend_draws=?,
		    current_win_streak=?, max_win_streak=?, total_battles=?
		WHERE user_id=?
	`, st.PvpWins, st.PvpLosses, st.PvpDraws,
		st.PveWins, st.PveLosses, st.PveDraws,
		st.FriendWins, st.FriendLosses, st.FriendDraws,
		st.CurrentWinStreak, st.MaxWinStreak, st.TotalBattles,
		userID); err != nil {
		return nil, err
	}

	// === 逐局明细落库 ===
	// detail 为空数组/空值时存 NULL，避免无意义占用
	var detail any
	if len(req.Detail) > 0 && string(req.Detail) != "null" && string(req.Detail) != "[]" {
		detail = []byte(req.Detail)
	}
	var oppName any
	if req.OpponentName != "" {
		oppName = req.OpponentName
	}
	if _, err = tx.ExecContext(ctx, `
		INSERT INTO ironfist_matches
		  (user_id, mode, result, player_hp, opponent_hp, rounds, opponent_name, detail)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, userID, req.Mode, req.Result, req.PlayerHP, req.OpponentHP, req.Rounds, oppName, detail); err != nil {
		return nil, err
	}

	// === 成就判定（好友娱乐局不计入任何成就）===
	var existing map[string]struct{}
	var newAchievements []string

	if req.Mode != "friend" {
		unlocked, err := s.queryAchievements(ctx, tx, userID)
		if err != nil {
			return nil, err
		}
		existing = make(map[string]struct{}, len(unlocked))
		for _, c := range unlocked {
			existing[c] = struct{}{}
		}

		shouldUnlock := []string{}
		if st.TotalBattles >= 1 {
			shouldUnlock = append(shouldUnlock, model.AchievementFirstBattle)
		}
		if st.TotalBattles >= 100 {
			shouldUnlock = append(shouldUnlock, model.AchievementHundredBattles)
		}
		if st.MaxWinStreak >= 5 {
			shouldUnlock = append(shouldUnlock, model.AchievementWinStreak5)
		}
		if req.CounterSuccesses >= 3 {
			shouldUnlock = append(shouldUnlock, model.AchievementCounterMaster)
		}
		if isWin && req.PlayerHP < 10 {
			shouldUnlock = append(shouldUnlock, model.AchievementLowHpComeback)
		}
		if isWin && req.PlayerHP > 90 {
			shouldUnlock = append(shouldUnlock, model.AchievementHighHpWin)
		}

		for _, code := range shouldUnlock {
			if _, ok := existing[code]; ok {
				continue
			}
			if _, err = tx.ExecContext(ctx, `
				INSERT IGNORE INTO ironfist_achievements (user_id, achievement_code) VALUES (?, ?)
			`, userID, code); err != nil {
				return nil, err
			}
			newAchievements = append(newAchievements, code)
			existing[code] = struct{}{}
		}
	} else {
		// 好友局：查询现有成就仅用于返回视图，不做任何写入
		unlocked, err := s.queryAchievements(ctx, tx, userID)
		if err != nil {
			return nil, err
		}
		existing = make(map[string]struct{}, len(unlocked))
		for _, c := range unlocked {
			existing[c] = struct{}{}
		}
	}

	if err = tx.Commit(); err != nil {
		return nil, err
	}

	// 组装返回视图（按定义顺序输出已解锁成就）
	allUnlocked := make([]string, 0, len(existing))
	for _, code := range model.AllAchievements {
		if _, ok := existing[code]; ok {
			allUnlocked = append(allUnlocked, code)
		}
	}
	if newAchievements == nil {
		newAchievements = []string{}
	}
	return &StatsView{
		PvpWins:          st.PvpWins,
		PvpLosses:        st.PvpLosses,
		PvpDraws:         st.PvpDraws,
		PveWins:          st.PveWins,
		PveLosses:        st.PveLosses,
		PveDraws:         st.PveDraws,
		FriendWins:       st.FriendWins,
		FriendLosses:     st.FriendLosses,
		FriendDraws:      st.FriendDraws,
		CurrentWinStreak: st.CurrentWinStreak,
		MaxWinStreak:     st.MaxWinStreak,
		TotalBattles:     st.TotalBattles,
		Achievements:     allUnlocked,
		NewAchievements:  newAchievements,
	}, nil
}

// ListMatches 查询逐局对战明细，游标分页（before_id），最新在前。
func (s *IronFistService) ListMatches(ctx context.Context, userID uint64, beforeID uint64, limit int) ([]*MatchLogView, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	query := `
		SELECT id, mode, result, player_hp, opponent_hp, rounds, opponent_name, detail, created_at
		FROM ironfist_matches
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

	out := make([]*MatchLogView, 0, limit)
	for rows.Next() {
		m := &MatchLogView{}
		var oppName sql.NullString
		var detail []byte
		if err = rows.Scan(
			&m.ID, &m.Mode, &m.Result, &m.PlayerHP, &m.OpponentHP,
			&m.Rounds, &oppName, &detail, &m.CreatedAt,
		); err != nil {
			return nil, err
		}
		if oppName.Valid {
			m.OpponentName = oppName.String
		}
		if len(detail) > 0 {
			m.Detail = json.RawMessage(detail)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
