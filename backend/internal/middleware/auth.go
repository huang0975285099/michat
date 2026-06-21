package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/service"
)

const CtxChatID = "chat_id"
const CtxUserID = "user_id"

// Auth 校验 session token，将 chat_id 注入 context
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
		// 查出 user id
		user, err := svc.GetByChatID(c.Request.Context(), chatID)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "user not found"})
			return
		}
		c.Set(CtxChatID, chatID)
		c.Set(CtxUserID, user.ID)
		c.Next()
	}
}

func extractToken(c *gin.Context) string {
	// 优先从 Authorization: Bearer <token>
	if auth := c.GetHeader("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ")
	}
	// 其次从 query param（WebSocket 握手用）
	return c.Query("token")
}
