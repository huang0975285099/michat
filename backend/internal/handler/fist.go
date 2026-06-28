package handler

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/middleware"
	"e2eechat/internal/model"
	"e2eechat/internal/service"
)

type FistHandler struct {
	svc *service.FistService
}

func NewFistHandler(svc *service.FistService) *FistHandler {
	return &FistHandler{svc: svc}
}

// GET /api/fist/account
// 返回当前余额、历史累计收入、今日 PvE 进度
func (h *FistHandler) GetAccount(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	view, err := h.svc.GetAccount(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get account"})
		return
	}
	c.JSON(http.StatusOK, view)
}

// POST /api/fist/pve-reward
// 玩家赢得一局 PvE 后调用，发放 500 $FIST，每日最多 10 次
// 返回: 更新后的账户状态（同 GetAccount）
func (h *FistHandler) ClaimPvEReward(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	view, err := h.svc.ClaimPvEReward(c.Request.Context(), userID)
	if err != nil {
		if errors.Is(err, service.ErrPvEDailyLimitReached) {
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error":     "daily PvE win limit reached",
				"today_max": service.PvEDailyMaxWins,
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "claim failed"})
		return
	}
	c.JSON(http.StatusOK, view)
}

// GET /api/fist/transactions?before_id=xxx&limit=20
// 游标分页查询流水明细，最新在前
// before_id 为上一页最后一条的 id，首次不传
func (h *FistHandler) GetTransactions(c *gin.Context) {
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

	txs, err := h.svc.GetTransactions(c.Request.Context(), userID, beforeID, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get transactions"})
		return
	}
	if txs == nil {
		txs = make([]*model.FistTransaction, 0) // 返回 [] 而非 null
	}
	c.JSON(http.StatusOK, gin.H{"transactions": txs})
}
