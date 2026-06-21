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

type FriendHandler struct {
	svc *service.FriendService
	hub *ws.Hub
}

func NewFriendHandler(svc *service.FriendService, hub *ws.Hub) *FriendHandler {
	return &FriendHandler{svc: svc, hub: hub}
}

// POST /api/friends/request
// Body: { "to_chat_id": "XXXXXXXX" }
func (h *FriendHandler) SendRequest(c *gin.Context) {
	fromUserID := c.GetUint64(middleware.CtxUserID)
	fromChatID := c.GetString(middleware.CtxChatID)

	var body struct {
		ToChatID string `json:"to_chat_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "to_chat_id is required"})
		return
	}

	_, toID, err := h.svc.GetUserIDByChatID(c.Request.Context(), body.ToChatID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}

	if err = h.svc.SendRequest(c.Request.Context(), fromUserID, toID); err != nil {
		switch {
		case errors.Is(err, service.ErrCannotAddSelf):
			c.JSON(http.StatusBadRequest, gin.H{"error": "cannot add yourself"})
		case errors.Is(err, service.ErrAlreadyFriends):
			c.JSON(http.StatusConflict, gin.H{"error": "already friends"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}

	// 实时推送给对方（若在线）
	h.hub.NotifyFriendRequest(body.ToChatID, fromChatID)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /api/friends/requests
func (h *FriendHandler) GetRequests(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	requests, err := h.svc.GetIncomingRequests(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if requests == nil {
		requests = []*service.FriendRequestView{}
	}
	c.JSON(http.StatusOK, requests)
}

// GET /api/friends/outgoing
func (h *FriendHandler) GetOutgoing(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	requests, err := h.svc.GetOutgoingRequests(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if requests == nil {
		requests = []*service.OutgoingRequestView{}
	}
	c.JSON(http.StatusOK, requests)
}

// PUT /api/friends/request/:id
// Body: { "accept": true }
func (h *FriendHandler) HandleRequest(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	reqID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request id"})
		return
	}
	var body struct {
		Accept bool `json:"accept"`
	}
	if err = c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	fromChatID, err := h.svc.HandleRequest(c.Request.Context(), reqID, userID, body.Accept)
	if err != nil {
		if errors.Is(err, service.ErrRequestNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "request not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// 实时通知发起方
	if body.Accept {
		h.hub.NotifyFriendAccepted(fromChatID)
	} else {
		h.hub.NotifyFriendRejected(fromChatID)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DELETE /api/friends/request/:id
func (h *FriendHandler) CancelRequest(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	reqID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request id"})
		return
	}
	if err = h.svc.CancelRequest(c.Request.Context(), reqID, userID); err != nil {
		if errors.Is(err, service.ErrRequestNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "request not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /api/friends
func (h *FriendHandler) GetFriends(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	friends, err := h.svc.GetFriends(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if friends == nil {
		friends = []*service.FriendView{}
	}
	c.JSON(http.StatusOK, friends)
}
