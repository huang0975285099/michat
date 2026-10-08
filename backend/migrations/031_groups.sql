-- Admin-managed group chat tables
-- v1 scope: admin creates/dissolves groups, adds/removes members, mutes members;
-- users only chat and self-recall their own messages/files.

CREATE TABLE IF NOT EXISTS `groups` (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  group_id    CHAR(14)     NOT NULL UNIQUE,   -- G- + 12 uppercase hex
  name        VARCHAR(64)  NOT NULL,          -- only plaintext the server persists
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS group_members (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  group_db_id BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  state       ENUM('active','removed') NOT NULL DEFAULT 'active',
  muted_until DATETIME(3) NULL,              -- NULL = not muted; past = not muted
  joined_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_member (group_db_id, user_id),
  KEY idx_member_user (user_id),
  CONSTRAINT fk_gm_group FOREIGN KEY (group_db_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_gm_user  FOREIGN KEY (user_id)     REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One ciphertext per message; per-member key envelopes in group_message_deliveries
CREATE TABLE IF NOT EXISTS group_messages (
  msg_id       VARCHAR(64)  NOT NULL PRIMARY KEY,  -- client-generated, ^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$
  group_db_id  BIGINT UNSIGNED NOT NULL,
  sender_chat_id CHAR(9)   NOT NULL,
  iv           VARCHAR(32)  NOT NULL,
  ciphertext   MEDIUMTEXT   NOT NULL,
  envelope_size INT UNSIGNED NOT NULL DEFAULT 0,
  sent_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  recalled_at  DATETIME(3)  NULL,   -- user self-recall tombstone
  deleted_at   DATETIME(3)  NULL,   -- admin deletion tombstone
  KEY idx_group_sent (group_db_id, sent_at),
  CONSTRAINT fk_gm_msg_group FOREIGN KEY (group_db_id) REFERENCES `groups`(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS group_message_deliveries (
  msg_id           VARCHAR(64)  NOT NULL,
  member_chat_id   CHAR(9)      NOT NULL,
  key_envelope     MEDIUMTEXT   NOT NULL,   -- JSON: ephemeral_pub_key, iv, key_ciphertext
  applied_at       DATETIME(3)  NULL,       -- recipient confirmed local persistence
  removed_applied_at DATETIME(3) NULL,      -- shared by recall and delete tombstones
  PRIMARY KEY (msg_id, member_chat_id),
  KEY idx_pending_member (member_chat_id, applied_at),
  CONSTRAINT fk_gmd_msg FOREIGN KEY (msg_id) REFERENCES group_messages(msg_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
