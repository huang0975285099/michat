package handler

import (
	"e2eechat/internal/middleware"
	"e2eechat/internal/service"
	"github.com/gin-gonic/gin"
	"net/http"
	"strings"
)

func (h *GroupHandler) RecordReads(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 900000)
	var body struct {
		Receipts []service.GroupReadProof `json:"receipts"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid receipts"})
		return
	}
	accepted, err := h.svc.RecordGroupReads(c.Request.Context(), c.Param("groupId"), c.GetString(middleware.CtxChatID), body.Receipts)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to record group reads"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"msg_ids": accepted})
}

func (h *GroupHandler) GetReads(c *gin.Context) {
	receipts, err := h.svc.GetGroupReads(c.Request.Context(), c.Param("groupId"), c.GetString(middleware.CtxChatID), strings.Split(c.Query("msg_ids"), ","))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to get group reads"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"receipts": receipts})
}
