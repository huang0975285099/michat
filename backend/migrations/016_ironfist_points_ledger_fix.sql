-- 中国版积分账本修复：
-- 1. 质押与真正的输局分离为 pvp_stake；
-- 2. 修正旧版取消匹配被误标为 pvp_win 的记录；
-- 3. 修正第 10 场 PvE 因 MySQL ON DUPLICATE KEY 赋值顺序少记 500 的每日累计。

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
