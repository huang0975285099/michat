package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/service"
)

// FistStatsHandler 聚合 PvE 发放 + PvP 国库/销毁的公开透明度统计，
// 供国际站 $FIST 介绍页展示，无需鉴权。
type FistStatsHandler struct {
	fistSvc     *service.FistService
	ironFistSvc *service.IronFistService
}

func NewFistStatsHandler(fistSvc *service.FistService, ironFistSvc *service.IronFistService) *FistStatsHandler {
	return &FistStatsHandler{fistSvc: fistSvc, ironFistSvc: ironFistSvc}
}

// GET /api/fist/stats
// 公开只读：当前流通量/玩家数、PvE 历史与近30天发放趋势、PvP 国库与销毁收入近30天趋势。
// 全部为跨用户聚合数据，不含任何单个用户的可识别信息。
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
