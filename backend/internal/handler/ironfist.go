package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/middleware"
	"e2eechat/internal/service"
	"e2eechat/internal/ws"
)

type IronFistHandler struct {
	svc *service.IronFistService
	hub *ws.Hub
}

func NewIronFistHandler(svc *service.IronFistService, hub *ws.Hub) *IronFistHandler {
	return &IronFistHandler{svc: svc, hub: hub}
}

// GET /api/games/ironfist/stats
// Returns current user battle statistics and unlocked achievements
func (h *IronFistHandler) GetStats(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	view, err := h.svc.GetStats(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get stats"})
		return
	}
	c.JSON(http.StatusOK, view)
}

// POST /api/games/ironfist/stats
// Report game results (win/lose/draw/doubleLose), update statistics and determine achievement unlocks
// Return to updated statistics + newly unlocked achievements this time
func (h *IronFistHandler) ReportMatch(c *gin.Context) {
	c.JSON(http.StatusUpgradeRequired, gin.H{"error": "upgrade_required"})
}

func (h *IronFistHandler) StartPVESession(c *gin.Context) {
	var body struct {
		Replace bool `json:"replace"`
	}
	if err := decodeStrictAuthorityJSON(c.Request.Body, &body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}
	view, err := h.svc.StartRewardedPVE(c.Request.Context(), c.GetUint64(middleware.CtxUserID), body.Replace)
	if err != nil {
		writeAuthorityError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func (h *IronFistHandler) GetActivePVESession(c *gin.Context) {
	view, err := h.svc.GetActiveRewardedPVE(c.Request.Context(), c.GetUint64(middleware.CtxUserID))
	if err != nil {
		writeAuthorityError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func (h *IronFistHandler) GetAuthoritativeGame(c *gin.Context) {
	view, err := h.svc.GetAuthoritativeGame(c.Request.Context(), c.GetUint64(middleware.CtxUserID), c.Param("id"))
	if err != nil {
		writeAuthorityError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func (h *IronFistHandler) SubmitAuthoritativeAction(c *gin.Context) {
	var command service.ActionCommand
	if err := decodeStrictAuthorityJSON(c.Request.Body, &command); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}
	view, err := h.svc.SubmitAuthoritativeAction(c.Request.Context(), c.GetUint64(middleware.CtxUserID), c.Param("id"), command)
	if err != nil {
		writeAuthorityError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func (h *IronFistHandler) ResignAuthoritativeGame(c *gin.Context) {
	view, err := h.svc.ResignAuthoritativeGame(c.Request.Context(), c.GetUint64(middleware.CtxUserID), c.Param("id"))
	if err != nil {
		writeAuthorityError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func decodeStrictAuthorityJSON(reader io.Reader, destination any) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}

func authorityHTTPStatus(err error) int {
	var authorityErr *service.AuthorityError
	if !errors.As(err, &authorityErr) {
		return http.StatusInternalServerError
	}
	switch authorityErr.Code {
	case "invalid_action", "invalid_request_id", "invalid_participants":
		return http.StatusBadRequest
	case "forbidden":
		return http.StatusForbidden
	case "not_found":
		return http.StatusNotFound
	case "action_locked", "stale_state", "game_finished":
		return http.StatusConflict
	case "session_expired":
		return http.StatusGone
	default:
		return http.StatusInternalServerError
	}
}

func writeAuthorityError(c *gin.Context, err error) {
	var authorityErr *service.AuthorityError
	if errors.As(err, &authorityErr) {
		c.JSON(authorityHTTPStatus(err), gin.H{"error": authorityErr.Code})
		return
	}
	log.Printf("[ironfist] authority request failed")
	c.JSON(http.StatusInternalServerError, gin.H{"error": "internal_error"})
}

// GET /api/games/ironfist/matches?before_id=xxx&limit=20
// Game-by-game battle details, cursor paging, latest first
func (h *IronFistHandler) ListMatches(c *gin.Context) {
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

	matches, err := h.svc.ListMatches(c.Request.Context(), userID, beforeID, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list matches"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"matches": matches})
}

// POST /api/games/ironfist/pvp/queue  body: { "tier": "gold" | "platinum" | "diamond" }
// Join the PVP matchmaking queue. Returns queued (queued, waiting for matching) or matched (matched immediately, including room number and opponent file).
func (h *IronFistHandler) EnqueuePVP(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	chatID := c.GetString(middleware.CtxChatID)

	var body struct {
		Tier string `json:"tier" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "tier is required"})
		return
	}
	res, err := h.svc.EnqueuePVP(c.Request.Context(), userID, chatID, body.Tier)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrPVPInvalidTier):
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid tier"})
		case errors.Is(err, service.ErrPVPInsufficientFist):
			c.JSON(http.StatusPaymentRequired, gin.H{"error": "insufficient points balance"})
		case errors.Is(err, service.ErrPVPAlreadyInMatch):
			c.JSON(http.StatusConflict, gin.H{"error": "already in an active pvp match"})
		default:
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		}
		return
	}
	// Immediate matching is successful: notify the waiting party (player A) to switch to the battle page
	if res.Status == "matched" && res.Waiting != "" {
		// The opponent profile pushed to A is information about the caller (player B)
		oppProfile, _ := h.svc.GetLobbyUserProfile(c.Request.Context(), chatID)
		if oppProfile == nil {
			oppProfile = &service.LobbyUserProfile{ChatID: chatID}
		}
		h.hub.NotifyPVPMatched(res.Waiting, gin.H{
			"room_id":  res.RoomID,
			"game_id":  res.GameID,
			"opponent": oppProfile,
			"tier":     res.Tier,
			"stake":    res.Stake,
		})
	}
	c.JSON(http.StatusOK, res)
}

// DELETE /api/games/ironfist/pvp/queue
// Actively cancel matching (still in the process of matching). Matched/settled rooms will not be affected and the call is idempotent.
func (h *IronFistHandler) CancelPVPQueue(c *gin.Context) {
	chatID := c.GetString(middleware.CtxChatID)
	_, err := h.svc.CancelPVPQueue(c.Request.Context(), chatID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// GET /api/games/ironfist/pvp/queue
// Query the current matching queue status. The waiting party (player A) polls this interface to discover the matching result when the WS notification is lost.
func (h *IronFistHandler) GetPVPQueueStatus(c *gin.Context) {
	userID := c.GetUint64(middleware.CtxUserID)
	res, err := h.svc.GetPVPQueueStatus(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}
