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

// WS 并发连接上限：防连接洪水耗尽 socket / goroutine / 内存。
// 手机为主 + 运营商 CGNAT：大量真实用户共用一个出口 IP，故单 IP 上限放宽，
// 仅作单机异常洪水兜底；真正的精细管控靠按用户(authRL)与按连接(msgLimiter)的限流。
const (
	maxWSConns      = 50000 // 全局并发连接上限（按单机容量设，超量直接拒新连）
	maxWSConnsPerIP = 500   // 单 IP 并发连接上限（CGNAT 下众多手机共用 IP）
)

// IsLocalDevOrigin 判断 origin 是否为应始终放行的本地开发 / 原生壳来源：
//   - file:// / capacitor://（移动端原生壳，无标准 http origin）
//   - 任意端口的 http(s)://localhost、127.0.0.1、[::1]（本地调试）
//
// 用精确 host 比对而非前缀匹配，避免 https://localhost.evil.com 之类的绕过。
// CheckOrigin 与 corsMiddleware 共用此判断。
func IsLocalDevOrigin(origin string) bool {
	if strings.HasPrefix(origin, "file://") || strings.HasPrefix(origin, "capacitor://") {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	switch u.Hostname() { // Hostname() 已去掉端口与 IPv6 方括号
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

type WSHandler struct {
	hub            *ws.Hub
	identSvc       *service.IdentityService
	allowedOrigins map[string]struct{}
	allowAll       bool

	// 并发连接计数（建连已被上游限流，非热路径，用互斥锁简单且无计数竞态）。
	connMu     sync.Mutex
	curConns   int            // 当前全局并发连接数
	connsPerIP map[string]int // ip → 当前该 IP 并发连接数
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

// acquireConn 尝试为来自 ip 的新连接占用名额：超过全局或单 IP 上限则返回 false。
// 成功时须在连接结束时调用对应的 releaseConn。
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
		delete(h.connsPerIP, ip) // 归零即删除，防止 IP 条目无界增长
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
	// 连接数上限：升级前即拦截，避免为超额连接分配资源。
	ip := c.ClientIP()
	if !h.acquireConn(ip) {
		c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "too many connections"})
		return
	}
	// 未成功移交给读写 goroutine 前（升级/认证失败等），由本 defer 释放名额。
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
