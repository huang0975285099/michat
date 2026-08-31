package service

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"sync"
	"time"
)

const attachmentGCMTagBytes int64 = 16

var (
	ErrAttachmentNotFound   = errors.New("attachment not found")
	ErrAttachmentForbidden  = errors.New("attachment access denied")
	ErrAttachmentInvalid    = errors.New("invalid attachment metadata")
	ErrAttachmentQuota      = errors.New("attachment quota exceeded")
	ErrAttachmentState      = errors.New("invalid attachment state")
	ErrAttachmentExpired    = errors.New("attachment expired")
	ErrAttachmentIncomplete = errors.New("attachment upload incomplete")
	ErrChunkConflict        = errors.New("encrypted chunk conflicts with uploaded chunk")
	ErrInvalidChunkSize     = errors.New("invalid encrypted chunk size")
)

var ciphertextSHA256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type AttachmentConfig struct {
	MaxFileBytes    int64
	MaxAccountBytes int64
	MinChunkBytes   int64
	MaxChunkBytes   int64
	UploadTTL       time.Duration
	Retention       time.Duration
	TombstoneTTL    time.Duration
}

func DefaultAttachmentConfig() AttachmentConfig {
	return AttachmentConfig{
		MaxFileBytes:    500 * 1024 * 1024,
		MaxAccountBytes: 5 * 1024 * 1024 * 1024,
		MinChunkBytes:   256 * 1024,
		MaxChunkBytes:   2 * 1024 * 1024,
		UploadTTL:       24 * time.Hour,
		Retention:       7 * 24 * time.Hour,
		TombstoneTTL:    7 * 24 * time.Hour,
	}
}

func ValidateAttachmentConfig(config AttachmentConfig) error {
	if config.MaxFileBytes <= 0 || config.MaxAccountBytes < config.MaxFileBytes ||
		config.MinChunkBytes <= 0 || config.MaxChunkBytes < config.MinChunkBytes ||
		config.UploadTTL <= 0 || config.Retention <= 0 || config.TombstoneTTL <= 0 {
		return errors.New("invalid attachment configuration")
	}
	return nil
}

type Attachment struct {
	ID              string
	OwnerUserID     uint64
	RecipientUserID uint64
	FileSize        int64
	CiphertextSize  int64
	ChunkSize       int64
	ChunkCount      int
	ReceivedBytes   int64
	Status          string
	ExpiresAt       time.Time
	CompletedAt     sql.NullTime
	AcknowledgedAt  sql.NullTime
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type AttachmentView struct {
	ID             string     `json:"id"`
	Role           string     `json:"role"`
	FileSize       int64      `json:"file_size"`
	CiphertextSize int64      `json:"ciphertext_size"`
	ChunkSize      int64      `json:"chunk_size"`
	ChunkCount     int        `json:"chunk_count"`
	ReceivedBytes  int64      `json:"received_bytes"`
	Status         string     `json:"status"`
	ExpiresAt      time.Time  `json:"expires_at"`
	CompletedAt    *time.Time `json:"completed_at,omitempty"`
	UploadedChunks []int      `json:"uploaded_chunks,omitempty"`
	MissingChunks  []int      `json:"missing_chunks,omitempty"`
}

type AttachmentQuotaView struct {
	UsedBytes      int64 `json:"used_bytes"`
	LimitBytes     int64 `json:"limit_bytes"`
	RemainingBytes int64 `json:"remaining_bytes"`
}

type AttachmentChunkResult struct {
	Index   int    `json:"index"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
	Already bool   `json:"already_uploaded"`
}

type AttachmentChunkDownload struct {
	Reader io.ReadCloser
	Size   int64
	SHA256 string
}

type attachmentLock struct {
	mu   sync.Mutex
	refs int
}

type AttachmentService struct {
	db      *sql.DB
	storage AttachmentStorage
	config  AttachmentConfig
	now     func() time.Time
	locksMu sync.Mutex
	locks   map[string]*attachmentLock
}

func NewAttachmentService(db *sql.DB, storage AttachmentStorage, config AttachmentConfig) *AttachmentService {
	defaults := DefaultAttachmentConfig()
	if config.MaxFileBytes <= 0 {
		config.MaxFileBytes = defaults.MaxFileBytes
	}
	if config.MaxAccountBytes <= 0 {
		config.MaxAccountBytes = defaults.MaxAccountBytes
	}
	if config.MinChunkBytes <= 0 {
		config.MinChunkBytes = defaults.MinChunkBytes
	}
	if config.MaxChunkBytes <= 0 {
		config.MaxChunkBytes = defaults.MaxChunkBytes
	}
	if config.UploadTTL <= 0 {
		config.UploadTTL = defaults.UploadTTL
	}
	if config.Retention <= 0 {
		config.Retention = defaults.Retention
	}
	if config.TombstoneTTL <= 0 {
		config.TombstoneTTL = defaults.TombstoneTTL
	}
	return &AttachmentService{
		db: db, storage: storage, config: config, now: func() time.Time { return time.Now().UTC() },
		locks: make(map[string]*attachmentLock),
	}
}

func (s *AttachmentService) MaxEncryptedChunkBytes() int64 {
	return s.config.MaxChunkBytes + attachmentGCMTagBytes
}

func (s *AttachmentService) Quota(ctx context.Context, ownerUserID uint64) (AttachmentQuotaView, error) {
	var usedBytes int64
	err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(ciphertext_size), 0) FROM attachments
		WHERE owner_user_id = ? AND status IN ('uploading','available')`, ownerUserID).Scan(&usedBytes)
	if err != nil {
		return AttachmentQuotaView{}, err
	}
	if usedBytes < 0 {
		usedBytes = 0
	}
	remainingBytes := s.config.MaxAccountBytes - usedBytes
	if remainingBytes < 0 {
		remainingBytes = 0
	}
	return AttachmentQuotaView{
		UsedBytes: usedBytes, LimitBytes: s.config.MaxAccountBytes, RemainingBytes: remainingBytes,
	}, nil
}

