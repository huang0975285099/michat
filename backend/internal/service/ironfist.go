package service

import (
	"context"
	cryptorand "crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
	"unicode/utf8"

	"e2eechat/internal/ironfistengine"
	"e2eechat/internal/model"
	"github.com/go-sql-driver/mysql"
)

// IronFistService Iron Fist battle statistics and achievement service
type IronFistService struct {
	db            *sql.DB
	now           func() time.Time
	random        io.Reader
	newGameID     func() string
	outboxPublish func(context.Context, string) error
}

func NewIronFistService(db *sql.DB) *IronFistService {
	return &IronFistService{
		db:     db,
		now:    time.Now,
		random: cryptorand.Reader,
		newGameID: func() string {
			id, _ := generateAuthorityUUID(cryptorand.Reader)
			return id
		},
	}
}

// StatsView returns an overview of statistics to the front end
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
	Achievements     []string         `json:"achievements"`         //List of unlocked achievement codes
	NewAchievements  []string         `json:"new_achievements"`     //Newly unlocked this time (only reported interface returns)
	PVPSettle        *PVPSettleResult `json:"pvp_settle,omitempty"` //Real PVP settlement result (only populated when mode=pvp + room_id)
}

// ReportMatchRequest reports match results
type ReportMatchRequest struct {
	Mode             string          `json:"mode"`              // "pve" | "pvp" | "friend"
	Result           string          `json:"result"`            // "win" | "lose" | "draw" | "doubleLose"
	PlayerHP         int             `json:"player_hp"`         //Player's final HP
	CounterSuccesses int             `json:"counter_successes"` //Number of successful counterattacks in a single game
	Rounds           int             `json:"rounds"`            //Total rounds
	OpponentHP       int             `json:"opponent_hp"`       //Opponent's final HP
	OpponentName     string          `json:"opponent_name"`     //Opponent Nickname (PvP)/"Computer"
	Detail           json.RawMessage `json:"detail"`            //JSON array of round-by-round details
	RoomID           *uint64         `json:"room_id,omitempty"` //Real PVP matching room ID: carrying it triggers pledge settlement (idempotent)
}

// MatchLogView game-by-game match details (returned to the front end)
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

// ensureStatsRow ensures that the user's ironfist_stats row exists
func (s *IronFistService) ensureStatsRow(ctx context.Context, ex interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, userID uint64) error {
	_, err := ex.ExecContext(ctx,
		`INSERT IGNORE INTO ironfist_stats (user_id) VALUES (?)`, userID)
	return err
}

// GetStats Query current user statistics and unlocked achievements
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

// queryAchievements Query the list of unlocked achievement codes (ordered, in AllAchievements order)
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
	// Output in the order defined by AllAchievements
	out := make([]string, 0, len(set))
	for _, code := range model.AllAchievements {
		if _, ok := set[code]; ok {
			out = append(out, code)
		}
	}
	return out, nil
}

