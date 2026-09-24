package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestAdminPasswordSession(t *testing.T) {
	gin.SetMode(gin.TestMode)
	auth := NewAdminAuth("operator", "secret-value")
	r := gin.New()
	r.POST("/api/admin/login", auth.Login)
	admin := r.Group("/api/admin", auth.Require())
	admin.GET("/stats", func(c *gin.Context) { c.Status(200) })
	admin.POST("/articles", func(c *gin.Context) { c.Status(201) })
	admin.POST("/logout", auth.Logout)

	request := func(method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if cookie != nil {
			req.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}
	if got := request("GET", "/api/admin/stats", "", nil).Code; got != 401 {
		t.Fatalf("unauthenticated stats: %d", got)
	}
	if got := request("POST", "/api/admin/login", `{"username":"operator","password":"wrong"}`, nil).Code; got != 401 {
		t.Fatalf("wrong password: %d", got)
	}
	w := request("POST", "/api/admin/login", `{"username":"operator","password":"secret-value"}`, nil)
	if w.Code != 200 || len(w.Result().Cookies()) != 1 {
		t.Fatalf("login: status %d cookies %d", w.Code, len(w.Result().Cookies()))
	}
	cookie := w.Result().Cookies()[0]
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("insecure cookie: %+v", cookie)
	}
	if got := request("GET", "/api/admin/stats", "", cookie).Code; got != 200 {
		t.Fatalf("authenticated stats: %d", got)
	}
	local := httptest.NewRequest("POST", "http://localhost:8888/api/admin/articles", nil)
	local.Header.Set("Origin", "http://localhost:8888")
	local.AddCookie(cookie)
	localResponse := httptest.NewRecorder()
	r.ServeHTTP(localResponse, local)
	if localResponse.Code != 201 {
		t.Fatalf("local admin POST: %d", localResponse.Code)
	}
	foreign := httptest.NewRequest("POST", "http://localhost:8888/api/admin/articles", nil)
	foreign.Header.Set("Origin", "http://other.example")
	foreign.AddCookie(cookie)
	foreignResponse := httptest.NewRecorder()
	r.ServeHTTP(foreignResponse, foreign)
	if foreignResponse.Code != 403 {
		t.Fatalf("foreign origin POST: %d", foreignResponse.Code)
	}
	proxied := httptest.NewRequest("POST", "http://m.yzs88.com/api/admin/articles", nil)
	proxied.Header.Set("X-Forwarded-Proto", "https")
	proxied.Header.Set("Origin", "https://m.yzs88.com:8088")
	proxied.AddCookie(cookie)
	proxiedResponse := httptest.NewRecorder()
	r.ServeHTTP(proxiedResponse, proxied)
	if proxiedResponse.Code != 201 {
		t.Fatalf("proxied admin POST: %d", proxiedResponse.Code)
	}
	if got := request("POST", "/api/admin/logout", "", cookie).Code; got != 204 {
		t.Fatalf("logout: %d", got)
	}
	if got := request("GET", "/api/admin/stats", "", cookie).Code; got != 401 {
		t.Fatalf("session after logout: %d", got)
	}
}