func (s *AttachmentService) acquireAttachmentLock(id string) func() {
	s.locksMu.Lock()
	entry := s.locks[id]
	if entry == nil {
		entry = &attachmentLock{}
		s.locks[id] = entry
	}
	entry.refs++
	s.locksMu.Unlock()
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		s.locksMu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(s.locks, id)
		}
		s.locksMu.Unlock()
	}
}

func validateAttachmentShape(fileSize, ciphertextSize, chunkSize int64, chunkCount int, config AttachmentConfig) error {
	if fileSize <= 0 || fileSize > config.MaxFileBytes || chunkSize <= 0 || chunkSize > config.MaxChunkBytes || chunkCount <= 0 {
		return ErrAttachmentInvalid
	}
	if fileSize > config.MinChunkBytes && chunkSize < config.MinChunkBytes {
		return ErrAttachmentInvalid
	}
	expectedChunks := int((fileSize + chunkSize - 1) / chunkSize)
	if chunkCount != expectedChunks || ciphertextSize != fileSize+attachmentGCMTagBytes*int64(chunkCount) {
		return ErrAttachmentInvalid
	}
	return nil
}

func expectedEncryptedChunkSize(attachment Attachment, index int) (int64, error) {
	if index < 0 || index >= attachment.ChunkCount {
		return 0, ErrInvalidChunkSize
	}
	plainSize := attachment.ChunkSize
	if index == attachment.ChunkCount-1 {
		plainSize = attachment.FileSize - int64(index)*attachment.ChunkSize
	}
	if plainSize <= 0 {
		return 0, ErrInvalidChunkSize
	}
	return plainSize + attachmentGCMTagBytes, nil
}

func newAttachmentID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	hexID := hex.EncodeToString(bytes)
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexID[:8], hexID[8:12], hexID[12:16], hexID[16:20], hexID[20:]), nil
}