// ReportMatch reports game results, updates statistics and determines achievement unlocks.
// The entire process is executed atomically within the transaction, and the updated statistics + the newly unlocked achievements are returned.
func (s *IronFistService) ReportMatch(ctx context.Context, userID uint64, req *ReportMatchRequest) (*StatsView, error) {
	if err := validateReportMatchRequest(req); err != nil {
		return nil, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	if err = s.ensureStatsRow(ctx, tx, userID); err != nil {
		return nil, err
	}

	// Read the current statistics and add row locks to prevent counting confusion caused by concurrent reporting.
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

	// === Real PVP reporting idempotent deduplication ===
	// When the same player reports to the same room repeatedly (double gameover/front-end retry/retry after settlement failure),
	// Statistics and results are only counted once - otherwise the number of pvp wins and losses will be inflated and duplicate record rows will be written.
	// The capital side is guaranteed by SettlePVP itself as idempotent, and only statistics and achievements are guarded here.
	// Depends on whether ironfist_matches already exists (user_id, pvp_room_id) row: this row is reported for the first time
	// It is committed within the transaction and has nothing to do with whether the settlement is successful, so even if the first settlement fails and the front-end retries, the count will not be repeated.
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
		// Repeated reporting: Skip all writing of statistics/achievements/achievements, and only query unlocked achievements for return view.
		// Note that there is no return here - you still need to go to SettlePVP (idempotent) below to get the settlement result when you try again.
		unlocked, qerr := s.queryAchievements(ctx, tx, userID)
		if qerr != nil {
			return nil, qerr
		}
		existing = make(map[string]struct{}, len(unlocked))
		for _, c := range unlocked {
			existing[c] = struct{}{}
		}
	} else {
		// === Update win-loss count ===
		// Note: PVP is counted here according to "own self-reported results" (once, guaranteed by pvpDup deduplication).
		// It is consistent with the arbitration result when both parties are consistent; only cheating/desync causes both parties to win and be SettlePVP
		// When the arbitration results in a draw, the two will diverge briefly (the statistics tend to be optimistic). Funds are subject to arbitration and statistics are for display only.
		isWin := req.Result == "win"
		// "doubleLose" (the upper limit of the round when both sides are exhausted) is counted as a draw, the same as "draw"
		isDraw := req.Result == "draw" || req.Result == "doubleLose"
		// "lose" counts as negative
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
			// Friends Entertainment Bureau: independent counting, does not affect total_battles / winning streak / achievements
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

		// === Winning streak & total games played (Friend games are not included) ===
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

		// === Game by game details ===
		// When detail is an empty array/null value, NULL is stored to avoid meaningless occupation.
		var detail any
		if len(req.Detail) > 0 && string(req.Detail) != "null" && string(req.Detail) != "[]" {
			detail = []byte(req.Detail)
		}
		var oppName any
		if req.OpponentName != "" {
			oppName = req.OpponentName
		}
		// Real PVP writes pvp_room_id as idempotent anchor; pve/friend is NULL (not limited by unique constraints)
		var roomIDVal any
		if req.Mode == "pvp" && req.RoomID != nil {
			roomIDVal = *req.RoomID
		}
		pveRewardEligible := req.Mode == "pve" && req.Result == "win"
		if _, err = tx.ExecContext(ctx, `
			INSERT INTO ironfist_matches
			  (user_id, mode, result, player_hp, opponent_hp, rounds, opponent_name, detail,
			   pvp_room_id, pve_reward_eligible)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, userID, req.Mode, req.Result, req.PlayerHP, req.OpponentHP, req.Rounds, oppName, detail,
			roomIDVal, pveRewardEligible); err != nil {
			return nil, err
		}

		// === Achievement determination (Friends Entertainment Bureau does not count into any achievements) ===
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
			// Friends Bureau: Querying existing achievements is only used to return the view, without any writing.
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

	// Real PVP: Trigger pledge settlement when carrying room_id (independent transaction, idempotent)
	// Decoupled from statistics writing: settlement failure does not affect the statistics being dropped into the database, and the front end can retry reportMatch.
	var settle *PVPSettleResult
	if req.Mode == "pvp" && req.RoomID != nil {
		sr, serr := s.SettlePVP(ctx, *req.RoomID, userID, req.Result)
		if serr != nil {
			// If settlement fails, only logs will be recorded and statistics will not be returned; the caller can prompt on the result page.
			fmt.Printf("[ironfist] pvp settlement failed: %v\n", serr)
		} else {
			settle = sr
		}
	}

	// Assemble return view (outputs unlocked achievements in defined order)
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

type reportRound struct {
	Round          int    `json:"r"`
	PlayerAction   string `json:"p"`
	OpponentAction string `json:"o"`
	PlayerDamage   int    `json:"pd"`
	OpponentDamage int    `json:"od"`
}

// validateReportMatchRequest rejects match data that cannot be generated by a normal client. Duplicate Settlement for Real PVP
// Polling will send rounds=0/detail=[], so zero round digests are only allowed in pvp mode with room_id.
func validateReportMatchRequest(req *ReportMatchRequest) error {
	if req == nil {
		return errors.New("missing report")
	}
	if req.Mode != "pve" && req.Mode != "pvp" && req.Mode != "friend" {
		return fmt.Errorf("invalid mode: %s", req.Mode)
	}
	switch req.Result {
	case "win", "lose", "draw", "doubleLose":
	default:
		return fmt.Errorf("invalid result: %s", req.Result)
	}
	if req.PlayerHP < 0 || req.PlayerHP > 100 || req.OpponentHP < 0 || req.OpponentHP > 100 {
		return errors.New("invalid hp")
	}
	if req.Rounds < 0 || req.Rounds > 20 || req.CounterSuccesses < 0 || req.CounterSuccesses > req.Rounds {
		return errors.New("invalid round summary")
	}
	if utf8.RuneCountInString(req.OpponentName) > 64 || len(req.Detail) > 32*1024 {
		return errors.New("report is too large")
	}
	isPVPSettleRetry := req.Mode == "pvp" && req.RoomID != nil && req.Rounds == 0
	if req.Rounds == 0 && !isPVPSettleRetry {
		return errors.New("zero-round report is not allowed")
	}
	if isPVPSettleRetry {
		return nil
	}
	var detail []reportRound
	if err := json.Unmarshal(req.Detail, &detail); err != nil || len(detail) != req.Rounds {
		return errors.New("detail does not match rounds")
	}
	counterSuccesses := 0
	for i, item := range detail {
		if item.Round != i+1 || !validReportedAction(item.PlayerAction) || !validReportedAction(item.OpponentAction) {
			return errors.New("invalid round detail")
		}
		if item.PlayerDamage < 0 || item.PlayerDamage > 100 || item.OpponentDamage < 0 || item.OpponentDamage > 100 {
			return errors.New("invalid round damage")
		}
		if item.PlayerAction == "counter" && item.OpponentAction == "attack" {
			counterSuccesses++
		}
	}
	if counterSuccesses != req.CounterSuccesses {
		return errors.New("counter summary does not match detail")
	}
	return nil
}

func validReportedAction(action string) bool {
	switch action {
	case "attack", "defend", "charge", "counter":
		return true
	default:
		return false
	}
}

// ListMatches queries the game-by-game match details, cursor paging (before_id), latest first.
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

// LobbyUserProfile User profile displayed in PVP lobby: aggregate users + fist_accounts + ironfist_stats
type LobbyUserProfile struct {
	ChatID       string `json:"chat_id"`
	Nickname     string `json:"nickname"`
	FistBalance  int64  `json:"fist_balance"`
	TotalBattles int    `json:"total_battles"`
}

// GetLobbyUserProfile joins the table to query the PVP lobby profile information of the specified chatID.
// Used to display the lobby list and click on the avatar to view player information.
// If any subtable is missing, 0/null value will be returned and no error will be reported (new users may not have fist_accounts / ironfist_stats rows yet).
func (s *IronFistService) GetLobbyUserProfile(ctx context.Context, chatID string) (*LobbyUserProfile, error) {
	p := &LobbyUserProfile{}
	// LEFT JOIN: users must exist; fist_accounts/ironfist_stats may be empty
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
// PVP matching and pledge settlement
// ─────────────────────────────────────────────────────

// PVPTierStakes The amount of individual stakes for each level (aligned with the front-end PVP_TIERS)
var PVPTierStakes = map[string]int64{
	"gold":     100,
	"platinum": 1000,
	"diamond":  10000,
}

var (
	ErrPVPInvalidTier          = fmt.Errorf("invalid pvp tier")
	ErrPVPInsufficientFist     = fmt.Errorf("insufficient $FIST balance")
	ErrPVPAlreadyQueued        = fmt.Errorf("already in pvp queue")
	ErrPVPNotInQueue           = fmt.Errorf("not in pvp queue")
	ErrPVPRoomNotFound         = fmt.Errorf("pvp room not found")
	ErrPVPRoomNotMatched       = fmt.Errorf("pvp room not in matched state")
	ErrPVPNotParticipant       = fmt.Errorf("caller is not a participant of this room")
	ErrPVPAlreadySettled       = fmt.Errorf("pvp room already settled")
	ErrPVPInvalidResult        = fmt.Errorf("invalid pvp result")
	ErrPVPSelfMatch            = fmt.Errorf("cannot match with self")
	ErrPVPAlreadyInMatch       = fmt.Errorf("already in an active pvp match")
	ErrLegacyPVPReportDisabled = fmt.Errorf("legacy PvP result reports are disabled")
)

// PVPMatchResult The return value of joining the matching queue
type PVPMatchResult struct {
	Status   string            `json:"status"` // "queued" | "matched"
	RoomID   uint64            `json:"room_id,omitempty"`
	GameID   string            `json:"game_id,omitempty"`
	Tier     string            `json:"tier,omitempty"`
	Stake    int64             `json:"stake,omitempty"`
	Opponent *LobbyUserProfile `json:"opponent,omitempty"`        //When the match is successful, the opponent's file is returned (for local direct start)
	Waiting  string            `json:"waiting_chat_id,omitempty"` //When the match is successful, it is the waiting party's chatID (for Hub push)
}

// PVPSettleResult settlement result
type PVPSettleResult struct {
	Settled      bool   `json:"settled"`           //false means unsettled (pending or settled idempotent return)
	Pending      bool   `json:"pending,omitempty"` //true means that our report has been recorded and is waiting for confirmation from the opponent.
	RoomID       uint64 `json:"room_id"`
	Result       string `json:"result"`        // win_a / win_b / draw / doubleLose
	WinnerAmount int64  `json:"winner_amount"` //The winner gets it (including principal)
	RefundA      int64  `json:"refund_a"`      //A returns in case of draw
	RefundB      int64  `json:"refund_b"`      //B returns in case of draw
	FeeBurn      int64  `json:"fee_burn"`      //Destroy part (MVP only accounting)
	FeeTreasury  int64  `json:"fee_treasury"`  //Treasury part (MVP only accounting)
}

// isDeadlock determines whether it is a MySQL deadlock error (1213) and is used for retry decisions.
func isDeadlock(err error) bool {
	var me *mysql.MySQLError
	return errors.As(err, &me) && me.Number == 1213
}

// EnqueuePVP joins the PVP matching queue and automatically retries up to 3 times for deadlocks internally.
//
// When the caller (Handler) gets Status=="matched", it needs to push a matching notification to the Waiting chatID through the Hub.
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

// enqueuePVP Join the PVP matching queue (single execution, no retries):
// 1. Verify gear level and balance
// 2. Try to match the waiting room (player B's perspective): If found, the pledge will be deducted, the status will be set to matched, and the opponent's file will be returned.
// 3. If no match is found, create a new room (player A’s perspective): withhold pledge, set status to matching, and return to queued
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

	// 1. First lock this user’s $FIST account: concurrent enqueuing requests for the same user are serialized here.
	// Only subsequent repeated enqueue checks (FOR UPDATE) can see the rooms submitted by the previous request.
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

	// 2. Prevent duplicate entry: Find existing matching/matched rooms for this user (check A/B identity at the same time).
	// FOR UPDATE does the current read, ensuring that rooms that have been submitted by concurrent requests are seen to avoid repeated deductions of pledges.
	// player_b must be checked: otherwise user can still create/join new rooms when already in matched room as B (not settled),
	// As a result, you are in multiple games at the same time and your stake is doubled.
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
			// Already in an unsettled game, prohibited from joining the team again
			return nil, ErrPVPAlreadyInMatch
		}
		// Already in the queue (matching), return queued directly.
		// Use the tier/stake of the existing room instead of this request value: the wrong gear should not be returned when the user changes gears and joins the queue again after refreshing.
		return &PVPMatchResult{Status: "queued", RoomID: existingID, Tier: existingTier, Stake: existingStake}, nil
	}
	if err != sql.ErrNoRows {
		return nil, err
	}

	// 3. Try to match: Find the earliest matching room in the same stall (excluding those created by yourself)
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
		// Hit matching: This user joins as B
		if aUserID == userID {
			return nil, ErrPVPSelfMatch
		}
		// Withhold B’s pledge
		if _, err = tx.ExecContext(ctx,
			`UPDATE fist_accounts SET balance = balance - ? WHERE user_id = ?`,
			stake, userID); err != nil {
			return nil, err
		}
		// B’s pledge deduction flow
		if err = s.writeFistTx(ctx, tx, userID, -stake, "pvp_stake", pvpRoomRef(roomID),
			fmt.Sprintf("PVP 质押（%s场，对手：%s）", tier, aChatID)); err != nil {
			return nil, err
		}
		now := s.authorityNow()
		// Room status advancement
		if _, err = tx.ExecContext(ctx, `
			UPDATE ironfist_pvp_rooms
			SET player_b_user_id = ?, player_b_chat_id = ?,
			    status = 'matched', matched_at = ?
			WHERE id = ? AND status = 'matching'
		`, userID, chatID, now, roomID); err != nil {
			return nil, err
		}
		gameID := s.newGameID()
		if !authorityUUIDPattern.MatchString(gameID) {
			return nil, fmt.Errorf("generate authority game id")
		}
		deadline := sqlNullTime(now.Add(authorityActionWindow))
		if err := insertAuthorityGameTx(ctx, tx, &lockedGame{
			GameID: gameID, Mode: "pvp", Status: "active",
			PlayerAUserID: aUserID, PlayerBUserID: userID,
			PVPRoomID:    sql.NullInt64{Int64: int64(roomID), Valid: true},
			RulesVersion: ironfistengine.RulesVersion, CurrentRound: 1, StateVersion: 1,
			State: ironfistengine.InitialState(), ActionDeadlineA: deadline, ActionDeadlineB: deadline,
			LastActivityAt: now, PendingActions: map[ironfistengine.Seat]lockedAction{},
		}); err != nil {
			return nil, err
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		// Query A's files for B to display directly
		opp, qerr := s.GetLobbyUserProfile(ctx, aChatID)
		if qerr != nil {
			opp = &LobbyUserProfile{ChatID: aChatID, Nickname: aChatID}
		}
		return &PVPMatchResult{
			Status:   "matched",
			RoomID:   roomID,
			GameID:   gameID,
			Tier:     tier,
			Stake:    stake,
			Opponent: opp,
			Waiting:  aChatID,
		}, nil
	}
	if err != sql.ErrNoRows {
		return nil, err
	}

	// 4. Miss Matchmaking: Create a new room as player A. Get the room_id first, and then write the pledge slip.
	// Enables each point change to be traced back exactly to the room via ref_id; all still within the same transaction.
	res, err := tx.ExecContext(ctx, `
		INSERT INTO ironfist_pvp_rooms
		  (tier, stake_amount, player_a_user_id, player_a_chat_id, status)
		VALUES (?, ?, ?, ?, 'matching')
	`, tier, stake, userID, chatID)
	if err != nil {
		return nil, err
	}
	rid, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	roomID = uint64(rid)
	if _, err = tx.ExecContext(ctx,
		`UPDATE fist_accounts SET balance = balance - ? WHERE user_id = ?`,
		stake, userID); err != nil {
		return nil, err
	}
	if err = s.writeFistTx(ctx, tx, userID, -stake, "pvp_stake", pvpRoomRef(roomID),
		fmt.Sprintf("PVP 质押（%s场，等待匹配）", tier)); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return &PVPMatchResult{
		Status: "queued",
		RoomID: roomID,
		Tier:   tier,
		Stake:  stake,
	}, nil
}

// GetPVPQueueStatus queries the matching queue status of the current user (the front-end polling WS notification is lost).
// Returns the nearest matching/matched room; otherwise returns status="idle".
// Used to wait for the party (player A) to discover the match result by polling when the WS ironfist_pvp_matched notification is lost.
func (s *IronFistService) GetPVPQueueStatus(ctx context.Context, userID uint64) (*PVPMatchResult, error) {
	var (
		roomID, aUserID       uint64
		aChatID, tier, status string
		stake                 int64
		bUserID               sql.NullInt64
		bChatID               sql.NullString
		gameID                sql.NullString
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT r.id, r.tier, r.stake_amount, r.status,
		       r.player_a_user_id, r.player_a_chat_id,
		       r.player_b_user_id, r.player_b_chat_id,
		       g.game_id
		FROM ironfist_pvp_rooms r
		LEFT JOIN ironfist_games g ON g.pvp_room_id = r.id
		WHERE (r.player_a_user_id = ? OR r.player_b_user_id = ?)
		  AND r.status IN ('matching', 'matched')
		ORDER BY r.id DESC LIMIT 1
	`, userID, userID).Scan(&roomID, &tier, &stake, &status, &aUserID, &aChatID, &bUserID, &bChatID, &gameID)
	if err == sql.ErrNoRows {
		return &PVPMatchResult{Status: "idle"}, nil
	}
	if err != nil {
		return nil, err
	}
	if status == "matching" {
		return &PVPMatchResult{Status: "queued", RoomID: roomID, Tier: tier, Stake: stake}, nil
	}
	// matched: This user may be A or B, and the opponent is the other party
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
		GameID:   gameID.String,
		Tier:     tier,
		Stake:    stake,
		Opponent: opp,
	}, nil
}

