package service

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

type MessageReadService struct {
	db *sql.DB
}

func NewMessageReadService(db *sql.DB) *MessageReadService {
	return &MessageReadService{db: db}
}

type ReadReceipt struct {
	MsgID  string `json:"msg_id"`
	ReadAt int64  `json:"read_at"`
}

var (
	ErrMessageIDConflict = errors.New("message id already belongs to another delivery")
	ErrMessageInboxFull  = errors.New("recipient encrypted message inbox is full")
)

const (
	PendingMessageRetentionDays = 7
	MaxPendingMessageCount      = 500
	MaxPendingRecallCount       = 500
	MaxPendingMessageBytes      = 10 * 1024 * 1024
)

// MessageDelivery contains delivery metadata. Ciphertext is kept separately and only until
// the recipient confirms that it has been durably stored on the device.
type MessageDelivery struct {
	MsgID   string `json:"msg_id"`
	MsgFrom string `json:"-"`
	MsgTo   string `json:"-"`
	SentAt  int64  `json:"ts"`
}

// PendingEncryptedMessage is an E2EE envelope waiting for recipient persistence.
// Envelope is JSON containing only public encryption parameters and ciphertext.
type PendingEncryptedMessage struct {
	MessageDelivery
	Envelope json.RawMessage `json:"-"`
}

// PendingRecall is a durable recall tombstone waiting to be applied by the recipient.
type PendingRecall struct {
	MsgID      string `json:"msg_id"`
	MsgFrom    string `json:"from"`
	RecalledAt int64  `json:"recalled_at"`
}

func msgIDTimestamp(msgID string) (int64, bool) {
	parts := strings.Split(msgID, "-")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return 0, false
	}
	for _, r := range parts[0] {
		if (r < '0' || r > '9') && (r < 'a' || r > 'z') {
			return 0, false
		}
	}
	ts, err := strconv.ParseInt(parts[0], 36, 64)
	return ts, err == nil && ts > 0
}

// RecordMessage records the message attribution actually accepted by the server. The same ID is only allowed to belong to the same sender/receiver pair,
// This prevents attackers from reusing other people's msg_id to forge read receipts.
func (s *MessageReadService) AcceptMessage(ctx context.Context, msgID, msgFrom, msgTo string) (MessageDelivery, bool, error) {
	res, err := s.db.ExecContext(ctx,
		`INSERT IGNORE INTO message_deliveries (msg_id, msg_from, msg_to) VALUES (?, ?, ?)`,
		msgID, msgFrom, msgTo,
	)
	if err != nil {
		return MessageDelivery{}, false, err
	}

	var delivery MessageDelivery
	delivery.MsgID = msgID
	if err := s.db.QueryRowContext(ctx,
		`SELECT msg_from, msg_to, CAST(UNIX_TIMESTAMP(sent_at) * 1000 AS SIGNED)
		 FROM message_deliveries WHERE msg_id = ?`, msgID,
	).Scan(&delivery.MsgFrom, &delivery.MsgTo, &delivery.SentAt); err != nil {
		return MessageDelivery{}, false, err
	}
	if delivery.MsgFrom != msgFrom || delivery.MsgTo != msgTo {
		return MessageDelivery{}, false, ErrMessageIDConflict
	}
	created, err := res.RowsAffected()
	if err != nil {
		return MessageDelivery{}, false, err
	}
	return delivery, created == 1, nil
}

