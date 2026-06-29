-- $FIST 代币系统数据库迁移
-- 执行: mysql -u root -p e2eechat < 004_fist_token.sql

USE e2eechat;

-- ─────────────────────────────────────────────────────
-- 表1：用户 $FIST 账户（每人一行，存当前余额）
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fist_accounts (
  user_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  balance       BIGINT          NOT NULL DEFAULT 0,   -- 当前余额（单位：$FIST 整数）
  total_earned  BIGINT UNSIGNED NOT NULL DEFAULT 0,   -- 历史累计收入（用于统计展示）
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_fa_user    FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT chk_fa_balance CHECK (balance >= 0)      -- 余额不能为负（MySQL 8.0+）
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户 $FIST 账户余额';

-- ─────────────────────────────────────────────────────
-- 表2：$FIST 流水账本（每次变动记一行，只增不改）
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fist_transactions (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id        BIGINT UNSIGNED NOT NULL,
  -- amount 正数=收入，负数=支出
  amount         BIGINT          NOT NULL,
  balance_after  BIGINT          NOT NULL,             -- 本次变动后的余额快照
  type           ENUM(
                   'pve_reward',      -- PvE 胜局奖励
                   'pvp_win',         -- PvP 赢局到手金额
                   'pvp_loss',        -- PvP 输局扣款
                   'pvp_refund',      -- PvP 取消/平局/超时退款
                   'pvp_fee',         -- PvP 赢局手续费（赢家被扣）
                   'tournament_entry',-- 锦标赛报名费
                   'tournament_prize',-- 锦标赛奖励
                   'referral_reward', -- 邀请奖励
                   'staking_reward',  -- 质押分红
                   'nft_mint',        -- NFT 铸造消耗（负数）
                   'withdraw',        -- 提现到链上钱包（负数）
                   'deposit',         -- 从链上充值（正数）
                   'system_adjust'    -- 系统人工调整（含说明）
                 ) NOT NULL,
  ref_id         VARCHAR(64)     NULL,                 -- 关联来源 ID（match_id、tournament_id 等）
  remark         VARCHAR(128)    NULL,                 -- 人类可读备注（如"第3场 PvE 胜局"）
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),  -- 毫秒精度
  KEY idx_ft_user_time (user_id, created_at),         -- 查明细的核心索引
  KEY idx_ft_type      (type),
  CONSTRAINT fk_ft_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='$FIST 资金流水（只增不改）';

-- ─────────────────────────────────────────────────────
-- 表3：PvE 每日进度（防刷核心）
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pve_daily_progress (
  user_id      BIGINT UNSIGNED NOT NULL,
  date         DATE            NOT NULL,
  wins_count   TINYINT UNSIGNED NOT NULL DEFAULT 0,   -- 今日有效胜局数（0-10）
  earned_today BIGINT UNSIGNED  NOT NULL DEFAULT 0,   -- 今日累计获得 $FIST
  PRIMARY KEY (user_id, date),
  CONSTRAINT fk_pdp_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PvE 每日胜局进度（UTC 日期）';

-- ─────────────────────────────────────────────────────
-- 表4：PvP 对局记录
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pvp_matches (
  match_id     CHAR(36)        NOT NULL PRIMARY KEY,  -- UUID
  room_tier    TINYINT UNSIGNED NOT NULL,              -- 1=铜拳(100) 2=银拳(1000) 3=金拳(10000)
  player_a_id  BIGINT UNSIGNED NOT NULL,
  player_b_id  BIGINT UNSIGNED NOT NULL,
  stake_amount BIGINT UNSIGNED NOT NULL,              -- 单人入场金额
  winner_id    BIGINT UNSIGNED NULL,                  -- NULL=平局/进行中
  status       ENUM('pending','playing','finished','cancelled') NOT NULL DEFAULT 'pending',
  tx_hash      VARCHAR(88)     NULL,                  -- 链上交易哈希（金拳场有）
  started_at   DATETIME        NULL,
  finished_at  DATETIME        NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pm_player_a (player_a_id),
  KEY idx_pm_player_b (player_b_id),
  KEY idx_pm_status   (status),
  CONSTRAINT fk_pm_a FOREIGN KEY (player_a_id) REFERENCES users(id),
  CONSTRAINT fk_pm_b FOREIGN KEY (player_b_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PvP 对局记录';

-- ─────────────────────────────────────────────────────
-- 表5：对局回合记录（用于战绩回放和 Merkle 存证）
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pvp_rounds (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  match_id     CHAR(36)        NOT NULL,
  round_num    TINYINT UNSIGNED NOT NULL,
  action_a     ENUM('attack','defend','charge','counter') NOT NULL,
  action_b     ENUM('attack','defend','charge','counter') NOT NULL,
  damage_a     SMALLINT UNSIGNED NOT NULL DEFAULT 0,  -- player_a 本回合受到的伤害
  damage_b     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  hp_a_after   SMALLINT UNSIGNED NOT NULL,            -- 本回合结束后 player_a 的 HP
  hp_b_after   SMALLINT UNSIGNED NOT NULL,
  created_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pr_match (match_id),
  CONSTRAINT fk_pr_match FOREIGN KEY (match_id) REFERENCES pvp_matches(match_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PvP 回合记录';
