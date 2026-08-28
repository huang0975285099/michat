package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestVersionHandlerReturnsPlatformDownloadURLs(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := NewVersionHandler(
		"1.2.0",
		"1.1.0",
		"https://m.yzs88.com:8088",
		"https://m.yzs88.com:8088/download/yunChat.exe",
		"https://m.yzs88.com:8088/download/yunChat.apk",
		"Bilingual update",
	)
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(http.MethodGet, "/api/version", nil)

	handler.Get(context)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var response VersionInfo
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Windows != "https://m.yzs88.com:8088/download/yunChat.exe" {
		t.Fatalf("windows URL = %q", response.Windows)
	}
	if response.APK != "https://m.yzs88.com:8088/download/yunChat.apk" {
		t.Fatalf("APK URL = %q", response.APK)
	}
	if response.URL != "https://m.yzs88.com:8088" {
		t.Fatalf("legacy URL = %q", response.URL)
	}
}
