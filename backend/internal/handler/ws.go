package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"e2eechat/internal/service"
	"e2eechat/internal/ws"
)

type WSHandler struct {
	hub            *ws.Hub
	identSvc       *service.IdentityService
	allowedOrigins map[string]struct{}
	allowAll       bool
}

func NewWSHandler(hub *ws.Hub, svc *service.IdentityService, allowedOrigins []string) *WSHandler {
	h := &WSHandler{hub: hub, identSvc: svc, allowedOrigins: make(map[string]struct{})}
	if len(allowedOrigins) == 0 || (len(allowedOrigins) == 1 && allowedOrigins[0] == "*") {
		h.allowAll = true
	} else {
		for _, o := range allowedOrigins {
			h.allowedOrigins[o] = struct{}{}
		}
	}
	return h
}

func (h *WSHandler) upgrader() websocket.Upgrader {
	return websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			if h.allowAll {
				return true
			}
			origin := r.Header.Get("Origin")
			if _, ok := h.allowedOrigins[origin]; ok {
				return true
			}
			return strings.HasPrefix(origin, "file://") || strings.HasPrefix(origin, "capacitor://") || strings.HasPrefix(origin, "https://localhost")
		},
	}
}

// GET /ws  — token is sent via the first WebSocket message, not in the URL.
func (h *WSHandler) Serve(c *gin.Context) {
	upgrader := h.upgrader()
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}

	// Expect {"type":"auth","payload":{"token":"..."}} within 10 s.
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		conn.Close()
		return
	}
	conn.SetReadDeadline(time.Time{})

	var msg ws.Message
	if err := json.Unmarshal(raw, &msg); err != nil || msg.Type != "auth" {
		writeAuthResult(conn, false, "expected auth message")
		conn.Close()
		return
	}

	var authPayload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(msg.Payload, &authPayload); err != nil || authPayload.Token == "" {
		writeAuthResult(conn, false, "missing token")
		conn.Close()
		return
	}

	ctx := context.Background()
	chatID, err := h.identSvc.ValidateSession(ctx, authPayload.Token)
	if err != nil {
		writeAuthResult(conn, false, "invalid token")
		conn.Close()
		return
	}

	user, err := h.identSvc.GetByChatID(ctx, chatID)
	if err != nil {
		writeAuthResult(conn, false, "user not found")
		conn.Close()
		return
	}

	writeAuthResult(conn, true, "")

	client := &ws.Client{
		ChatID: chatID,
		UserID: user.ID,
	}
	ws.InitClient(client, conn, make(chan []byte, 256))

	go func() {
		h.hub.ServeClient(client)
		h.identSvc.UpdateLastSeen(ctx, chatID)
	}()
}

func writeAuthResult(conn *websocket.Conn, success bool, reason string) {
	type payload struct {
		Success bool   `json:"success"`
		Reason  string `json:"reason,omitempty"`
	}
	type envelope struct {
		Type    string  `json:"type"`
		Payload payload `json:"payload"`
	}
	data, _ := json.Marshal(envelope{Type: "auth_result", Payload: payload{Success: success, Reason: reason}})
	conn.WriteMessage(websocket.TextMessage, data)
}
