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

// RecordMessage 记录服务器实际接受的消息归属。相同 ID 只允许属于同一对发送者/接收者，
// 从而防止攻击者复用他人的 msg_id 伪造已读回执。
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

// DeleteMessage 撤销尚未真正投递的消息归属（例如文件 offer 无法进入接收端缓冲）。
func (s *MessageReadService) DeleteMessage(ctx context.Context, msgID, msgFrom, msgTo string) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM message_deliveries
		WHERE msg_id = ? AND msg_from = ? AND msg_to = ?
		  AND NOT EXISTS (SELECT 1 FROM message_reads WHERE message_reads.msg_id = message_deliveries.msg_id)`,
		msgID, msgFrom, msgTo,
	)
	return err
}

// RecordReads 批量记录首次已读时间（幂等）。INSERT ... SELECT 同时验证每条消息确实由
// msgFrom 发给 readerChatID；不存在匹配投递记录的 ID 不会创建回执，也不会出现在返回值。
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

	// 兼容升级前已经保存在客户端、但服务器尚未建立 message_deliveries 的消息。
	// msg_id 的首段是发送毫秒时间（base36）；只有早于归属追踪启用时间的 ID 才走兼容路径。
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

// GetReadMsgIDs 获取某人已读的消息 ID 列表
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

// DeleteOldReadReceipts 仅清理已经产生回执的旧投递归属；message_reads 本身是发送方
// 长期离线时仍必须保留的阅后即焚 tombstone，不能按固定天数删除。
func (s *MessageReadService) DeleteOldReadReceipts(ctx context.Context, olderThanDays int) (int64, error) {
	// 先删除已经产生且超过保留期的投递归属；未读消息必须保留归属，否则用户很久后
	// 首次打开消息时，服务器将无法验证其合法已读回执。
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

// GetReadReceiptsForSender 返回某发送者尚未确认应用的已读 tombstone，按阅读者分组。
// WebSocket 重连时补投，避免 Redis 离线队列过期后丢失阅后即焚起始时间。
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

// MarkReadReceiptsApplied 标记发送方已经把回执应用到本地消息。记录本身不删除，
// 以便阅读方重试 read 时仍能拿到同一个权威首次阅读时间。
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

// GetReadReceiptsByPeer 查询 msgFrom 发送给 readerChatID 的消息及服务器记录的首次阅读时间。
// 用于发送方离线期间错过已读回执时的补偿查询
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
