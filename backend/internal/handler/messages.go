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
// Returns the list of message IDs sent by the current user that have been read by friend peerId
// Used to compensate for missed read receipts when the sender is offline
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

	receipts, err := h.readSvc.GetReadReceiptsByPeer(c.Request.Context(), myChatID, peerChatID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "query failed"})
		return
	}
	if receipts == nil {
		receipts = []service.ReadReceipt{}
	}
	// msg_ids are retained for a release cycle and are compatible with clients that have not yet upgraded to the authoritative read_at protocol.
	ids := make([]string, 0, len(receipts))
	for _, receipt := range receipts {
		ids = append(ids, receipt.MsgID)
	}
	c.JSON(http.StatusOK, gin.H{"receipts": receipts, "msg_ids": ids})
}
