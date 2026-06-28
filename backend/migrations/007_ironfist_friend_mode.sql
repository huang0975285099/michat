-- 好友对战模式独立统计，与 PvP/PvE 分开计数；不计入成就与总场次
-- 注意：ADD COLUMN 在已有列时会触发 MySQL 1060（由 AutoMigrate 静默跳过）

USE e2eechat;

-- 1. ironfist_stats 增加好友对战胜负平列
ALTER TABLE ironfist_stats ADD COLUMN friend_wins   INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE ironfist_stats ADD COLUMN friend_losses INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE ironfist_stats ADD COLUMN friend_draws  INT UNSIGNED NOT NULL DEFAULT 0;

-- 2. ironfist_matches.mode 加入 'friend' 枚举值（MODIFY COLUMN 幂等）
ALTER TABLE ironfist_matches MODIFY COLUMN mode ENUM('pve','pvp','friend') NOT NULL;
