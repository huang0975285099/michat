package handler

import (
	_ "embed"
	"net/http"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/service"
)

//go:embed admin.html
var adminPageHTML string

// AdminHandler serves the operator dashboard: one static HTML page plus the
// aggregate JSON it renders. Both sit behind Auth + AdminOnly.
type AdminHandler struct {
	adminSvc *service.AdminService
}

func NewAdminHandler(adminSvc *service.AdminService) *AdminHandler {
	return &AdminHandler{adminSvc: adminSvc}
}

// GET /admin
// The page itself carries no data — it asks for a session token, then fetches
// /api/admin/stats. Serving it unauthenticated is deliberate: there is nothing
// on it to leak, and gating it would mean putting a token in the URL.
func (h *AdminHandler) Page(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(adminPageHTML))
}

// GET /api/admin/stats
func (h *AdminHandler) GetStats(c *gin.Context) {
	stats, err := h.adminSvc.GetStats(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to collect stats"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, stats)
}
