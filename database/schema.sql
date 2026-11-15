CREATE DATABASE IF NOT EXISTS universal_chess CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE universal_chess;

CREATE TABLE IF NOT EXISTS players (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  player_uuid CHAR(36) NOT NULL UNIQUE,
  display_name VARCHAR(40) NOT NULL,
  preferred_team ENUM('white','black') NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS games (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  game_uuid CHAR(36) NOT NULL UNIQUE,
  fen VARCHAR(120) NOT NULL,
  pgn MEDIUMTEXT NOT NULL,
  current_turn ENUM('white','black') NOT NULL DEFAULT 'white',
  move_number INT UNSIGNED NOT NULL DEFAULT 1,
  game_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_successful_team_move ENUM('white','black') NULL,
  last_successful_player_id BIGINT UNSIGNED NULL,
  game_status ENUM('active','checkmate','stalemate','draw','resigned') NOT NULL DEFAULT 'active',
  active_player_id BIGINT UNSIGNED NULL,
  active_turn_token CHAR(36) NULL,
  active_deadline_at DATETIME(3) NULL,
  turn_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 15,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_games_active_player FOREIGN KEY (active_player_id) REFERENCES players(id) ON DELETE SET NULL,
  CONSTRAINT fk_games_last_successful_player FOREIGN KEY (last_successful_player_id) REFERENCES players(id) ON DELETE SET NULL,
  INDEX idx_games_status (game_status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS universal_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  current_game_id BIGINT UNSIGNED NOT NULL,
  CONSTRAINT fk_universal_current_game FOREIGN KEY (current_game_id) REFERENCES games(id),
  CONSTRAINT chk_universal_singleton CHECK (id = 1)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS moves (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  game_id BIGINT UNSIGNED NOT NULL,
  player_id BIGINT UNSIGNED NOT NULL,
  team ENUM('white','black') NOT NULL,
  from_square CHAR(2) NOT NULL,
  to_square CHAR(2) NOT NULL,
  promotion CHAR(1) NULL,
  san VARCHAR(16) NOT NULL,
  fen_after_move VARCHAR(120) NOT NULL,
  move_number INT UNSIGNED NOT NULL,
  idempotency_key CHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_moves_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  CONSTRAINT fk_moves_player FOREIGN KEY (player_id) REFERENCES players(id),
  INDEX idx_moves_game_order (game_id, id),
  UNIQUE KEY uq_moves_idempotency (game_id, idempotency_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS queue_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  game_id BIGINT UNSIGNED NOT NULL,
  player_id BIGINT UNSIGNED NOT NULL,
  team ENUM('white','black') NOT NULL,
  queue_position BIGINT UNSIGNED NOT NULL,
  queue_status ENUM('waiting','assigned','completed','timed_out','left') NOT NULL DEFAULT 'waiting',
  joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_queue_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  CONSTRAINT fk_queue_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  INDEX idx_queue_next (game_id, team, queue_status, queue_position),
  INDEX idx_queue_player (game_id, player_id, queue_status),
  UNIQUE KEY uq_queue_position (game_id, team, queue_position)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS turns (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  game_id BIGINT UNSIGNED NOT NULL,
  player_id BIGINT UNSIGNED NOT NULL,
  team ENUM('white','black') NOT NULL,
  turn_token CHAR(36) NOT NULL UNIQUE,
  assigned_at DATETIME(3) NOT NULL,
  deadline_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  status ENUM('active','completed','timed_out','cancelled') NOT NULL DEFAULT 'active',
  CONSTRAINT fk_turns_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  CONSTRAINT fk_turns_player FOREIGN KEY (player_id) REFERENCES players(id),
  INDEX idx_turns_active (game_id, status, deadline_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS game_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  game_id BIGINT UNSIGNED NOT NULL,
  player_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(40) NOT NULL,
  event_data JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_events_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  CONSTRAINT fk_events_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL,
  INDEX idx_events_game (game_id, id)
) ENGINE=InnoDB;

-- Migration 001: one game is inserted by the application on first startup.
