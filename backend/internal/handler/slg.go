package handler

import (
	"errors"
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
// 世界满员时返回 403 {error:"world_full"}。
func (h *SlgHandler) Join(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	chatID := c.GetString(middleware.CtxChatID)
	nickname := c.GetString(middleware.CtxNickname)

	result, err := h.svc.Join(c.Request.Context(), userID, chatID, nickname)
	if err != nil {
		if errors.Is(err, service.ErrWorldFull) {
			c.JSON(http.StatusForbidden, gin.H{"error": "world_full"})
			return
		}
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

	marches, err := h.svc.GetActiveMarches(c.Request.Context(), w.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"world_id":       w.ID,
		"seed":           w.Seed,
		"season":         w.Season,
		"territories":    territories,
		"players":        players,
		"active_marches": marches,
	})
}

// GET /api/games/slg/status
// 查询世界状态（玩家数/是否已满），供前端入口判断是否可进入
func (h *SlgHandler) GetStatus(c *gin.Context) {
	count, full, err := h.svc.GetWorldStatus(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"player_count": count,
		"max_players":  5,
		"full":         full,
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
		switch {
		case errors.Is(err, service.ErrTileOwnedByOther):
			c.JSON(http.StatusForbidden, gin.H{"error": "tile_owned_by_other"})
		case errors.Is(err, service.ErrNotAdjacent):
			c.JSON(http.StatusBadRequest, gin.H{"error": "not_adjacent"})
		case errors.Is(err, service.ErrInvalidClaim):
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_claim"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}

	// 通过 WS 广播给同世界在线玩家（含自己）
	h.hub.BroadcastSLGEvent(chatID, ev)

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/games/slg/march
// 出征/行军开始上报：落库存证 + 广播给同世界在线玩家，供他人渲染/碰撞检测。
func (h *SlgHandler) StartMarch(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	chatID := c.GetString(middleware.CtxChatID)
	nickname := c.GetString(middleware.CtxNickname)

	var req service.MarchStartRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	ev, err := h.svc.StartMarch(c.Request.Context(), userID, chatID, nickname, &req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.hub.BroadcastSLGMarchEvent(chatID, ev)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/games/slg/march/end
// 行军结束上报（到达/驻扎/召回/被消灭后清理）。
func (h *SlgHandler) EndMarch(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	chatID := c.GetString(middleware.CtxChatID)

	var req service.MarchEndRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	ev, err := h.svc.EndMarch(c.Request.Context(), userID, chatID, &req)
	if err != nil {
		if errors.Is(err, service.ErrMarchNotFound) {
			// march 可能已被对方在碰撞战斗中标记 done，或从未成功上报过 start，均无需报错阻塞客户端
			c.JSON(http.StatusOK, gin.H{"ok": true})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.hub.BroadcastSLGMarchEvent(chatID, ev)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/games/slg/march/battle
// 玩家部队碰撞遭遇战结果上报（战斗本身已由客户端用 resolveBattle 确定性算出）。
func (h *SlgHandler) ReportMarchBattle(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	chatID := c.GetString(middleware.CtxChatID)

	var req service.MarchBattleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request"})
		return
	}
	ev, err := h.svc.ReportMarchBattle(c.Request.Context(), userID, chatID, &req)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrMarchAlreadyResolved):
			// 对方已先一步上报同一场战斗：不是错误，静默跳过（避免重复广播）
			c.JSON(http.StatusOK, gin.H{"ok": true, "already_resolved": true})
		case errors.Is(err, service.ErrMarchNotOwner):
			c.JSON(http.StatusForbidden, gin.H{"error": "not_owner"})
		case errors.Is(err, service.ErrMarchNotFound):
			c.JSON(http.StatusNotFound, gin.H{"error": "march_not_found"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}
	h.hub.BroadcastSLGMarchEvent(chatID, ev)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/games/slg/reset
// 管理员重置当前世界（标记 ended + 清空玩家/领地，下次 Join 创建新世界）
func (h *SlgHandler) ResetWorld(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	if err := h.svc.ResetWorld(c.Request.Context(), userID); err != nil {
		if errors.Is(err, service.ErrNotAdmin) {
			c.JSON(http.StatusForbidden, gin.H{"error": "not admin"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
