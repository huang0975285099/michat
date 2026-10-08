-- Group attachment support: group_db_id column + per-member ack table
-- Group attachments expire after 3 days (DM keeps 7 days).

ALTER TABLE attachments ADD COLUMN group_db_id BIGINT UNSIGNED NULL;
ALTER TABLE attachments ADD INDEX idx_attachments_group (group_db_id, status, expires_at);

CREATE TABLE IF NOT EXISTS attachment_acks (
  attachment_id   CHAR(36)       NOT NULL,
  member_user_id  BIGINT UNSIGNED NOT NULL,
  acked_at        DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (attachment_id, member_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
