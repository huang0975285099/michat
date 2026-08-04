-- Chinese version points ledger repair:
-- 1. The pledge and the real loss are separated into pvp_stake;
-- 2. Fixed the old version’s cancellation of matching records that were mistakenly marked as pvp_win;
-- 3. Corrected the 10th PvE game where the daily accumulation of 500 was missed due to the assignment sequence of MySQL ON DUPLICATE KEY.

USE e2eechat;

ALTER TABLE fist_transactions MODIFY COLUMN type ENUM(
  'pve_reward',
  'pvp_stake',
  'pvp_win',
  'pvp_loss',
  'pvp_refund',
  'pvp_fee',
  'tournament_entry',
  'tournament_prize',
  'referral_reward',
  'staking_reward',
  'nft_mint',
  'withdraw',
  'deposit',
  'system_adjust'
) NOT NULL;

UPDATE fist_transactions
SET type = 'pvp_stake'
WHERE type = 'pvp_loss' AND remark LIKE 'PVP 质押%';

UPDATE fist_transactions
SET type = 'pvp_refund'
WHERE type = 'pvp_win' AND remark LIKE 'PVP 取消匹配%';

UPDATE pve_daily_progress
SET earned_today = wins_count * 500 + IF(wins_count >= 10, 1000, 0)
WHERE earned_today <> wins_count * 500 + IF(wins_count >= 10, 1000, 0);
