package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"e2eechat/internal/service"
	"github.com/gin-gonic/gin"
)

func TestAuthorityErrorHTTPMapping(t *testing.T) {
	tests := []struct {
		code   string
		status int
	}{
		{"invalid_action", 400}, {"invalid_request_id", 400},
		{"forbidden", 403}, {"not_found", 404},
		{"action_locked", 409}, {"stale_state", 409}, {"game_finished", 409},
		{"session_expired", 410},
	}
	for _, test := range tests {
		status := authorityHTTPStatus(&service.AuthorityError{Code: test.code})
		if status != test.status {
			t.Fatalf("code=%s status=%d, want %d", test.code, status, test.status)
		}
	}
}

func TestStrictAuthorityJSONRejectsUnknownAndTrailingFields(t *testing.T) {
	for _, body := range []string{
		`{"round":1,"action":"attack","request_id":"6e7060d4-0c83-49fc-815a-800ad3b84a2e","expected_version":1,"player_hp":100}`,
		`{"round":1,"action":"attack","request_id":"6e7060d4-0c83-49fc-815a-800ad3b84a2e","expected_version":1}{}`,
	} {
		var command service.ActionCommand
		if err := decodeStrictAuthorityJSON(strings.NewReader(body), &command); err == nil {
			t.Fatalf("accepted untrusted fields in %s", body)
		}
	}
}

func TestLegacyUpgradeResponseStatus(t *testing.T) {
	if http.StatusUpgradeRequired != 426 {
		t.Fatal("unexpected HTTP upgrade status")
	}
}

func TestSubmitActionRejectsUnknownJSONFields(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	handler := NewIronFistHandler(nil, nil)
	router.POST("/games/:id/actions", handler.SubmitAuthoritativeAction)
	body := `{"round":1,"action":"attack","request_id":"6e7060d4-0c83-49fc-815a-800ad3b84a2e","expected_version":1,"player_hp":100}`
	request := httptest.NewRequest(http.MethodPost, "/games/g/actions", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestLegacyReportAndClaimRequireUpgrade(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	ironFistHandler := NewIronFistHandler(nil, nil)
	fistHandler := NewFistHandler(nil)
	router.POST("/games/ironfist/stats", ironFistHandler.ReportMatch)
	router.POST("/fist/pve-reward", fistHandler.ClaimPvEReward)
	for _, path := range []string{"/games/ironfist/stats", "/fist/pve-reward"} {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != http.StatusUpgradeRequired || !strings.Contains(response.Body.String(), "upgrade_required") {
			t.Fatalf("path=%s status=%d body=%s", path, response.Code, response.Body.String())
		}
	}
}