// AcceptEncryptedMessage atomically records delivery ownership and the encrypted envelope.
// The per-recipient lock makes the count/byte quotas deterministic under concurrent sends.
func (s *MessageReadService) AcceptEncryptedMessage(ctx context.Context, msgID, msgFrom, msgTo string, envelope json.RawMessage) (MessageDelivery, bool, error) {
	if len(envelope) == 0 || !json.Valid(envelope) {
		return MessageDelivery{}, false, errors.New("invalid encrypted envelope")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MessageDelivery{}, false, err
	}
	defer tx.Rollback()

	// Serialize quota decisions for one recipient without locking unrelated inboxes.
	var recipientID uint64
	if err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE chat_id = ? FOR UPDATE`, msgTo).Scan(&recipientID); err != nil {
		return MessageDelivery{}, false, err
	}

	var delivery MessageDelivery
	var existingFrom, existingTo string
	err = tx.QueryRowContext(ctx, `
		SELECT msg_from, msg_to, CAST(UNIX_TIMESTAMP(sent_at) * 1000 AS SIGNED)
		FROM message_deliveries WHERE msg_id = ? FOR UPDATE`, msgID,
	).Scan(&existingFrom, &existingTo, &delivery.SentAt)
	if err == nil {
		if existingFrom != msgFrom || existingTo != msgTo {
			return MessageDelivery{}, false, ErrMessageIDConflict
		}
		delivery.MsgID, delivery.MsgFrom, delivery.MsgTo = msgID, existingFrom, existingTo
		if err = tx.Commit(); err != nil {
			return MessageDelivery{}, false, err
		}
		return delivery, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return MessageDelivery{}, false, err
	}

	// Expired ciphertext is cleared before calculating quotas. Delivery attribution remains
	// for read-receipt validation and sender status reconciliation.
	if _, err = tx.ExecContext(ctx, `
		UPDATE message_deliveries
		SET encrypted_envelope = NULL, envelope_size = 0
		WHERE msg_to = ? AND encrypted_envelope IS NOT NULL
		  AND sent_at < (NOW() - INTERVAL ? DAY)`, msgTo, PendingMessageRetentionDays); err != nil {
		return MessageDelivery{}, false, err
	}

	var pendingCount int
	var pendingBytes int64
	if err = tx.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(SUM(envelope_size), 0)
		FROM message_deliveries
		WHERE msg_to = ? AND encrypted_envelope IS NOT NULL`, msgTo,
	).Scan(&pendingCount, &pendingBytes); err != nil {
		return MessageDelivery{}, false, err
	}
	if pendingCount >= MaxPendingMessageCount || pendingBytes+int64(len(envelope)) > MaxPendingMessageBytes {
		return MessageDelivery{}, false, ErrMessageInboxFull
	}

	res, err := tx.ExecContext(ctx, `
		INSERT IGNORE INTO message_deliveries
		  (msg_id, msg_from, msg_to, encrypted_envelope, envelope_size)
		VALUES (?, ?, ?, ?, ?)`, msgID, msgFrom, msgTo, string(envelope), len(envelope))
	if err != nil {
		return MessageDelivery{}, false, err
	}
	created, err := res.RowsAffected()
	if err != nil {
		return MessageDelivery{}, false, err
	}
	if created != 1 {
		return MessageDelivery{}, false, ErrMessageIDConflict
	}

	delivery = MessageDelivery{MsgID: msgID, MsgFrom: msgFrom, MsgTo: msgTo}
	if err = tx.QueryRowContext(ctx,
		`SELECT CAST(UNIX_TIMESTAMP(sent_at) * 1000 AS SIGNED) FROM message_deliveries WHERE msg_id = ?`, msgID,
	).Scan(&delivery.SentAt); err != nil {
		return MessageDelivery{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return MessageDelivery{}, false, err
	}
	return delivery, true, nil
}

// GetPendingEncryptedMessages returns encrypted envelopes in authoritative send order.
func (s *MessageReadService) GetPendingEncryptedMessages(ctx context.Context, msgTo string, limit int) ([]PendingEncryptedMessage, error) {
	if limit <= 0 || limit > MaxPendingMessageCount {
		limit = MaxPendingMessageCount
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE message_deliveries SET encrypted_envelope = NULL, envelope_size = 0
		WHERE msg_to = ? AND encrypted_envelope IS NOT NULL
		  AND sent_at < (NOW() - INTERVAL ? DAY)`, msgTo, PendingMessageRetentionDays); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT msg_id, msg_from, msg_to, CAST(UNIX_TIMESTAMP(sent_at) * 1000 AS SIGNED), encrypted_envelope
		FROM message_deliveries
		WHERE msg_to = ? AND encrypted_envelope IS NOT NULL
		ORDER BY sent_at, msg_id LIMIT ?`, msgTo, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]PendingEncryptedMessage, 0)
	for rows.Next() {
		var item PendingEncryptedMessage
		var envelope string
		if err = rows.Scan(&item.MsgID, &item.MsgFrom, &item.MsgTo, &item.SentAt, &envelope); err != nil {
			return nil, err
		}
		item.Envelope = json.RawMessage(envelope)
		result = append(result, item)
	}
	return result, rows.Err()
}

