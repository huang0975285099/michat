package handler

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/middleware"
	"e2eechat/internal/service"
)

type IdentityHandler struct {
	svc       *service.IdentityService
	inviteSvc *service.InviteService
	friendSvc *service.FriendService
	hub       interface {
		NotifyFriendRequest(toChatID, fromChatID string)
	}
}

func NewIdentityHandler(svc *service.IdentityService, inviteSvc *service.InviteService, friendSvc *service.FriendService, hub interface {
	NotifyFriendRequest(toChatID, fromChatID string)
}) *IdentityHandler {
	return &IdentityHandler{svc: svc, inviteSvc: inviteSvc, friendSvc: friendSvc, hub: hub}
}

// POST /api/identity/init
// 首次进入：服务端生成 chat_id + nickname，返回 session_token
// 可选 invite_code：使用邀请码注册后自动发送好友申请
func (h *IdentityHandler) Init(c *gin.Context) {
	var body struct {
		InviteCode string `json:"invite_code"`
	}
	_ = c.ShouldBindJSON(&body) // 忽略错误，invite_code 是可选的

	user, token, err := h.svc.Init(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// 处理邀请码
	var inviterChatID string
	if body.InviteCode != "" && h.inviteSvc != nil {
		inviterChatID, err = h.inviteSvc.CreateFriendRequestWithInvite(c.Request.Context(), body.InviteCode, user.ID)
		if err == nil && h.hub != nil {
			// 实时通知邀请者
			h.hub.NotifyFriendRequest(inviterChatID, user.ChatID)
		}
		// 邀请码无效不阻止注册，只是不创建好友申请
	}

	c.JSON(http.StatusCreated, gin.H{
		"chat_id":         user.ChatID,
		"nickname":        user.Nickname,
		"session_token":   token,
		"inviter_chat_id": inviterChatID, // 返回邀请者的 chat_id，前端可显示提示
	})
}

// PUT /api/identity/pubkey
// 上传公钥，完成注册（需要 session token）
func (h *IdentityHandler) UploadPubkey(c *gin.Context) {
	chatID := c.GetString(middleware.CtxChatID)

	var body struct {
		PublicKey string `json:"public_key" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "public_key is required"})
		return
	}

	err := h.svc.UploadPublicKey(c.Request.Context(), chatID, body.PublicKey)
	if errors.Is(err, service.ErrAlreadyReady) {
		c.JSON(http.StatusConflict, gin.H{"error": "public key already uploaded"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /api/identity/me
// 查询自己的身份信息
func (h *IdentityHandler) Me(c *gin.Context) {
	chatID := c.GetString(middleware.CtxChatID)
	user, err := h.svc.GetByChatID(c.Request.Context(), chatID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, user)
}

// DELETE /api/identity/me
// 注销账号：删除用户、好友关系、所有 session
func (h *IdentityHandler) DeleteAccount(c *gin.Context) {
	chatID := c.GetString(middleware.CtxChatID)
	if err := h.svc.DeleteAccount(c.Request.Context(), chatID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DELETE /api/identity/logout
// 注销 session（删除服务端 Redis token）
func (h *IdentityHandler) Logout(c *gin.Context) {
	token := extractToken(c)
	if token != "" {
		h.svc.RevokeSession(c.Request.Context(), token)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /api/identity/reauth/challenge
// 获取挑战码（用于私钥签名验证）
func (h *IdentityHandler) GetReauthChallenge(c *gin.Context) {
	publicKey := c.Query("public_key")
	if publicKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "public_key is required"})
		return
	}
	nonce, err := h.svc.GetReauthChallenge(c.Request.Context(), publicKey)
	if errors.Is(err, service.ErrUserNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"nonce": nonce})
}

// POST /api/identity/reauth
// 凭公钥+挑战码签名换取新 session_token（私钥恢复场景）
func (h *IdentityHandler) Reauth(c *gin.Context) {
	var body struct {
		PublicKey string `json:"public_key" binding:"required"`
		Signature string `json:"signature" binding:"required"`
		Nonce     string `json:"nonce" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "public_key, signature, nonce are required"})
		return
	}
	user, token, err := h.svc.Reauth(c.Request.Context(), body.PublicKey, body.Signature, body.Nonce)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"session_token": token,
		"chat_id":       user.ChatID,
		"nickname":      user.Nickname,
	})
}

// PUT /api/identity/nickname
// 修改昵称，长度限制 1-8 个字符
func (h *IdentityHandler) UpdateNickname(c *gin.Context) {
	chatID := c.GetString(middleware.CtxChatID)
	var body struct {
		Nickname string `json:"nickname" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "nickname is required"})
		return
	}
	name := strings.TrimSpace(body.Nickname)
	n := utf8.RuneCountInString(name)
	if n == 0 || n > 8 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "昵称长度须为 1-8 个字符"})
		return
	}
	if err := h.svc.UpdateNickname(c.Request.Context(), chatID, name); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "nickname": name})
}

func extractToken(c *gin.Context) string {
	auth := c.GetHeader("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	return auth
}
