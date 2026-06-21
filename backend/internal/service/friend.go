package service

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	rdb "github.com/redis/go-redis/v9"

	"e2eechat/internal/model"
	pkgredis "e2eechat/pkg/redis"
)

var (
	ErrAlreadyFriends   = errors.New("already friends")
	ErrRequestNotFound  = errors.New("friend request not found")
	ErrCannotAddSelf    = errors.New("cannot add yourself")
	ErrNotRequestOwner  = errors.New("not the request owner")
)

type FriendService struct {
	db    *sql.DB
	redis *rdb.Client
}

func NewFriendService(db *sql.DB, redis *rdb.Client) *FriendService {
	return &FriendService{db: db, redis: redis}
}

// FriendRequestView 查询时的视图（含发送方信息）
type FriendRequestView struct {
	ID           uint64    `json:"id"`
	Status       string    `json:"status"`
	CreatedAt    time.Time `json:"created_at"`
	FromChatID   string    `json:"from_chat_id"`
	FromNickname string    `json:"from_nickname"`
}

// OutgoingRequestView 用户发出的好友申请（含接收方信息）
type OutgoingRequestView struct {
	ID         uint64    `json:"id"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"created_at"`
	ToChatID   string    `json:"to_chat_id"`
	ToNickname string    `json:"to_nickname"`
}

// FriendView 好友列表视图
type FriendView struct {
	ChatID    string     `json:"chat_id"`
	Nickname  string     `json:"nickname"`
	PublicKey string     `json:"public_key"`
	LastSeen  *time.Time `json:"last_seen"`
	Online    bool       `json:"online"` // 实时在线状态
}

// GetUserIDByChatID 通过 chat_id 查询 user id
func (s *FriendService) GetUserIDByChatID(ctx context.Context, chatID string) (*model.User, uint64, error) {
	u := &model.User{}
	err := s.db.QueryRowContext(ctx,
		`SELECT id, chat_id, nickname, is_ready FROM users WHERE chat_id = ?`, chatID,
	).Scan(&u.ID, &u.ChatID, &u.Nickname, &u.IsReady)
	if err == sql.ErrNoRows || (err == nil && !u.IsReady) {
		return nil, 0, ErrUserNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	return u, u.ID, nil
}

// SendRequest 发送好友申请
func (s *FriendService) SendRequest(ctx context.Context, fromID, toID uint64) error {
	if fromID == toID {
		return ErrCannotAddSelf
	}
	var count int
	s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM friendships WHERE user_id = ? AND friend_id = ?`, fromID, toID,
	).Scan(&count)
	if count > 0 {
		return ErrAlreadyFriends
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO friend_requests (from_user_id, to_user_id) VALUES (?, ?)
		 ON DUPLICATE KEY UPDATE status = IF(status='rejected','pending',status)`,
		fromID, toID,
	)
	if err != nil {
		return fmt.Errorf("insert friend_request: %w", err)
	}
	return nil
}

