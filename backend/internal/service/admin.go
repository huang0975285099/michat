package service

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	rdb "github.com/redis/go-redis/v9"

	pkgredis "e2eechat/pkg/redis"
)

// AdminService produces the aggregate figures shown on the operator dashboard.
//
// Everything here is a COUNT/SUM across users. Message *content* is end-to-end
// encrypted and never reaches the server, so the messaging figures below are
// derived purely from delivery metadata (who sent to whom, and when) — there is
// no query in this file that could surface the text of a message, and there
// should never be one.
type AdminService struct {
	db    *sql.DB
	redis *rdb.Client
}

func NewAdminService(db *sql.DB, redis *rdb.Client) *AdminService {
	return &AdminService{db: db, redis: redis}
}

type DailyCount struct {
	Date  string `json:"date"` // YYYY-MM-DD
	Count int64  `json:"count"`
}

type UserStats struct {
	Total     int64 `json:"total"`
	Ready     int64 `json:"ready"`      // Completed registration (public key uploaded)
	Pending   int64 `json:"pending"`    // Initialised but never finished onboarding
	Admins    int64 `json:"admins"`
	NewToday  int64 `json:"new_today"`
	New7d     int64 `json:"new_7d"`
	New30d    int64 `json:"new_30d"`
	Active24h int64 `json:"active_24h"`
	Active7d  int64 `json:"active_7d"`
}

type SocialStats struct {
	Friendships      int64   `json:"friendships"` // Distinct pairs, not rows
	PendingRequests  int64   `json:"pending_requests"`
	AcceptedRequests int64   `json:"accepted_requests"`
	RejectedRequests int64   `json:"rejected_requests"`
	AvgFriends       float64 `json:"avg_friends"`
	IsolatedUsers    int64   `json:"isolated_users"` // Registered but zero friends
}

type MessagingStats struct {
	TotalTracked   int64 `json:"total_tracked"`
	Today          int64 `json:"today"`
	Last7d         int64 `json:"last_7d"`
	Last30d        int64 `json:"last_30d"`
	ActiveSenders  int64 `json:"active_senders_7d"`
	DeviceTokens   int64 `json:"device_tokens"`
	PushableUsers  int64 `json:"pushable_users"`
	PendingReceipt int64 `json:"pending_receipts"`
}

type EconomyStats struct {
	Accounts     int64 `json:"accounts"`
	TotalBalance int64 `json:"total_balance"`
	TotalEarned  int64 `json:"total_earned"`
	Transactions int64 `json:"transactions"`
	Tx30d        int64 `json:"tx_30d"`
}

type GameStats struct {
	TotalMatches int64 `json:"total_matches"`
	PvEMatches   int64 `json:"pve_matches"`
	PvPMatches   int64 `json:"pvp_matches"`
	MatchesToday int64 `json:"matches_today"`
	Players      int64 `json:"players"`
	RoomsWaiting int64 `json:"rooms_waiting"`
	RoomsActive  int64 `json:"rooms_active"`
}

type AdminStats struct {
	GeneratedAt   time.Time      `json:"generated_at"`
	Online        int64          `json:"online"`
	Users         UserStats      `json:"users"`
	Social        SocialStats    `json:"social"`
	Messaging     MessagingStats `json:"messaging"`
	Economy       EconomyStats   `json:"economy"`
	Game          GameStats      `json:"game"`
	Signups       []DailyCount   `json:"signups"`
	MessageVolume []DailyCount   `json:"message_volume"`
}

const trendDays = 30

func (s *AdminService) GetStats(ctx context.Context) (*AdminStats, error) {
	stats := &AdminStats{GeneratedAt: time.Now().UTC()}

	if err := s.loadUsers(ctx, &stats.Users); err != nil {
		return nil, fmt.Errorf("user stats: %w", err)
	}
	if err := s.loadSocial(ctx, &stats.Social, stats.Users.Ready); err != nil {
		return nil, fmt.Errorf("social stats: %w", err)
	}
	if err := s.loadMessaging(ctx, &stats.Messaging); err != nil {
		return nil, fmt.Errorf("messaging stats: %w", err)
	}
	if err := s.loadEconomy(ctx, &stats.Economy); err != nil {
		return nil, fmt.Errorf("economy stats: %w", err)
	}
	if err := s.loadGame(ctx, &stats.Game); err != nil {
		return nil, fmt.Errorf("game stats: %w", err)
	}

	online, err := s.countOnline(ctx)
	if err != nil {
		return nil, fmt.Errorf("online count: %w", err)
	}
	stats.Online = online

	if stats.Signups, err = s.dailySeries(ctx, "SELECT DATE(created_at) d, COUNT(*) c FROM users WHERE created_at >= ? GROUP BY d"); err != nil {
		return nil, fmt.Errorf("signup trend: %w", err)
	}
	if stats.MessageVolume, err = s.dailySeries(ctx, "SELECT DATE(sent_at) d, COUNT(*) c FROM message_deliveries WHERE sent_at >= ? GROUP BY d"); err != nil {
		return nil, fmt.Errorf("message trend: %w", err)
	}

	return stats, nil
}

