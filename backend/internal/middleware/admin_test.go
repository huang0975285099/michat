package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// AdminOnly is the only thing standing between a valid session and the operator
// dashboard, so the cases that matter are the ones where the flag is absent or
// falsy — it must fail closed in both.
func TestAdminOnly(t *testing.T) {
	gin.SetMode(gin.TestMode)

	tests := []struct {
		name       string
		setFlag    bool
		flagValue  any
		wantStatus int
		wantCalled bool
	}{
		{name: "admin passes through", setFlag: true, flagValue: true, wantStatus: http.StatusOK, wantCalled: true},
		{name: "non-admin blocked", setFlag: true, flagValue: false, wantStatus: http.StatusNotFound},
		// Auth not chained in front: the key is missing entirely.
		{name: "missing flag blocked", setFlag: false, wantStatus: http.StatusNotFound},
		// A non-bool in the slot must not be coerced into access.
		{name: "wrong type blocked", setFlag: true, flagValue: "true", wantStatus: http.StatusNotFound},
		{name: "nil blocked", setFlag: true, flagValue: nil, wantStatus: http.StatusNotFound},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			w := httptest.NewRecorder()
			r := gin.New()
			r.GET("/admin/stats", func(c *gin.Context) {
				if tt.setFlag {
					c.Set(CtxIsAdmin, tt.flagValue)
				}
				c.Next()
			}, AdminOnly(), func(c *gin.Context) {
				called = true
				c.Status(http.StatusOK)
			})

			r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/admin/stats", nil))

			if w.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", w.Code, tt.wantStatus)
			}
			if called != tt.wantCalled {
				t.Errorf("handler called = %v, want %v", called, tt.wantCalled)
			}
		})
	}
}

// A non-admin gets 404 rather than 403 so the endpoint does not confirm it exists.
func TestAdminOnlyDoesNotAdvertiseItself(t *testing.T) {
	gin.SetMode(gin.TestMode)

	w := httptest.NewRecorder()
	r := gin.New()
	r.GET("/admin/stats", func(c *gin.Context) { c.Set(CtxIsAdmin, false) }, AdminOnly(),
		func(c *gin.Context) { c.Status(http.StatusOK) })
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/admin/stats", nil))

	if w.Code == http.StatusForbidden {
		t.Error("403 tells a non-admin the route exists; expected 404")
	}
	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}
