-- Apply once to an existing installation. This migration preserves all players, games, moves, queues and turns.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE games
  ADD COLUMN game_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN last_successful_team_move ENUM('white','black') NULL,
  ADD COLUMN last_successful_player_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_games_last_successful_player FOREIGN KEY (last_successful_player_id) REFERENCES players(id) ON DELETE SET NULL;

ALTER TABLE moves
  ADD COLUMN idempotency_key CHAR(36) NULL,
  ADD UNIQUE KEY uq_moves_idempotency (game_id, idempotency_key);

CREATE TABLE IF NOT EXISTS universal_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  current_game_id BIGINT UNSIGNED NOT NULL,
  CONSTRAINT fk_universal_current_game FOREIGN KEY (current_game_id) REFERENCES games(id),
  CONSTRAINT chk_universal_singleton CHECK (id = 1)
) ENGINE=InnoDB;

INSERT IGNORE INTO universal_state (id,current_game_id)
SELECT 1,id FROM games ORDER BY id LIMIT 1;

UPDATE games g SET
  game_version=(SELECT COUNT(*) FROM moves m WHERE m.game_id=g.id),
  last_successful_team_move=(SELECT m.team FROM moves m WHERE m.game_id=g.id ORDER BY m.id DESC LIMIT 1),
  last_successful_player_id=(SELECT m.player_id FROM moves m WHERE m.game_id=g.id ORDER BY m.id DESC LIMIT 1);

INSERT IGNORE INTO schema_migrations (version) VALUES ('002_repeat_participation');
