package handler

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"e2eechat/internal/middleware"
	"e2eechat/internal/service"
)

type attachmentAPIMock struct {
	initCalled bool
	putCalled  bool
	initErr    error
	putErr     error
	getErr     error
	download   service.AttachmentChunkDownload
}

func (m *attachmentAPIMock) MaxEncryptedChunkBytes() int64 { return 2*1024*1024 + 16 }
func (m *attachmentAPIMock) Quota(_ context.Context, _ uint64) (service.AttachmentQuotaView, error) {
	return service.AttachmentQuotaView{UsedBytes: 10, LimitBytes: 100, RemainingBytes: 90}, m.getErr
}

func (m *attachmentAPIMock) Init(_ context.Context, _ uint64, _ string, _, _, _ int64, _ int) (service.AttachmentView, error) {
	m.initCalled = true
	return service.AttachmentView{ID: "12345678-1234-4234-9234-123456789abc", Status: "uploading"}, m.initErr
}

func (m *attachmentAPIMock) PutChunk(_ context.Context, _ uint64, _ string, index int, hash string, src io.Reader) (service.AttachmentChunkResult, error) {
	m.putCalled = true
	data, _ := io.ReadAll(src)
	return service.AttachmentChunkResult{Index: index, Size: int64(len(data)), SHA256: hash}, m.putErr
}

func (m *attachmentAPIMock) Get(_ context.Context, _ uint64, _ string) (service.AttachmentView, error) {
	return service.AttachmentView{Status: "available"}, m.getErr
}

func (m *attachmentAPIMock) Complete(_ context.Context, _ uint64, _ string) (service.AttachmentView, error) {
	return service.AttachmentView{Status: "available"}, nil
}

func (m *attachmentAPIMock) DownloadChunk(_ context.Context, _ uint64, _ string, _ int) (service.AttachmentChunkDownload, error) {
	return m.download, m.getErr
}

func (m *attachmentAPIMock) Acknowledge(_ context.Context, _ uint64, _ string) error { return m.getErr }
func (m *attachmentAPIMock) Cancel(_ context.Context, _ uint64, _ string) error      { return m.getErr }

func attachmentTestContext(method, target string, body io.Reader) (*gin.Context, *httptest.ResponseRecorder) {
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	context.Request = httptest.NewRequest(method, target, body)
	context.Set(middleware.CtxUserID, uint64(7))
	return context, recorder
}

func TestAttachmentInitRejectsFileKeysAndPlaintextMetadata(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mock := &attachmentAPIMock{}
	handler := NewAttachmentHandler(mock)
	body := `{"recipient_chat_id":"1234-ABCD","file_size":10,"ciphertext_size":26,"chunk_size":10,"chunk_count":1,"file_key":"must-not-reach-server"}`
	context, recorder := attachmentTestContext(http.MethodPost, "/api/attachments", strings.NewReader(body))
	context.Request.Header.Set("Content-Type", "application/json")

	handler.Init(context)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
	if mock.initCalled {
		t.Fatal("attachment service received forbidden plaintext metadata")
	}
}

func TestAttachmentInitAcceptsOnlyOpaqueOperationalMetadata(t *testing.T) {
	mock := &attachmentAPIMock{}
	handler := NewAttachmentHandler(mock)
	body := `{"recipient_chat_id":"1234-ABCD","file_size":1048576,"ciphertext_size":1048592,"chunk_size":1048576,"chunk_count":1}`
	context, recorder := attachmentTestContext(http.MethodPost, "/api/attachments", strings.NewReader(body))
	context.Request.Header.Set("Content-Type", "application/json")

	handler.Init(context)

	if recorder.Code != http.StatusCreated || !mock.initCalled {
		t.Fatalf("status = %d, init called = %v", recorder.Code, mock.initCalled)
	}
}

func TestAttachmentChunkRequiresBinaryContentAndChecksum(t *testing.T) {
	mock := &attachmentAPIMock{}
	handler := NewAttachmentHandler(mock)
	context, recorder := attachmentTestContext(http.MethodPut, "/api/attachments/id/chunks/0", bytes.NewReader([]byte("ciphertext")))
	context.Params = gin.Params{{Key: "id", Value: "12345678-1234-4234-9234-123456789abc"}, {Key: "index", Value: "0"}}

	handler.PutChunk(context)

	if recorder.Code != http.StatusUnsupportedMediaType || mock.putCalled {
		t.Fatalf("status = %d, put called = %v", recorder.Code, mock.putCalled)
	}

	context, recorder = attachmentTestContext(http.MethodPut, "/api/attachments/id/chunks/0", bytes.NewReader([]byte("ciphertext")))
	context.Params = gin.Params{{Key: "id", Value: "12345678-1234-4234-9234-123456789abc"}, {Key: "index", Value: "0"}}
	context.Request.Header.Set("Content-Type", "application/octet-stream")
	context.Request.Header.Set("X-Chunk-SHA256", strings.Repeat("a", 64))
	handler.PutChunk(context)
	if recorder.Code != http.StatusOK || !mock.putCalled {
		t.Fatalf("status = %d, put called = %v", recorder.Code, mock.putCalled)
	}
}

func TestAttachmentDownloadIsNoStoreAndReturnsIntegrityHeader(t *testing.T) {
	mock := &attachmentAPIMock{download: service.AttachmentChunkDownload{
		Reader: io.NopCloser(strings.NewReader("opaque")), Size: 6, SHA256: strings.Repeat("b", 64),
	}}
	handler := NewAttachmentHandler(mock)
	context, recorder := attachmentTestContext(http.MethodGet, "/api/attachments/id/chunks/2", nil)
	context.Params = gin.Params{{Key: "id", Value: "12345678-1234-4234-9234-123456789abc"}, {Key: "index", Value: "2"}}

	handler.DownloadChunk(context)

	if recorder.Code != http.StatusOK || recorder.Body.String() != "opaque" {
		t.Fatalf("status = %d, body = %q", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Cache-Control") != "private, no-store" || recorder.Header().Get("X-Chunk-SHA256") != strings.Repeat("b", 64) {
		t.Fatalf("download headers = %#v", recorder.Header())
	}
}

func TestAttachmentErrorsDoNotRevealExistence(t *testing.T) {
	mock := &attachmentAPIMock{getErr: service.ErrAttachmentForbidden}
	handler := NewAttachmentHandler(mock)
	context, recorder := attachmentTestContext(http.MethodGet, "/api/attachments/secret", nil)
	context.Params = gin.Params{{Key: "id", Value: "secret"}}
	handler.Get(context)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNotFound)
	}
}

func TestAttachmentQuotaIsPrivateAndNoStore(t *testing.T) {
	mock := &attachmentAPIMock{}
	handler := NewAttachmentHandler(mock)
	context, recorder := attachmentTestContext(http.MethodGet, "/api/attachments/quota", nil)
	handler.Quota(context)
	if recorder.Code != http.StatusOK || recorder.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("status = %d, headers = %#v", recorder.Code, recorder.Header())
	}
	if !strings.Contains(recorder.Body.String(), `"remaining_bytes":90`) {
		t.Fatalf("quota response = %s", recorder.Body.String())
	}
}
