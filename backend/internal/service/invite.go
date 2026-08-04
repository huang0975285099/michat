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

// chatIdPattern matches the chat_id format, such as 1234-ABCD (4 digits - 4 alphanumeric)
var chatIdPattern = regexp.MustCompile(`^\d{4}-[A-Z0-9]{4}$`)

type InviteService struct {
	redis     *rdb.Client
	friendSvc *FriendService
}

func NewInviteService(redis *rdb.Client, friendSvc *FriendService) *InviteService {
	return &InviteService{redis: redis, friendSvc: friendSvc}
}

// GenerateCode generates an invitation code and stores it in Redis. The value is the inviter's chat_id.
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

// ValidateCode verifies the invitation code and returns the inviter's chat_id (it will not be deleted after verification and is allowed to be used multiple times).
// If the code itself is in the chat_id format (XXXX-XXXX), the database will be directly checked to verify the existence of the user, which is permanently valid.
func (s *InviteService) ValidateCode(ctx context.Context, code string) (string, error) {
	// Use chat_id directly as the invitation parameter, which is permanently valid
	if chatIdPattern.MatchString(code) {
		_, _, err := s.friendSvc.GetUserIDByChatID(ctx, code)
		if err != nil {
			return "", ErrInviteCodeInvalid
		}
		return code, nil
	}

	// Old random invitation code, check Redis (backwards compatible)
	val, err := s.redis.Get(ctx, pkgredis.InviteCodeKey(code)).Result()
	if err == rdb.Nil {
		return "", ErrInviteCodeInvalid
	}
	if err != nil {
		return "", err
	}
	return val, nil
}

// CreateFriendRequestWithInvite Use invitation code to create friend request
// Returns the inviter's chat_id (used for WebSocket notifications)
func (s *InviteService) CreateFriendRequestWithInvite(ctx context.Context, code string, newUserID uint64) (string, error) {
	inviterChatID, err := s.ValidateCode(ctx, code)
	if err != nil {
		return "", err
	}

	// Get the user_id of the inviter
	_, inviterID, err := s.friendSvc.GetUserIDByChatID(ctx, inviterChatID)
	if err != nil {
		return "", err
	}

	// Create a friend application (initiated by new users to the inviter)
	if err = s.friendSvc.SendRequest(ctx, newUserID, inviterID); err != nil {
		return "", err
	}

	return inviterChatID, nil
}