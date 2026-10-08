package handler

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/middleware"
	"e2eechat/internal/service"
)

// GroupHandler exposes the read-only user-facing group API.
type GroupHandler struct {
	svc *service.GroupService
}

func NewGroupHandler(svc *service.GroupService) *GroupHandler {
	return &GroupHandler{svc: svc}
}

// GET /api/groups — my active groups
func (h *GroupHandler) ListMyGroups(c *gin.Context) {
	chatID := c.GetString(middleware.CtxChatID)
	groups, err := h.svc.ListMyGroups(c.Request.Context(), chatID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list groups"})
		return
	}
	if groups == nil {
		groups = []*service.GroupSummary{}
	}
	c.JSON(http.StatusOK, groups)
}

// GET /api/groups/:groupId — group detail (members + public keys)
func (h *GroupHandler) GetGroupDetail(c *gin.Context) {
	chatID := c.GetString(middleware.CtxChatID)
	groupID := c.Param("groupId")
	detail, err := h.svc.GetGroupDetail(c.Request.Context(), groupID, chatID)
	if err != nil {
		if errors.Is(err, service.ErrGroupNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "group not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get group"})
		return
	}
	c.JSON(http.StatusOK, detail)
}

// --- Admin group management ---

// AdminGroupHandler exposes the admin group management API.
type AdminGroupHandler struct {
	svc *service.GroupService
}

func NewAdminGroupHandler(svc *service.GroupService) *AdminGroupHandler {
	return &AdminGroupHandler{svc: svc}
}

// POST /api/admin/groups
func (h *AdminGroupHandler) CreateGroup(c *gin.Context) {
	var body struct {
		Name          string   `json:"name" binding:"required"`
		MemberChatIDs []string `json:"member_chat_ids" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name and member_chat_ids are required"})
		return
	}
	group, err := h.svc.CreateGroup(c.Request.Context(), body.Name, body.MemberChatIDs)
	if err != nil {
		h.mapCreateError(c, err)
		return
	}
	c.JSON(http.StatusOK, group)
}

func (h *AdminGroupHandler) mapCreateError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrTooFewMembers):
		c.JSON(http.StatusBadRequest, gin.H{"error": "at least 2 members required"})
	case errors.Is(err, service.ErrGroupFull):
		c.JSON(http.StatusBadRequest, gin.H{"error": "group is full"})
	case errors.Is(err, service.ErrUserNotReady):
		c.JSON(http.StatusBadRequest, gin.H{"error": "a member has not uploaded a public key"})
	default:
		if strings.Contains(err.Error(), "invalid chat id") || strings.Contains(err.Error(), "user not found") {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create group"})
	}
}

// GET /api/admin/groups
func (h *AdminGroupHandler) ListGroups(c *gin.Context) {
	groups, err := h.svc.ListGroupsWithCounts(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list groups"})
		return
	}
	if groups == nil {
		groups = []*service.GroupSummary{}
	}
	c.JSON(http.StatusOK, groups)
}

// GET /api/admin/groups/:groupId
func (h *AdminGroupHandler) GetGroup(c *gin.Context) {
	groupID := c.Param("groupId")
	detail, err := h.svc.GetAdminGroupDetail(c.Request.Context(), groupID)
	if err != nil {
		if errors.Is(err, service.ErrGroupNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "group not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get group"})
		return
	}
	c.JSON(http.StatusOK, detail)
}

// PUT /api/admin/groups/:groupId — rename
func (h *AdminGroupHandler) RenameGroup(c *gin.Context) {
	groupID := c.Param("groupId")
	var body struct {
		Name string `json:"name" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	if err := h.svc.RenameGroup(c.Request.Context(), groupID, body.Name); err != nil {
		if errors.Is(err, service.ErrGroupNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "group not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// POST /api/admin/groups/:groupId/members
func (h *AdminGroupHandler) AddMembers(c *gin.Context) {
	groupID := c.Param("groupId")
	var body struct {
		ChatIDs []string `json:"chat_ids" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "chat_ids is required"})
		return
	}
	if err := h.svc.AddMembers(c.Request.Context(), groupID, body.ChatIDs); err != nil {
		h.mapMemberError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DELETE /api/admin/groups/:groupId/members/:chatId
func (h *AdminGroupHandler) RemoveMember(c *gin.Context) {
	groupID := c.Param("groupId")
	chatID := c.Param("chatId")
	if err := h.svc.RemoveMember(c.Request.Context(), groupID, chatID); err != nil {
		h.mapMemberError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// PUT /api/admin/groups/:groupId/members/:chatId/mute
func (h *AdminGroupHandler) MuteMember(c *gin.Context) {
	groupID := c.Param("groupId")
	chatID := c.Param("chatId")
	var body struct {
		MutedUntil *string `json:"muted_until"` // RFC3339 or null
	}
	_ = c.ShouldBindJSON(&body)

	var until *time.Time
	if body.MutedUntil != nil && *body.MutedUntil != "" {
		t, err := time.Parse(time.RFC3339, *body.MutedUntil)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid muted_until format"})
			return
		}
		until = &t
	}

	if err := h.svc.MuteMember(c.Request.Context(), groupID, chatID, until); err != nil {
		h.mapMemberError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DELETE /api/admin/groups/:groupId — dissolve
func (h *AdminGroupHandler) DissolveGroup(c *gin.Context) {
	groupID := c.Param("groupId")
	if err := h.svc.DissolveGroup(c.Request.Context(), groupID); err != nil {
		if errors.Is(err, service.ErrGroupNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "group not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to dissolve group"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /api/admin/groups/:groupId/messages — ciphertext metadata only
func (h *AdminGroupHandler) ListMessages(c *gin.Context) {
	groupID := c.Param("groupId")
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	msgs, err := h.svc.ListGroupMessageMetadata(c.Request.Context(), groupID, limit, offset)
	if err != nil {
		if errors.Is(err, service.ErrGroupNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "group not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list messages"})
		return
	}
	if msgs == nil {
		msgs = []*service.GroupMessageMetadata{}
	}
	c.JSON(http.StatusOK, msgs)
}

// DELETE /api/admin/groups/:groupId/messages/:msgId — admin delete
func (h *AdminGroupHandler) DeleteMessage(c *gin.Context) {
	groupID := c.Param("groupId")
	msgID := c.Param("msgId")
	if err := h.svc.DeleteGroupMessage(c.Request.Context(), groupID, msgID); err != nil {
		if errors.Is(err, service.ErrGroupNotFound) || errors.Is(err, service.ErrMessageNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "message not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete message"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *AdminGroupHandler) mapMemberError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrGroupNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "group not found"})
	case errors.Is(err, service.ErrNotGroupMember):
		c.JSON(http.StatusNotFound, gin.H{"error": "member not found"})
	case errors.Is(err, service.ErrGroupFull):
		c.JSON(http.StatusBadRequest, gin.H{"error": "group is full"})
	case errors.Is(err, service.ErrUserNotReady):
		c.JSON(http.StatusBadRequest, gin.H{"error": "user has not uploaded a public key"})
	case errors.Is(err, service.ErrUserNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}
