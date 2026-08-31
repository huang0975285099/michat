package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"testing"
)

const testAttachmentID = "12345678-1234-4234-9234-123456789abc"

func chunkHash(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func TestLocalAttachmentStorageWritesVerifiesAndDeletesCiphertext(t *testing.T) {
	storage, err := NewLocalAttachmentStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ciphertext := []byte("opaque authenticated ciphertext")
	stored, err := storage.PutChunk(context.Background(), testAttachmentID, 0, bytes.NewReader(ciphertext), int64(len(ciphertext)), chunkHash(ciphertext))
	if err != nil {
		t.Fatal(err)
	}
	if stored.Size != int64(len(ciphertext)) || stored.SHA256 != chunkHash(ciphertext) {
		t.Fatalf("stored chunk = %#v", stored)
	}
	ids, err := storage.ListAttachmentIDs(context.Background())
	if err != nil || len(ids) != 1 || ids[0] != testAttachmentID {
		t.Fatalf("stored attachment ids = %v, err = %v", ids, err)
	}
	reader, err := storage.OpenChunk(context.Background(), testAttachmentID, 0)
	if err != nil {
		t.Fatal(err)
	}
	readBack, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || !bytes.Equal(readBack, ciphertext) {
		t.Fatalf("read encrypted chunk = %q, err = %v", readBack, err)
	}
	if err = storage.DeleteAttachment(context.Background(), testAttachmentID); err != nil {
		t.Fatal(err)
	}
	if _, err = storage.OpenChunk(context.Background(), testAttachmentID, 0); !errors.Is(err, ErrChunkNotFound) {
		t.Fatalf("open deleted chunk error = %v", err)
	}
}

func TestLocalAttachmentStorageRejectsInvalidChecksumSizeAndPath(t *testing.T) {
	storage, err := NewLocalAttachmentStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ciphertext := []byte("ciphertext")
	_, err = storage.PutChunk(context.Background(), testAttachmentID, 0, bytes.NewReader(ciphertext), int64(len(ciphertext)), chunkHash([]byte("different")))
	if !errors.Is(err, ErrChunkChecksum) {
		t.Fatalf("checksum error = %v", err)
	}
	_, err = storage.PutChunk(context.Background(), testAttachmentID, 0, bytes.NewReader(ciphertext), 3, chunkHash(ciphertext))
	if !errors.Is(err, ErrChunkTooLarge) {
		t.Fatalf("size error = %v", err)
	}
	_, err = storage.PutChunk(context.Background(), "../../escape", 0, bytes.NewReader(ciphertext), int64(len(ciphertext)), chunkHash(ciphertext))
	if !errors.Is(err, ErrInvalidAttachmentID) {
		t.Fatalf("path validation error = %v", err)
	}
}

func TestAttachmentShapeBindsAESGCMOverheadAndChunkIndexes(t *testing.T) {
	config := DefaultAttachmentConfig()
	fileSize := int64(3*1024*1024 + 7)
	chunkSize := int64(1024 * 1024)
	chunkCount := 4
	ciphertextSize := fileSize + attachmentGCMTagBytes*int64(chunkCount)
	if err := validateAttachmentShape(fileSize, ciphertextSize, chunkSize, chunkCount, config); err != nil {
		t.Fatalf("valid attachment rejected: %v", err)
	}
	if err := validateAttachmentShape(fileSize, ciphertextSize-1, chunkSize, chunkCount, config); !errors.Is(err, ErrAttachmentInvalid) {
		t.Fatalf("invalid GCM overhead error = %v", err)
	}
	attachment := Attachment{FileSize: fileSize, ChunkSize: chunkSize, ChunkCount: chunkCount}
	if size, _ := expectedEncryptedChunkSize(attachment, 0); size != chunkSize+attachmentGCMTagBytes {
		t.Fatalf("first encrypted chunk size = %d", size)
	}
	if size, _ := expectedEncryptedChunkSize(attachment, 3); size != 7+attachmentGCMTagBytes {
		t.Fatalf("last encrypted chunk size = %d", size)
	}
	if _, err := expectedEncryptedChunkSize(attachment, 4); !errors.Is(err, ErrInvalidChunkSize) {
		t.Fatalf("out-of-range chunk error = %v", err)
	}
}

func TestAttachmentConfigRejectsQuotaBelowOneFileAndInvalidChunkRange(t *testing.T) {
	config := DefaultAttachmentConfig()
	config.MaxAccountBytes = config.MaxFileBytes - 1
	if err := ValidateAttachmentConfig(config); err == nil {
		t.Fatal("quota below the single-file limit was accepted")
	}
	config = DefaultAttachmentConfig()
	config.MinChunkBytes = config.MaxChunkBytes + 1
	if err := ValidateAttachmentConfig(config); err == nil {
		t.Fatal("inverted chunk size range was accepted")
	}
}
