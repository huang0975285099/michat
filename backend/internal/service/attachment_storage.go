package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

var (
	ErrInvalidAttachmentID = errors.New("invalid attachment id")
	ErrChunkTooLarge       = errors.New("encrypted chunk is too large")
	ErrChunkChecksum       = errors.New("encrypted chunk checksum mismatch")
	ErrChunkNotFound       = errors.New("encrypted chunk not found")
)

var attachmentIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type StoredAttachmentChunk struct {
	Size   int64
	SHA256 string
}

type AttachmentStorage interface {
	PutChunk(ctx context.Context, attachmentID string, index int, src io.Reader, maxBytes int64, expectedSHA256 string) (StoredAttachmentChunk, error)
	OpenChunk(ctx context.Context, attachmentID string, index int) (io.ReadCloser, error)
	DeleteChunk(ctx context.Context, attachmentID string, index int) error
	DeleteAttachment(ctx context.Context, attachmentID string) error
	ListAttachmentIDs(ctx context.Context) ([]string, error)
}

type LocalAttachmentStorage struct {
	basePath string
}

func NewLocalAttachmentStorage(basePath string) (*LocalAttachmentStorage, error) {
	if basePath == "" {
		return nil, errors.New("attachment storage path is required")
	}
	abs, err := filepath.Abs(basePath)
	if err != nil {
		return nil, fmt.Errorf("resolve attachment storage path: %w", err)
	}
	if err = os.MkdirAll(abs, 0o700); err != nil {
		return nil, fmt.Errorf("create attachment storage path: %w", err)
	}
	return &LocalAttachmentStorage{basePath: abs}, nil
}

func (s *LocalAttachmentStorage) attachmentDir(id string) (string, error) {
	if !attachmentIDPattern.MatchString(id) {
		return "", ErrInvalidAttachmentID
	}
	return filepath.Join(s.basePath, id), nil
}

func (s *LocalAttachmentStorage) chunkPath(id string, index int) (string, error) {
	if index < 0 {
		return "", ErrChunkNotFound
	}
	dir, err := s.attachmentDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, fmt.Sprintf("%08d.chunk", index)), nil
}

func (s *LocalAttachmentStorage) PutChunk(ctx context.Context, attachmentID string, index int, src io.Reader, maxBytes int64, expectedSHA256 string) (StoredAttachmentChunk, error) {
	var result StoredAttachmentChunk
	if err := ctx.Err(); err != nil {
		return result, err
	}
	finalPath, err := s.chunkPath(attachmentID, index)
	if err != nil {
		return result, err
	}
	dir := filepath.Dir(finalPath)
	if err = os.MkdirAll(dir, 0o700); err != nil {
		return result, fmt.Errorf("create attachment directory: %w", err)
	}

	temp, err := os.CreateTemp(dir, ".upload-*.tmp")
	if err != nil {
		return result, fmt.Errorf("create encrypted chunk: %w", err)
	}
	tempPath := temp.Name()
	committed := false
	defer func() {
		temp.Close()
		if !committed {
			_ = os.Remove(tempPath)
		}
	}()

	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temp, hash), io.LimitReader(src, maxBytes+1))
	if copyErr != nil {
		return result, fmt.Errorf("write encrypted chunk: %w", copyErr)
	}
	if written <= 0 || written > maxBytes {
		return result, ErrChunkTooLarge
	}
	result = StoredAttachmentChunk{Size: written, SHA256: hex.EncodeToString(hash.Sum(nil))}
	if result.SHA256 != expectedSHA256 {
		return StoredAttachmentChunk{}, ErrChunkChecksum
	}
	if err = temp.Sync(); err != nil {
		return StoredAttachmentChunk{}, fmt.Errorf("sync encrypted chunk: %w", err)
	}
	if err = temp.Close(); err != nil {
		return StoredAttachmentChunk{}, fmt.Errorf("close encrypted chunk: %w", err)
	}
	// A process may have stopped after committing the file but before recording
	// the chunk in MySQL. The service serializes writes per attachment and only
	// calls PutChunk when no chunk row exists, so replacing that orphan is safe.
	if err = os.Remove(finalPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return StoredAttachmentChunk{}, fmt.Errorf("replace orphan encrypted chunk: %w", err)
	}
	if err = os.Rename(tempPath, finalPath); err != nil {
		return StoredAttachmentChunk{}, fmt.Errorf("commit encrypted chunk: %w", err)
	}
	committed = true
	return result, nil
}

func (s *LocalAttachmentStorage) OpenChunk(ctx context.Context, attachmentID string, index int) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path, err := s.chunkPath(attachmentID, index)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrChunkNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("open encrypted chunk: %w", err)
	}
	return file, nil
}

func (s *LocalAttachmentStorage) DeleteChunk(ctx context.Context, attachmentID string, index int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	path, err := s.chunkPath(attachmentID, index)
	if err != nil {
		return err
	}
	if err = os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete encrypted chunk: %w", err)
	}
	return nil
}

func (s *LocalAttachmentStorage) DeleteAttachment(ctx context.Context, attachmentID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	dir, err := s.attachmentDir(attachmentID)
	if err != nil {
		return err
	}
	if err = os.RemoveAll(dir); err != nil {
		return fmt.Errorf("delete encrypted attachment: %w", err)
	}
	return nil
}

func (s *LocalAttachmentStorage) ListAttachmentIDs(ctx context.Context) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.basePath)
	if err != nil {
		return nil, fmt.Errorf("list encrypted attachments: %w", err)
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() && attachmentIDPattern.MatchString(entry.Name()) {
			ids = append(ids, entry.Name())
		}
	}
	return ids, nil
}
