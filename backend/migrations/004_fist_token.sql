-- $FIST Token System Database Migration
-- Execution: mysql -u root -p e2eechat < 004_fist_token.sql

USE e2eechat;

-- ─────────────────────────────────────────────────────
-- Table 1: User $FIST account (one row per person, save current balance)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fist_accounts (
  user_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  balance       BIGINT          NOT NULL DEFAULT 0,   -- Current balance (unit: $FIST integer)
  total_earned  BIGINT UNSIGNED NOT NULL DEFAULT 0,   -- Historical cumulative income (for statistical display)
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_fa_user    FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT chk_fa_balance CHECK (balance >= 0)      -- Balance cannot be negative (MySQL 8.0+)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户 $FIST 账户余额';

-- ─────────────────────────────────────────────────────
-- Table 2: $FIST running ledger (record one line for each change, only additions but no changes)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fist_transactions (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id        BIGINT UNSIGNED NOT NULL,
  -- amount positive number=income, negative number=expense
  amount         BIGINT          NOT NULL,
  balance_after  BIGINT          NOT NULL,             -- Balance snapshot after this change
  type           ENUM(
                   'pve_reward',      -- PvE win rewards
                   'pvp_stake',       -- PvP Entry Staking
                   'pvp_win',         -- PvP winnings amount
                   'pvp_loss',        -- PvP loss deduction
                   'pvp_refund',      -- PvP Cancellation/Draw/Timeout Refund
                   'pvp_fee',         -- PvP winning fee (winner deducted)
                   'tournament_entry',-- Tournament entry fee
                   'tournament_prize',-- Tournament rewards
                   'referral_reward', -- Invitation rewards
                   'staking_reward',  -- Pledge dividends
                   'nft_mint',        -- NFT minting cost (negative number)
                   'withdraw',        -- Withdraw to on-chain wallet (negative number)
                   'deposit',         -- Recharge from the chain (positive number)
                   'system_adjust'    -- System manual adjustment (with instructions)
                 ) NOT NULL,
  ref_id         VARCHAR(64)     NULL,                 -- Association source ID (match_id, tournament_id, etc.)
  remark         VARCHAR(128)    NULL,                 -- Human readable comments (e.g. "3rd PvE win")
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),  -- millisecond precision
  KEY idx_ft_user_time (user_id, created_at),         -- Find detailed core index
  KEY idx_ft_type      (type),
  CONSTRAINT fk_ft_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='$FIST 资金流水（只增不改）';

-- ─────────────────────────────────────────────────────
-- Table 3: PvE daily progress (anti-brush core)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pve_daily_progress (
  user_id      BIGINT UNSIGNED NOT NULL,
  date         DATE            NOT NULL,
  wins_count   TINYINT UNSIGNED NOT NULL DEFAULT 0,   -- Today’s effective number of wins (0-10)
  earned_today BIGINT UNSIGNED  NOT NULL DEFAULT 0,   -- Earned a total of $FIST today
  PRIMARY KEY (user_id, date),
  CONSTRAINT fk_pdp_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PvE 每日胜局进度（UTC 日期）';

-- ─────────────────────────────────────────────────────
-- Table 4: PvP match records
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pvp_matches (
  match_id     CHAR(36)        NOT NULL PRIMARY KEY,  -- UUID
  room_tier    TINYINT UNSIGNED NOT NULL,              -- 1=Bronze Fist(100) 2=Silver Fist(1000) 3=Golden Fist(10000)
  player_a_id  BIGINT UNSIGNED NOT NULL,
  player_b_id  BIGINT UNSIGNED NOT NULL,
  stake_amount BIGINT UNSIGNED NOT NULL,              -- Single admission amount
  winner_id    BIGINT UNSIGNED NULL,                  -- NULL=tie/in progress
  status       ENUM('pending','playing','finished','cancelled') NOT NULL DEFAULT 'pending',
  tx_hash      VARCHAR(88)     NULL,                  -- On-chain transaction hash (available in Golden Boxing Stadium)
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
-- Table 5: Match round record (for record replay and Merkle evidence storage)
-- ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pvp_rounds (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  match_id     CHAR(36)        NOT NULL,
  round_num    TINYINT UNSIGNED NOT NULL,
  action_a     ENUM('attack','defend','charge','counter') NOT NULL,
  action_b     ENUM('attack','defend','charge','counter') NOT NULL,
  damage_a     SMALLINT UNSIGNED NOT NULL DEFAULT 0,  -- The damage player_a received this round
  damage_b     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  hp_a_after   SMALLINT UNSIGNED NOT NULL,            -- player_a's HP after this round
  hp_b_after   SMALLINT UNSIGNED NOT NULL,
  created_at   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pr_match (match_id),
  CONSTRAINT fk_pr_match FOREIGN KEY (match_id) REFERENCES pvp_matches(match_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='PvP 回合记录';
