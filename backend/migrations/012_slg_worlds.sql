-- 九州征途（SLG）多人世界表
-- 一个赛季一个世界（共享地图种子），玩家加入世界后获得出生点，
-- 各自拥有独立领地与主城。领地变更通过 WebSocket 实时广播给同世界玩家。
USE e2eechat;

CREATE TABLE IF NOT EXISTS slg_worlds (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  seed        INT              NOT NULL,               -- 地图种子（同 seed 同图）
  season      INT              NOT NULL DEFAULT 1,      -- 赛季编号
  status      ENUM('active','ended') NOT NULL DEFAULT 'active',
  created_at  DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at    DATETIME(3)      NULL,
  KEY idx_slgw_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='SLG 赛季世界';

CREATE TABLE IF NOT EXISTS slg_players (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  world_id    BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  chat_id     VARCHAR(64)     NOT NULL,
  nickname    VARCHAR(128)    NOT NULL DEFAULT '',
  spawn_x     INT             NOT NULL,
  spawn_y     INT             NOT NULL,
  -- 玩家完整状态 JSON（资源/主城等级/建筑/武将/行军/编队/战法/装备等，与前端存档格式一致）
  state_json  LONGTEXT        NOT NULL,
  last_active DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_slg_player (world_id, user_id),
  KEY idx_slgp_chat (chat_id),
  CONSTRAINT fk_slgp_world FOREIGN KEY (world_id) REFERENCES slg_worlds(id),
  CONSTRAINT fk_slgp_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='SLG 玩家状态';

CREATE TABLE IF NOT EXISTS slg_territories (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  world_id      BIGINT UNSIGNED NOT NULL,
  x             INT             NOT NULL,
  y             INT             NOT NULL,
  owner_chat_id VARCHAR(64)     NOT NULL,               -- 领地主（chat_id）；NPC 城池由系统占领
  owner_name    VARCHAR(128)    NOT NULL DEFAULT '',     -- 领主昵称（冗余，前端渲染用）
  is_city       TINYINT(1)      NOT NULL DEFAULT 0,
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_slg_tile (world_id, x, y),
  KEY idx_slgt_owner (owner_chat_id),
  CONSTRAINT fk_slgt_world FOREIGN KEY (world_id) REFERENCES slg_worlds(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='SLG 领地归属';
