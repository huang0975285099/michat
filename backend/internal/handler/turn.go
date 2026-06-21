package handler

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

type TurnHandler struct {
	secret string
	host   string
	port   int
}

func NewTurnHandler(secret, host string, port int) *TurnHandler {
	return &TurnHandler{secret: secret, host: host, port: port}
}

func (h *TurnHandler) GetCredentials(c *gin.Context) {
	expires := time.Now().Add(24 * time.Hour).Unix()
	chatID := c.GetString("chat_id")
	username := fmt.Sprintf("%d:%s", expires, chatID)

	mac := hmac.New(sha1.New, []byte(h.secret))
	mac.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	addr := fmt.Sprintf("%s:%d", h.host, h.port)
	c.JSON(http.StatusOK, gin.H{
		"username": username,
		"password": password,
		"ttl":      86400,
		"uris": []string{
			"stun:" + addr,
			"turn:" + addr + "?transport=udp",
			"turn:" + addr + "?transport=tcp",
		},
	})
}
