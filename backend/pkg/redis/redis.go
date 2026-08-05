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
	SessionTTL            = 30 * 24 * time.Hour //30 days
	OnlineTTL             = 60 * time.Second    //Online heartbeat 60s
	OfflineMsgTTL         = 7 * 24 * time.Hour  //Offline messages 7 days
	ReauthChallengeTTL    = 5 * time.Minute     //The challenge code is valid for 5 minutes
	InviteCodeTTL         = 7 * 24 * time.Hour  //The invitation code is valid for 7 days
	IronFistActionsTTL    = 30 * time.Minute    //Tekken game action log retention window (covers 60s reconnection + extreme situations)
	IronFistEventsChannel = "ironfist:events"
)

// NewInMemory starts an in-process memory Redis (miniredis) and returns the client connected to it.
// Only for local development, no need to install Redis. All data will be lost when the process exits, so do not use it for production.
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
func IronFistActionOnceKey(roomID, chatID string, round int) string {
	return fmt.Sprintf("ironfist:action-once:%s:%s:%d", roomID, chatID, round)
}
