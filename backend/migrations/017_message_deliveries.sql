-- 消息投递归属表：已读回执只能由真实接收者为真实消息创建。
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

-- 记录“服务器开始持久化消息归属”的时间。旧客户端本地已有、但服务器尚无归属记录的
-- 消息，可依据消息 ID 内嵌的发送时间在升级窗口内兼容生成已读回执。
CREATE TABLE IF NOT EXISTS message_delivery_config (
  id                  TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  tracking_started_at DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO message_delivery_config (id) VALUES (1);
