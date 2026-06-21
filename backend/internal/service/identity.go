package service

import (
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"

	rdb "github.com/redis/go-redis/v9"

	"e2eechat/internal/model"
	pkgredis "e2eechat/pkg/redis"
)

var (
	ErrIdentityNotReady = errors.New("identity not ready")
	ErrAlreadyReady     = errors.New("identity already ready")
	ErrUserNotFound     = errors.New("user not found")
)

const (
	chatIDDigits  = "0123456789"
	chatIDLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
)

var (
	nicknameColors = []string{
		// 🎨 颜色系（偏柔和）
		"蔚蓝的", "天蓝的", "湖蓝的", "薄荷绿的",
		"柠檬黄的", "暖橙的", "樱粉的", "玫瑰粉的",
		"薰衣草紫的", "奶油白的", "象牙白的",
		"银灰的", "香槟金的", "琥珀色的", "翡翠色的",

		// ✨ 气质类（最推荐）
		"温柔的", "可爱的", "安静的", "慵懒的",
		"闪闪的", "柔软的", "甜甜的", "暖暖的",
		"清新的", "干净的", "纯真的", "治愈的",

		// 🌙 氛围感
		"神秘的", "梦幻的", "浪漫的", "孤独的",
		"自由的", "勇敢的", "快乐的", "悲伤的",
		"迷路的", "发光的", "透明的", "安然的",

		// 🌿 文艺感（高级一点）
		"风中的", "雨后的", "夜里的", "清晨的",
		"黄昏的", "星空下的", "云朵里的",
		"森林中的", "海边的",
	}
	nicknameAnimals = []string{
		"小猫咪", "小狐狸", "小兔子", "小熊猫", "小脑斧",
		"小狮子", "小企鹅", "小海豚", "小松鼠", "小猫头鹰",
		"小狼崽", "小熊", "小鹿", "小鹰",
		"小龙崽", "小马", "小羊", "小猴",
		"小狗狗", "小猪猪", "小考拉", "小袋鼠",
		"小刺猬", "小鹦鹉", "小火烈鸟", "小天鹅",
		"小孔雀", "小蝴蝶", "小蜜蜂", "小蜻蜓",
		"小鲸鱼", "小海马", "小海龟",
		"小变色龙", "小树懒", "小水獭", "小浣熊",
	}
)

type IdentityService struct {
	db    *sql.DB
	redis *rdb.Client
}

func NewIdentityService(db *sql.DB, redis *rdb.Client) *IdentityService {
	return &IdentityService{db: db, redis: redis}
}

// Init 创建新身份，返回 (user, sessionToken, error)
func (s *IdentityService) Init(ctx context.Context) (*model.User, string, error) {
	chatID, err := genChatID()
	if err != nil {
		return nil, "", fmt.Errorf("gen chat_id: %w", err)
	}
	nickname, err := genNickname()
	if err != nil {
		return nil, "", fmt.Errorf("gen nickname: %w", err)
	}

	res, err := s.db.ExecContext(ctx,
		`INSERT INTO users (chat_id, nickname, public_key, is_ready) VALUES (?, ?, '', 0)`,
		chatID, nickname,
	)
	if err != nil {
		return nil, "", fmt.Errorf("insert user: %w", err)
	}
	id, _ := res.LastInsertId()

	user := &model.User{
		ID:       uint64(id),
		ChatID:   chatID,
		Nickname: nickname,
		IsReady:  false,
	}

	token, err := s.issueSession(ctx, chatID)
	if err != nil {
		return nil, "", fmt.Errorf("issue session: %w", err)
	}
	return user, token, nil
}

// UploadPublicKey 上传公钥，完成注册
func (s *IdentityService) UploadPublicKey(ctx context.Context, chatID, publicKey string) error {
	var isReady bool
	err := s.db.QueryRowContext(ctx, `SELECT is_ready FROM users WHERE chat_id = ?`, chatID).Scan(&isReady)
	if err == sql.ErrNoRows {
		return ErrUserNotFound
	}
	if err != nil {
		return err
	}
	if isReady {
		return ErrAlreadyReady
	}
	_, err = s.db.ExecContext(ctx,
		`UPDATE users SET public_key = ?, is_ready = 1 WHERE chat_id = ?`,
		publicKey, chatID,
	)
	return err
}

