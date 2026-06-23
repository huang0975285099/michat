package service

import (
	"context"
	"database/sql"
)

type MessageReadService struct {
	db *sql.DB
}

func NewMessageReadService(db *sql.DB) *MessageReadService {
	return &MessageReadService{db: db}
}

// RecordRead 记录已读回执（幂等）
func (s *MessageReadService) RecordRead(ctx context.Context, msgID, msgFrom, msgTo, readerChatID string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT IGNORE INTO message_reads (msg_id, msg_from, msg_to, reader_chat_id) VALUES (?, ?, ?, ?)`,
		msgID, msgFrom, msgTo, readerChatID,
	)
	return err
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

// DeleteOldReadReceipts 清理过期的已读回执记录。
// 已读回执只用于「发送方离线期间错过回执」的补偿查询；超过保留期后，
// 相关消息早已超出阅后即焚（2 小时）与撤回（6 天）窗口，记录不再有用。
// 定期清理避免 message_reads 表无限增长。返回删除行数。
func (s *MessageReadService) DeleteOldReadReceipts(ctx context.Context, olderThanDays int) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM message_reads WHERE read_at < (NOW() - INTERVAL ? DAY)`,
		olderThanDays,
	)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// GetReadReceiptsByPeer 查询 msgFrom 发送给 readerChatID 的消息中已被阅读的 ID 列表
// 用于发送方离线期间错过已读回执时的补偿查询
func (s *MessageReadService) GetReadReceiptsByPeer(ctx context.Context, msgFrom, readerChatID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT msg_id FROM message_reads WHERE msg_from = ? AND reader_chat_id = ?`,
		msgFrom, readerChatID,
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
