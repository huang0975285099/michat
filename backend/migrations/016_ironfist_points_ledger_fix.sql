-- Chinese version points ledger repair:
-- 1. The pledge and the real loss are separated into pvp_stake;
-- 2. Fixed the old version’s cancellation of matching records that were mistakenly marked as pvp_win;
-- 3. Corrected the 10th PvE game where the daily accumulation of 500 was missed due to the assignment sequence of MySQL ON DUPLICATE KEY.

USE e2eechat;

-- Do not narrow this back to an ENUM. Newer game modes add transaction types,
-- and startup migrations may be replayed after those values already exist.
ALTER TABLE fist_transactions MODIFY COLUMN type VARCHAR(64) NOT NULL;

UPDATE fist_transactions
SET type = 'pvp_stake'
WHERE type = 'pvp_loss' AND remark LIKE 'PVP 质押%';

UPDATE fist_transactions
SET type = 'pvp_refund'
WHERE type = 'pvp_win' AND remark LIKE 'PVP 取消匹配%';

UPDATE pve_daily_progress
SET earned_today = wins_count * 500 + IF(wins_count >= 10, 1000, 0)
WHERE earned_today <> wins_count * 500 + IF(wins_count >= 10, 1000, 0);
