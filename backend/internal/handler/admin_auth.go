package handler

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const adminCookie = "yunmi_admin_session"

type AdminAuth struct {
	username string
	password string
	mu       sync.Mutex
	sessions map[string]time.Time
}

func NewAdminAuth(username, password string) *AdminAuth {
	return &AdminAuth{username: username, password: password, sessions: make(map[string]time.Time)}
}

func (a *AdminAuth) Login(c *gin.Context) {
	var credentials struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if c.ShouldBindJSON(&credentials) != nil || len(credentials.Username) > 256 || len(credentials.Password) > 1024 {
		c.JSON(400, gin.H{"error": "invalid credentials"})
		return
	}
	if a.username == "" || a.password == "" || subtle.ConstantTimeCompare([]byte(credentials.Username), []byte(a.username)) != 1 || subtle.ConstantTimeCompare([]byte(credentials.Password), []byte(a.password)) != 1 {
		c.JSON(401, gin.H{"error": "invalid credentials"})
		return
	}
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		c.Status(500)
		return
	}
	token := hex.EncodeToString(bytes)
	a.mu.Lock()
	for key, expiry := range a.sessions {
		if time.Now().After(expiry) {
			delete(a.sessions, key)
		}
	}
	a.sessions[token] = time.Now().Add(8 * time.Hour)
	a.mu.Unlock()
	http.SetCookie(c.Writer, &http.Cookie{Name: adminCookie, Value: token, Path: "/api/admin", HttpOnly: true, Secure: adminSecure(c), SameSite: http.SameSiteStrictMode, MaxAge: 8 * 3600})
	c.JSON(200, gin.H{"ok": true})
}

func adminSecure(c *gin.Context) bool {
	return c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
}

func (a *AdminAuth) Require() gin.HandlerFunc {
	return func(c *gin.Context) {
		cookie, err := c.Cookie(adminCookie)
		if err != nil {
			c.Status(401)
			c.Abort()
			return
		}
		a.mu.Lock()
		expiry, ok := a.sessions[cookie]
		a.mu.Unlock()
		if !ok || time.Now().After(expiry) {
			c.Status(401)
			c.Abort()
			return
		}
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			origin := c.GetHeader("Origin")
			if origin != "" && !sameAdminOrigin(c, origin) {
				c.Status(403)
				c.Abort()
				return
			}
		}
		c.Next()
	}
}

func sameAdminOrigin(c *gin.Context, origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if adminSecure(c) {
		host := c.Request.Host
		return u.Scheme == "https" && (strings.EqualFold(u.Host, host) || strings.EqualFold(u.Host, host+":8088"))
	}
	return u.Scheme == "http" && strings.EqualFold(u.Host, c.Request.Host)
}

func (a *AdminAuth) Logout(c *gin.Context) {
	if cookie, err := c.Cookie(adminCookie); err == nil {
		a.mu.Lock()
		delete(a.sessions, cookie)
		a.mu.Unlock()
	}
	http.SetCookie(c.Writer, &http.Cookie{Name: adminCookie, Path: "/api/admin", HttpOnly: true, Secure: adminSecure(c), SameSite: http.SameSiteStrictMode, MaxAge: -1})
	c.Status(204)
}