// MarkEncryptedMessagesApplied clears ciphertext only after the recipient has persisted it locally.
func (s *MessageReadService) MarkEncryptedMessagesApplied(ctx context.Context, msgIDs []string, msgFrom, msgTo string) error {
	if len(msgIDs) == 0 {
		return nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(msgIDs)), ",")
	args := make([]any, 0, len(msgIDs)+2)
	args = append(args, msgFrom, msgTo)
	for _, id := range msgIDs {
		args = append(args, id)
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE message_deliveries
		SET encrypted_envelope = NULL, envelope_size = 0,
		    recipient_applied_at = COALESCE(recipient_applied_at, NOW(3))
		WHERE msg_from = ? AND msg_to = ? AND msg_id IN (`+placeholders+`)`, args...)
	return err
}

// RecallMessage validates ownership, removes any not-yet-delivered ciphertext, and creates
// an idempotent tombstone for the recipient. Repeating an already-applied recall does not reopen it.
func (s *MessageReadService) RecallMessage(ctx context.Context, msgID, msgFrom, msgTo string) (MessageDelivery, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return MessageDelivery{}, false, err
	}
	defer tx.Rollback()
	var recipientID uint64
	if err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE chat_id = ? FOR UPDATE`, msgTo).Scan(&recipientID); err != nil {
		return MessageDelivery{}, false, err
	}
	var delivery MessageDelivery
	var recalledAt sql.NullTime
	if err = tx.QueryRowContext(ctx, `
		SELECT msg_id, msg_from, msg_to, CAST(UNIX_TIMESTAMP(sent_at) * 1000 AS SIGNED), recalled_at
		FROM message_deliveries WHERE msg_id = ? FOR UPDATE`, msgID,
	).Scan(&delivery.MsgID, &delivery.MsgFrom, &delivery.MsgTo, &delivery.SentAt, &recalledAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return MessageDelivery{}, false, nil
		}
		return MessageDelivery{}, false, err
	}
	if delivery.MsgFrom != msgFrom || delivery.MsgTo != msgTo {
		return MessageDelivery{}, false, nil
	}
	if !recalledAt.Valid {
		var pendingRecalls int
		if err = tx.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM message_deliveries
			WHERE msg_to = ? AND recalled_at IS NOT NULL AND recall_applied_at IS NULL`, msgTo,
		).Scan(&pendingRecalls); err != nil {
			return MessageDelivery{}, false, err
		}
		if pendingRecalls >= MaxPendingRecallCount {
			return MessageDelivery{}, false, ErrMessageInboxFull
		}
	}
	if _, err = tx.ExecContext(ctx, `
		UPDATE message_deliveries
		SET encrypted_envelope = NULL, envelope_size = 0,
		    recalled_at = COALESCE(recalled_at, NOW(3))
		WHERE msg_id = ?`, msgID); err != nil {
		return MessageDelivery{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return MessageDelivery{}, false, err
	}
	return delivery, true, nil
}

func (s *MessageReadService) GetPendingRecalls(ctx context.Context, msgTo string, limit int) ([]PendingRecall, error) {
	if limit <= 0 || limit > MaxPendingMessageCount {
		limit = MaxPendingMessageCount
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT msg_id, msg_from, CAST(UNIX_TIMESTAMP(recalled_at) * 1000 AS SIGNED)
		FROM message_deliveries
		WHERE msg_to = ? AND recalled_at IS NOT NULL AND recall_applied_at IS NULL
		ORDER BY recalled_at, msg_id LIMIT ?`, msgTo, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]PendingRecall, 0)
	for rows.Next() {
		var item PendingRecall
		if err = rows.Scan(&item.MsgID, &item.MsgFrom, &item.RecalledAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *MessageReadService) MarkRecallsApplied(ctx context.Context, msgIDs []string, msgFrom, msgTo string) error {
	if len(msgIDs) == 0 {
		return nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(msgIDs)), ",")
	args := make([]any, 0, len(msgIDs)+2)
	args = append(args, msgFrom, msgTo)
	for _, id := range msgIDs {
		args = append(args, id)
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE message_deliveries SET recall_applied_at = COALESCE(recall_applied_at, NOW(3))
		WHERE msg_from = ? AND msg_to = ? AND recalled_at IS NOT NULL
		  AND msg_id IN (`+placeholders+`)`, args...)
	return err
}

func (s *MessageReadService) ExpirePendingEncryptedMessages(ctx context.Context) (int64, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE message_deliveries SET encrypted_envelope = NULL, envelope_size = 0
		WHERE encrypted_envelope IS NOT NULL
		  AND sent_at < (NOW() - INTERVAL ? DAY)`, PendingMessageRetentionDays)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// RecordMessage retains the original API for file-transfer attribution.
func (s *MessageReadService) RecordMessage(ctx context.Context, msgID, msgFrom, msgTo string) error {
	_, _, err := s.AcceptMessage(ctx, msgID, msgFrom, msgTo)
	return err
}

// GetMessageDeliveries returns accepted IDs owned by the sender. Missing IDs are intentionally omitted.
func (s *MessageReadService) GetMessageDeliveries(ctx context.Context, msgFrom string, msgIDs []string) ([]MessageDelivery, error) {
	if len(msgIDs) == 0 {
		return []MessageDelivery{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(msgIDs)), ",")
	args := make([]any, 0, len(msgIDs)+1)
	args = append(args, msgFrom)
	for _, id := range msgIDs {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT msg_id, msg_from, msg_to, CAST(UNIX_TIMESTAMP(sent_at) * 1000 AS SIGNED)
		FROM message_deliveries
		WHERE msg_from = ? AND msg_id IN (`+placeholders+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	deliveries := make([]MessageDelivery, 0, len(msgIDs))
	for rows.Next() {
		var delivery MessageDelivery
		if err = rows.Scan(&delivery.MsgID, &delivery.MsgFrom, &delivery.MsgTo, &delivery.SentAt); err != nil {
			return nil, err
		}
		deliveries = append(deliveries, delivery)
	}
	return deliveries, rows.Err()
}

// DeleteMessage revokes the ownership of a message that has not yet been actually delivered (for example, a file offer cannot enter the receiving end buffer).
func (s *MessageReadService) DeleteMessage(ctx context.Context, msgID, msgFrom, msgTo string) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM message_deliveries
		WHERE msg_id = ? AND msg_from = ? AND msg_to = ?
		  AND NOT EXISTS (SELECT 1 FROM message_reads WHERE message_reads.msg_id = message_deliveries.msg_id)`,
		msgID, msgFrom, msgTo,
	)
	return err
}

// RecordReads records the first read time in batches (idempotent). INSERT ... SELECT also verifies that each message was actually sent by
// msgFrom is sent to readerChatID; an ID that does not match the delivery record will not create a receipt and will not appear in the return value.
func (s *MessageReadService) RecordReads(ctx context.Context, msgIDs []string, msgFrom, readerChatID string) ([]ReadReceipt, error) {
	if len(msgIDs) == 0 {
		return []ReadReceipt{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(msgIDs)), ",")
	insertArgs := make([]any, 0, len(msgIDs)+3)
	insertArgs = append(insertArgs, readerChatID, msgFrom, readerChatID)
	for _, id := range msgIDs {
		insertArgs = append(insertArgs, id)
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT IGNORE INTO message_reads (msg_id, msg_from, msg_to, reader_chat_id)
		SELECT msg_id, msg_from, msg_to, ?
		FROM message_deliveries
		WHERE msg_from = ? AND msg_to = ? AND msg_id IN (`+placeholders+`)`, insertArgs...)
	if err != nil {
		return nil, err
	}

	receipts, err := s.queryReceipts(ctx, msgIDs, msgFrom, readerChatID, placeholders)
	if err != nil {
		return nil, err
	}

	// Compatible with messages that have been saved on the client before the upgrade, but the server has not yet established message_deliveries.
	// The first segment of msg_id is the sending millisecond time (base36); only IDs that are earlier than the time when attribution tracking is enabled will take the compatible path.
	existing := make(map[string]struct{}, len(receipts))
	for _, receipt := range receipts {
		existing[receipt.MsgID] = struct{}{}
	}
	if len(existing) < len(msgIDs) {
		var trackingStartedAt int64
		if err = s.db.QueryRowContext(ctx,
			`SELECT CAST(UNIX_TIMESTAMP(tracking_started_at) * 1000 AS SIGNED) FROM message_delivery_config WHERE id = 1`,
		).Scan(&trackingStartedAt); err != nil {
			return nil, err
		}
		legacyIDs := make([]string, 0, len(msgIDs)-len(existing))
		for _, id := range msgIDs {
			if _, found := existing[id]; found {
				continue
			}
			if sentAt, ok := msgIDTimestamp(id); ok && sentAt < trackingStartedAt {
				legacyIDs = append(legacyIDs, id)
			}
		}
		if len(legacyIDs) > 0 {
			values := strings.TrimSuffix(strings.Repeat("(?,?,?,?),", len(legacyIDs)), ",")
			args := make([]any, 0, len(legacyIDs)*4)
			for _, id := range legacyIDs {
				args = append(args, id, msgFrom, readerChatID, readerChatID)
			}
			if _, err = s.db.ExecContext(ctx,
				`INSERT IGNORE INTO message_reads (msg_id, msg_from, msg_to, reader_chat_id) VALUES `+values,
				args...,
			); err != nil {
				return nil, err
			}
			receipts, err = s.queryReceipts(ctx, msgIDs, msgFrom, readerChatID, placeholders)
			if err != nil {
				return nil, err
			}
		}
	}
	return receipts, nil
}

func (s *MessageReadService) queryReceipts(ctx context.Context, msgIDs []string, msgFrom, readerChatID, placeholders string) ([]ReadReceipt, error) {
	queryArgs := make([]any, 0, len(msgIDs)+3)
	queryArgs = append(queryArgs, msgFrom, readerChatID, readerChatID)
	for _, id := range msgIDs {
		queryArgs = append(queryArgs, id)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT msg_id, CAST(UNIX_TIMESTAMP(read_at) * 1000 AS SIGNED)
		FROM message_reads
		WHERE msg_from = ? AND msg_to = ? AND reader_chat_id = ? AND msg_id IN (`+placeholders+`)`, queryArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	receipts := make([]ReadReceipt, 0, len(msgIDs))
	for rows.Next() {
		var receipt ReadReceipt
		if err = rows.Scan(&receipt.MsgID, &receipt.ReadAt); err != nil {
			return nil, err
		}
		receipts = append(receipts, receipt)
	}
	return receipts, rows.Err()
}

// GetReadMsgIDs Gets a list of message IDs that someone has read
func (s *MessageReadService) GetReadMsgIDs(ctx context.Context, msgTo, readerChatID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT msg_id FROM message_reads WHERE msg_to = ? AND reader_chat_id = ?`,
		msgTo, readerChatID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// DeleteOldReadReceipts only cleans up old delivery attributions that have generated receipts; message_reads itself is the sender
// Tombstones that must be retained even when offline for a long period of time cannot be deleted based on a fixed number of days.
func (s *MessageReadService) DeleteOldReadReceipts(ctx context.Context, olderThanDays int) (int64, error) {
	// First delete the delivery attributes that have been generated and have exceeded the retention period; unread messages must retain the attributes, otherwise the user will wait for a long time
	// When a message is first opened, the server will not be able to verify that it is a legitimate read receipt.
	res, err := s.db.ExecContext(ctx, `
		DELETE d FROM message_deliveries d
		INNER JOIN message_reads r ON r.msg_id = d.msg_id
		WHERE r.read_at < (NOW() - INTERVAL ? DAY)
		  AND d.encrypted_envelope IS NULL
		  AND (d.recalled_at IS NULL OR d.recall_applied_at IS NOT NULL)`,
		olderThanDays,
	)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// GetReadReceiptsForSender Returns read tombstones for a sender that have not yet acknowledged the application, grouped by reader.
// WebSocket re-invests when reconnecting to prevent the Redis offline queue from losing the burn-after-read start time after expiration.
func (s *MessageReadService) GetReadReceiptsForSender(ctx context.Context, msgFrom string) (map[string][]ReadReceipt, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT msg_id, reader_chat_id, CAST(UNIX_TIMESTAMP(read_at) * 1000 AS SIGNED)
		FROM message_reads WHERE msg_from = ? AND sender_applied = 0`, msgFrom)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string][]ReadReceipt)
	for rows.Next() {
		var receipt ReadReceipt
		var reader string
		if err = rows.Scan(&receipt.MsgID, &reader, &receipt.ReadAt); err != nil {
			return nil, err
		}
		result[reader] = append(result[reader], receipt)
	}
	return result, rows.Err()
}

