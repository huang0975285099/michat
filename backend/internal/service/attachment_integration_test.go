package service

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"reflect"
	"testing"
	"time"

	pkgredis "e2eechat/pkg/redis"
)

func TestAttachmentEncryptedLifecycleWithResumeAcknowledgeAndExpiry(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	ctx := context.Background()
	ownerID := insertAttachmentTestUser(t, db, "8000-OWNR", "owner")
	recipientID := insertAttachmentTestUser(t, db, "8001-RCPT", "recipient")
	strangerID := insertAttachmentTestUser(t, db, "8002-STRG", "stranger")
	if _, err := db.Exec(`INSERT INTO friendships (user_id, friend_id) VALUES (?, ?), (?, ?)`, ownerID, recipientID, recipientID, ownerID); err != nil {
		t.Fatal(err)
	}

	storage, err := NewLocalAttachmentStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	config := DefaultAttachmentConfig()
	clock := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	service := NewAttachmentService(db, storage, config)
	service.now = func() time.Time { return clock }

	const chunkSize int64 = 256 * 1024
	fileSize := 2*chunkSize + 7
	chunkCount := 3
	ciphertextSize := fileSize + attachmentGCMTagBytes*int64(chunkCount)

	if _, err = service.Init(ctx, ownerID, "8002-STRG", fileSize, ciphertextSize, chunkSize, chunkCount); !errors.Is(err, ErrAttachmentForbidden) {
		t.Fatalf("non-friend init error = %v, want forbidden", err)
	}

	initialized, err := service.Init(ctx, ownerID, "8001-RCPT", fileSize, ciphertextSize, chunkSize, chunkCount)
	if err != nil {
		t.Fatal(err)
	}
	if initialized.Status != "uploading" || !reflect.DeepEqual(initialized.MissingChunks, []int{0, 1, 2}) {
		t.Fatalf("initialized attachment = %+v", initialized)
	}
	if _, err = service.Get(ctx, strangerID, initialized.ID); !errors.Is(err, ErrAttachmentNotFound) {
		t.Fatalf("stranger get error = %v, want not found", err)
	}
	if _, err = service.Get(ctx, recipientID, initialized.ID); !errors.Is(err, ErrAttachmentNotFound) {
		t.Fatalf("recipient saw incomplete attachment: %v", err)
	}

	chunks := make([][]byte, chunkCount)
	for index := range chunks {
		plainSize := chunkSize
		if index == chunkCount-1 {
			plainSize = 7
		}
		chunks[index] = bytes.Repeat([]byte{byte(index + 1)}, int(plainSize+attachmentGCMTagBytes))
	}
	for _, index := range []int{0, 2} {
		if _, err = service.PutChunk(ctx, ownerID, initialized.ID, index, chunkHash(chunks[index]), bytes.NewReader(chunks[index])); err != nil {
			t.Fatalf("put chunk %d: %v", index, err)
		}
	}

	resumable, err := service.Get(ctx, ownerID, initialized.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(resumable.UploadedChunks, []int{0, 2}) || !reflect.DeepEqual(resumable.MissingChunks, []int{1}) {
		t.Fatalf("resume state = %+v", resumable)
	}
	if _, err = service.Complete(ctx, ownerID, initialized.ID); !errors.Is(err, ErrAttachmentIncomplete) {
		t.Fatalf("incomplete completion error = %v", err)
	}

	result, err := service.PutChunk(ctx, ownerID, initialized.ID, 1, chunkHash(chunks[1]), bytes.NewReader(chunks[1]))
	if err != nil {
		t.Fatal(err)
	}
	if result.Already {
		t.Fatal("first chunk upload was marked as already uploaded")
	}
	result, err = service.PutChunk(ctx, ownerID, initialized.ID, 1, chunkHash(chunks[1]), bytes.NewReader(nil))
	if err != nil || !result.Already {
		t.Fatalf("idempotent upload = %+v, %v", result, err)
	}
	if _, err = service.PutChunk(ctx, ownerID, initialized.ID, 1, chunkHash([]byte("different")), bytes.NewReader(chunks[1])); !errors.Is(err, ErrChunkConflict) {
		t.Fatalf("conflicting upload error = %v", err)
	}

	available, err := service.Complete(ctx, ownerID, initialized.ID)
	if err != nil {
		t.Fatal(err)
	}
	if available.Status != "available" || available.ReceivedBytes != ciphertextSize || !available.ExpiresAt.Equal(clock.Add(config.Retention)) {
		t.Fatalf("available attachment = %+v", available)
	}
	recipientView, err := service.Get(ctx, recipientID, initialized.ID)
	if err != nil || recipientView.Role != "recipient" || recipientView.Status != "available" {
		t.Fatalf("recipient view = %+v, %v", recipientView, err)
	}
	if _, err = service.DownloadChunk(ctx, ownerID, initialized.ID, 0); !errors.Is(err, ErrChunkNotFound) {
		t.Fatalf("owner download error = %v, want chunk not found", err)
	}
	for index, expected := range chunks {
		download, downloadErr := service.DownloadChunk(ctx, recipientID, initialized.ID, index)
		if downloadErr != nil {
			t.Fatalf("download chunk %d: %v", index, downloadErr)
		}
		actual, readErr := io.ReadAll(download.Reader)
		closeErr := download.Reader.Close()
		if readErr != nil || closeErr != nil || !bytes.Equal(actual, expected) || download.SHA256 != chunkHash(expected) {
			t.Fatalf("download chunk %d failed integrity check: read=%v close=%v", index, readErr, closeErr)
		}
	}

	if err = service.Acknowledge(ctx, recipientID, initialized.ID); err != nil {
		t.Fatal(err)
	}
	consumed, err := service.Get(ctx, recipientID, initialized.ID)
	if err != nil || consumed.Status != "consumed" || consumed.ReceivedBytes != 0 {
		t.Fatalf("consumed attachment = %+v, %v", consumed, err)
	}
	if _, err = storage.OpenChunk(ctx, initialized.ID, 0); !errors.Is(err, ErrChunkNotFound) {
		t.Fatalf("acknowledged ciphertext still exists: %v", err)
	}
	var storedChunks int
	if err = db.QueryRow(`SELECT COUNT(*) FROM attachment_chunks WHERE attachment_id = ?`, initialized.ID).Scan(&storedChunks); err != nil || storedChunks != 0 {
		t.Fatalf("stored chunks after acknowledge = %d, %v", storedChunks, err)
	}

	expiring, err := service.Init(ctx, ownerID, "8001-RCPT", fileSize, ciphertextSize, chunkSize, chunkCount)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.PutChunk(ctx, ownerID, expiring.ID, 0, chunkHash(chunks[0]), bytes.NewReader(chunks[0])); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(config.UploadTTL + time.Second)
	cleaned, err := service.CleanupExpired(ctx, 100)
	if err != nil || cleaned != 1 {
		t.Fatalf("expired cleanup count = %d, err = %v", cleaned, err)
	}
	if _, err = storage.OpenChunk(ctx, expiring.ID, 0); !errors.Is(err, ErrChunkNotFound) {
		t.Fatalf("expired ciphertext still exists: %v", err)
	}
	var status string
	var receivedBytes int64
	if err = db.QueryRow(`SELECT status, received_bytes FROM attachments WHERE id = ?`, expiring.ID).Scan(&status, &receivedBytes); err != nil {
		t.Fatal(err)
	}
	if status != "expired" || receivedBytes != 0 {
		t.Fatalf("expired record status=%q received_bytes=%d", status, receivedBytes)
	}
}

func TestAccountDeletionRemovesAttachmentRowsAndCiphertext(t *testing.T) {
	db := openIsolatedAuthorityServiceTestDatabase(t)
	ctx := context.Background()
	ownerID := insertAttachmentTestUser(t, db, "8100-OWNR", "owner")
	recipientID := insertAttachmentTestUser(t, db, "8101-RCPT", "recipient")
	if _, err := db.Exec(`INSERT INTO friendships (user_id, friend_id) VALUES (?, ?), (?, ?)`, ownerID, recipientID, recipientID, ownerID); err != nil {
		t.Fatal(err)
	}
	storage, err := NewLocalAttachmentStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	attachmentService := NewAttachmentService(db, storage, DefaultAttachmentConfig())
	view, err := attachmentService.Init(ctx, ownerID, "8101-RCPT", 10, 26, 10, 1)
	if err != nil {
		t.Fatal(err)
	}
	ciphertext := bytes.Repeat([]byte{7}, 26)
	if _, err = attachmentService.PutChunk(ctx, ownerID, view.ID, 0, chunkHash(ciphertext), bytes.NewReader(ciphertext)); err != nil {
		t.Fatal(err)
	}

	redisClient, err := pkgredis.NewInMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = redisClient.Close() })
	identityService := NewIdentityService(db, redisClient)
	identityService.SetAttachmentCleanup(func(cleanupContext context.Context, attachmentIDs []string) error {
		for _, id := range attachmentIDs {
			if cleanupErr := storage.DeleteAttachment(cleanupContext, id); cleanupErr != nil {
				return cleanupErr
			}
		}
		return nil
	})
	if err = identityService.DeleteAccount(ctx, "8100-OWNR"); err != nil {
		t.Fatal(err)
	}
	if _, err = storage.OpenChunk(ctx, view.ID, 0); !errors.Is(err, ErrChunkNotFound) {
		t.Fatalf("deleted account ciphertext still exists: %v", err)
	}
	var attachmentRows int
	if err = db.QueryRow(`SELECT COUNT(*) FROM attachments WHERE id = ?`, view.ID).Scan(&attachmentRows); err != nil || attachmentRows != 0 {
		t.Fatalf("attachment rows after account deletion = %d, %v", attachmentRows, err)
	}
}

func insertAttachmentTestUser(t *testing.T, db *sql.DB, chatID, nickname string) uint64 {
	t.Helper()
	result, err := db.Exec(`INSERT INTO users (chat_id, nickname, public_key, is_ready) VALUES (?, ?, 'test-key', 1)`, chatID, nickname)
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return uint64(id)
}
