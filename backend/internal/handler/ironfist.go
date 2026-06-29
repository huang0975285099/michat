package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/middleware"
	"e2eechat/internal/service"
	"e2eechat/internal/ws"
)

type IronFistHandler struct {
	svc *service.IronFistService
	hub *ws.Hub
}

func NewIronFistHandler(svc *service.IronFistService, hub *ws.Hub) *IronFistHandler {
	return &IronFistHandler{svc: svc, hub: hub}
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

// POST /api/games/ironfist/pvp/queue  body: { "tier": "gold" | "platinum" | "diamond" }
// 加入 PVP 撮合队列。返回 queued（已入队，等待匹配）或 matched（立即匹配成功，含房间号与对手档案）。
func (h *IronFistHandler) EnqueuePVP(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	chatID := c.GetString(middleware.CtxChatID)

	var body struct {
		Tier string `json:"tier" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "tier is required"})
		return
	}
	res, err := h.svc.EnqueuePVP(c.Request.Context(), userID, chatID, body.Tier)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrPVPInvalidTier):
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tier"})
		case errors.Is(err, service.ErrPVPInsufficientFist):
			c.JSON(http.StatusPaymentRequired, gin.H{"error": "insufficient $FIST balance"})
		case errors.Is(err, service.ErrPVPAlreadyInMatch):
			c.JSON(http.StatusConflict, gin.H{"error": "already in an active pvp match"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}
	// 立即匹配成功：通知等待方（玩家 A）切到对战页面
	if res.Status == "matched" && res.Waiting != "" {
		// 推送给 A 的对手档案为本调用方（玩家 B）的信息
		oppProfile, _ := h.svc.GetLobbyUserProfile(c.Request.Context(), chatID)
		if oppProfile == nil {
			oppProfile = &service.LobbyUserProfile{ChatID: chatID}
		}
		h.hub.NotifyPVPMatched(res.Waiting, gin.H{
			"room_id":  res.RoomID,
			"opponent": oppProfile,
			"tier":     res.Tier,
			"stake":    res.Stake,
		})
	}
	c.JSON(http.StatusOK, res)
}

// DELETE /api/games/ironfist/pvp/queue
// 主动取消撮合（仍在匹配中）。已匹配/已结算的房间不会受影响，调用幂等。
func (h *IronFistHandler) CancelPVPQueue(c *gin.Context) {
	chatID := c.GetString(middleware.CtxChatID)
	_, err := h.svc.CancelPVPQueue(c.Request.Context(), chatID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /api/games/ironfist/pvp/queue
// 查询当前撮合队列状态。等待方（玩家 A）在 WS 通知丢失时轮询此接口兜底发现匹配结果。
func (h *IronFistHandler) GetPVPQueueStatus(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	res, err := h.svc.GetPVPQueueStatus(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}