func (s *AdminService) loadUsers(ctx context.Context, u *UserStats) error {
	return s.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*),
			COALESCE(SUM(is_ready = 1), 0),
			COALESCE(SUM(is_ready = 0), 0),
			COALESCE(SUM(is_admin = 1), 0),
			COALESCE(SUM(created_at >= CURDATE()), 0),
			COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)), 0),
			COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)), 0),
			COALESCE(SUM(last_seen >= DATE_SUB(NOW(), INTERVAL 24 HOUR)), 0),
			COALESCE(SUM(last_seen >= DATE_SUB(NOW(), INTERVAL 7 DAY)), 0)
		FROM users`,
	).Scan(&u.Total, &u.Ready, &u.Pending, &u.Admins, &u.NewToday, &u.New7d, &u.New30d, &u.Active24h, &u.Active7d)
}

func (s *AdminService) loadSocial(ctx context.Context, so *SocialStats, readyUsers int64) error {
	// friendships stores each relationship twice (a→b and b→a) so that lookups are
	// one-directional; halve the row count to report actual pairs.
	var rows int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM friendships`).Scan(&rows); err != nil {
		return err
	}
	so.Friendships = rows / 2

	if err := s.db.QueryRowContext(ctx, `
		SELECT
			COALESCE(SUM(status = 'pending'), 0),
			COALESCE(SUM(status = 'accepted'), 0),
			COALESCE(SUM(status = 'rejected'), 0)
		FROM friend_requests`,
	).Scan(&so.PendingRequests, &so.AcceptedRequests, &so.RejectedRequests); err != nil {
		return err
	}

	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM users u
		WHERE u.is_ready = 1 AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.user_id = u.id)`,
	).Scan(&so.IsolatedUsers); err != nil {
		return err
	}

	if readyUsers > 0 {
		so.AvgFriends = float64(rows) / float64(readyUsers)
	}
	return nil
}

func (s *AdminService) loadMessaging(ctx context.Context, m *MessagingStats) error {
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*),
			COALESCE(SUM(sent_at >= CURDATE()), 0),
			COALESCE(SUM(sent_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)), 0),
			COALESCE(SUM(sent_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)), 0),
			COUNT(DISTINCT CASE WHEN sent_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN msg_from END)
		FROM message_deliveries`,
	).Scan(&m.TotalTracked, &m.Today, &m.Last7d, &m.Last30d, &m.ActiveSenders); err != nil {
		return err
	}

	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*), COUNT(DISTINCT chat_id) FROM device_tokens`,
	).Scan(&m.DeviceTokens, &m.PushableUsers); err != nil {
		return err
	}

	// Read receipts still queued for delivery to the original sender.
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM message_reads`).Scan(&m.PendingReceipt); err != nil {
		return err
	}
	return nil
}

func (s *AdminService) loadEconomy(ctx context.Context, e *EconomyStats) error {
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(SUM(balance), 0), COALESCE(SUM(total_earned), 0) FROM fist_accounts`,
	).Scan(&e.Accounts, &e.TotalBalance, &e.TotalEarned); err != nil {
		return err
	}
	return s.db.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)), 0) FROM fist_transactions`,
	).Scan(&e.Transactions, &e.Tx30d)
}

func (s *AdminService) loadGame(ctx context.Context, g *GameStats) error {
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*),
			COALESCE(SUM(mode = 'pve'), 0),
			COALESCE(SUM(mode = 'pvp'), 0),
			COALESCE(SUM(created_at >= CURDATE()), 0),
			COUNT(DISTINCT user_id)
		FROM ironfist_matches`,
	).Scan(&g.TotalMatches, &g.PvEMatches, &g.PvPMatches, &g.MatchesToday, &g.Players); err != nil {
		return err
	}
	return s.db.QueryRowContext(ctx, `
		SELECT
			COALESCE(SUM(status = 'matching'), 0),
			COALESCE(SUM(status = 'matched'), 0)
		FROM ironfist_pvp_rooms`,
	).Scan(&g.RoomsWaiting, &g.RoomsActive)
}

// countOnline counts live presence keys in Redis. Reading Redis rather than a
// single process's connection map means the figure stays correct when more than
// one backend replica is running.
//
// SCAN can return the same key twice, so results are de-duplicated instead of
// simply summed; SCAN is used rather than KEYS to avoid blocking Redis.
func (s *AdminService) countOnline(ctx context.Context) (int64, error) {
	seen := make(map[string]struct{})
	var cursor uint64
	for {
		keys, next, err := s.redis.Scan(ctx, cursor, pkgredis.OnlineKey("*"), 500).Result()
		if err != nil {
			return 0, err
		}
		for _, k := range keys {
			seen[k] = struct{}{}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	return int64(len(seen)), nil
}

// dailySeries runs a "date, count" grouped query over the trend window and pads
// missing days with zero, so the caller always gets exactly trendDays points in
// chronological order and the chart never implies a gap was a dip.
func (s *AdminService) dailySeries(ctx context.Context, query string) ([]DailyCount, error) {
	start := time.Now().AddDate(0, 0, -(trendDays - 1))
	rows, err := s.db.QueryContext(ctx, query, start.Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	found := make(map[string]int64, trendDays)
	for rows.Next() {
		var day string
		var count int64
		if err := rows.Scan(&day, &count); err != nil {
			return nil, err
		}
		// DATE() may arrive as a full timestamp depending on driver settings.
		if len(day) > 10 {
			day = day[:10]
		}
		found[day] = count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return padSeries(found, start, trendDays), nil
}

// padSeries expands sparse "day → count" results into a dense run of days
// starting at start. A day the query returned nothing for is a real zero, so it
// has to be emitted as one — dropping it would let the chart draw a straight
// line across a gap and imply activity that never happened.
func padSeries(found map[string]int64, start time.Time, days int) []DailyCount {
	series := make([]DailyCount, 0, days)
	for i := 0; i < days; i++ {
		day := start.AddDate(0, 0, i).Format("2006-01-02")
		series = append(series, DailyCount{Date: day, Count: found[day]})
	}
	return series
}
