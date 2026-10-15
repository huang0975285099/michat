CREATE TABLE IF NOT EXISTS group_message_reads (
  msg_id VARCHAR(64) NOT NULL,
  member_chat_id CHAR(9) NOT NULL,
  read_at DATETIME(3) NULL,
  proof TEXT NULL,
  public_key TEXT NULL,
  PRIMARY KEY (msg_id, member_chat_id),
  CONSTRAINT fk_group_read_message FOREIGN KEY (msg_id) REFERENCES group_messages(msg_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO group_message_reads (msg_id, member_chat_id)
SELECT msg_id, member_chat_id FROM group_message_deliveries;
