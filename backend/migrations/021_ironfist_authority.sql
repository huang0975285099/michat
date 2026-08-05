-- Unified server-authoritative IronFist game state and settlement anchors.

USE e2eechat;

CREATE TABLE IF NOT EXISTS ironfist_games (
  game_id                  CHAR(36) NOT NULL PRIMARY KEY,
  mode                     ENUM('pve','pvp','friend') NOT NULL,
  status                   ENUM('waiting','active','completed','abandoned','cancelled') NOT NULL,
  player_a_user_id         BIGINT UNSIGNED NOT NULL,
  player_b_user_id         BIGINT UNSIGNED NULL,
  pvp_room_id              BIGINT UNSIGNED NULL,
  rules_version            SMALLINT UNSIGNED NOT NULL,
  current_round            TINYINT UNSIGNED NOT NULL DEFAULT 1,
  state_version            BIGINT UNSIGNED NOT NULL DEFAULT 1,
  state_json               JSON NOT NULL,
  ai_seed                  BINARY(32) NULL,
  action_deadline_a        DATETIME(3) NULL,
  action_deadline_b        DATETIME(3) NULL,
  remaining_action_ms_a    INT UNSIGNED NULL,
  remaining_action_ms_b    INT UNSIGNED NULL,
  disconnect_deadline_a    DATETIME(3) NULL,
  disconnect_deadline_b    DATETIME(3) NULL,
  last_activity_at         DATETIME(3) NOT NULL,
  expires_at               DATETIME(3) NULL,
  result                   VARCHAR(16) NULL,
  winner_user_id           BIGINT UNSIGNED NULL,
  finish_reason            VARCHAR(32) NULL,
  finished_at              DATETIME(3) NULL,
  settled_at               DATETIME(3) NULL,
  created_at               DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ifg_pvp_room (pvp_room_id),
  KEY idx_ifg_due (status, action_deadline_a, action_deadline_b),
  KEY idx_ifg_disconnect_due (status, disconnect_deadline_a, disconnect_deadline_b),
  KEY idx_ifg_player_a (player_a_user_id, status),
  KEY idx_ifg_player_b (player_b_user_id, status),
  CONSTRAINT fk_ifg_a FOREIGN KEY (player_a_user_id) REFERENCES users(id),
  CONSTRAINT fk_ifg_b FOREIGN KEY (player_b_user_id) REFERENCES users(id),
  CONSTRAINT fk_ifg_room FOREIGN KEY (pvp_room_id) REFERENCES ironfist_pvp_rooms(id),
  CONSTRAINT fk_ifg_winner FOREIGN KEY (winner_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Authoritative IronFist games';

CREATE TABLE IF NOT EXISTS ironfist_game_actions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  game_id        CHAR(36) NOT NULL,
  round_num      TINYINT UNSIGNED NOT NULL,
  seat           ENUM('a','b') NOT NULL,
  action         ENUM('attack','defend','charge','counter') NOT NULL,
  source         ENUM('player','deadline_default','ai') NOT NULL,
  user_id        BIGINT UNSIGNED NULL,
  request_id     CHAR(36) NULL,
  response_json  JSON NULL,
  accepted_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ifga_round_seat (game_id, round_num, seat),
  UNIQUE KEY uq_ifga_request (game_id, user_id, request_id),
  KEY idx_ifga_user (user_id, accepted_at),
  CONSTRAINT fk_ifga_game FOREIGN KEY (game_id) REFERENCES ironfist_games(game_id) ON DELETE CASCADE,
  CONSTRAINT fk_ifga_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Immutable authoritative IronFist actions';

CREATE TABLE IF NOT EXISTS ironfist_game_rounds (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  game_id             CHAR(36) NOT NULL,
  round_num           TINYINT UNSIGNED NOT NULL,
  action_a            ENUM('attack','defend','charge','counter') NOT NULL,
  action_b            ENUM('attack','defend','charge','counter') NOT NULL,
  damage_a            SMALLINT UNSIGNED NOT NULL,
  damage_b            SMALLINT UNSIGNED NOT NULL,
  environment_damage  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  state_json           JSON NOT NULL,
  outcome              VARCHAR(16) NULL,
  resolution_reason    VARCHAR(32) NOT NULL,
  resolved_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ifgr_round (game_id, round_num),
  CONSTRAINT fk_ifgr_game FOREIGN KEY (game_id) REFERENCES ironfist_games(game_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Resolved authoritative IronFist rounds';

CREATE TABLE IF NOT EXISTS ironfist_active_pve (
  user_id      BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  game_id      CHAR(36) NOT NULL,
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ifap_game (game_id),
  CONSTRAINT fk_ifap_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_ifap_game FOREIGN KEY (game_id) REFERENCES ironfist_games(game_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='One active rewarded PvE session per user';

CREATE TABLE IF NOT EXISTS ironfist_outbox (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id       CHAR(36) NOT NULL,
  game_id        CHAR(36) NOT NULL,
  state_version  BIGINT UNSIGNED NOT NULL,
  event_type     VARCHAR(48) NOT NULL,
  payload        JSON NOT NULL,
  attempts       INT UNSIGNED NOT NULL DEFAULT 0,
  last_error     VARCHAR(255) NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at   DATETIME(3) NULL,
  UNIQUE KEY uq_ifo_event (event_id),
  KEY idx_ifo_unpublished (published_at, id),
  KEY idx_ifo_game_version (game_id, state_version),
  CONSTRAINT fk_ifo_game FOREIGN KEY (game_id) REFERENCES ironfist_games(game_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Transactional IronFist notification outbox';

CREATE TABLE IF NOT EXISTS system_migration_markers (
  name          VARCHAR(128) NOT NULL PRIMARY KEY,
  completed_at  DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Durable one-time application migration markers';

ALTER TABLE ironfist_matches ADD COLUMN authoritative_game_id CHAR(36) NULL;
ALTER TABLE ironfist_matches ADD UNIQUE KEY uq_im_authoritative_game (user_id, authoritative_game_id);

ALTER TABLE fist_transactions ADD COLUMN settlement_ref VARCHAR(128) NULL;
ALTER TABLE fist_transactions ADD UNIQUE KEY uq_ft_settlement_ref (user_id, type, settlement_ref);
