package handler

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

type DeviceHandler struct {
	db *sql.DB
}

func NewDeviceHandler(db *sql.DB) *DeviceHandler {
	return &DeviceHandler{db: db}
}

// SaveToken registers or updates device push token (Aurora Registration ID)
// POST /api/device/token
func (h *DeviceHandler) SaveToken(c *gin.Context) {
	chatID := c.GetString("chat_id")
	var req struct {
		RegID string `json:"reg_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "reg_id required"})
		return
	}
	_, err := h.db.ExecContext(c.Request.Context(),
		`INSERT INTO device_tokens (chat_id, reg_id) VALUES (?, ?)
		 ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP`,
		chatID, req.RegID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "db error"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DeleteTokens deletes all device tokens of this account when logging out
// DELETE /api/device/token
func (h *DeviceHandler) DeleteTokens(c *gin.Context) {
	chatID := c.GetString("chat_id")
	_, err := h.db.ExecContext(c.Request.Context(),
		`DELETE FROM device_tokens WHERE chat_id = ?`, chatID,
	)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "db error"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
