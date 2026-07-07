package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/middleware"
	"e2eechat/internal/service"
	"e2eechat/internal/ws"
)

type SlgHandler struct {
	svc *service.SlgService
	hub *ws.Hub
}

func NewSlgHandler(svc *service.SlgService, hub *ws.Hub) *SlgHandler {
	return &SlgHandler{svc: svc, hub: hub}
}

// POST /api/games/slg/join
// 加入世界。返回世界种子、出生点、玩家存档与全图领地。
func (h *SlgHandler) Join(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	chatID := c.GetString(middleware.CtxChatID)
	nickname := c.GetString(middleware.CtxNickname)

	result, err := h.svc.Join(c.Request.Context(), userID, chatID, nickname)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, result)
}

// GET /api/games/slg/world
// 获取世界快照（领地列表 + 在线玩家）
func (h *SlgHandler) GetWorld(c *gin.Context) {
	w, err := h.svc.GetActiveWorld(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	territories, err := h.svc.GetTerritories(c.Request.Context(), w.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	players, err := h.svc.GetPlayers(c.Request.Context(), w.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"world_id":    w.ID,
		"seed":        w.Seed,
		"season":      w.Season,
		"territories": territories,
		"players":     players,
	})
}

// PUT /api/games/slg/state
// 保存玩家状态
func (h *SlgHandler) SaveState(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	var req service.SaveStateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if err := h.svc.SaveState(c.Request.Context(), userID, req.State); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/games/slg/territory
// 更新领地归属。服务端记录后通过 WS 广播给同世界在线玩家。
func (h *SlgHandler) UpdateTerritory(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	chatID := c.GetString(middleware.CtxChatID)
	nickname := c.GetString(middleware.CtxNickname)

	var req service.TerritoryUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	if req.Action != "claim" && req.Action != "abandon" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "action must be claim or abandon"})
		return
	}

	ev, err := h.svc.UpdateTerritory(c.Request.Context(), userID, chatID, nickname, &req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// 通过 WS 广播给同世界在线玩家（含自己）
	h.hub.BroadcastSLGEvent(chatID, ev)

	c.JSON(http.StatusOK, gin.H{"ok": true})
}
