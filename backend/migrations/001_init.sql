-- E2EE Chat 初始化建表脚本
-- 执行: mysql -u root -p e2eechat < 001_init.sql

CREATE DATABASE IF NOT EXISTS e2eechat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE e2eechat;

-- 用户身份表（只存公开信息，私钥永远不上服务器）
CREATE TABLE IF NOT EXISTS users (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  chat_id     CHAR(9)      NOT NULL UNIQUE,   -- 格式 NNNN-AAAA（如 1234-ABCD）
  nickname    VARCHAR(64)  NOT NULL,           -- 自动生成：颜色+动物
  public_key  TEXT         NOT NULL,           -- X25519 公钥（Base64 URL 编码）
  is_ready    TINYINT(1)   NOT NULL DEFAULT 0, -- 0=待上传公钥 1=完成注册
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen   DATETIME     NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 好友申请表
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

-- 好友关系表（双向存储，方便查询）
CREATE TABLE IF NOT EXISTS friendships (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  friend_id   BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pair (user_id, friend_id),
  CONSTRAINT fk_fs_user   FOREIGN KEY (user_id)   REFERENCES users(id),
  CONSTRAINT fk_fs_friend FOREIGN KEY (friend_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
