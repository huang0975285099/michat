package middleware

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestPrivacyLoggerUsesRouteTemplateWithoutSensitiveRequestData(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var output bytes.Buffer
	router := gin.New()
	router.Use(PrivacyLogger(&output), PrivacyRecovery(&output))
	router.GET("/api/friends/:peerId/read-receipts", func(c *gin.Context) {
		c.Status(http.StatusNoContent)
	})

	request := httptest.NewRequest(
		http.MethodGet,
		"/api/friends/1234-ABCD/read-receipts?token=secret-token",
		nil,
	)
	request.RemoteAddr = "203.0.113.42:4321"
	request.Header.Set("Authorization", "Bearer secret-token")
	response := httptest.NewRecorder()

	router.ServeHTTP(response, request)

	logged := output.String()
	for _, want := range []string{
		"method=GET",
		"route=/api/friends/:peerId/read-receipts",
		"status=204",
	} {
		if !strings.Contains(logged, want) {
			t.Fatalf("privacy log missing %q: %s", want, logged)
		}
	}
	if !regexp.MustCompile("request_id=[0-9a-f]{16}").MatchString(logged) {
		t.Fatalf("privacy log missing generated request id: %s", logged)
	}
	for _, secret := range []string{
		"1234-ABCD",
		"203.0.113.42",
		"secret-token",
		"Authorization",
		"?token=",
	} {
		if strings.Contains(logged, secret) {
			t.Fatalf("privacy log leaked %q: %s", secret, logged)
		}
	}
}

func TestPrivacyLoggerUsesConstantLabelForUnmatchedRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var output bytes.Buffer
	router := gin.New()
	router.Use(PrivacyLogger(&output), PrivacyRecovery(&output))

	request := httptest.NewRequest(http.MethodGet, "/private/1234-ABCD?token=secret-token", nil)
	router.ServeHTTP(httptest.NewRecorder(), request)

	logged := output.String()
	if !strings.Contains(logged, "route=unmatched-route") {
		t.Fatalf("unmatched route was not anonymized: %s", logged)
	}
	if strings.Contains(logged, "1234-ABCD") || strings.Contains(logged, "secret-token") {
		t.Fatalf("unmatched route leaked request data: %s", logged)
	}
}

func TestPrivacyRecoveryDoesNotDumpPanickingRequest(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var output bytes.Buffer
	router := gin.New()
	router.Use(PrivacyLogger(&output), PrivacyRecovery(&output))
	router.GET("/panic/:privateID", func(c *gin.Context) {
		panic("private panic payload")
	})

	request := httptest.NewRequest(http.MethodGet, "/panic/1234-ABCD?token=secret-token", nil)
	request.RemoteAddr = "203.0.113.42:4321"
	request.Header.Set("Authorization", "Bearer secret-token")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("panic status = %d, want 500", response.Code)
	}
	logged := output.String()
	if !strings.Contains(logged, "event=request-panic") {
		t.Fatalf("panic event missing from privacy log: %s", logged)
	}
	for _, secret := range []string{
		"private panic payload",
		"1234-ABCD",
		"203.0.113.42",
		"secret-token",
		"Authorization",
	} {
		if strings.Contains(logged, secret) {
			t.Fatalf("panic log leaked %q: %s", secret, logged)
		}
	}
}
