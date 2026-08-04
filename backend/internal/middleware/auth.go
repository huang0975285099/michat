package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/service"
)

const CtxChatID = "chat_id"
const CtxUserID = "user_id"
const CtxNickname = "nickname"

// Auth verifies session token and injects chat_id into context
func Auth(svc *service.IdentityService) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := extractToken(c)
		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
			return
		}
		chatID, err := svc.ValidateSession(c.Request.Context(), token)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired session"})
			return
		}
		// Find user id
		user, err := svc.GetByChatID(c.Request.Context(), chatID)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "user not found"})
			return
		}
		c.Set(CtxChatID, chatID)
		c.Set(CtxUserID, user.ID)
		c.Set(CtxNickname, user.Nickname)
		c.Next()
	}
}

func extractToken(c *gin.Context) string {
	// Prioritize from Authorization: Bearer <token>
	if auth := c.GetHeader("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	// Secondly, from query param (used for WebSocket handshake)
	return c.Query("token")
}