func (s *AttachmentService) Init(ctx context.Context, ownerUserID uint64, recipientChatID string, fileSize, ciphertextSize, chunkSize int64, chunkCount int) (AttachmentView, error) {
	if err := validateAttachmentShape(fileSize, ciphertextSize, chunkSize, chunkCount, s.config); err != nil {
		return AttachmentView{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AttachmentView{}, err
	}
	defer tx.Rollback()

	var lockedOwner uint64
	if err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE id = ? FOR UPDATE`, ownerUserID).Scan(&lockedOwner); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return AttachmentView{}, ErrAttachmentForbidden
		}
		return AttachmentView{}, err
	}
	var recipientUserID uint64
	err = tx.QueryRowContext(ctx, `
		SELECT u.id FROM friendships f
		JOIN users u ON u.id = f.friend_id
		WHERE f.user_id = ? AND u.chat_id = ? AND u.is_ready = 1`, ownerUserID, recipientChatID).Scan(&recipientUserID)
	if errors.Is(err, sql.ErrNoRows) {
		return AttachmentView{}, ErrAttachmentForbidden
	}
	if err != nil {
		return AttachmentView{}, err
	}
	var usedBytes int64
	if err = tx.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(ciphertext_size), 0) FROM attachments
		WHERE owner_user_id = ? AND status IN ('uploading','available')`, ownerUserID).Scan(&usedBytes); err != nil {
		return AttachmentView{}, err
	}
	if usedBytes > s.config.MaxAccountBytes-ciphertextSize {
		return AttachmentView{}, ErrAttachmentQuota
	}

	id, err := newAttachmentID()
	if err != nil {
		return AttachmentView{}, err
	}
	now := s.now()
	expiresAt := now.Add(s.config.UploadTTL)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO attachments
		(id, owner_user_id, recipient_user_id, file_size, ciphertext_size, chunk_size, chunk_count, status, expires_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)`,
		id, ownerUserID, recipientUserID, fileSize, ciphertextSize, chunkSize, chunkCount, expiresAt, now, now)
	if err != nil {
		return AttachmentView{}, err
	}
	if err = tx.Commit(); err != nil {
		return AttachmentView{}, err
	}
	return AttachmentView{
		ID: id, Role: "owner", FileSize: fileSize, CiphertextSize: ciphertextSize,
		ChunkSize: chunkSize, ChunkCount: chunkCount, Status: "uploading", ExpiresAt: expiresAt,
		UploadedChunks: []int{}, MissingChunks: integerRange(chunkCount),
	}, nil
}

func integerRange(count int) []int {
	values := make([]int, count)
	for index := range values {
		values[index] = index
	}
	return values
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanAttachment(row rowScanner) (Attachment, error) {
	var attachment Attachment
	err := row.Scan(
		&attachment.ID, &attachment.OwnerUserID, &attachment.RecipientUserID,
		&attachment.FileSize, &attachment.CiphertextSize, &attachment.ChunkSize,
		&attachment.ChunkCount, &attachment.ReceivedBytes, &attachment.Status,
		&attachment.ExpiresAt, &attachment.CompletedAt, &attachment.AcknowledgedAt,
		&attachment.CreatedAt, &attachment.UpdatedAt,
	)
	return attachment, err
}

const attachmentColumns = `id, owner_user_id, recipient_user_id, file_size, ciphertext_size, chunk_size, chunk_count,
	received_bytes, status, expires_at, completed_at, acknowledged_at, created_at, updated_at`

func (s *AttachmentService) ownedAttachment(ctx context.Context, ownerUserID uint64, id string) (Attachment, error) {
	if !attachmentIDPattern.MatchString(id) {
		return Attachment{}, ErrAttachmentNotFound
	}
	attachment, err := scanAttachment(s.db.QueryRowContext(ctx,
		`SELECT `+attachmentColumns+` FROM attachments WHERE id = ? AND owner_user_id = ?`, id, ownerUserID))
	if errors.Is(err, sql.ErrNoRows) {
		return Attachment{}, ErrAttachmentNotFound
	}
	return attachment, err
}

func (s *AttachmentService) PutChunk(ctx context.Context, ownerUserID uint64, id string, index int, expectedSHA256 string, src io.Reader) (AttachmentChunkResult, error) {
	if !ciphertextSHA256Pattern.MatchString(expectedSHA256) {
		return AttachmentChunkResult{}, ErrChunkChecksum
	}
	release := s.acquireAttachmentLock(id)
	defer release()

	attachment, err := s.ownedAttachment(ctx, ownerUserID, id)
	if err != nil {
		return AttachmentChunkResult{}, err
	}
	if !attachment.ExpiresAt.After(s.now()) {
		return AttachmentChunkResult{}, ErrAttachmentExpired
	}
	if attachment.Status != "uploading" {
		return AttachmentChunkResult{}, ErrAttachmentState
	}
	expectedSize, err := expectedEncryptedChunkSize(attachment, index)
	if err != nil {
		return AttachmentChunkResult{}, err
	}

	var existingSize int64
	var existingHash string
	err = s.db.QueryRowContext(ctx, `SELECT ciphertext_size, ciphertext_sha256 FROM attachment_chunks WHERE attachment_id = ? AND chunk_index = ?`, id, index).Scan(&existingSize, &existingHash)
	if err == nil {
		if existingHash != expectedSHA256 {
			return AttachmentChunkResult{}, ErrChunkConflict
		}
		return AttachmentChunkResult{Index: index, Size: existingSize, SHA256: existingHash, Already: true}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return AttachmentChunkResult{}, err
	}

	stored, err := s.storage.PutChunk(ctx, id, index, src, expectedSize, expectedSHA256)
	if err != nil {
		return AttachmentChunkResult{}, err
	}
	if stored.Size != expectedSize {
		_ = s.storage.DeleteChunk(context.Background(), id, index)
		return AttachmentChunkResult{}, ErrInvalidChunkSize
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		_ = s.storage.DeleteChunk(context.Background(), id, index)
		return AttachmentChunkResult{}, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		UPDATE attachments SET received_bytes = received_bytes + ?, updated_at = ?
		WHERE id = ? AND owner_user_id = ? AND status = 'uploading' AND expires_at > ?`,
		stored.Size, s.now(), id, ownerUserID, s.now())
	if err != nil {
		_ = s.storage.DeleteChunk(context.Background(), id, index)
		return AttachmentChunkResult{}, err
	}
	rows, _ := result.RowsAffected()
	if rows != 1 {
		_ = s.storage.DeleteChunk(context.Background(), id, index)
		return AttachmentChunkResult{}, ErrAttachmentState
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO attachment_chunks (attachment_id, chunk_index, ciphertext_size, ciphertext_sha256)
		VALUES (?, ?, ?, ?)`, id, index, stored.Size, stored.SHA256)
	if err != nil {
		_ = s.storage.DeleteChunk(context.Background(), id, index)
		return AttachmentChunkResult{}, err
	}
	if err = tx.Commit(); err != nil {
		_ = s.storage.DeleteChunk(context.Background(), id, index)
		return AttachmentChunkResult{}, err
	}
	return AttachmentChunkResult{Index: index, Size: stored.Size, SHA256: stored.SHA256}, nil
}

func (s *AttachmentService) Get(ctx context.Context, userID uint64, id string) (AttachmentView, error) {
	if !attachmentIDPattern.MatchString(id) {
		return AttachmentView{}, ErrAttachmentNotFound
	}
	attachment, err := scanAttachment(s.db.QueryRowContext(ctx,
		`SELECT `+attachmentColumns+` FROM attachments WHERE id = ? AND (owner_user_id = ? OR recipient_user_id = ?)`, id, userID, userID))
	if errors.Is(err, sql.ErrNoRows) {
		return AttachmentView{}, ErrAttachmentNotFound
	}
	if err != nil {
		return AttachmentView{}, err
	}
	if (attachment.Status == "uploading" || attachment.Status == "available") && !attachment.ExpiresAt.After(s.now()) {
		return AttachmentView{}, ErrAttachmentExpired
	}
	role := "recipient"
	if attachment.OwnerUserID == userID {
		role = "owner"
	} else if attachment.Status == "uploading" {
		return AttachmentView{}, ErrAttachmentNotFound
	}

	view := attachmentView(attachment, role)
	if role == "owner" && attachment.Status == "uploading" {
		rows, queryErr := s.db.QueryContext(ctx, `SELECT chunk_index FROM attachment_chunks WHERE attachment_id = ? ORDER BY chunk_index`, id)
		if queryErr != nil {
			return AttachmentView{}, queryErr
		}
		defer rows.Close()
		uploadedSet := make(map[int]struct{}, attachment.ChunkCount)
		for rows.Next() {
			var index int
			if err = rows.Scan(&index); err != nil {
				return AttachmentView{}, err
			}
			view.UploadedChunks = append(view.UploadedChunks, index)
			uploadedSet[index] = struct{}{}
		}
		for index := 0; index < attachment.ChunkCount; index++ {
			if _, ok := uploadedSet[index]; !ok {
				view.MissingChunks = append(view.MissingChunks, index)
			}
		}
	}
	return view, nil
}

func attachmentView(attachment Attachment, role string) AttachmentView {
	view := AttachmentView{
		ID: attachment.ID, Role: role, FileSize: attachment.FileSize, CiphertextSize: attachment.CiphertextSize,
		ChunkSize: attachment.ChunkSize, ChunkCount: attachment.ChunkCount, ReceivedBytes: attachment.ReceivedBytes,
		Status: attachment.Status, ExpiresAt: attachment.ExpiresAt,
	}
	if attachment.CompletedAt.Valid {
		completed := attachment.CompletedAt.Time
		view.CompletedAt = &completed
	}
	return view
}

func (s *AttachmentService) Complete(ctx context.Context, ownerUserID uint64, id string) (AttachmentView, error) {
	release := s.acquireAttachmentLock(id)
	defer release()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AttachmentView{}, err
	}
	defer tx.Rollback()
	attachment, err := scanAttachment(tx.QueryRowContext(ctx,
		`SELECT `+attachmentColumns+` FROM attachments WHERE id = ? AND owner_user_id = ? FOR UPDATE`, id, ownerUserID))
	if errors.Is(err, sql.ErrNoRows) {
		return AttachmentView{}, ErrAttachmentNotFound
	}
	if err != nil {
		return AttachmentView{}, err
	}
	if attachment.Status == "available" {
		return attachmentView(attachment, "owner"), tx.Commit()
	}
	if attachment.Status != "uploading" || !attachment.ExpiresAt.After(s.now()) {
		return AttachmentView{}, ErrAttachmentState
	}
	var count int
	var total int64
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(ciphertext_size), 0) FROM attachment_chunks WHERE attachment_id = ?`, id).Scan(&count, &total); err != nil {
		return AttachmentView{}, err
	}
	if count != attachment.ChunkCount || total != attachment.CiphertextSize || attachment.ReceivedBytes != attachment.CiphertextSize {
		return AttachmentView{}, ErrAttachmentIncomplete
	}
	now := s.now()
	attachment.Status = "available"
	attachment.ExpiresAt = now.Add(s.config.Retention)
	attachment.CompletedAt = sql.NullTime{Time: now, Valid: true}
	_, err = tx.ExecContext(ctx, `UPDATE attachments SET status = 'available', completed_at = ?, expires_at = ?, updated_at = ? WHERE id = ?`, now, attachment.ExpiresAt, now, id)
	if err != nil {
		return AttachmentView{}, err
	}
	if err = tx.Commit(); err != nil {
		return AttachmentView{}, err
	}
	return attachmentView(attachment, "owner"), nil
}

