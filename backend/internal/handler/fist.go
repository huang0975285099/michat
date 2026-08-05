package handler

import (
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
// Returns current balance, historical accumulated income, and today's PvE progress
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
// Called after the player wins a PvE round, 500 $FIST will be issued, up to 10 times per day
// Returns: updated account status (same as GetAccount)
func (h *FistHandler) ClaimPvEReward(c *gin.Context) {
	c.JSON(http.StatusUpgradeRequired, gin.H{"error": "upgrade_required"})
}

// GET /api/fist/transactions?before_id=xxx&limit=20
// Cursor paging to query the flow details, latest first
// before_id is the id of the last item on the previous page and is not passed for the first time.
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
		txs = make([]*model.FistTransaction, 0) //Return [] instead of null
	}
	c.JSON(http.StatusOK, gin.H{"transactions": txs})
}
