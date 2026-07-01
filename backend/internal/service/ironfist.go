package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"e2eechat/internal/model"
	"github.com/go-sql-driver/mysql"
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
	PvpWins          int              `json:"pvp_wins"`
	PvpLosses        int              `json:"pvp_losses"`
	PvpDraws         int              `json:"pvp_draws"`
	PveWins          int              `json:"pve_wins"`
	PveLosses        int              `json:"pve_losses"`
	PveDraws         int              `json:"pve_draws"`
	FriendWins       int              `json:"friend_wins"`
	FriendLosses     int              `json:"friend_losses"`
	FriendDraws      int              `json:"friend_draws"`
	CurrentWinStreak int              `json:"current_win_streak"`
	MaxWinStreak     int              `json:"max_win_streak"`
	TotalBattles     int              `json:"total_battles"`
	Achievements     []string         `json:"achievements"`         // 已解锁成就代号列表
	NewAchievements  []string         `json:"new_achievements"`     // 本次新解锁（仅上报接口返回）
	PVPSettle        *PVPSettleResult `json:"pvp_settle,omitempty"` // 真实 PVP 结算结果（仅 mode=pvp + room_id 时填充）
}

// ReportMatchRequest 上报对局结果
type ReportMatchRequest struct {
	Mode             string          `json:"mode"`              // "pve" | "pvp" | "friend"
	Result           string          `json:"result"`            // "win" | "lose" | "draw" | "doubleLose"
	PlayerHP         int             `json:"player_hp"`         // 玩家最终 HP
	CounterSuccesses int             `json:"counter_successes"` // 单场反击成功次数
	Rounds           int             `json:"rounds"`            // 总回合数
	OpponentHP       int             `json:"opponent_hp"`       // 对手最终 HP
	OpponentName     string          `json:"opponent_name"`     // 对手昵称（PvP）/「电脑」
	Detail           json.RawMessage `json:"detail"`            // 逐回合明细 JSON 数组
	RoomID           *uint64         `json:"room_id,omitempty"` // 真实 PVP 撮合房间 ID：携带则触发质押结算（幂等）
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

	// === 真实 PVP 上报幂等去重 ===
	// 同一玩家对同一房间重复上报（双 gameover / 前端重试 / settle 失败后重试）时，
	// 统计与战绩只计一次——否则会虚增 pvp 胜负场次并写入重复战绩行。
	// 资金侧由 SettlePVP 自身幂等保证，此处仅守护统计与战绩。
	// 以 ironfist_matches 是否已存在 (user_id, pvp_room_id) 行为准：该行在首次上报的
	// 事务内提交，且与 settle 是否成功无关，因此即便首次 settle 失败、前端重试也不会重复计数。
	pvpDup := false
	if req.Mode == "pvp" && req.RoomID != nil {
		var one int
		derr := tx.QueryRowContext(ctx,
			`SELECT 1 FROM ironfist_matches WHERE user_id = ? AND pvp_room_id = ? LIMIT 1`,
			userID, *req.RoomID).Scan(&one)
		if derr == nil {
			pvpDup = true
		} else if derr != sql.ErrNoRows {
			return nil, derr
		}
	}

	var existing map[string]struct{}
	var newAchievements []string

	if pvpDup {
		// 重复上报：跳过统计/战绩/成就的全部写入，仅查询已解锁成就用于返回视图。
		// 注意不在此 return —— 仍需走下方 SettlePVP（幂等）以便重试时拿到结算结果。
		unlocked, qerr := s.queryAchievements(ctx, tx, userID)
		if qerr != nil {
			return nil, qerr
		}
		existing = make(map[string]struct{}, len(unlocked))
		for _, c := range unlocked {
			existing[c] = struct{}{}
		}
	} else {
		// === 更新胜负计数 ===
		// 注意：PVP 这里按"本方自报结果"计数（一次，已由 pvpDup 去重保证）。
		// 双方一致的常态下与仲裁结果相符；仅在作弊/desync 导致双方都报赢、被 SettlePVP
		// 仲裁为平局时，二者会短暂背离（统计偏向乐观）。资金以仲裁为准，统计仅展示用。
		isWin := req.Result == "win"
		// "doubleLose"（回合上限双方力竭）按平局计入，与 "draw" 同口径
		isDraw := req.Result == "draw" || req.Result == "doubleLose"
		// "lose" 计为负
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
		// 真实 PVP 写入 pvp_room_id 作为幂等锚点；pve/friend 为 NULL（不受唯一约束限制）
		var roomIDVal any
		if req.Mode == "pvp" && req.RoomID != nil {
			roomIDVal = *req.RoomID
		}
		if _, err = tx.ExecContext(ctx, `
			INSERT INTO ironfist_matches
			  (user_id, mode, result, player_hp, opponent_hp, rounds, opponent_name, detail, pvp_room_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, userID, req.Mode, req.Result, req.PlayerHP, req.OpponentHP, req.Rounds, oppName, detail, roomIDVal); err != nil {
			return nil, err
		}

		// === 成就判定（好友娱乐局不计入任何成就）===
		if req.Mode != "friend" {
			unlocked, qerr := s.queryAchievements(ctx, tx, userID)
			if qerr != nil {
				return nil, qerr
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
			unlocked, qerr := s.queryAchievements(ctx, tx, userID)
			if qerr != nil {
				return nil, qerr
			}
			existing = make(map[string]struct{}, len(unlocked))
			for _, c := range unlocked {
				existing[c] = struct{}{}
			}
		}
	}

	if err = tx.Commit(); err != nil {
		return nil, err
	}

	// 真实 PVP：携带 room_id 时触发质押结算（独立事务，幂等）
	// 与统计写入解耦：结算失败不影响统计已落库，前端可重试 reportMatch。
	var settle *PVPSettleResult
	if req.Mode == "pvp" && req.RoomID != nil {
		sr, serr := s.SettlePVP(ctx, *req.RoomID, userID, req.Result)
		if serr != nil {
			// 结算失败仅记录日志，不阻塞统计返回；调用方可在结果页提示
			fmt.Printf("[ironfist] settle pvp room %d by user %d: %v\n", *req.RoomID, userID, serr)
		} else {
			settle = sr
		}
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
		PVPSettle:        settle,
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

// LobbyUserProfile PVP 大厅展示的用户档案：聚合 users + fist_accounts + ironfist_stats
type LobbyUserProfile struct {
	ChatID       string `json:"chat_id"`
	Nickname     string `json:"nickname"`
	FistBalance  int64  `json:"fist_balance"`
	TotalBattles int    `json:"total_battles"`
}

// GetLobbyUserProfile 联表查询指定 chatID 的 PVP 大厅档案信息。
// 用于大厅列表展示与点击头像查看玩家信息。
// 任意子表缺失均返回 0/空值，不报错（新用户可能尚无 fist_accounts / ironfist_stats 行）。
func (s *IronFistService) GetLobbyUserProfile(ctx context.Context, chatID string) (*LobbyUserProfile, error) {
	p := &LobbyUserProfile{}
	// LEFT JOIN：users 一定存在；fist_accounts/ironfist_stats 可能为空
	err := s.db.QueryRowContext(ctx, `
		SELECT u.chat_id, u.nickname,
		       COALESCE(fa.balance, 0),
		       COALESCE(ist.total_battles, 0)
		FROM users u
		LEFT JOIN fist_accounts fa ON fa.user_id = u.id
		LEFT JOIN ironfist_stats ist ON ist.user_id = u.id
		WHERE u.chat_id = ?
	`, chatID).Scan(&p.ChatID, &p.Nickname, &p.FistBalance, &p.TotalBattles)
	if err != nil {
		return nil, err
	}
	return p, nil
}

// ─────────────────────────────────────────────────────
// PVP 撮合与质押结算
// ─────────────────────────────────────────────────────

// PVPTierStakes 各档位单人质押金额（与前端 PVP_TIERS 对齐）
var PVPTierStakes = map[string]int64{
	"gold":     100,
	"platinum": 1000,
	"diamond":  10000,
}

var (
	ErrPVPInvalidTier      = fmt.Errorf("invalid pvp tier")
	ErrPVPInsufficientFist = fmt.Errorf("insufficient $FIST balance")
	ErrPVPAlreadyQueued    = fmt.Errorf("already in pvp queue")
	ErrPVPNotInQueue       = fmt.Errorf("not in pvp queue")
	ErrPVPRoomNotFound     = fmt.Errorf("pvp room not found")
	ErrPVPRoomNotMatched   = fmt.Errorf("pvp room not in matched state")
	ErrPVPNotParticipant   = fmt.Errorf("caller is not a participant of this room")
	ErrPVPAlreadySettled   = fmt.Errorf("pvp room already settled")
	ErrPVPInvalidResult    = fmt.Errorf("invalid pvp result")
	ErrPVPSelfMatch        = fmt.Errorf("cannot match with self")
	ErrPVPAlreadyInMatch   = fmt.Errorf("already in an active pvp match")
)

// PVPMatchResult 加入撮合队列的返回值
type PVPMatchResult struct {
	Status   string            `json:"status"` // "queued" | "matched"
	RoomID   uint64            `json:"room_id,omitempty"`
	Tier     string            `json:"tier,omitempty"`
	Stake    int64             `json:"stake,omitempty"`
	Opponent *LobbyUserProfile `json:"opponent,omitempty"`        // 匹配成功时返回对手档案（供本地直接开局）
	Waiting  string            `json:"waiting_chat_id,omitempty"` // 匹配成功时为等待方 chatID（供 Hub 推送）
}

// PVPSettleResult 结算结果
type PVPSettleResult struct {
	Settled      bool   `json:"settled"`           // false 表示未结算（pending 或已结算的幂等返回）
	Pending      bool   `json:"pending,omitempty"` // true 表示已记录本方上报，等待对手确认
	RoomID       uint64 `json:"room_id"`
	Result       string `json:"result"`        // win_a / win_b / draw / doubleLose
	WinnerAmount int64  `json:"winner_amount"` // 赢家到手（含本金）
	RefundA      int64  `json:"refund_a"`      // 平局时 A 退回
	RefundB      int64  `json:"refund_b"`      // 平局时 B 退回
	FeeBurn      int64  `json:"fee_burn"`      // 销毁部分（MVP 仅记账）
	FeeTreasury  int64  `json:"fee_treasury"`  // 国库部分（MVP 仅记账）
}

// isDeadlock 判断是否为 MySQL 死锁错误（1213），用于重试决策。
func isDeadlock(err error) bool {
	var me *mysql.MySQLError
	return errors.As(err, &me) && me.Number == 1213
}

// EnqueuePVP 加入 PVP 撮合队列，内部对死锁自动重试最多 3 次。
//
// 调用方（Handler）拿到 Status=="matched" 时需通过 Hub 向 Waiting chatID 推送匹配通知。
func (s *IronFistService) EnqueuePVP(ctx context.Context, userID uint64, chatID, tier string) (*PVPMatchResult, error) {
	const maxRetries = 3
	for attempt := 0; ; attempt++ {
		result, err := s.enqueuePVPOnce(ctx, userID, chatID, tier)
		if err == nil || !isDeadlock(err) || attempt >= maxRetries-1 {
			return result, err
		}
		time.Sleep(time.Duration(attempt+1) * 20 * time.Millisecond)
	}
}

// enqueuePVP 加入 PVP 撮合队列（单次执行，不含重试）：
//  1. 校验档位与余额
//  2. 尝试匹配等待中的房间（玩家 B 视角）：找到则扣质押、状态置 matched、返回对手档案
//  3. 未匹配到则创建新房间（玩家 A 视角）：扣质押、状态置 matching、返回 queued
func (s *IronFistService) enqueuePVPOnce(ctx context.Context, userID uint64, chatID, tier string) (*PVPMatchResult, error) {
	stake, ok := PVPTierStakes[tier]
	if !ok {
		return nil, ErrPVPInvalidTier
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// 1. 先锁定本用户 $FIST 账户：对同一用户的并发入队请求在此处串行化，
	//    后续的重复入队检查（FOR UPDATE）才能看到前一个请求已提交的房间。
	if err = s.ensureFistAccountTx(ctx, tx, userID); err != nil {
		return nil, err
	}
	var balance int64
	if err = tx.QueryRowContext(ctx,
		`SELECT balance FROM fist_accounts WHERE user_id = ? FOR UPDATE`, userID).
		Scan(&balance); err != nil {
		return nil, err
	}
	if balance < stake {
		return nil, ErrPVPInsufficientFist
	}

	// 2. 防止重复入队：查找本用户已存在的 matching/matched 房间（同时检查 A/B 身份）。
	//    FOR UPDATE 做当前读，确保看到并发请求已提交的房间，避免重复扣质押。
	//    必须检查 player_b：否则用户已作为 B 在 matched 房间（未结算）时仍可创建/加入新房间，
	//    导致同时处于多场对局、质押双倍锁定。
	var (
		existingID     uint64
		existingStatus string
		existingTier   string
		existingStake  int64
	)
	err = tx.QueryRowContext(ctx, `
		SELECT id, status, tier, stake_amount FROM ironfist_pvp_rooms
		WHERE (player_a_user_id = ? OR player_b_user_id = ?) AND status IN ('matching', 'matched')
		ORDER BY id DESC LIMIT 1 FOR UPDATE
	`, userID, userID).Scan(&existingID, &existingStatus, &existingTier, &existingStake)
	if err == nil {
		if existingStatus == "matched" {
			// 已在一场未结算的对局中，禁止再次入队
			return nil, ErrPVPAlreadyInMatch
		}
		// 已在队列中（matching），直接返回 queued。
		// 用已有房间的 tier/stake 而非本次请求值：用户刷新后换档位再次入队时不应返回错误档位。
		return &PVPMatchResult{Status: "queued", RoomID: existingID, Tier: existingTier, Stake: existingStake}, nil
	}
	if err != sql.ErrNoRows {
		return nil, err
	}

	// 3. 尝试撮合：寻找同档位最早的 matching 房间（排除自己创建的）
	var (
		roomID, aUserID uint64
		aChatID         string
	)
	err = tx.QueryRowContext(ctx, `
		SELECT id, player_a_user_id, player_a_chat_id
		FROM ironfist_pvp_rooms
		WHERE tier = ? AND status = 'matching' AND player_a_user_id <> ?
		ORDER BY id ASC LIMIT 1 FOR UPDATE
	`, tier, userID).Scan(&roomID, &aUserID, &aChatID)
	if err == nil {
		// 命中撮合：本用户作为 B 加入
		if aUserID == userID {
			return nil, ErrPVPSelfMatch
		}
		// 扣 B 的质押
		if _, err = tx.ExecContext(ctx,
			`UPDATE fist_accounts SET balance = balance - ? WHERE user_id = ?`,
			stake, userID); err != nil {
			return nil, err
		}
		// B 的质押扣款流水
		if err = s.writeFistTx(ctx, tx, userID, -stake, "pvp_loss",
			fmt.Sprintf("PVP 质押（%s场，对手：%s）", tier, aChatID)); err != nil {
			return nil, err
		}
		// 房间状态推进
		if _, err = tx.ExecContext(ctx, `
			UPDATE ironfist_pvp_rooms
			SET player_b_user_id = ?, player_b_chat_id = ?,
			    status = 'matched', matched_at = CURRENT_TIMESTAMP(3)
			WHERE id = ? AND status = 'matching'
		`, userID, chatID, roomID); err != nil {
			return nil, err
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		// 查询 A 的档案供 B 直接展示
		opp, qerr := s.GetLobbyUserProfile(ctx, aChatID)
		if qerr != nil {
			opp = &LobbyUserProfile{ChatID: aChatID, Nickname: aChatID}
		}
		return &PVPMatchResult{
			Status:   "matched",
			RoomID:   roomID,
			Tier:     tier,
			Stake:    stake,
			Opponent: opp,
			Waiting:  aChatID,
		}, nil
	}
	if err != sql.ErrNoRows {
		return nil, err
	}

	// 4. 未命中撮合：作为玩家 A 创建新房间
	if _, err = tx.ExecContext(ctx,
		`UPDATE fist_accounts SET balance = balance - ? WHERE user_id = ?`,
		stake, userID); err != nil {
		return nil, err
	}
	if err = s.writeFistTx(ctx, tx, userID, -stake, "pvp_loss",
		fmt.Sprintf("PVP 质押（%s场，等待匹配）", tier)); err != nil {
		return nil, err
	}
	res, err := tx.ExecContext(ctx, `
		INSERT INTO ironfist_pvp_rooms
		  (tier, stake_amount, player_a_user_id, player_a_chat_id, status)
		VALUES (?, ?, ?, ?, 'matching')
	`, tier, stake, userID, chatID)
	if err != nil {
		return nil, err
	}
	rid, _ := res.LastInsertId()
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return &PVPMatchResult{
		Status: "queued",
		RoomID: uint64(rid),
		Tier:   tier,
		Stake:  stake,
	}, nil
}

// GetPVPQueueStatus 查询当前用户的撮合队列状态（前端轮询兜底 WS 通知丢失）。
// 返回最近的 matching/matched 房间；无则返回 status="idle"。
// 用于等待方（玩家 A）在 WS ironfist_pvp_matched 通知丢失时通过轮询发现匹配结果。
func (s *IronFistService) GetPVPQueueStatus(ctx context.Context, userID uint64) (*PVPMatchResult, error) {
	var (
		roomID, aUserID       uint64
		aChatID, tier, status string
		stake                 int64
		bUserID               sql.NullInt64
		bChatID               sql.NullString
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT id, tier, stake_amount, status,
		       player_a_user_id, player_a_chat_id,
		       player_b_user_id, player_b_chat_id
		FROM ironfist_pvp_rooms
		WHERE (player_a_user_id = ? OR player_b_user_id = ?)
		  AND status IN ('matching', 'matched')
		ORDER BY id DESC LIMIT 1
	`, userID, userID).Scan(&roomID, &tier, &stake, &status, &aUserID, &aChatID, &bUserID, &bChatID)
	if err == sql.ErrNoRows {
		return &PVPMatchResult{Status: "idle"}, nil
	}
	if err != nil {
		return nil, err
	}
	if status == "matching" {
		return &PVPMatchResult{Status: "queued", RoomID: roomID, Tier: tier, Stake: stake}, nil
	}
	// matched：本用户可能是 A 或 B，对手为另一方
	var oppChatID string
	if aUserID == userID {
		oppChatID = bChatID.String
	} else {
		oppChatID = aChatID
	}
	opp, qerr := s.GetLobbyUserProfile(ctx, oppChatID)
	if qerr != nil {
		opp = &LobbyUserProfile{ChatID: oppChatID}
	}
	return &PVPMatchResult{
		Status:   "matched",
		RoomID:   roomID,
		Tier:     tier,
		Stake:    stake,
		Opponent: opp,
	}, nil
}

// PVPRoomParticipants 房间参与方信息，供 WS 层做越权校验
type PVPRoomParticipants struct {
	Status  string // matching / matched / settled / cancelled
	AChatID string // player_a_chat_id（NOT NULL，必有值）
	BChatID string // player_b_chat_id（matched 前为空）
}

// GetPVPRoomParticipants 查询指定 PVP 房间的状态与双方 chatID。
// 用于 WS 层 ironfist_action / ironfist_reconnect 防越权：
//   - 校验 from 是否为参与方
//   - 校验 p.To 是否为对手 chatID
//   - 校验状态为 matched（结算后不再允许 action / reconnect）
//
// 房间不存在时返回 (nil, nil)。
func (s *IronFistService) GetPVPRoomParticipants(ctx context.Context, roomID uint64) (*PVPRoomParticipants, error) {
	var (
		status  string
		aChatID string
		bChatID sql.NullString
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT status, player_a_chat_id, player_b_chat_id
		FROM ironfist_pvp_rooms WHERE id = ?
	`, roomID).Scan(&status, &aChatID, &bChatID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p := &PVPRoomParticipants{Status: status, AChatID: aChatID}
	if bChatID.Valid {
		p.BChatID = bChatID.String
	}
	return p, nil
}

// CancelPVPQueue 取消撮合（用户主动取消或断线清理）：
// 仅 'matching' 状态可取消，全额退回质押；其他状态视为已无可取消队列。
// 通过 chatID 取消以支持 Hub.Unregister 调用；返回取消的 roomID（0 表示无可取消）。
func (s *IronFistService) CancelPVPQueue(ctx context.Context, chatID string) (uint64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var (
		roomID, aUserID uint64
		stake           int64
		tier            string
	)
	err = tx.QueryRowContext(ctx, `
		SELECT id, player_a_user_id, stake_amount, tier
		FROM ironfist_pvp_rooms
		WHERE player_a_chat_id = ? AND status = 'matching'
		ORDER BY id DESC LIMIT 1 FOR UPDATE
	`, chatID).Scan(&roomID, &aUserID, &stake, &tier)
	if err == sql.ErrNoRows {
		return 0, nil // 无在队，幂等
	}
	if err != nil {
		return 0, err
	}
	// 退款
	if _, err = tx.ExecContext(ctx,
		`UPDATE fist_accounts SET balance = balance + ? WHERE user_id = ?`,
		stake, aUserID); err != nil {
		return 0, err
	}
	if err = s.writeFistTx(ctx, tx, aUserID, stake, "pvp_refund",
		fmt.Sprintf("PVP 取消匹配（%s场，全额退回）", tier)); err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx,
		`UPDATE ironfist_pvp_rooms SET status = 'cancelled' WHERE id = ?`, roomID); err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return roomID, nil
}

// PVPMatchTimeout PVP 撮合等待超时窗口：超过则服务端自动取消并退款。
// 设为 5 分钟：长于前端兜底（10 分钟）会失去意义，短于 1 分钟会误伤。
// 客户端可提前主动取消；这里只兜底"客户端崩溃 / 网络完全失联"的极端情况。
const PVPMatchTimeout = 5 * time.Minute

// SweepTimeoutPVPQueues 扫描所有超时未匹配的 PVP 房间并退款。
// 由 main.go 的定时任务周期性调用（每 1 分钟）。返回处理的房间数。
//
// 触发条件：status='matching' 且 created_at < NOW() - PVPMatchTimeout。
// 退款方式与 CancelPVPQueue 一致：全额退给 A 玩家，房间状态置 'cancelled'。
func (s *IronFistService) SweepTimeoutPVPQueues(ctx context.Context) (int, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, player_a_user_id, stake_amount, tier
		FROM ironfist_pvp_rooms
		WHERE status = 'matching'
		  AND created_at < (NOW() - INTERVAL ? MINUTE)
	`, int(PVPMatchTimeout.Minutes()))
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	type pending struct {
		roomID, aUserID uint64
		stake           int64
		tier            string
	}
	var list []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.roomID, &p.aUserID, &p.stake, &p.tier); err != nil {
			return 0, err
		}
		list = append(list, p)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(list) == 0 {
		return 0, nil
	}

	swept := 0
	for _, p := range list {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return swept, err
		}
		// 二次校验状态（防止与正常撮合/取消并发冲突）
		var status string
		err = tx.QueryRowContext(ctx,
			`SELECT status FROM ironfist_pvp_rooms WHERE id = ? FOR UPDATE`,
			p.roomID).Scan(&status)
		if err == sql.ErrNoRows {
			tx.Rollback()
			continue
		}
		if err != nil {
			tx.Rollback()
			return swept, err
		}
		if status != "matching" {
			tx.Rollback()
			continue // 已被撮合/取消，跳过
		}
		// 退款给 A
		if _, err = tx.ExecContext(ctx,
			`UPDATE fist_accounts SET balance = balance + ? WHERE user_id = ?`,
			p.stake, p.aUserID); err != nil {
			tx.Rollback()
			return swept, err
		}
		if err = s.writeFistTx(ctx, tx, p.aUserID, p.stake, "pvp_refund",
			fmt.Sprintf("PVP 匹配超时（%s场，全额退回）", p.tier)); err != nil {
			tx.Rollback()
			return swept, err
		}
		if _, err = tx.ExecContext(ctx,
			`UPDATE ironfist_pvp_rooms SET status = 'cancelled' WHERE id = ?`,
			p.roomID); err != nil {
			tx.Rollback()
			return swept, err
		}
		if err = tx.Commit(); err != nil {
			return swept, err
		}
		swept++
	}
	return swept, nil
}

