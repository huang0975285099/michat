package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/middleware"
	"e2eechat/internal/service"
)

type attachmentAPI interface {
	MaxEncryptedChunkBytes() int64
	Quota(ctx context.Context, ownerUserID uint64) (service.AttachmentQuotaView, error)
	Init(ctx context.Context, ownerUserID uint64, recipientChatID string, fileSize, ciphertextSize, chunkSize int64, chunkCount int) (service.AttachmentView, error)
	PutChunk(ctx context.Context, ownerUserID uint64, id string, index int, expectedSHA256 string, src io.Reader) (service.AttachmentChunkResult, error)
	Get(ctx context.Context, userID uint64, id string) (service.AttachmentView, error)
	Complete(ctx context.Context, ownerUserID uint64, id string) (service.AttachmentView, error)
	DownloadChunk(ctx context.Context, recipientUserID uint64, id string, index int) (service.AttachmentChunkDownload, error)
	Acknowledge(ctx context.Context, recipientUserID uint64, id string) error
	Cancel(ctx context.Context, ownerUserID uint64, id string) error
}

func (h *AttachmentHandler) Quota(c *gin.Context) {
	view, err := h.service.Quota(c.Request.Context(), attachmentUserID(c))
	if err != nil {
		writeAttachmentError(c, err)
		return
	}
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, view)
}

type AttachmentHandler struct {
	service attachmentAPI
}

func NewAttachmentHandler(attachmentService attachmentAPI) *AttachmentHandler {
	return &AttachmentHandler{service: attachmentService}
}

func attachmentUserID(c *gin.Context) uint64 {
	value, _ := c.Get(middleware.CtxUserID)
	userID, _ := value.(uint64)
	return userID
}

func writeAttachmentError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrAttachmentNotFound), errors.Is(err, service.ErrAttachmentForbidden), errors.Is(err, service.ErrChunkNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "attachment not found"})
	case errors.Is(err, service.ErrAttachmentExpired):
		c.JSON(http.StatusGone, gin.H{"error": "attachment expired", "code": "attachment_expired"})
	case errors.Is(err, service.ErrAttachmentQuota):
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error(), "code": "attachment_quota_exceeded"})
	case errors.Is(err, service.ErrChunkTooLarge):
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
	case errors.Is(err, service.ErrAttachmentState), errors.Is(err, service.ErrAttachmentIncomplete), errors.Is(err, service.ErrChunkConflict):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	case errors.Is(err, service.ErrAttachmentInvalid), errors.Is(err, service.ErrChunkChecksum), errors.Is(err, service.ErrInvalidChunkSize), errors.Is(err, service.ErrInvalidAttachmentID):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": "attachment operation failed"})
	}
}

// Init creates an opaque upload slot. No filename, MIME type or file key is accepted.
func (h *AttachmentHandler) Init(c *gin.Context) {
	var request struct {
		RecipientChatID string `json:"recipient_chat_id" binding:"required"`
		FileSize        int64  `json:"file_size" binding:"required"`
		CiphertextSize  int64  `json:"ciphertext_size" binding:"required"`
		ChunkSize       int64  `json:"chunk_size" binding:"required"`
		ChunkCount      int    `json:"chunk_count" binding:"required"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || !peerChatIDRe.MatchString(request.RecipientChatID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid attachment metadata"})
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid attachment metadata"})
		return
	}
	view, err := h.service.Init(
		c.Request.Context(), attachmentUserID(c), request.RecipientChatID,
		request.FileSize, request.CiphertextSize, request.ChunkSize, request.ChunkCount,
	)
	if err != nil {
		writeAttachmentError(c, err)
		return
	}
	c.JSON(http.StatusCreated, view)
}

func parseChunkIndex(c *gin.Context) (int, bool) {
	index, err := strconv.Atoi(c.Param("index"))
	if err != nil || index < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid chunk index"})
		return 0, false
	}
	return index, true
}

// PutChunk accepts exactly one already-encrypted AES-GCM chunk.
func (h *AttachmentHandler) PutChunk(c *gin.Context) {
	index, ok := parseChunkIndex(c)
	if !ok {
		return
	}
	if contentType := strings.ToLower(strings.TrimSpace(strings.Split(c.GetHeader("Content-Type"), ";")[0])); contentType != "application/octet-stream" {
		c.JSON(http.StatusUnsupportedMediaType, gin.H{"error": "encrypted chunks require application/octet-stream"})
		return
	}
	expectedSHA256 := strings.ToLower(strings.TrimSpace(c.GetHeader("X-Chunk-SHA256")))
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, h.service.MaxEncryptedChunkBytes()+1)
	result, err := h.service.PutChunk(c.Request.Context(), attachmentUserID(c), c.Param("id"), index, expectedSHA256, c.Request.Body)
	if err != nil {
		writeAttachmentError(c, err)
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *AttachmentHandler) Get(c *gin.Context) {
	view, err := h.service.Get(c.Request.Context(), attachmentUserID(c), c.Param("id"))
	if err != nil {
		writeAttachmentError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func (h *AttachmentHandler) Complete(c *gin.Context) {
	view, err := h.service.Complete(c.Request.Context(), attachmentUserID(c), c.Param("id"))
	if err != nil {
		writeAttachmentError(c, err)
		return
	}
	c.JSON(http.StatusOK, view)
}

func (h *AttachmentHandler) DownloadChunk(c *gin.Context) {
	index, ok := parseChunkIndex(c)
	if !ok {
		return
	}
	chunk, err := h.service.DownloadChunk(c.Request.Context(), attachmentUserID(c), c.Param("id"), index)
	if err != nil {
		writeAttachmentError(c, err)
		return
	}
	defer chunk.Reader.Close()
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Chunk-SHA256", chunk.SHA256)
	c.DataFromReader(http.StatusOK, chunk.Size, "application/octet-stream", chunk.Reader, nil)
}

func (h *AttachmentHandler) Acknowledge(c *gin.Context) {
	if err := h.service.Acknowledge(c.Request.Context(), attachmentUserID(c), c.Param("id")); err != nil {
		writeAttachmentError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "ciphertext_deleted": true})
}

func (h *AttachmentHandler) Cancel(c *gin.Context) {
	if err := h.service.Cancel(c.Request.Context(), attachmentUserID(c), c.Param("id")); err != nil {
		writeAttachmentError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "ciphertext_deleted": true})
}
