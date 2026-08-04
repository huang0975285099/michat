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

// FriendRequestView View when querying (including sender information)
type FriendRequestView struct {
	ID           uint64    `json:"id"`
	Status       string    `json:"status"`
	CreatedAt    time.Time `json:"created_at"`
	FromChatID   string    `json:"from_chat_id"`
	FromNickname string    `json:"from_nickname"`
}

// OutgoingRequestView Friend request sent by user (including recipient information)
type OutgoingRequestView struct {
	ID         uint64    `json:"id"`
	Status     string    `json:"status"`
	CreatedAt  time.Time `json:"created_at"`
	ToChatID   string    `json:"to_chat_id"`
	ToNickname string    `json:"to_nickname"`
}

// FriendView friend list view
type FriendView struct {
	ChatID    string     `json:"chat_id"`
	Nickname  string     `json:"nickname"`
	PublicKey string     `json:"public_key"`
	LastSeen  *time.Time `json:"last_seen"`
	Online    bool       `json:"online"` //Real-time online status
}

// GetUserIDByChatID queries user id through chat_id
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

// SendRequest Send friend request
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

// GetIncomingRequests Query the pending requests received
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

// GetOutgoingRequests Query the friend requests sent by the user
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

// HandleRequest accepts or rejects friend requests
// Returns the chat_id of the request originator (used for WebSocket notifications)
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

	// Get the initiator's chat_id (query outside the transaction to avoid locks)
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

// GetFriends gets the friend list (including public key and online status)
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
		// Check Redis online status
		if s.redis != nil {
			exists, _ := s.redis.Exists(ctx, pkgredis.OnlineKey(v.ChatID)).Result()
			v.Online = exists > 0
		}
		result = append(result, v)
	}
	return result, nil
}

// CancelRequest cancels the pending friend request issued by yourself
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

// AutoRejectExpired marks pending requests that have not been processed for more than 7 days as rejected
func (s *FriendService) AutoRejectExpired(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE friend_requests SET status = 'rejected'
		 WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`,
	)
	return err
}

// GetFriendChatIDs Gets the chat_id list of friends (used for broadcasting online status)
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

// AreFriends checks whether there is a two-way friend relationship between userID and friendChatID
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

// GetUserIDByChatID queries user id through chat_id (already exists, no need to modify)