// PVPRoomParticipants Room participant information for WS layer to perform unauthorized verification
type PVPRoomParticipants struct {
	Status  string // matching / matched / settled / cancelled
	AChatID string //player_a_chat_id (NOT NULL, must have a value)
	BChatID string //player_b_chat_id (empty before matched)
}

// GetPVPRoomParticipants queries the status of the specified PVP room and the chat IDs of both parties.
// Used for WS layer ironfist_action / ironfist_reconnect to prevent unauthorized access:
// - Verify whether from is a participant
// - Verify whether p.To is the opponent's chatID
// - The verification status is matched (action / reconnect is no longer allowed after settlement)
//
// Returns (nil, nil) if the room does not exist.
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

// CancelPVPQueue cancels matching (user actively cancels or disconnects to clean up):
// Only the 'matching' status can be canceled and the pledge will be returned in full; other statuses are deemed to have no cancellation queue.
// Cancel via chatID to support Hub.Unregister calls; returns the canceled roomID (0 means no cancellation).
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
		return 0, nil //No team, idempotent
	}
	if err != nil {
		return 0, err
	}
	// Refund
	if _, err = tx.ExecContext(ctx,
		`UPDATE fist_accounts SET balance = balance + ? WHERE user_id = ?`,
		stake, aUserID); err != nil {
		return 0, err
	}
	if err = s.writeFistTx(ctx, tx, aUserID, stake, "pvp_refund", pvpRoomRef(roomID),
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

// PVPMatchTimeout PVP matching waiting timeout window: if exceeded, the server will automatically cancel and refund.
// Set to 5 minutes: If it is longer than the front end pocket (10 minutes), it will be meaningless, and if it is shorter than 1 minute, it will cause accidental injury.
// The client can proactively cancel in advance; here we only cover the extreme situation of "client crash/complete network loss".
const PVPMatchTimeout = 5 * time.Minute

// SweepTimeoutPVPQueues scans all unmatched PVP rooms that time out and refunds them.
// Called periodically (every 1 minute) by the scheduled task of main.go. Returns the number of rooms processed.
//
// Trigger condition: status='matching' and created_at < NOW() - PVPMatchTimeout.
// The refund method is the same as CancelPVPQueue: full refund to player A, and the room status is set to 'cancelled'.
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
		// Secondary verification status (to prevent conflicts with normal matching/cancellation of concurrency)
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
			continue //Already matched/cancelled, skipped
		}
		// Refund to A
		if _, err = tx.ExecContext(ctx,
			`UPDATE fist_accounts SET balance = balance + ? WHERE user_id = ?`,
			p.stake, p.aUserID); err != nil {
			tx.Rollback()
			return swept, err
		}
		if err = s.writeFistTx(ctx, tx, p.aUserID, p.stake, "pvp_refund", pvpRoomRef(p.roomID),
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

// PVPMatchedTimeout Timeout window for matches that have been matched but not settled: if exceeded, the server will refund the money as a draw.
//
// It must be ≥ the maximum real duration of a single game, otherwise the "normal game still in progress" will be mistakenly converted into a draw.
// Steal the victory from the winner and deduct more handling fees from both parties. Upper limit of battle: MAX_ROUNDS(20) × ROUND_SECONDS(30s) =
// 600s (10 minutes), plus a 60s reconnection window after disconnection (possibly multiple times), the actual maximum time is about 11~12 minutes.
// Therefore, it is set to 15 minutes to safely cover the longest game + buffer; matched_at will not be refreshed after being written during matching.
// Therefore, this is the hard upper limit of "from successful matching to settlement required".
// Price: After matching, the orphan room with no one to start the game will be locked for up to 15 minutes before being refunded (rare, the front-end has tried its best to cancel it proactively).
const PVPMatchedTimeout = 15 * time.Minute

// SweepTimeoutPVPMatched scans all matched rooms that have timed out but have not been settled, and refunds will be made based on a tie.
// Called periodically (every 1 minute) by the scheduled task of main.go. Returns the number of rooms processed.
//
// Trigger condition: status='matched' and matched_at < NOW() - PVPMatchedTimeout.
// Refund method: Both parties will refund 97.5% (consistent with draw settlement), the room status is set to 'settled', result='draw'.
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
			continue //Has been settled/cancelled, skipped
		}
		// In case of a tie, both parties will be refunded equally, each will be refunded floor((pool - fee)/2), and the remainder will be incorporated into the handling fee (consistent with SettlePVP)
		totalPool := p.stake * 2
		nominalFee := totalPool * 25 / 1000 //Nominal 2.5%
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
		if err = s.writeFistTx(ctx, tx, p.aUserID, refundA, "pvp_refund", pvpRoomRef(p.roomID),
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
		if err = s.writeFistTx(ctx, tx, p.bUserID, refundB, "pvp_refund", pvpRoomRef(p.roomID),
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

// SettlePVP settlement PVP room: Calculate winner/refund/handling fee based on result and caller identity.
// Idempotent: If the room has been settled, the saved result will be returned directly (settled=false means it has been settled before).
// The fee (destruction + treasury) is not actually transferred during the MVP stage, but is only written into the room field and transaction notes for reconciliation;
// In the future, it will be changed to real burn/treasury transfer when connecting to the on-chain contract.
func (s *IronFistService) SettlePVP(ctx context.Context, roomID, callerUserID uint64, callerResult string) (*PVPSettleResult, error) {
	return nil, ErrLegacyPVPReportDisabled

	/*
		// Retained temporarily for migration archaeology. Authoritative games call
		// settleWageredPVPTx inside their terminal game transaction instead.
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
		// Idempotent: Settled → Play back the saved final result and amount (for the first reporting party to poll to get consistent settlement information)
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

		// Caller perspective → Room perspective
		callerIsA := callerUserID == aUserID
		roomResult, err := mapPVPResult(callerResult, callerIsA)
		if err != nil {
			return nil, err
		}

		// The first time is valid and cannot be modified: as long as this party has already reported it (regardless of whether the results are the same), this report will be ignored.
		// Being able to get here (status='matched' unsettled) means that the opponent has not yet reported - otherwise when the second reporting party triggers
		// Both parties are valid and will be settled within the same transaction, and the previous status check has been returned.
		// Therefore, our repeated reporting does not need to be rewritten, nor will it affect settlement. It will directly return pending (carrying the saved results).
		if callerIsA && reportA.Valid {
			return &PVPSettleResult{Pending: true, RoomID: roomID, Result: reportA.String}, nil
		}
		if !callerIsA && reportB.Valid {
			return &PVPSettleResult{Pending: true, RoomID: roomID, Result: reportB.String}, nil
		}

		// Record our first report
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

		// Settlement will be made only after both parties have reported; otherwise, pending will be returned after submitting the report from one party.
		if !reportA.Valid || !reportB.Valid {
			if err = tx.Commit(); err != nil {
				return nil, err
			}
			return &PVPSettleResult{Pending: true, RoomID: roomID, Result: roomResult}, nil
		}

		// If the reports from both parties are consistent → settle according to the result; if they are inconsistent → a draw (to prevent cheating)
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
		out.FeeTreasury = totalFee - out.FeeBurn //The remainder goes to the treasury

		// Lock two account lines (to prevent conflicts with concurrent withdrawals, etc.)
		if err = s.ensureFistAccountTx(ctx, tx, aUserID); err != nil {
			return nil, err
		}
		if err = s.ensureFistAccountTx(ctx, tx, bUserID); err != nil {
			return nil, err
		}

		// Directly include the chat IDs of both opponents in the remarks: A’s opponent is B, and B’s opponent is A.
		switch finalResult {
		case "win_a":
			out.WinnerAmount = totalPool - totalFee
			if _, err = tx.ExecContext(ctx,
				`UPDATE fist_accounts SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?`,
				out.WinnerAmount, out.WinnerAmount, aUserID); err != nil {
				return nil, err
			}
			if err = s.writeFistTx(ctx, tx, aUserID, out.WinnerAmount, "pvp_win", pvpRoomRef(roomID),
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
			if err = s.writeFistTx(ctx, tx, bUserID, out.WinnerAmount, "pvp_win", pvpRoomRef(roomID),
				fmt.Sprintf("PVP 胜利奖励（%s场，对手：%s）", tierStr, aChatID)); err != nil {
				return nil, err
			}
		case "draw", "doubleLose":
			// Tie: Both parties will refund equally, each will refund floor((pool - fee)/2), and the remainder that is not divisible will be included in the handling fee.
			// Compared with "remainder goes to B", the refund amount of the two players is exactly the same (to avoid the difference in perception between one party 97 and one party 98),
			// The trade-off is that the draw rate may be 1 minimum unit more than the nominal 2.5% (incorporated into burn/treasury, still conserved).
			refundEach := (totalPool - totalFee) / 2
			out.RefundA = refundEach
			out.RefundB = refundEach
			actualFee := totalPool - refundEach*2 //= totalFee or totalFee+1
			out.FeeBurn = actualFee / 2
			out.FeeTreasury = actualFee - out.FeeBurn
			if _, err = tx.ExecContext(ctx,
				`UPDATE fist_accounts SET balance = balance + ? WHERE user_id = ?`,
				out.RefundA, aUserID); err != nil {
				return nil, err
			}
			if err = s.writeFistTx(ctx, tx, aUserID, out.RefundA, "pvp_refund", pvpRoomRef(roomID),
				fmt.Sprintf("PVP 平局退回（%s场，对手：%s）", tierStr, bChatID)); err != nil {
				return nil, err
			}
			if _, err = tx.ExecContext(ctx,
				`UPDATE fist_accounts SET balance = balance + ? WHERE user_id = ?`,
				out.RefundB, bUserID); err != nil {
				return nil, err
			}
			if err = s.writeFistTx(ctx, tx, bUserID, out.RefundB, "pvp_refund", pvpRoomRef(roomID),
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
	*/
}

// mapPVPResult maps the win/lose/draw/doubleLose reported by the caller to the room perspective result.
// callerIsA=true means the caller is player A, otherwise it is player B.
//
//	"win" → caller is the winner: A wins → win_a, B wins → win_b
//	"lose" → caller is the loser: A loses → win_b, B loses → win_a
//	"draw"/"doubleLose" → same name
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

// TreasuryStats public read-only PvP treasury/destruction statistics (no authentication required, for display on the international station introduction page)
// fee_treasury/fee_burn is currently only the MVP accounting standard (not actually transferred/destroyed), see SettlePVP notes for details.
type TreasuryStats struct {
	TotalTreasury int64                `json:"total_treasury"` //Historical cumulative treasury revenue
	TotalBurn     int64                `json:"total_burn"`     //Historical cumulative number of destroyed items
	TotalVolume   int64                `json:"total_volume"`   //Historical accumulated PvP staking turnover (total principal of both parties)
	TotalMatches  int64                `json:"total_matches"`  //Historical accumulated settled events
	TodayTreasury int64                `json:"today_treasury"`
	TodayBurn     int64                `json:"today_burn"`
	TodayMatches  int64                `json:"today_matches"`
	Daily         []TreasuryDailyPoint `json:"daily"`          //Most recent StatsDailyWindowDays days, ascending date order
	TierBreakdown []TierStat           `json:"tier_breakdown"` //Historical accumulation split by gear (gold/platinum/diamond)
}

// TierStat historical cumulative data split by PVP tier
type TierStat struct {
	Tier     string `json:"tier"`
	Matches  int64  `json:"matches"`
	Treasury int64  `json:"treasury"`
	Burn     int64  `json:"burn"`
	Volume   int64  `json:"volume"`
}

// TreasuryDailyPoint Treasury/Destruction data points aggregated by day
type TreasuryDailyPoint struct {
	Date     string `json:"date"` //YYYY-MM-DD (DB server session local time zone, consistent with settled_at writing side)
	Matches  int64  `json:"matches"`
	Treasury int64  `json:"treasury"`
	Burn     int64  `json:"burn"`
	Volume   int64  `json:"volume"`
}

// GetTreasuryStats Query global PvP treasury/destroy data: historical cumulative + recent daily trend.
// Only rooms with status='settled' are counted (including draw/overtime refunds, because a 2.5% handling fee is also charged for draws).
func (s *IronFistService) GetTreasuryStats(ctx context.Context) (*TreasuryStats, error) {
	st := &TreasuryStats{}

	if err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(fee_treasury), 0), COALESCE(SUM(fee_burn), 0),
		       COALESCE(SUM(stake_amount * 2), 0), COUNT(*)
		FROM ironfist_pvp_rooms WHERE status = 'settled'
	`).Scan(&st.TotalTreasury, &st.TotalBurn, &st.TotalVolume, &st.TotalMatches); err != nil {
		return nil, err
	}

	// settled_at is written by SettlePVP/SweepTimeoutPVPMatched using CURRENT_TIMESTAMP(3) (server session local
	// time zone), so CURDATE()/CURDATE() is used instead of UTC_DATE() for comparison, keeping the same time zone reference as the writing side,
	// Avoid systematic offset of "today" and bucketing by day when the server session time zone is non-UTC.
	if err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(fee_treasury), 0), COALESCE(SUM(fee_burn), 0), COUNT(*)
		FROM ironfist_pvp_rooms
		WHERE status = 'settled' AND DATE(settled_at) = CURDATE()
	`).Scan(&st.TodayTreasury, &st.TodayBurn, &st.TodayMatches); err != nil {
		return nil, err
	}

	var anchor time.Time
	if err := s.db.QueryRowContext(ctx, `SELECT CURDATE()`).Scan(&anchor); err != nil {
		return nil, err
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT DATE(settled_at) AS d, COUNT(*), SUM(fee_treasury), SUM(fee_burn), SUM(stake_amount * 2)
		FROM ironfist_pvp_rooms
		WHERE status = 'settled' AND settled_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
		GROUP BY d
		ORDER BY d ASC
	`, StatsDailyWindowDays-1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	byDate := make(map[string]TreasuryDailyPoint, StatsDailyWindowDays)
	for rows.Next() {
		var d time.Time
		p := TreasuryDailyPoint{}
		if err = rows.Scan(&d, &p.Matches, &p.Treasury, &p.Burn, &p.Volume); err != nil {
			return nil, err
		}
		byDate[d.Format("2006-01-02")] = p
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}

	// Push back by the anchor date and add zeros to StatsDailyWindowDays days to ensure that there are data points on zero activity days (for the front-end to draw continuous line charts)
	st.Daily = make([]TreasuryDailyPoint, StatsDailyWindowDays)
	for i := 0; i < StatsDailyWindowDays; i++ {
		ds := anchor.AddDate(0, 0, i-(StatsDailyWindowDays-1)).Format("2006-01-02")
		p := TreasuryDailyPoint{Date: ds}
		if v, ok := byDate[ds]; ok {
			p.Matches, p.Treasury, p.Burn, p.Volume = v.Matches, v.Treasury, v.Burn, v.Volume
		}
		st.Daily[i] = p
	}

	tierRows, err := s.db.QueryContext(ctx, `
		SELECT tier, COUNT(*), SUM(fee_treasury), SUM(fee_burn), SUM(stake_amount * 2)
		FROM ironfist_pvp_rooms
		WHERE status = 'settled'
		GROUP BY tier
		ORDER BY FIELD(tier, 'gold', 'platinum', 'diamond')
	`)
	if err != nil {
		return nil, err
	}
	defer tierRows.Close()

	st.TierBreakdown = make([]TierStat, 0, 3)
	for tierRows.Next() {
		t := TierStat{}
		if err = tierRows.Scan(&t.Tier, &t.Matches, &t.Treasury, &t.Burn, &t.Volume); err != nil {
			return nil, err
		}
		st.TierBreakdown = append(st.TierBreakdown, t)
	}
	return st, tierRows.Err()
}

// ensureFistAccountTx ensures fist_accounts row exists within transaction (equivalent to FistService.ensureAccount)
func (s *IronFistService) ensureFistAccountTx(ctx context.Context, tx *sql.Tx, userID uint64) error {
	_, err := tx.ExecContext(ctx,
		`INSERT IGNORE INTO fist_accounts (user_id) VALUES (?)`, userID)
	return err
}

func pvpRoomRef(roomID uint64) string {
	return fmt.Sprintf("ironfist_pvp_room:%d", roomID)
}

// writeFistTx writes a fist_transactions pipeline with source references within the transaction.
func (s *IronFistService) writeFistTx(ctx context.Context, tx *sql.Tx, userID uint64, amount int64, txType, refID, remark string) error {
	var balanceAfter int64
	if err := tx.QueryRowContext(ctx,
		`SELECT balance FROM fist_accounts WHERE user_id = ?`, userID).
		Scan(&balanceAfter); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO fist_transactions (user_id, amount, balance_after, type, ref_id, remark)
		VALUES (?, ?, ?, ?, ?, ?)
	`, userID, amount, balanceAfter, txType, refID, remark)
	return err
}
