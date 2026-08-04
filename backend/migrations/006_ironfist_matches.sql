-- Tekken game-by-game battle details database migration
-- Execution: mysql -u root -p e2eechat < 006_ironfist_matches.sql

USE e2eechat;

-- One line is recorded for each completed game, which is used to display the game-by-game details in the "Battle Record".
-- detail Save round-by-round JSON: [{"r":1,"p":"attack","o":"defend","pd":0,"od":8}, ...]
-- r=number of rounds p=our move o=opponent’s move pd=our side receives damage od=opponent receives damage
CREATE TABLE IF NOT EXISTS ironfist_matches (
  id            BIGINT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  user_id       BIGINT UNSIGNED  NOT NULL,
  mode          ENUM('pve','pvp') NOT NULL,
  result        ENUM('win','lose','draw','doubleLose') NOT NULL,
  player_hp     SMALLINT         NOT NULL DEFAULT 0,    -- Final game HP
  opponent_hp   SMALLINT         NOT NULL DEFAULT 0,    -- Final opponent HP
  rounds        TINYINT UNSIGNED NOT NULL DEFAULT 0,    -- Total rounds
  opponent_name VARCHAR(64)      NULL,                  -- Opponent Nickname (PvP)/"Computer"
  detail        JSON             NULL,                  -- round by round breakdown
  created_at    DATETIME(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_im_user (user_id, id),
  CONSTRAINT fk_im_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='铁拳逐局对战明细';
