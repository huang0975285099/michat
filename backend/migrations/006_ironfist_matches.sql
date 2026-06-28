-- 铁拳逐局对战明细数据库迁移
-- 执行: mysql -u root -p e2eechat < 006_ironfist_matches.sql

USE e2eechat;

-- 每完成一局对战记一行，用于「对战记录」的逐局明细展示。
-- detail 存逐回合 JSON：[{"r":1,"p":"attack","o":"defend","pd":0,"od":8}, ...]
--   r=回合数 p=我方出招 o=对手出招 pd=我方受到伤害 od=对手受到伤害
CREATE TABLE IF NOT EXISTS ironfist_matches (
  id            BIGINT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED  NOT NULL,
  mode          ENUM('pve','pvp') NOT NULL,
  result        ENUM('win','lose','draw','doubleLose') NOT NULL,
  player_hp     SMALLINT         NOT NULL DEFAULT 0,    -- 终局我方 HP
  opponent_hp   SMALLINT         NOT NULL DEFAULT 0,    -- 终局对手 HP
  rounds        TINYINT UNSIGNED NOT NULL DEFAULT 0,    -- 总回合数
  opponent_name VARCHAR(64)      NULL,                  -- 对手昵称（PvP）/「电脑」
  detail        JSON             NULL,                  -- 逐回合明细
  created_at    DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_im_user (user_id, id),
  CONSTRAINT fk_im_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='铁拳逐局对战明细';
