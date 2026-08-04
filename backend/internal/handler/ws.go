package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"

	"e2eechat/internal/service"
	"e2eechat/internal/ws"
)

// WS concurrent connection upper limit: prevent connection flooding from exhausting socket/goroutine/memory.
// Mainly mobile phone + operator CGNAT: A large number of real users share an export IP, so the upper limit of a single IP is relaxed.
// It is only used to protect against abnormal floods on a single machine; real fine control relies on per-user (authRL) and per-connection (msgLimiter) current limiting.
const (
	maxWSConns      = 50000 //The upper limit of global concurrent connections (set according to the capacity of a single machine, if the limit is exceeded, new connections will be directly rejected)
	maxWSConnsPerIP = 500   //The upper limit of concurrent connections for a single IP (many mobile phones share IP under CGNAT)
)

// IsLocalDevOrigin determines whether origin is a local development/native shell origin that should always be allowed:
// - file:// / capacitor:// / tauri:// (native shell, no standard http origin)
// - http(s)://localhost, 127.0.0.1, [::1] on any port (local debugging)
// - http(s)://tauri.localhost (Tauri v2 serves the bundled assets from this host on Windows)
//
// Use exact host comparison instead of prefix matching to avoid bypasses such as https://localhost.evil.com.
// CheckOrigin and corsMiddleware share this judgment.
func IsLocalDevOrigin(origin string) bool {
	if strings.HasPrefix(origin, "file://") || strings.HasPrefix(origin, "capacitor://") ||
		strings.HasPrefix(origin, "tauri://") {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	switch u.Hostname() { //Hostname() has removed the port and IPv6 square brackets
	case "localhost", "127.0.0.1", "::1", "tauri.localhost":
		return true
	}
	return false
}

type WSHandler struct {
	hub            *ws.Hub
	identSvc       *service.IdentityService
	allowedOrigins map[string]struct{}
	allowAll       bool

	// Concurrent connection count (connection establishment has been limited by the upstream, non-hot path, simple to use mutex lock and no counting race).
	connMu     sync.Mutex
	curConns   int            //The current number of global concurrent connections
	connsPerIP map[string]int //ip → Current number of concurrent connections for this IP
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

// acquireConn attempts to take up quota for new connections from ip: returns false if the global or per-IP limit is exceeded.
// If successful, the corresponding releaseConn must be called at the end of the connection.
func (h *WSHandler) acquireConn(ip string) bool {
	h.connMu.Lock()
	defer h.connMu.Unlock()
	if h.curConns >= maxWSConns || h.connsPerIP[ip] >= maxWSConnsPerIP {
		return false
	}
	if h.connsPerIP == nil {
		h.connsPerIP = make(map[string]int)
	}
	h.curConns++
	h.connsPerIP[ip]++
	return true
}

func (h *WSHandler) releaseConn(ip string) {
	h.connMu.Lock()
	defer h.connMu.Unlock()
	if h.curConns > 0 {
		h.curConns--
	}
	if h.connsPerIP[ip] <= 1 {
		delete(h.connsPerIP, ip) //Delete when reset to zero to prevent unbounded growth of IP entries.
	} else {
		h.connsPerIP[ip]--
	}
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
			return IsLocalDevOrigin(origin)
		},
	}
}

// GET /ws  — token is sent via the first WebSocket message, not in the URL.
func (h *WSHandler) Serve(c *gin.Context) {
	// Maximum number of connections: intercept before upgrading to avoid allocating resources for excessive connections.
	ip := c.ClientIP()
	if !h.acquireConn(ip) {
		c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "too many connections"})
		return
	}
	// Before being successfully transferred to the read-write goroutine (upgrade/authentication failure, etc.), this defer will release the quota.
	handedOff := false
	defer func() {
		if !handedOff {
			h.releaseConn(ip)
		}
	}()

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

	handedOff = true
	go func() {
		defer h.releaseConn(ip)
		h.hub.ServeClient(client)
		h.identSvc.UpdateLastSeen(ctx, chatID)
	}()
}

func writeAuthResult(conn *websocket.Conn, success bool, reason string) {
	type payload struct {
		Success    bool   `json:"success"`
		Reason     string `json:"reason,omitempty"`
		ServerTime int64  `json:"server_time"`
		ReadAck    bool   `json:"read_ack"`
	}
	type envelope struct {
		Type    string  `json:"type"`
		Payload payload `json:"payload"`
	}
	data, _ := json.Marshal(envelope{Type: "auth_result", Payload: payload{
		Success: success, Reason: reason, ServerTime: time.Now().UnixMilli(), ReadAck: true,
	}})
	conn.WriteMessage(websocket.TextMessage, data)
}
