package handler

import (
	"net/http"
	"regexp"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/middleware"
	"e2eechat/internal/service"
)

var peerChatIDRe = regexp.MustCompile(`^\d{4}-[A-Z]{4}$`)

type MessagesHandler struct {
	readSvc *service.MessageReadService
}

func NewMessagesHandler(readSvc *service.MessageReadService) *MessagesHandler {
	return &MessagesHandler{readSvc: readSvc}
}

// GET /api/friends/:peerId/read-receipts
// 返回好友 peerId 已读的、由当前用户发送的消息 ID 列表
// 用于补偿发送方离线时错过的已读回执
func (h *MessagesHandler) GetReadReceipts(c *gin.Context) {
	myChatID := c.GetString(middleware.CtxChatID)
	peerChatID := c.Param("peerId")

	if !peerChatIDRe.MatchString(peerChatID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid peer id"})
		return
	}
	if peerChatID == myChatID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid peer id"})
		return
	}

	ids, err := h.readSvc.GetReadReceiptsByPeer(c.Request.Context(), myChatID, peerChatID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "query failed"})
		return
	}
	if ids == nil {
		ids = []string{}
	}
	c.JSON(http.StatusOK, gin.H{"msg_ids": ids})
}
