package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// The page route deliberately touches no database — it returns the embedded
// shell, which then authenticates itself against /api/admin/stats. That makes it
// testable on its own, and worth testing: a broken //go:embed or a wrong content
// type would otherwise only show up in a deployed environment.
func TestAdminPage(t *testing.T) {
	gin.SetMode(gin.TestMode)

	h := NewAdminHandler(nil)
	r := gin.New()
	r.GET("/admin", h.Page)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/admin", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
	// The dashboard reflects live operational figures; a cached copy would be wrong
	// and could outlive the admin's session.
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}

	body := w.Body.String()
	if len(body) == 0 {
		t.Fatal("empty body — //go:embed admin.html produced nothing")
	}
	for _, want := range []string{
		"<title>Yunmi — Admin</title>",
		"/api/admin/stats", // the endpoint the shell calls
		"end-to-end encrypted",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("body missing %q", want)
		}
	}
	// The page must stay self-contained: nginx serves it from the backend, and
	// nothing external is fetchable from that origin.
	for _, bad := range []string{"src=\"http", "href=\"http", "cdn."} {
		if strings.Contains(body, bad) {
			t.Errorf("page references an external resource (%q); it must be self-contained", bad)
		}
	}
}
