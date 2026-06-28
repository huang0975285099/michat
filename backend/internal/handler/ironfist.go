package handler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/middleware"
	"e2eechat/internal/service"
)

type IronFistHandler struct {
	svc *service.IronFistService
}

func NewIronFistHandler(svc *service.IronFistService) *IronFistHandler {
	return &IronFistHandler{svc: svc}
}

// GET /api/games/ironfist/stats
// 返回当前用户对战统计与已解锁成就
func (h *IronFistHandler) GetStats(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	view, err := h.svc.GetStats(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get stats"})
		return
	}
	c.JSON(http.StatusOK, view)
}

// POST /api/games/ironfist/stats
// 上报对局结果（win/lose/draw/doubleLose），更新统计并判定成就解锁
// 返回更新后的统计 + 本次新解锁的成就
func (h *IronFistHandler) ReportMatch(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	var req service.ReportMatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	view, err := h.svc.ReportMatch(c.Request.Context(), userID, &req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, view)
}

// GET /api/games/ironfist/matches?before_id=xxx&limit=20
// 逐局对战明细，游标分页，最新在前
func (h *IronFistHandler) ListMatches(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)

	var beforeID uint64
	if v := c.Query("before_id"); v != "" {
		beforeID, _ = strconv.ParseUint(v, 10, 64)
	}
	limit := 20
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}

	matches, err := h.svc.ListMatches(c.Request.Context(), userID, beforeID, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list matches"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"matches": matches})
}
