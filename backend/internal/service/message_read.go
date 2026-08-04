package service

import (
	"context"
	"database/sql"
	"fmt"
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
func (s *MessageReadService) RecordMessage(ctx context.Context, msgID, msgFrom, msgTo string) error {
	if _, err := s.db.ExecContext(ctx,
		`INSERT IGNORE INTO message_deliveries (msg_id, msg_from, msg_to) VALUES (?, ?, ?)`,
		msgID, msgFrom, msgTo,
	); err != nil {
		return err
	}

	var storedFrom, storedTo string
	if err := s.db.QueryRowContext(ctx,
		`SELECT msg_from, msg_to FROM message_deliveries WHERE msg_id = ?`, msgID,
	).Scan(&storedFrom, &storedTo); err != nil {
		return err
	}
	if storedFrom != msgFrom || storedTo != msgTo {
		return fmt.Errorf("message id already belongs to another delivery")
	}
	return nil
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
		WHERE r.read_at < (NOW() - INTERVAL ? DAY)`,
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