// GetIncomingRequests 查询收到的待处理申请
func (s *FriendService) GetIncomingRequests(ctx context.Context, toID uint64) ([]*FriendRequestView, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT fr.id, fr.status, fr.created_at, u.chat_id, u.nickname
		FROM friend_requests fr
		JOIN users u ON u.id = fr.from_user_id
		WHERE fr.to_user_id = ? AND fr.status = 'pending'
		ORDER BY fr.created_at DESC`, toID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*FriendRequestView
	for rows.Next() {
		r := &FriendRequestView{}
		if err = rows.Scan(&r.ID, &r.Status, &r.CreatedAt, &r.FromChatID, &r.FromNickname); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, nil
}

// GetOutgoingRequests 查询用户发出的好友申请
func (s *FriendService) GetOutgoingRequests(ctx context.Context, fromID uint64) ([]*OutgoingRequestView, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT fr.id, fr.status, fr.created_at, u.chat_id, u.nickname
		FROM friend_requests fr
		JOIN users u ON u.id = fr.to_user_id
		WHERE fr.from_user_id = ? AND fr.status IN ('pending', 'rejected')
		ORDER BY fr.created_at DESC`, fromID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*OutgoingRequestView
	for rows.Next() {
		r := &OutgoingRequestView{}
		if err = rows.Scan(&r.ID, &r.Status, &r.CreatedAt, &r.ToChatID, &r.ToNickname); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, nil
}

// HandleRequest 接受或拒绝好友申请
// 返回请求发起者的 chat_id（用于 WebSocket 通知）
func (s *FriendService) HandleRequest(ctx context.Context, reqID, toID uint64, accept bool) (string, error) {
	var fromID uint64
	err := s.db.QueryRowContext(ctx,
		`SELECT from_user_id FROM friend_requests WHERE id = ? AND to_user_id = ? AND status = 'pending'`,
		reqID, toID,
	).Scan(&fromID)
	if err == sql.ErrNoRows {
		return "", ErrRequestNotFound
	}
	if err != nil {
		return "", err
	}

	// 获取发起者的 chat_id（在事务外查询，避免锁）
	var fromChatID string
	if err = s.db.QueryRowContext(ctx,
		`SELECT chat_id FROM users WHERE id = ?`, fromID,
	).Scan(&fromChatID); err != nil {
		return "", err
	}

	status := "rejected"
	if accept {
		status = "accepted"
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	if _, err = tx.ExecContext(ctx,
		`UPDATE friend_requests SET status = ? WHERE id = ?`, status, reqID); err != nil {
		return "", err
	}
	if accept {
		if _, err = tx.ExecContext(ctx,
			`INSERT IGNORE INTO friendships (user_id, friend_id) VALUES (?,?),(?,?)`,
			toID, fromID, fromID, toID); err != nil {
			return "", err
		}
	}
	return fromChatID, tx.Commit()
}

// GetFriends 获取好友列表（含公钥和在线状态）
func (s *FriendService) GetFriends(ctx context.Context, userID uint64) ([]*FriendView, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.chat_id, u.nickname, u.public_key, u.last_seen
		FROM friendships f
		JOIN users u ON u.id = f.friend_id
		WHERE f.user_id = ?
		ORDER BY u.nickname`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*FriendView
	for rows.Next() {
		v := &FriendView{}
		if err = rows.Scan(&v.ChatID, &v.Nickname, &v.PublicKey, &v.LastSeen); err != nil {
			return nil, err
		}
		// 检查 Redis 在线状态
		if s.redis != nil {
			exists, _ := s.redis.Exists(ctx, pkgredis.OnlineKey(v.ChatID)).Result()
			v.Online = exists > 0
		}
		result = append(result, v)
	}
	return result, nil
}

// CancelRequest 撤销自己发出的待处理好友申请
func (s *FriendService) CancelRequest(ctx context.Context, reqID, fromUserID uint64) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM friend_requests WHERE id = ? AND from_user_id = ? AND status = 'pending'`,
		reqID, fromUserID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrRequestNotFound
	}
	return nil
}

// AutoRejectExpired 将超过 7 天未处理的 pending 申请标记为 rejected
func (s *FriendService) AutoRejectExpired(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE friend_requests SET status = 'rejected'
		 WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`,
	)
	return err
}

// GetFriendChatIDs 获取好友的 chat_id 列表（用于广播在线状态）
func (s *FriendService) GetFriendChatIDs(ctx context.Context, userID uint64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.chat_id
		FROM friendships f
		JOIN users u ON u.id = f.friend_id
		WHERE f.user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		var chatID string
		if err = rows.Scan(&chatID); err != nil {
			return nil, err
		}
		result = append(result, chatID)
	}
	return result, nil
}

// AreFriends 检查 userID 与 friendChatID 是否存在双向好友关系
func (s *FriendService) AreFriends(ctx context.Context, userID uint64, friendChatID string) (bool, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM friendships f
		JOIN users u ON u.id = f.friend_id
		WHERE f.user_id = ? AND u.chat_id = ?`, userID, friendChatID).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// GetUserIDByChatID 通过 chat_id 查询 user id（已存在，无需修改）