func (s *AttachmentService) DownloadChunk(ctx context.Context, recipientUserID uint64, id string, index int) (AttachmentChunkDownload, error) {
	if !attachmentIDPattern.MatchString(id) || index < 0 {
		return AttachmentChunkDownload{}, ErrChunkNotFound
	}
	var status string
	var expiresAt time.Time
	var size int64
	var hash string
	err := s.db.QueryRowContext(ctx, `
		SELECT a.status, a.expires_at, c.ciphertext_size, c.ciphertext_sha256
		FROM attachments a JOIN attachment_chunks c ON c.attachment_id = a.id
		WHERE a.id = ? AND a.recipient_user_id = ? AND c.chunk_index = ?`, id, recipientUserID, index).
		Scan(&status, &expiresAt, &size, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return AttachmentChunkDownload{}, ErrChunkNotFound
	}
	if err != nil {
		return AttachmentChunkDownload{}, err
	}
	if status != "available" {
		return AttachmentChunkDownload{}, ErrAttachmentState
	}
	if !expiresAt.After(s.now()) {
		return AttachmentChunkDownload{}, ErrAttachmentExpired
	}
	reader, err := s.storage.OpenChunk(ctx, id, index)
	if err != nil {
		return AttachmentChunkDownload{}, err
	}
	return AttachmentChunkDownload{Reader: reader, Size: size, SHA256: hash}, nil
}

