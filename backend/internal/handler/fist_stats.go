package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/service"
)

// FistStatsHandler aggregates public transparency statistics of PvE issuance + PvP treasury/destroy,
// For display on the $FIST introduction page of the international station, no authentication is required.
type FistStatsHandler struct {
	fistSvc     *service.FistService
	ironFistSvc *service.IronFistService
}

func NewFistStatsHandler(fistSvc *service.FistService, ironFistSvc *service.IronFistService) *FistStatsHandler {
	return &FistStatsHandler{fistSvc: fistSvc, ironFistSvc: ironFistSvc}
}

// GET /api/fist/stats
// Public read-only: current circulation volume/number of players, PvE history and distribution trends in the past 30 days, PvP treasury and destruction revenue trends in the past 30 days.
// All data is aggregated across users and does not contain any identifiable information about individual users.
func (h *FistStatsHandler) GetStats(c *gin.Context) {
	ctx := c.Request.Context()

	overview, err := h.fistSvc.GetEcosystemStats(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get ecosystem stats"})
		return
	}
	treasury, err := h.ironFistSvc.GetTreasuryStats(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get treasury stats"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"overview": overview,
		"treasury": treasury,
	})
}