// PVPMatchedTimeout 已匹配但未结算的对局超时窗口：超过则服务端按平局退款兜底。
//
// 必须 ≥ 单局对战的最大真实时长，否则会把"仍在进行中的正常对局"误扫成平局，
// 抢走赢家的胜利并多扣双方手续费。对战上限：MAX_ROUNDS(20) × ROUND_SECONDS(30s) =
// 600s(10 分钟)，再叠加掉线后 60s 重连窗口（可能多次），实际最长约 11~12 分钟。
// 故设为 15 分钟，安全覆盖最长对局 + 缓冲；matched_at 在撮合时写入后不再刷新，
// 因此这是"从撮合成功到必须结算"的硬上限。
// 代价：撮合后无人开局的孤儿房间最长锁定 15 分钟才退款（罕见，前端已尽力主动取消）。
const PVPMatchedTimeout = 15 * time.Minute

// SweepTimeoutPVPMatched 扫描所有超时未结算的 matched 房间，按平局退款兜底。
// 由 main.go 的定时任务周期性调用（每 1 分钟）。返回处理的房间数。
//
// 触发条件：status='matched' 且 matched_at < NOW() - PVPMatchedTimeout。
// 退款方式：双方各退 97.5%（与平局结算一致），房间状态置 'settled'，result='draw'。
func (s *IronFistService) SweepTimeoutPVPMatched(ctx context.Context) (int, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, player_a_user_id, player_b_user_id, stake_amount, tier
		FROM ironfist_pvp_rooms
		WHERE status = 'matched'
		  AND matched_at < (NOW() - INTERVAL ? MINUTE)
	`, int(PVPMatchedTimeout.Minutes()))
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	type pending struct {
		roomID, aUserID, bUserID uint64
		stake                    int64
		tier                     string
	}
	var list []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.roomID, &p.aUserID, &p.bUserID, &p.stake, &p.tier); err != nil {
			return 0, err
		}
		list = append(list, p)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(list) == 0 {
		return 0, nil
	}

	swept := 0
	for _, p := range list {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return swept, err
		}
		var status string
		err = tx.QueryRowContext(ctx,
			`SELECT status FROM ironfist_pvp_rooms WHERE id = ? FOR UPDATE`,
			p.roomID).Scan(&status)
		if err == sql.ErrNoRows {
			tx.Rollback()
			continue
		}
		if err != nil {
			tx.Rollback()
			return swept, err
		}
		if status != "matched" {
			tx.Rollback()
			continue // 已被结算/取消，跳过
		}
		// 平局兜底：双方对等退回，各退 floor((pool - fee)/2)，余数并入手续费（与 SettlePVP 一致）
		totalPool := p.stake * 2
		nominalFee := totalPool * 25 / 1000 // 名义 2.5%
		refundEach := (totalPool - nominalFee) / 2
		refundA := refundEach
		refundB := refundEach
		actualFee := totalPool - refundEach*2
		feeBurn := actualFee / 2
		feeTreasury := actualFee - feeBurn
		if err = s.ensureFistAccountTx(ctx, tx, p.aUserID); err != nil {
			tx.Rollback()
			return swept, err
		}
		if err = s.ensureFistAccountTx(ctx, tx, p.bUserID); err != nil {
			tx.Rollback()
			return swept, err
		}
		if _, err = tx.ExecContext(ctx,
			`UPDATE fist_accounts SET balance = balance + ? WHERE user_id = ?`,
			refundA, p.aUserID); err != nil {
			tx.Rollback()
			return swept, err
		}
		if err = s.writeFistTx(ctx, tx, p.aUserID, refundA, "pvp_refund",
			fmt.Sprintf("PVP 对局超时未结算（%s场，平局退回）", p.tier)); err != nil {
			tx.Rollback()
			return swept, err
		}
		if _, err = tx.ExecContext(ctx,
			`UPDATE fist_accounts SET balance = balance + ? WHERE user_id = ?`,
			refundB, p.bUserID); err != nil {
			tx.Rollback()
			return swept, err
		}
		if err = s.writeFistTx(ctx, tx, p.bUserID, refundB, "pvp_refund",
			fmt.Sprintf("PVP 对局超时未结算（%s场，平局退回）", p.tier)); err != nil {
			tx.Rollback()
			return swept, err
		}
		if _, err = tx.ExecContext(ctx, `
			UPDATE ironfist_pvp_rooms
			SET status = 'settled', result = 'draw',
			    refund_a = ?, refund_b = ?, fee_burn = ?, fee_treasury = ?,
			    settled_at = CURRENT_TIMESTAMP(3)
			WHERE id = ?
		`, refundA, refundB, feeBurn, feeTreasury, p.roomID); err != nil {
			tx.Rollback()
			return swept, err
		}
		if err = tx.Commit(); err != nil {
			return swept, err
		}
		swept++
	}
	return swept, nil
}

// SettlePVP 结算 PVP 房间：根据 result 与 caller 身份计算赢家/退款/手续费。
// 幂等：若房间已 settled，直接返回已存结果（settled=false 表示之前已结算）。
// fee（销毁+国库）在 MVP 阶段不实际转账，仅写入房间字段与流水备注用于对账；
// 未来接入链上合约时改为真实 burn/treasury 转账。
func (s *IronFistService) SettlePVP(ctx context.Context, roomID, callerUserID uint64, callerResult string) (*PVPSettleResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var (
		status, tierStr, storedResult     string
		stake                             int64
		aUserID, bUserID                  uint64
		aChatID, bChatID                  string
		reportA, reportB                  sql.NullString
		stWinnerAmt, stRefundA, stRefundB int64
		stFeeBurn, stFeeTreasury          int64
	)
	err = tx.QueryRowContext(ctx, `
		SELECT status, tier, stake_amount,
		       player_a_user_id, player_b_user_id,
		       player_a_chat_id, player_b_chat_id,
		       COALESCE(result, ''), report_a, report_b,
		       winner_amount, refund_a, refund_b, fee_burn, fee_treasury
		FROM ironfist_pvp_rooms WHERE id = ? FOR UPDATE
	`, roomID).Scan(&status, &tierStr, &stake, &aUserID, &bUserID, &aChatID, &bChatID,
		&storedResult, &reportA, &reportB,
		&stWinnerAmt, &stRefundA, &stRefundB, &stFeeBurn, &stFeeTreasury)
	if err == sql.ErrNoRows {
		return nil, ErrPVPRoomNotFound
	}
	if err != nil {
		return nil, err
	}
	if callerUserID != aUserID && callerUserID != bUserID {
		return nil, ErrPVPNotParticipant
	}
	// 幂等：已结算 → 回放已存的最终结果与金额（供先上报方轮询拿到一致的结算信息）
	if status == "settled" {
		return &PVPSettleResult{
			Settled: true, RoomID: roomID, Result: storedResult,
			WinnerAmount: stWinnerAmt, RefundA: stRefundA, RefundB: stRefundB,
			FeeBurn: stFeeBurn, FeeTreasury: stFeeTreasury,
		}, nil
	}
	if status != "matched" {
		return nil, ErrPVPRoomNotMatched
	}

	// 调用方视角 → 房间视角
	callerIsA := callerUserID == aUserID
	roomResult, err := mapPVPResult(callerResult, callerIsA)
	if err != nil {
		return nil, err
	}

	// 首次为准，不可修改：本方只要已上报过（无论结果是否相同），就忽略本次上报。
	// 能走到这里（status='matched' 未结算）说明对手尚未上报——否则第二个上报方触发时
	// 双方均已 valid 会在同一事务内结算并置 settled，前面的 status 检查就已返回。
	// 因此本方重复上报无需改写、也不会影响结算，直接返回 pending（携带已存结果）。
	if callerIsA && reportA.Valid {
		return &PVPSettleResult{Pending: true, RoomID: roomID, Result: reportA.String}, nil
	}
	if !callerIsA && reportB.Valid {
		return &PVPSettleResult{Pending: true, RoomID: roomID, Result: reportB.String}, nil
	}

	// 记录本方首次上报
	if callerIsA {
		if _, err = tx.ExecContext(ctx,
			`UPDATE ironfist_pvp_rooms SET report_a = ? WHERE id = ?`, roomResult, roomID); err != nil {
			return nil, err
		}
		reportA = sql.NullString{String: roomResult, Valid: true}
	} else {
		if _, err = tx.ExecContext(ctx,
			`UPDATE ironfist_pvp_rooms SET report_b = ? WHERE id = ?`, roomResult, roomID); err != nil {
			return nil, err
		}
		reportB = sql.NullString{String: roomResult, Valid: true}
	}

	// 双方均已上报才结算；否则提交本方上报后返回 pending
	if !reportA.Valid || !reportB.Valid {
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return &PVPSettleResult{Pending: true, RoomID: roomID, Result: roomResult}, nil
	}

	// 双方上报一致 → 按该结果结算；不一致 → 判平局（防作弊兜底）
	finalResult := roomResult
	if reportA.String != reportB.String {
		finalResult = "draw"
	}

	out := &PVPSettleResult{RoomID: roomID, Result: finalResult, Settled: true}
	totalPool := stake * 2
	var totalFee int64
	if finalResult == "draw" || finalResult == "doubleLose" {
		totalFee = totalPool * 25 / 1000 // 2.5%
	} else {
		totalFee = totalPool * 5 / 100 // 5%
	}
	out.FeeBurn = totalFee / 2
	out.FeeTreasury = totalFee - out.FeeBurn // 余数归国库

	// 锁定两个账户行（防止与并发提现等冲突）
	if err = s.ensureFistAccountTx(ctx, tx, aUserID); err != nil {
		return nil, err
	}
	if err = s.ensureFistAccountTx(ctx, tx, bUserID); err != nil {
		return nil, err
	}

	// 备注里直接带上双方对手 chatID：A 的对手是 B，B 的对手是 A
	switch finalResult {
	case "win_a":
		out.WinnerAmount = totalPool - totalFee
		if _, err = tx.ExecContext(ctx,
			`UPDATE fist_accounts SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?`,
			out.WinnerAmount, out.WinnerAmount, aUserID); err != nil {
			return nil, err
		}
		if err = s.writeFistTx(ctx, tx, aUserID, out.WinnerAmount, "pvp_win",
			fmt.Sprintf("PVP 胜利奖励（%s场，对手：%s）", tierStr, bChatID)); err != nil {
			return nil, err
		}
	case "win_b":
		out.WinnerAmount = totalPool - totalFee
		if _, err = tx.ExecContext(ctx,
			`UPDATE fist_accounts SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?`,
			out.WinnerAmount, out.WinnerAmount, bUserID); err != nil {
			return nil, err
		}
		if err = s.writeFistTx(ctx, tx, bUserID, out.WinnerAmount, "pvp_win",
			fmt.Sprintf("PVP 胜利奖励（%s场，对手：%s）", tierStr, aChatID)); err != nil {
			return nil, err
		}
	case "draw", "doubleLose":
		// 平局：双方对等退回，各退 floor((pool - fee)/2)，不可整除的余数并入手续费。
		// 相比"余数归 B"，这样两名玩家退款金额完全一致（避免一方 97、一方 98 的观感差异），
		// 代价是平局费率可能比名义 2.5% 多出 1 个最小单位（并入 burn/treasury，仍守恒）。
		refundEach := (totalPool - totalFee) / 2
		out.RefundA = refundEach
		out.RefundB = refundEach
		actualFee := totalPool - refundEach*2 // = totalFee 或 totalFee+1
		out.FeeBurn = actualFee / 2
		out.FeeTreasury = actualFee - out.FeeBurn
		if _, err = tx.ExecContext(ctx,
			`UPDATE fist_accounts SET balance = balance + ? WHERE user_id = ?`,
			out.RefundA, aUserID); err != nil {
			return nil, err
		}
		if err = s.writeFistTx(ctx, tx, aUserID, out.RefundA, "pvp_refund",
			fmt.Sprintf("PVP 平局退回（%s场，对手：%s）", tierStr, bChatID)); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx,
			`UPDATE fist_accounts SET balance = balance + ? WHERE user_id = ?`,
			out.RefundB, bUserID); err != nil {
			return nil, err
		}
		if err = s.writeFistTx(ctx, tx, bUserID, out.RefundB, "pvp_refund",
			fmt.Sprintf("PVP 平局退回（%s场，对手：%s）", tierStr, aChatID)); err != nil {
			return nil, err
		}
	default:
		return nil, ErrPVPInvalidResult
	}

	if _, err = tx.ExecContext(ctx, `
		UPDATE ironfist_pvp_rooms
		SET status = 'settled', result = ?,
		    winner_amount = ?, refund_a = ?, refund_b = ?,
		    fee_burn = ?, fee_treasury = ?,
		    settled_at = CURRENT_TIMESTAMP(3)
		WHERE id = ?
	`, finalResult, out.WinnerAmount, out.RefundA, out.RefundB,
		out.FeeBurn, out.FeeTreasury, roomID); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// mapPVPResult 把调用方上报的 win/lose/draw/doubleLose 映射为房间视角结果。
// callerIsA=true 表示调用方是 A 玩家，否则是 B 玩家。
//
//	"win"  → caller 是胜者：A 胜→win_a，B 胜→win_b
//	"lose" → caller 是败者：A 败→win_b，B 败→win_a
//	"draw"/"doubleLose" → 同名
func mapPVPResult(r string, callerIsA bool) (string, error) {
	switch r {
	case "win":
		if callerIsA {
			return "win_a", nil
		}
		return "win_b", nil
	case "lose":
		if callerIsA {
			return "win_b", nil
		}
		return "win_a", nil
	case "draw":
		return "draw", nil
	case "doubleLose":
		return "doubleLose", nil
	default:
		return "", ErrPVPInvalidResult
	}
}

// ensureFistAccountTx 在事务内确保 fist_accounts 行存在（与 FistService.ensureAccount 等价）
func (s *IronFistService) ensureFistAccountTx(ctx context.Context, tx *sql.Tx, userID uint64) error {
	_, err := tx.ExecContext(ctx,
		`INSERT IGNORE INTO fist_accounts (user_id) VALUES (?)`, userID)
	return err
}

// writeFistTx 在事务内写一条 fist_transactions 流水
func (s *IronFistService) writeFistTx(ctx context.Context, tx *sql.Tx, userID uint64, amount int64, txType, remark string) error {
	var balanceAfter int64
	if err := tx.QueryRowContext(ctx,
		`SELECT balance FROM fist_accounts WHERE user_id = ?`, userID).
		Scan(&balanceAfter); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO fist_transactions (user_id, amount, balance_after, type, remark)
		VALUES (?, ?, ?, ?, ?)
	`, userID, amount, balanceAfter, txType, remark)
	return err
}
