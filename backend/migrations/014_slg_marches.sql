-- SLG 玩家部队位置同步（行军/出征广播 + 玩家碰撞遭遇战存证）
CREATE TABLE IF NOT EXISTS slg_marches (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  world_id BIGINT UNSIGNED NOT NULL,
  march_uid VARCHAR(64) NOT NULL,
  owner_chat_id VARCHAR(64) NOT NULL,
  owner_name VARCHAR(64) NOT NULL,
  intent VARCHAR(16) NOT NULL,
  from_x INT NOT NULL,
  from_y INT NOT NULL,
  to_x INT NOT NULL,
  to_y INT NOT NULL,
  path_json TEXT NOT NULL,
  depart_at_ms BIGINT NOT NULL,
  arrive_at_ms BIGINT NOT NULL,
  units_json TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_world_march (world_id, march_uid),
  KEY idx_world_status (world_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
