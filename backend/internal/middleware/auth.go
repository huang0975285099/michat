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
const CtxIsAdmin = "is_admin"

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
		c.Set(CtxIsAdmin, user.IsAdmin)
		c.Next()
	}
}

// AdminOnly gates a route on the users.is_admin flag. It must be chained after
// Auth, which is what loads the flag — on its own it denies everything, so a
// missing Auth fails closed rather than opening the route up.
func AdminOnly() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !c.GetBool(CtxIsAdmin) {
			// 404 rather than 403: an admin-only surface should not confirm its own
			// existence to a non-admin who is nonetheless holding a valid session.
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
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
