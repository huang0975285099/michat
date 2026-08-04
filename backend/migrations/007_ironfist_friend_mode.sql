-- Friend battle mode has independent statistics and is counted separately from PvP/PvE; it is not included in achievements and total games.
-- Note: ADD COLUMN triggers MySQL 1060 when the column already exists (silently skipped by AutoMigrate)

USE e2eechat;

-- 1. ironfist_stats adds friends’ victory and defeat rankings
ALTER TABLE ironfist_stats ADD COLUMN friend_wins   INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE ironfist_stats ADD COLUMN friend_losses INT UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE ironfist_stats ADD COLUMN friend_draws  INT UNSIGNED NOT NULL DEFAULT 0;

-- 2. ironfist_matches.mode adds 'friend' enumeration value (MODIFY COLUMN idempotent)
ALTER TABLE ironfist_matches MODIFY COLUMN mode ENUM('pve','pvp','friend') NOT NULL;
