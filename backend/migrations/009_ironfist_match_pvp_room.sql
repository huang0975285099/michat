-- ironfist_matches 增加 pvp_room_id：真实 PVP 上报的幂等去重锚点
-- 同一玩家对同一 PVP 房间只记一条统计与战绩；pve/friend 该列为 NULL。
-- MySQL 唯一索引允许多个 NULL，故 pve/friend 不受 (user_id, pvp_room_id) 唯一约束限制。
-- ADD COLUMN / ADD UNIQUE KEY 重复执行分别触发 1060 / 1061，由 AutoMigrate 静默跳过。

USE e2eechat;

ALTER TABLE ironfist_matches ADD COLUMN pvp_room_id BIGINT UNSIGNED NULL;
ALTER TABLE ironfist_matches ADD UNIQUE KEY uniq_im_user_pvproom (user_id, pvp_room_id);
