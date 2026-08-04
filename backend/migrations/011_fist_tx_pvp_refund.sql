-- Fixed: fist_transactions.type enum missing 'pvp_refund'.
-- The backend writeFistTx writes 'pvp_refund' in all refund paths such as match cancellation/tie settlement/timeout settlement, etc.
-- If the old enumeration does not contain this value, 1265 (Data truncated) will be triggered, causing the entire refund transaction to be rolled back——
-- The performance is "unable to cancel the match, no refund for draw/timeout, and the pledge is locked".
-- MODIFY COLUMN is idempotent: if the target enumeration is consistent, repeated execution will not report an error.

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
