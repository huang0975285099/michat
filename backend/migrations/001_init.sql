-- E2EE Chat initialization table creation script
-- Execution: mysql -u root -p e2eechat < 001_init.sql

CREATE DATABASE IF NOT EXISTS e2eechat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE e2eechat;

-- User identity table (only public information is stored, private keys are never uploaded to the server)
CREATE TABLE IF NOT EXISTS users (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  chat_id     CHAR(9)      NOT NULL UNIQUE,   -- Format NNNN-AAAA (such as 1234-ABCD)
  nickname    VARCHAR(64)  NOT NULL,           -- Automatically generated: color + animal
  public_key  TEXT         NOT NULL,           -- X25519 public key (Base64 URL encoded)
  is_ready    TINYINT(1)   NOT NULL DEFAULT 0, -- 0=Public key to be uploaded 1=Registration completed
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen   DATETIME     NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Friend application form
CREATE TABLE IF NOT EXISTS friend_requests (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  from_user_id BIGINT UNSIGNED NOT NULL,
  to_user_id   BIGINT UNSIGNED NOT NULL,
  status       ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_request (from_user_id, to_user_id),
  KEY idx_to_user (to_user_id),
  CONSTRAINT fk_fr_from FOREIGN KEY (from_user_id) REFERENCES users(id),
  CONSTRAINT fk_fr_to   FOREIGN KEY (to_user_id)   REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Friend relationship table (two-way storage, easy to query)
CREATE TABLE IF NOT EXISTS friendships (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  friend_id   BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pair (user_id, friend_id),
  CONSTRAINT fk_fs_user   FOREIGN KEY (user_id)   REFERENCES users(id),
  CONSTRAINT fk_fs_friend FOREIGN KEY (friend_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
