USE e2eechat;

CREATE TABLE IF NOT EXISTS ironfist_dragon_tiger_rounds (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  status                ENUM('betting','locked','playing','settling','settled','voided') NOT NULL,
  state_version         BIGINT UNSIGNED NOT NULL DEFAULT 1,
  rules_version         SMALLINT UNSIGNED NOT NULL,
  seed_commitment       BINARY(32) NOT NULL,
  server_seed           BINARY(32) NOT NULL,
  battle_json           JSON NULL,
  result                ENUM('dragon','tiger','draw','void') NULL,
  void_reason           VARCHAR(64) NULL,
  dragon_bet_total      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tiger_bet_total       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  draw_bet_total        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  winning_user_count    INT UNSIGNED NOT NULL DEFAULT 0,
  betting_started_at    DATETIME(3) NOT NULL,
  betting_ends_at       DATETIME(3) NOT NULL,
  battle_started_at     DATETIME(3) NULL,
  battle_ends_at        DATETIME(3) NULL,
  settled_at            DATETIME(3) NULL,
  display_ends_at       DATETIME(3) NULL,
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ifdtr_betting_due (status, betting_ends_at),
  KEY idx_ifdtr_battle_due (status, battle_ends_at),
  KEY idx_ifdtr_display_due (status, display_ends_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Iron Fist Dragon Tiger public rounds';

CREATE TABLE IF NOT EXISTS ironfist_dragon_tiger_scheduler (
  id                TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  current_round_id  BIGINT UNSIGNED NULL,
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO ironfist_dragon_tiger_scheduler (id, current_round_id) VALUES (1, NULL);

CREATE TABLE IF NOT EXISTS ironfist_dragon_tiger_bets (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  round_id        BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  selection       ENUM('dragon','tiger','draw') NOT NULL,
  stake_amount    BIGINT UNSIGNED NOT NULL,
  payout_amount   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status          ENUM('active','won','lost','refunded') NOT NULL DEFAULT 'active',
  settled_at      DATETIME(3) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ifdtb_round_user (round_id, user_id),
  KEY idx_ifdtb_round_status (round_id, status),
  CONSTRAINT fk_ifdtb_round FOREIGN KEY (round_id) REFERENCES ironfist_dragon_tiger_rounds(id),
  CONSTRAINT fk_ifdtb_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ironfist_dragon_tiger_bet_commands (
  request_id      CHAR(36) NOT NULL PRIMARY KEY,
  round_id        BIGINT UNSIGNED NOT NULL,
  user_id         BIGINT UNSIGNED NOT NULL,
  selection       ENUM('dragon','tiger','draw') NOT NULL,
  amount          BIGINT UNSIGNED NOT NULL,
  response_json   JSON NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ifdtbc_user_created (user_id, created_at),
  CONSTRAINT fk_ifdtbc_round FOREIGN KEY (round_id) REFERENCES ironfist_dragon_tiger_rounds(id),
  CONSTRAINT fk_ifdtbc_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ironfist_dragon_tiger_outbox (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id       CHAR(36) NOT NULL,
  round_id       BIGINT UNSIGNED NOT NULL,
  state_version  BIGINT UNSIGNED NOT NULL,
  event_type     VARCHAR(64) NOT NULL,
  payload        JSON NOT NULL,
  attempts       INT UNSIGNED NOT NULL DEFAULT 0,
  last_error     VARCHAR(255) NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at   DATETIME(3) NULL,
  UNIQUE KEY uq_ifdto_event (event_id),
  KEY idx_ifdto_unpublished (published_at, id),
  CONSTRAINT fk_ifdto_round FOREIGN KEY (round_id) REFERENCES ironfist_dragon_tiger_rounds(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Preserve public history while removing personal identity on account deletion.
ALTER TABLE ironfist_dragon_tiger_bets DROP FOREIGN KEY fk_ifdtb_user;
ALTER TABLE ironfist_dragon_tiger_bets MODIFY COLUMN user_id BIGINT UNSIGNED NULL;
ALTER TABLE ironfist_dragon_tiger_bets ADD CONSTRAINT fk_ifdtb_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ironfist_dragon_tiger_bet_commands DROP FOREIGN KEY fk_ifdtbc_user;
ALTER TABLE ironfist_dragon_tiger_bet_commands MODIFY COLUMN user_id BIGINT UNSIGNED NULL;
ALTER TABLE ironfist_dragon_tiger_bet_commands ADD CONSTRAINT fk_ifdtbc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Transaction types are application-validated strings. Using VARCHAR avoids
-- old replayed migrations rejecting values introduced by newer game modes.
ALTER TABLE fist_transactions MODIFY COLUMN type VARCHAR(64) NOT NULL;
