package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/service"
)

type UserHandler struct {
	svc *service.IdentityService
}

func NewUserHandler(svc *service.IdentityService) *UserHandler {
	return &UserHandler{svc: svc}
}

// GET /api/users/search?id=NNNN-AAAA
func (h *UserHandler) Search(c *gin.Context) {
	chatID := c.Query("id")
	if len(chatID) != 9 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "id must be in NNNN-AAAA format"})
		return
	}
	user, err := h.svc.GetByChatID(c.Request.Context(), chatID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	if !user.IsReady {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"chat_id":    user.ChatID,
		"nickname":   user.Nickname,
		"public_key": user.PublicKey,
	})
}