func (s *AttachmentService) Acknowledge(ctx context.Context, recipientUserID uint64, id string) error {
	release := s.acquireAttachmentLock(id)
	defer release()
	now := s.now()
	result, err := s.db.ExecContext(ctx, `
		UPDATE attachments SET status = 'consumed', acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ?
		WHERE id = ? AND recipient_user_id = ? AND status IN ('available','consumed')`, now, now, id, recipientUserID)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return ErrAttachmentNotFound
	}
	if err = s.storage.DeleteAttachment(ctx, id); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM attachment_chunks WHERE attachment_id = ?`, id)
	if err == nil {
		_, err = s.db.ExecContext(ctx, `UPDATE attachments SET received_bytes = 0 WHERE id = ?`, id)
	}
	return err
}

func (s *AttachmentService) Cancel(ctx context.Context, ownerUserID uint64, id string) error {
	release := s.acquireAttachmentLock(id)
	defer release()
	now := s.now()
	result, err := s.db.ExecContext(ctx, `
		UPDATE attachments SET status = 'canceled', updated_at = ?
		WHERE id = ? AND owner_user_id = ? AND status IN ('uploading','available')`, now, id, ownerUserID)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return ErrAttachmentNotFound
	}
	if err = s.storage.DeleteAttachment(ctx, id); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM attachment_chunks WHERE attachment_id = ?`, id)
	if err == nil {
		_, err = s.db.ExecContext(ctx, `UPDATE attachments SET received_bytes = 0 WHERE id = ?`, id)
	}
	return err
}

