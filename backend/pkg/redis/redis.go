package redis

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	SessionTTL         = 30 * 24 * time.Hour // 30天
	OnlineTTL          = 60 * time.Second    // 在线心跳 60s
	OfflineMsgTTL      = 7 * 24 * time.Hour  // 离线消息 7天
	ReauthChallengeTTL = 5 * time.Minute     // 挑战码有效期 5分钟
	InviteCodeTTL      = 7 * 24 * time.Hour  // 邀请码有效期 7天
)

func New(addr, password string, db int) (*redis.Client, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
		DB:       db,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}
	return rdb, nil
}

func SessionKey(token string) string         { return "session:" + token }
func SessionGenKey(chatID string) string     { return "session_gen:" + chatID }
func OnlineKey(chatID string) string         { return "online:" + chatID }
func OfflineKey(chatID string) string        { return "offline:" + chatID }
func ReauthChallengeKey(nonce string) string { return "reauth_challenge:" + nonce }
func InviteCodeKey(code string) string       { return "invite:" + code }
