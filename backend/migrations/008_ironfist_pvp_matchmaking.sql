-- 铁拳 PVP 撮合与质押房间表
-- 记录撮合队列、匹配状态、对局结果与结算。
-- 配合 fist_accounts / fist_transactions 完成质押扣款、退回、胜利分成。
-- 注意：与 004 中预规划的 pvp_matches（链上版本）解耦，本表为 MVP 内存外撮合使用。

USE e2eechat;

CREATE TABLE IF NOT EXISTS ironfist_pvp_rooms (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tier              VARCHAR(16)     NOT NULL,                 -- gold / platinum / diamond
  stake_amount      BIGINT          NOT NULL,                 -- 单人质押金额（与 tier 对应）

  -- 玩家 A（房间创建者，先入队）
  player_a_user_id  BIGINT UNSIGNED NOT NULL,
  player_a_chat_id  VARCHAR(64)     NOT NULL,

  -- 玩家 B（匹配到的对手，匹配前为 NULL）
  player_b_user_id  BIGINT UNSIGNED NULL,
  player_b_chat_id  VARCHAR(64)     NULL,

  -- 状态机：matching(等待) → matched(已匹配) → settled(已结算) / cancelled(取消)
  status            ENUM('matching','matched','settled','cancelled') NOT NULL DEFAULT 'matching',
  -- 结算结果（仅 settled 时填写）：win_a / win_b / draw / doubleLose
  result            VARCHAR(16)     NULL,
  -- 双方上报的房间视角结果（防作弊：双方一致才结算，不一致按平局退款）
  report_a          VARCHAR(16)     NULL,
  report_b          VARCHAR(16)     NULL,

  -- 资金字段（仅 settled 时填写，用于审计与流水对账）
  winner_amount     BIGINT          NOT NULL DEFAULT 0,       -- 赢家到手（含本金）
  refund_a          BIGINT          NOT NULL DEFAULT 0,       -- 玩家 A 退回（平局）
  refund_b          BIGINT          NOT NULL DEFAULT 0,       -- 玩家 B 退回（平局）
  fee_burn          BIGINT          NOT NULL DEFAULT 0,      -- 销毁部分（MVP 未实际销毁，仅记账）
  fee_treasury      BIGINT          NOT NULL DEFAULT 0,      -- 国库部分（MVP 同 burn，仅记账）

  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  matched_at        DATETIME(3)     NULL,
  settled_at        DATETIME(3)     NULL,

  KEY idx_pvr_tier_status (tier, status),                     -- 撮合核心索引
  KEY idx_pvr_player_a (player_a_user_id),
  KEY idx_pvr_player_b (player_b_user_id),
  CONSTRAINT fk_pvr_a FOREIGN KEY (player_a_user_id) REFERENCES users(id),
  CONSTRAINT fk_pvr_b FOREIGN KEY (player_b_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='铁拳 PVP 撮合房间与质押结算';
