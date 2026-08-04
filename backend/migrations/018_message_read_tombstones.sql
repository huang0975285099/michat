-- 已读回执是阅后即焚的服务端 tombstone：即使阅读方随后注销，发送方仍需在下次上线时
-- 获得首次阅读时间。因此移除对 users 的外键，账号删除时仅清理“发送方已删除”的记录。
ALTER TABLE message_reads DROP FOREIGN KEY fk_mr_from;
ALTER TABLE message_reads DROP FOREIGN KEY fk_mr_to;

-- 保留首次阅读时间供阅读方幂等重试；发送方确认已将回执写入本地后停止登录回放。
ALTER TABLE message_reads ADD COLUMN sender_applied TINYINT(1) NOT NULL DEFAULT 0 AFTER read_at;
ALTER TABLE message_reads ADD INDEX idx_pending_sender (msg_from, sender_applied);