func (s *AttachmentService) CleanupExpired(ctx context.Context, limit int) (int, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, status FROM attachments
		WHERE (status IN ('uploading','available') AND expires_at <= ?)
		   OR (status IN ('consumed','canceled') AND received_bytes > 0)
		ORDER BY updated_at LIMIT ?`, s.now(), limit)
	if err != nil {
		return 0, err
	}
	type cleanupCandidate struct{ id, status string }
	candidates := make([]cleanupCandidate, 0, limit)
	for rows.Next() {
		var candidate cleanupCandidate
		if err = rows.Scan(&candidate.id, &candidate.status); err != nil {
			rows.Close()
			return 0, err
		}
		candidates = append(candidates, candidate)
	}
	rows.Close()

	cleaned := 0
	for _, candidate := range candidates {
		release := s.acquireAttachmentLock(candidate.id)
		deleteErr := s.storage.DeleteAttachment(ctx, candidate.id)
		if deleteErr == nil {
			tx, txErr := s.db.BeginTx(ctx, nil)
			if txErr == nil {
				_, txErr = tx.ExecContext(ctx, `DELETE FROM attachment_chunks WHERE attachment_id = ?`, candidate.id)
				if txErr == nil {
					status := candidate.status
					if status == "uploading" || status == "available" {
						status = "expired"
					}
					_, txErr = tx.ExecContext(ctx, `UPDATE attachments SET status = ?, received_bytes = 0, updated_at = ? WHERE id = ?`, status, s.now(), candidate.id)
				}
				if txErr == nil {
					txErr = tx.Commit()
				} else {
					tx.Rollback()
				}
			}
			if txErr == nil {
				cleaned++
			} else if err == nil {
				err = txErr
			}
		} else if err == nil {
			err = deleteErr
		}
		release()
	}

	cutoff := s.now().Add(-s.config.TombstoneTTL)
	if _, deleteErr := s.db.ExecContext(ctx, `DELETE FROM attachments WHERE status IN ('expired','consumed','canceled') AND updated_at < ?`, cutoff); deleteErr != nil && err == nil {
		err = deleteErr
	}
	if orphanErr := s.cleanupOrphanDirectories(ctx); orphanErr != nil && err == nil {
		err = orphanErr
	}
	return cleaned, err
}

func (s *AttachmentService) cleanupOrphanDirectories(ctx context.Context) error {
	ids, err := s.storage.ListAttachmentIDs(ctx)
	if err != nil {
		return err
	}
	sort.Strings(ids)
	for _, id := range ids {
		var exists int
		err = s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM attachments WHERE id = ?)`, id).Scan(&exists)
		if err != nil {
			return err
		}
		if exists == 0 {
			if err = s.storage.DeleteAttachment(ctx, id); err != nil {
				return err
			}
		}
	}
	return nil
}
