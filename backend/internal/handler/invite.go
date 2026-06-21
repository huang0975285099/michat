package handler

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/middleware"
	"e2eechat/internal/service"
)

type InviteHandler struct {
	svc *service.InviteService
}

func NewInviteHandler(svc *service.InviteService) *InviteHandler {
	return &InviteHandler{svc: svc}
}

// POST /api/invite/generate
// 生成邀请码，返回 invite_code
func (h *InviteHandler) Generate(c *gin.Context) {
	chatID := c.GetString(middleware.CtxChatID)

	code, err := h.svc.GenerateCode(c.Request.Context(), chatID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"invite_code": code})
}

// GET /api/invite/validate?code=xxx
// 验证邀请码，返回邀请者的 chat_id 和 nickname（公开信息）
func (h *InviteHandler) Validate(c *gin.Context) {
	code := c.Query("code")
	if code == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "code is required"})
		return
	}

	inviterChatID, err := h.svc.ValidateCode(c.Request.Context(), code)
	if errors.Is(err, service.ErrInviteCodeInvalid) {
		c.JSON(http.StatusNotFound, gin.H{"error": "invite code invalid or expired"})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"inviter_chat_id": inviterChatID,
		"valid":           true,
	})
}