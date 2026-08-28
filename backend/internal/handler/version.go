package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// VersionInfo is the version information returned by /api/version
// Maintained in the environment variables of docker-compose (see APP_LATEST_VERSION of main.go, etc.)
type VersionInfo struct {
	Latest       string `json:"latest"`                  //The latest version number currently online
	MinSupported string `json:"min_supported,omitempty"` //Versions below this should be forced to update (optional)
	URL          string `json:"url,omitempty"`           //Legacy common download address (kept for older clients)
	Windows      string `json:"windows,omitempty"`       //Windows installer download address
	APK          string `json:"apk,omitempty"`           //Android APK download address
	Notes        string `json:"notes,omitempty"`         //Update instructions (optional)
}

type VersionHandler struct {
	info VersionInfo
}

func NewVersionHandler(latest, minSupported, url, windows, apk, notes string) *VersionHandler {
	return &VersionHandler{info: VersionInfo{
		Latest:       latest,
		MinSupported: minSupported,
		URL:          url,
		Windows:      windows,
		APK:          apk,
		Notes:        notes,
	}}
}

// GET /api/version public interface: returns the latest online version for front-end comparison prompt update
func (h *VersionHandler) Get(c *gin.Context) {
	c.JSON(http.StatusOK, h.info)
}
