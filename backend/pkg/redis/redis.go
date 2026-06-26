package redis

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

const (
	SessionTTL         = 30 * 24 * time.Hour // 30天
	OnlineTTL          = 60 * time.Second    // 在线心跳 60s
	OfflineMsgTTL      = 7 * 24 * time.Hour  // 离线消息 7天
	ReauthChallengeTTL = 5 * time.Minute     // 挑战码有效期 5分钟
	InviteCodeTTL      = 7 * 24 * time.Hour  // 邀请码有效期 7天
	IronFistActionsTTL = 30 * time.Minute    // 铁拳对局 action 日志保留窗口（覆盖 60s 重连 + 极端情况）
)

// NewInMemory 启动一个进程内的内存 Redis（miniredis），返回连接它的 client。
// 仅用于本地开发，免去安装 Redis。进程退出即数据全失，不要用于生产。
func NewInMemory() (*redis.Client, error) {
	srv, err := miniredis.Run()
	if err != nil {
		return nil, fmt.Errorf("start miniredis: %w", err)
	}
	log.Printf("[redis] 使用内存版 Redis (miniredis) @ %s — 仅限开发", srv.Addr())
	return redis.NewClient(&redis.Options{Addr: srv.Addr()}), nil
}

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

func SessionKey(token string) string          { return "session:" + token }
func SessionGenKey(chatID string) string      { return "session_gen:" + chatID }
func OnlineKey(chatID string) string          { return "online:" + chatID }
func OfflineKey(chatID string) string         { return "offline:" + chatID }
func ReauthChallengeKey(nonce string) string  { return "reauth_challenge:" + nonce }
func InviteCodeKey(code string) string        { return "invite:" + code }
func IronFistActionsKey(roomID string) string { return "ironfist:actions:" + roomID }
