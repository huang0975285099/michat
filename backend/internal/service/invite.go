package service

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"regexp"

	rdb "github.com/redis/go-redis/v9"

	pkgredis "e2eechat/pkg/redis"
)

var ErrInviteCodeInvalid = errors.New("invite code invalid or expired")

// chatIdPattern 匹配 chat_id 格式，如 1234-ABCD（4位数字-4位字母数字）
var chatIdPattern = regexp.MustCompile(`^\d{4}-[A-Z0-9]{4}$`)

type InviteService struct {
	redis     *rdb.Client
	friendSvc *FriendService
}

func NewInviteService(redis *rdb.Client, friendSvc *FriendService) *InviteService {
	return &InviteService{redis: redis, friendSvc: friendSvc}
}

// GenerateCode 生成邀请码，存入 Redis，值为邀请者的 chat_id
func (s *InviteService) GenerateCode(ctx context.Context, inviterChatID string) (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	code := base64.URLEncoding.EncodeToString(b)

	if err := s.redis.Set(ctx, pkgredis.InviteCodeKey(code), inviterChatID, pkgredis.InviteCodeTTL).Err(); err != nil {
		return "", err
	}
	return code, nil
}

// ValidateCode 验证邀请码，返回邀请者的 chat_id（验证后不删除，允许多次使用）。
// 若 code 本身是 chat_id 格式（XXXX-XXXX），则直接查数据库验证用户存在，永久有效。
func (s *InviteService) ValidateCode(ctx context.Context, code string) (string, error) {
	// 直接用 chat_id 作为邀请参数，永久有效
	if chatIdPattern.MatchString(code) {
		_, _, err := s.friendSvc.GetUserIDByChatID(ctx, code)
		if err != nil {
			return "", ErrInviteCodeInvalid
		}
		return code, nil
	}

	// 旧式随机邀请码，查 Redis（向后兼容）
	val, err := s.redis.Get(ctx, pkgredis.InviteCodeKey(code)).Result()
	if err == rdb.Nil {
		return "", ErrInviteCodeInvalid
	}
	if err != nil {
		return "", err
	}
	return val, nil
}

// CreateFriendRequestWithInvite 使用邀请码创建好友申请
// 返回邀请者的 chat_id（用于 WebSocket 通知）
func (s *InviteService) CreateFriendRequestWithInvite(ctx context.Context, code string, newUserID uint64) (string, error) {
	inviterChatID, err := s.ValidateCode(ctx, code)
	if err != nil {
		return "", err
	}

	// 获取邀请者的 user_id
	_, inviterID, err := s.friendSvc.GetUserIDByChatID(ctx, inviterChatID)
	if err != nil {
		return "", err
	}

	// 创建好友申请（新用户向邀请者发起）
	if err = s.friendSvc.SendRequest(ctx, newUserID, inviterID); err != nil {
		return "", err
	}

	return inviterChatID, nil
}