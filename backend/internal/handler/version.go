package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// VersionInfo 是 /api/version 返回的版本信息
// 在 docker-compose 的环境变量里维护（见 main.go 的 APP_LATEST_VERSION 等）
type VersionInfo struct {
	Latest       string `json:"latest"`                  // 当前线上最新版本号
	MinSupported string `json:"min_supported,omitempty"` // 低于此版本应强制更新（可选）
	URL          string `json:"url,omitempty"`           // 更新/下载地址（可选）
	Notes        string `json:"notes,omitempty"`         // 更新说明（可选）
}

type VersionHandler struct {
	info VersionInfo
}

func NewVersionHandler(latest, minSupported, url, notes string) *VersionHandler {
	return &VersionHandler{info: VersionInfo{
		Latest:       latest,
		MinSupported: minSupported,
		URL:          url,
		Notes:        notes,
	}}
}

// GET /api/version 公开接口：返回线上最新版本，供前端对比提示更新
func (h *VersionHandler) Get(c *gin.Context) {
	c.JSON(http.StatusOK, h.info)
}
