package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	rdb "github.com/redis/go-redis/v9"

	"e2eechat/internal/service"
	pkgredis "e2eechat/pkg/redis"
)

func TestLogoutRevocationResult(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, scenario := range []string{"success", "failure", "missing-token"} {
		t.Run(scenario, func(t *testing.T) {
			server := miniredis.RunT(t)
			redis := rdb.NewClient(&rdb.Options{Addr: server.Addr(), MaxRetries: -1})
			defer redis.Close()
			server.Set(pkgredis.SessionKey("token"), "1234-ABCD:0")
			identity := service.NewIdentityService(nil, redis)
			notified := false
			unsubscribe := identity.SubscribeSessionRevocation("token", "1234-ABCD", func() { notified = true })
			defer unsubscribe()
			handler := NewIdentityHandler(identity, nil, nil, nil)
			router := gin.New()
			router.DELETE("/logout", handler.Logout)
			request := httptest.NewRequest(http.MethodDelete, "/logout", nil)
			if scenario != "missing-token" {
				request.Header.Set("Authorization", "Bearer token")
			}
			wantStatus := http.StatusOK
			if scenario == "failure" {
				server.SetError("ERR unavailable")
				wantStatus = http.StatusServiceUnavailable
			} else if scenario == "missing-token" {
				wantStatus = http.StatusUnauthorized
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, wantStatus)
			}
			if notified != (scenario != "missing-token") {
				t.Fatalf("revocation notification = %v", notified)
			}
			if scenario == "success" && server.Exists(pkgredis.SessionKey("token")) {
				t.Fatal("logout retained token")
			}
			if scenario == "failure" && !server.Exists(pkgredis.SessionKey("token")) {
				t.Fatal("failed deletion unexpectedly removed token")
			}
		})
	}
}
