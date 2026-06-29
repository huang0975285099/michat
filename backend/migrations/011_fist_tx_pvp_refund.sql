-- 修复：fist_transactions.type 枚举缺少 'pvp_refund'。
-- 后端 writeFistTx 在取消撮合/平局结算/超时兜底等退款路径均写入 'pvp_refund'，
-- 旧枚举不含该值会触发 1265（Data truncated），导致整个退款事务回滚——
-- 表现为"无法取消匹配、平局/超时不退款、质押被锁死"。
-- MODIFY COLUMN 幂等：目标枚举一致时重复执行不报错。

USE e2eechat;

ALTER TABLE fist_transactions MODIFY COLUMN type ENUM(
  'pve_reward',
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
