package model

import "time"

type User struct {
	ID        uint64     `json:"id"`
	ChatID    string     `json:"chat_id"`
	Nickname  string     `json:"nickname"`
	PublicKey string     `json:"public_key"`
	IsReady   bool       `json:"is_ready"`
	CreatedAt time.Time  `json:"created_at"`
	LastSeen  *time.Time `json:"last_seen"`
}

type FriendRequest struct {
	ID         uint64    `json:"id"`
	FromUserID uint64    `json:"from_user_id"`
	ToUserID   uint64    `json:"to_user_id"`
	Status     string    `json:"status"` // pending | accepted | rejected
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`

	// 查询时附带的关联信息
	FromUser *User `json:"from_user,omitempty"`
	ToUser   *User `json:"to_user,omitempty"`
}

type Friendship struct {
	ID        uint64    `json:"id"`
	UserID    uint64    `json:"user_id"`
	FriendID  uint64    `json:"friend_id"`
	CreatedAt time.Time `json:"created_at"`

	Friend *User `json:"friend,omitempty"`
}