// GetByChatID 查询用户
func (s *IdentityService) GetByChatID(ctx context.Context, chatID string) (*model.User, error) {
	u := &model.User{}
	err := s.db.QueryRowContext(ctx,
		`SELECT id, chat_id, nickname, public_key, is_ready, created_at, last_seen FROM users WHERE chat_id = ?`,
		chatID,
	).Scan(&u.ID, &u.ChatID, &u.Nickname, &u.PublicKey, &u.IsReady, &u.CreatedAt, &u.LastSeen)
	if err == sql.ErrNoRows {
		return nil, ErrUserNotFound
	}
	return u, err
}

// UpdateNickname 修改昵称
func (s *IdentityService) UpdateNickname(ctx context.Context, chatID, nickname string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET nickname = ? WHERE chat_id = ?`, nickname, chatID)
	return err
}

// UpdateLastSeen 更新最后在线时间
func (s *IdentityService) UpdateLastSeen(ctx context.Context, chatID string) {
	now := time.Now()
	s.db.ExecContext(ctx, `UPDATE users SET last_seen = ? WHERE chat_id = ?`, now, chatID) //nolint
}

// issueSession 生成 session token，值为 "chatID:gen"，写入 Redis
func (s *IdentityService) issueSession(ctx context.Context, chatID string) (string, error) {
	// 获取当前 session 版本号
	genStr, err := s.redis.Get(ctx, pkgredis.SessionGenKey(chatID)).Result()
	var gen int64
	if err == nil {
		gen, _ = strconv.ParseInt(genStr, 10, 64)
	}

	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := base64.URLEncoding.EncodeToString(b)
	val := chatID + ":" + strconv.FormatInt(gen, 10)
	return token, s.redis.Set(ctx, pkgredis.SessionKey(token), val, pkgredis.SessionTTL).Err()
}

// ValidateSession 校验 token，返回 chat_id；版本号不匹配时视为已失效
func (s *IdentityService) ValidateSession(ctx context.Context, token string) (string, error) {
	val, err := s.redis.Get(ctx, pkgredis.SessionKey(token)).Result()
	if err == rdb.Nil {
		return "", errors.New("invalid or expired session")
	}
	if err != nil {
		return "", err
	}

	// val 格式: "chatID:gen"
	idx := strings.LastIndex(val, ":")
	if idx < 0 {
		// 兼容旧格式（无版本号），直接返回
		return val, nil
	}
	chatID := val[:idx]
	gen, _ := strconv.ParseInt(val[idx+1:], 10, 64)

	// 校验版本号
	curGenStr, err := s.redis.Get(ctx, pkgredis.SessionGenKey(chatID)).Result()
	if err != nil && err != rdb.Nil {
		return "", err
	}
	var curGen int64
	if err == nil {
		curGen, _ = strconv.ParseInt(curGenStr, 10, 64)
	}
	if gen != curGen {
		return "", errors.New("session superseded")
	}
	return chatID, nil
}

// revokeAllSessions 递增版本号，使该用户所有旧 session 立即失效
func (s *IdentityService) revokeAllSessions(ctx context.Context, chatID string) error {
	return s.redis.Incr(ctx, pkgredis.SessionGenKey(chatID)).Err()
}

// RevokeSession 注销 session（删除 Redis 中的 token）
func (s *IdentityService) RevokeSession(ctx context.Context, token string) error {
	return s.redis.Del(ctx, pkgredis.SessionKey(token)).Err()
}

// DeleteAccount 注销账号：删除好友关系、好友申请、已读回执、用户记录、所有 session
func (s *IdentityService) DeleteAccount(ctx context.Context, chatID string) error {
	var userID uint64
	err := s.db.QueryRowContext(ctx, `SELECT id FROM users WHERE chat_id = ?`, chatID).Scan(&userID)
	if err == sql.ErrNoRows {
		return ErrUserNotFound
	}
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err = tx.ExecContext(ctx, `DELETE FROM message_reads WHERE msg_from = ? OR msg_to = ?`, chatID, chatID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM friendships WHERE user_id = ? OR friend_id = ?`, userID, userID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM friend_requests WHERE from_user_id = ? OR to_user_id = ?`, userID, userID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}

	s.revokeAllSessions(ctx, chatID)
	s.redis.Del(ctx, pkgredis.OnlineKey(chatID))
	return nil
}

// GetReauthChallenge 为指定公钥生成一次性挑战码，存入 Redis（5分钟有效）
func (s *IdentityService) GetReauthChallenge(ctx context.Context, publicKey string) (string, error) {
	var chatID string
	err := s.db.QueryRowContext(ctx,
		`SELECT chat_id FROM users WHERE public_key = ? AND is_ready = 1`, publicKey,
	).Scan(&chatID)
	if err == sql.ErrNoRows {
		return "", ErrUserNotFound
	}
	if err != nil {
		return "", err
	}

	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	nonce := base64.URLEncoding.EncodeToString(b)
	if err := s.redis.Set(ctx, pkgredis.ReauthChallengeKey(nonce), chatID, pkgredis.ReauthChallengeTTL).Err(); err != nil {
		return "", err
	}
	return nonce, nil
}

// Reauth 用挑战码+签名验证私钥所有权，颁发新 session_token
func (s *IdentityService) Reauth(ctx context.Context, publicKey, signature, nonce string) (*model.User, string, error) {
	// 1. 原子消费挑战码（GETDEL 保证一次性使用）
	val, err := s.redis.GetDel(ctx, pkgredis.ReauthChallengeKey(nonce)).Result()
	if err == rdb.Nil {
		return nil, "", errors.New("invalid or expired challenge")
	}
	if err != nil {
		return nil, "", err
	}
	chatID := val

	// 2. 查询用户
	u := &model.User{}
	err = s.db.QueryRowContext(ctx,
		`SELECT id, chat_id, nickname, public_key, is_ready, created_at, last_seen FROM users WHERE chat_id = ? AND is_ready = 1`,
		chatID,
	).Scan(&u.ID, &u.ChatID, &u.Nickname, &u.PublicKey, &u.IsReady, &u.CreatedAt, &u.LastSeen)
	if err == sql.ErrNoRows {
		return nil, "", ErrUserNotFound
	}
	if err != nil {
		return nil, "", err
	}

	// 3. 验证公钥与挑战码对应的用户一致
	if u.PublicKey != publicKey {
		return nil, "", errors.New("public key mismatch")
	}

	// 4. 验证 ECDSA 签名（证明持有私钥）
	if err := verifyECDSASignature(publicKey, nonce, signature); err != nil {
		return nil, "", err
	}

	// 5. 吊销旧 session，颁发新 token
	if err := s.revokeAllSessions(ctx, u.ChatID); err != nil {
		return nil, "", err
	}
	token, err := s.issueSession(ctx, u.ChatID)
	if err != nil {
		return nil, "", err
	}
	return u, token, nil
}

// verifyECDSASignature 验证 Web Crypto API 产生的 ECDSA P-256 签名（IEEE P1363 格式）
func verifyECDSASignature(publicKeyB64, message, signatureB64 string) error {
	pubKeyBytes, err := base64.StdEncoding.DecodeString(publicKeyB64)
	if err != nil {
		return fmt.Errorf("decode public key: %w", err)
	}
	pubKeyIface, err := x509.ParsePKIXPublicKey(pubKeyBytes)
	if err != nil {
		return fmt.Errorf("parse public key: %w", err)
	}
	ecPubKey, ok := pubKeyIface.(*ecdsa.PublicKey)
	if !ok {
		return errors.New("not an EC public key")
	}

	sigBytes, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return fmt.Errorf("decode signature: %w", err)
	}
	// Web Crypto ECDSA P-256 签名格式为 IEEE P1363: r||s，各 32 字节
	if len(sigBytes) != 64 {
		return errors.New("invalid signature length")
	}
	r := new(big.Int).SetBytes(sigBytes[:32])
	s := new(big.Int).SetBytes(sigBytes[32:])

	hash := sha256.Sum256([]byte(message))
	if !ecdsa.Verify(ecPubKey, hash[:], r, s) {
		return errors.New("signature verification failed")
	}
	return nil
}

// genChatID 生成 NNNN-AAAA 格式 ID（4位数字-4位大写字母，如 1234-ABCD）
func genChatID() (string, error) {
	digits := make([]byte, 4)
	for i := range digits {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(chatIDDigits))))
		if err != nil {
			return "", err
		}
		digits[i] = chatIDDigits[n.Int64()]
	}
	letters := make([]byte, 4)
	for i := range letters {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(chatIDLetters))))
		if err != nil {
			return "", err
		}
		letters[i] = chatIDLetters[n.Int64()]
	}
	return string(digits) + "-" + string(letters), nil
}

// genNickname 生成"颜色+动物"格式昵称
func genNickname() (string, error) {
	ci, err := rand.Int(rand.Reader, big.NewInt(int64(len(nicknameColors))))
	if err != nil {
		return "", err
	}
	ai, err := rand.Int(rand.Reader, big.NewInt(int64(len(nicknameAnimals))))
	if err != nil {
		return "", err
	}
	return nicknameColors[ci.Int64()] + nicknameAnimals[ai.Int64()], nil
}
