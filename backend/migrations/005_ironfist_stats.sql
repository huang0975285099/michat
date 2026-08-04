-- Tekken battle statistics and achievement system database migration
-- Execution: mysql -u root -p e2eechat < 005_ironfist_stats.sql

USE e2eechat;

-- ─────────────────────────────────────────────────────
-- Table 1: User battle statistics (one row per person)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ironfist_stats (
  user_id            BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  pvp_wins           INT UNSIGNED NOT NULL DEFAULT 0,
  pvp_losses         INT UNSIGNED NOT NULL DEFAULT 0,
  pvp_draws          INT UNSIGNED NOT NULL DEFAULT 0,
  pve_wins           INT UNSIGNED NOT NULL DEFAULT 0,
  pve_losses         INT UNSIGNED NOT NULL DEFAULT 0,
  pve_draws          INT UNSIGNED NOT NULL DEFAULT 0,
  current_win_streak INT UNSIGNED NOT NULL DEFAULT 0,   -- Current winning streak (return to zero if not winning)
  max_win_streak     INT UNSIGNED NOT NULL DEFAULT 0,   -- Highest winning streak in history
  total_battles      INT UNSIGNED NOT NULL DEFAULT 0,   -- Total number of battles
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_is_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='铁拳对战统计';

-- ─────────────────────────────────────────────────────
-- Table 2: Achievement unlock records (one row per user per achievement)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ironfist_achievements (
  user_id         BIGINT UNSIGNED NOT NULL,
  achievement_code VARCHAR(32) NOT NULL,                -- first_battle / hundred_battles / win_streak_5 / counter_master / low_hp_comeback / high_hp_win
  unlocked_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, achievement_code),
  CONSTRAINT fk_ia_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='铁拳成就解锁记录';
