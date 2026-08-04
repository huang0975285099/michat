-- Message delivery attribution table: Read receipts can only be created by real recipients for real messages.
CREATE TABLE IF NOT EXISTS message_deliveries (
  msg_id   VARCHAR(64) NOT NULL PRIMARY KEY,
  msg_from CHAR(9)     NOT NULL,
  msg_to   CHAR(9)     NOT NULL,
  sent_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_delivery_pair (msg_from, msg_to),
  KEY idx_delivery_sent_at (sent_at),
  CONSTRAINT fk_md_from FOREIGN KEY (msg_from) REFERENCES users(chat_id),
  CONSTRAINT fk_md_to   FOREIGN KEY (msg_to)   REFERENCES users(chat_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Record the time when "the server starts persisting message attribution". The old client already exists locally, but the server has no ownership record.
-- Messages can generate read receipts within the upgrade window based on the sending time embedded in the message ID.
CREATE TABLE IF NOT EXISTS message_delivery_config (
  id                  TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  tracking_started_at DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO message_delivery_config (id) VALUES (1);
