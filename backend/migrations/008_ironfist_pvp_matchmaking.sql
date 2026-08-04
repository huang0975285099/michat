-- Tekken PVP matchmaking and staking room table
-- Record the matching queue, matching status, game results and settlement.
-- Cooperate with fist_accounts / fist_transactions to complete pledge deduction, refund, and victory share.
-- Note: Decoupled from the pre-planned pvp_matches (on-chain version) in 004, this table is used for MVP out-of-memory matching.

USE e2eechat;

CREATE TABLE IF NOT EXISTS ironfist_pvp_rooms (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tier              VARCHAR(16)     NOT NULL,                 -- gold / platinum / diamond
  stake_amount      BIGINT          NOT NULL,                 -- Single person’s pledge amount (corresponding to tier)

  -- Player A (room creator, first to join the team)
  player_a_user_id  BIGINT UNSIGNED NOT NULL,
  player_a_chat_id  VARCHAR(64)     NOT NULL,

  -- Player B (matched opponent, NULL before matching)
  player_b_user_id  BIGINT UNSIGNED NULL,
  player_b_chat_id  VARCHAR(64)     NULL,

  -- State machine: matching (waiting) → matched (matched) → settled (settled) / canceled (cancelled)
  status            ENUM('matching','matched','settled','cancelled') NOT NULL DEFAULT 'matching',
  -- Settlement result (only filled in when settled): win_a / win_b / draw / doubleLose
  result            VARCHAR(16)     NULL,
  -- Room perspective results reported by both parties (anti-cheating: settlement will be made only if both parties agree, if not, refund will be a draw)
  report_a          VARCHAR(16)     NULL,
  report_b          VARCHAR(16)     NULL,

  -- Fund field (only filled in when settled, used for auditing and reconciliation)
  winner_amount     BIGINT          NOT NULL DEFAULT 0,       -- The winner gets it (including principal)
  refund_a          BIGINT          NOT NULL DEFAULT 0,       -- Player A retreats (draw)
  refund_b          BIGINT          NOT NULL DEFAULT 0,       -- Player B retreats (draw)
  fee_burn          BIGINT          NOT NULL DEFAULT 0,      -- Destruction part (MVP is not actually destroyed, only accounting)
  fee_treasury      BIGINT          NOT NULL DEFAULT 0,      -- Treasury part (MVP is the same as burn, only accounting)

  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  matched_at        DATETIME(3)     NULL,
  settled_at        DATETIME(3)     NULL,

  KEY idx_pvr_tier_status (tier, status),                     -- Match core index
  KEY idx_pvr_player_a (player_a_user_id),
  KEY idx_pvr_player_b (player_b_user_id),
  CONSTRAINT fk_pvr_a FOREIGN KEY (player_a_user_id) REFERENCES users(id),
  CONSTRAINT fk_pvr_b FOREIGN KEY (player_b_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='铁拳 PVP 撮合房间与质押结算';
