-- ironfist_matches adds pvp_room_id: the idempotent deduplication anchor reported by real PVP
-- The same player will only record one statistics and record for the same PVP room; the pve/friend column is NULL.
-- MySQL unique index allows multiple NULLs, so pve/friend is not subject to the (user_id, pvp_room_id) unique constraint.
-- Repeated execution of ADD COLUMN / ADD UNIQUE KEY triggers 1060 / 1061 respectively, which are silently skipped by AutoMigrate.

USE e2eechat;

ALTER TABLE ironfist_matches ADD COLUMN pvp_room_id BIGINT UNSIGNED NULL;
ALTER TABLE ironfist_matches ADD UNIQUE KEY uniq_im_user_pvproom (user_id, pvp_room_id);