// MarkReadReceiptsApplied Marks that the sender has applied receipts to local messages. The record itself is not deleted,
// So that the reader can still get the same authoritative first reading time when retrying read.
func (s *MessageReadService) MarkReadReceiptsApplied(ctx context.Context, msgIDs []string, msgFrom, readerChatID string) error {
	if len(msgIDs) == 0 {
		return nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(msgIDs)), ",")
	args := make([]any, 0, len(msgIDs)+2)
	args = append(args, msgFrom, readerChatID)
	for _, id := range msgIDs {
		args = append(args, id)
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE message_reads SET sender_applied = 1
		WHERE msg_from = ? AND reader_chat_id = ? AND msg_id IN (`+placeholders+`)`, args...)
	return err
}

// GetReadReceiptsByPeer queries the message msgFrom sent to readerChatID and the first reading time recorded by the server.
// Compensation query for missed read receipts while the sender is offline
func (s *MessageReadService) GetReadReceiptsByPeer(ctx context.Context, msgFrom, readerChatID string) ([]ReadReceipt, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT msg_id, CAST(UNIX_TIMESTAMP(read_at) * 1000 AS SIGNED)
		 FROM message_reads WHERE msg_from = ? AND reader_chat_id = ?`,
		msgFrom, readerChatID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var receipts []ReadReceipt
	for rows.Next() {
		var receipt ReadReceipt
		if err = rows.Scan(&receipt.MsgID, &receipt.ReadAt); err != nil {
			return nil, err
		}
		receipts = append(receipts, receipt)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return receipts, nil
}
