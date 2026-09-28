package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCompanyAndArticleEvidenceValidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	if validIntelligenceURL("javascript:alert(1)") || validIntelligenceURL("https://user:pass@example.com") || !validIntelligenceURL("https://example.com/news") {
		t.Fatal("source URL validation must accept only usable HTTP(S) links without credentials")
	}
	if !validOccurredOn("2026-09-27") || validOccurredOn("2026-02-30") {
		t.Fatal("event date validation must reject impossible dates")
	}

	tests := []struct {
		name string
		body string
		want int
	}{
		{"company slug", `{"slug":"../tesla","name_en":"Tesla"}`, http.StatusBadRequest},
		{"company profile", `{"slug":"tesla","name_en":"Tesla","website":"https://www.tesla.com","aliases":["Tesla, Inc."]}`, http.StatusNoContent},
		{"published company article without evidence", `{"title":"Update","content":"<p>News</p>","published":true,"company_id":1}`, http.StatusBadRequest},
		{"published company article with evidence", `{"title":"Update","content":"<p>News</p>","published":true,"company_id":1,"source_url":"https://example.com/news","occurred_on":"2026-09-27"}`, http.StatusNoContent},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			c.Request = httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tc.body))
			c.Request.Header.Set("Content-Type", "application/json")
			if strings.HasPrefix(tc.name, "company") {
				if _, ok := readCompanyInput(c); ok {
					c.Status(http.StatusNoContent)
				}
			} else {
				if _, ok := readRobotInput(c); ok {
					c.Status(http.StatusNoContent)
				}
			}
			c.Writer.WriteHeaderNow()
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", w.Code, tc.want, w.Body.String())
			}
		})
	}
}
