const { Chess } = require('chess.js');
const { randomUUID } = require('node:crypto');

async function hasColumn(conn, table, column) {
  const [rows] = await conn.query('SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?', [table, column]);
  return rows.length > 0;
}
async function hasIndex(conn, table, index) {
  const [rows] = await conn.query('SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=? LIMIT 1', [table, index]);
  return rows.length > 0;
}

async function migrate(pool) {
  const conn = await pool.getConnection();
  let gotLock = false;
  try {
    const [[lock]] = await conn.query("SELECT GET_LOCK('universal_chess_migrations', 30) AS acquired");
    gotLock = lock.acquired === 1;
    if (!gotLock) throw new Error('Could not acquire the migration lock.');
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) NOT NULL PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`);
    await conn.query('INSERT IGNORE INTO schema_migrations (version) VALUES (?)', ['001_initial_schema']);
    const [[alreadyMigrated]] = await conn.query("SELECT 1 AS applied FROM schema_migrations WHERE version='002_repeat_participation' LIMIT 1");
    await conn.query(`CREATE TABLE IF NOT EXISTS universal_state (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      current_game_id BIGINT UNSIGNED NOT NULL,
      CONSTRAINT fk_universal_current_game FOREIGN KEY (current_game_id) REFERENCES games(id),
      CONSTRAINT chk_universal_singleton CHECK (id = 1)
    ) ENGINE=InnoDB`);
    if (!await hasColumn(conn, 'games', 'game_version')) await conn.query('ALTER TABLE games ADD COLUMN game_version BIGINT UNSIGNED NOT NULL DEFAULT 0');
    if (!await hasColumn(conn, 'games', 'last_successful_team_move')) await conn.query("ALTER TABLE games ADD COLUMN last_successful_team_move ENUM('white','black') NULL");
    if (!await hasColumn(conn, 'games', 'last_successful_player_id')) {
      await conn.query('ALTER TABLE games ADD COLUMN last_successful_player_id BIGINT UNSIGNED NULL');
      await conn.query('ALTER TABLE games ADD CONSTRAINT fk_games_last_successful_player FOREIGN KEY (last_successful_player_id) REFERENCES players(id) ON DELETE SET NULL');
    }
    if (!await hasColumn(conn, 'moves', 'idempotency_key')) await conn.query('ALTER TABLE moves ADD COLUMN idempotency_key CHAR(36) NULL');
    if (!await hasIndex(conn, 'moves', 'uq_moves_idempotency')) await conn.query('ALTER TABLE moves ADD UNIQUE KEY uq_moves_idempotency (game_id,idempotency_key)');
    if (!alreadyMigrated) {
      await conn.query(`UPDATE games g SET
        game_version=(SELECT COUNT(*) FROM moves m WHERE m.game_id=g.id),
        last_successful_team_move=(SELECT m.team FROM moves m WHERE m.game_id=g.id ORDER BY m.id DESC LIMIT 1),
        last_successful_player_id=(SELECT m.player_id FROM moves m WHERE m.game_id=g.id ORDER BY m.id DESC LIMIT 1)`);
      await conn.query("INSERT IGNORE INTO schema_migrations (version) VALUES ('002_repeat_participation')");
    }

    const [[existing]] = await conn.query("SELECT id FROM games WHERE game_uuid='00000000-0000-4000-8000-000000000001' LIMIT 1");
    if (!existing) {
      const [insert] = await conn.query('INSERT INTO games (game_uuid,fen,pgn,current_turn,move_number,turn_seconds) VALUES (?,?,\'\',\'white\',1,?)', [randomUUID(), new Chess().fen(), Math.max(5, Math.min(120, Number(process.env.MOVE_TIMER_SECONDS || 15)))]);
      await conn.query('INSERT IGNORE INTO universal_state (id,current_game_id) VALUES (1,?)', [insert.insertId]);
    } else {
      await conn.query('INSERT IGNORE INTO universal_state (id,current_game_id) VALUES (1,?)', [existing.id]);
    }
  } finally {
    if (gotLock) await conn.query("SELECT RELEASE_LOCK('universal_chess_migrations')");
    conn.release();
  }
}

module.exports = { migrate };
