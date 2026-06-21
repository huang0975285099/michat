-- 消息已读回执表
CREATE TABLE IF NOT EXISTS message_reads (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  msg_id         VARCHAR(64)     NOT NULL,
  msg_from       CHAR(9)         NOT NULL,  -- 消息发送者 chat_id
  msg_to         CHAR(9)         NOT NULL,  -- 消息接收者 chat_id
  reader_chat_id CHAR(9)         NOT NULL,  -- 已读者 chat_id
  read_at        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_read (msg_id, reader_chat_id),
  KEY idx_msg_to (msg_to, reader_chat_id),
  CONSTRAINT fk_mr_from FOREIGN KEY (msg_from) REFERENCES users(chat_id),
  CONSTRAINT fk_mr_to   FOREIGN KEY (msg_to)   REFERENCES users(chat_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
