-- Offline attachments are opaque encrypted chunks. File keys, filenames and
-- MIME types are deliberately absent from the server schema.
CREATE TABLE IF NOT EXISTS attachments (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  owner_user_id BIGINT UNSIGNED NOT NULL,
  recipient_user_id BIGINT UNSIGNED NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  ciphertext_size BIGINT UNSIGNED NOT NULL,
  chunk_size INT UNSIGNED NOT NULL,
  chunk_count INT UNSIGNED NOT NULL,
  received_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'uploading',
  expires_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  acknowledged_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_attachments_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_attachments_recipient FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_attachments_owner_quota (owner_user_id, status, expires_at),
  INDEX idx_attachments_recipient (recipient_user_id, status, expires_at),
  INDEX idx_attachments_cleanup (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS attachment_chunks (
  attachment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  chunk_index INT UNSIGNED NOT NULL,
  ciphertext_size INT UNSIGNED NOT NULL,
  ciphertext_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (attachment_id, chunk_index),
  CONSTRAINT fk_attachment_chunks_attachment FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
