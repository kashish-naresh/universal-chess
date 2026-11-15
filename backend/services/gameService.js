const { randomUUID } = require('node:crypto');
const pool = require('../config/database');
const { Chess } = require('chess.js');
const { applyMove } = require('./chessService');
const { AppError } = require('../utils/errors');
const migrationService = require('./migrationService');

const timerSeconds = Math.max(5, Math.min(120, Number(process.env.MOVE_TIMER_SECONDS || 15)));

async function withGameLock(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[current]] = await conn.query('SELECT current_game_id FROM universal_state WHERE id=1 FOR UPDATE');
    if (!current) throw new Error('The universal game pointer is missing.');
    const [[game]] = await conn.query('SELECT * FROM games WHERE id = ? FOR UPDATE', [current.current_game_id]);
    if (!game) throw new Error('The universal game has not been initialized.');
    const result = await fn(conn, game);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally { conn.release(); }
}

async function initialize() {
  await migrationService.migrate(pool);
  await recoverAndAllocate();
}

async function ensurePlayer(uuid, name = null, team = null) {
  const displayName = (name || `Guest ${uuid.slice(0, 4)}`).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 40) || `Guest ${uuid.slice(0, 4)}`;
  await pool.query(`INSERT INTO players (player_uuid, display_name, preferred_team) VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), preferred_team = COALESCE(preferred_team, VALUES(preferred_team)), last_seen_at = CURRENT_TIMESTAMP`, [uuid, displayName, team]);
  const [[player]] = await pool.query('SELECT * FROM players WHERE player_uuid = ?', [uuid]);
  return player;
}

async function getGameId(conn) { const [[row]] = await conn.query('SELECT current_game_id AS id FROM universal_state WHERE id=1'); return row.id; }

async function assignNext(conn, game, gameId) {
  if (game.game_status !== 'active' || game.active_player_id) return null;
  const team = game.current_turn;
  const [[entry]] = await conn.query(`SELECT q.*, p.display_name FROM queue_entries q JOIN players p ON p.id=q.player_id
    WHERE q.game_id=? AND q.team=? AND q.queue_status='waiting'
      AND ( ? IS NULL OR q.player_id <> ? )
    ORDER BY q.queue_position, q.id LIMIT 1 FOR UPDATE`, [gameId, team, game.last_successful_player_id, game.last_successful_player_id]);
  if (!entry) return null;
  const [[clock]] = await conn.query('SELECT UTC_TIMESTAMP(3) AS now, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND) AS deadline', [game.turn_seconds]);
  const now = clock.now;
  const deadline = clock.deadline;
  const token = randomUUID();
  await conn.query("UPDATE queue_entries SET queue_status='assigned' WHERE id=?", [entry.id]);
  await conn.query(`INSERT INTO turns (game_id, player_id, team, turn_token, assigned_at, deadline_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')`, [gameId, entry.player_id, team, token, now, deadline]);
  await conn.query('UPDATE games SET active_player_id=?, active_turn_token=?, active_deadline_at=? WHERE id=?', [entry.player_id, token, deadline, gameId]);
  await event(conn, gameId, entry.player_id, 'turn_assigned', { team, deadline: deadline.toISOString() });
  return { playerId: entry.player_id, playerUuid: null, playerName: entry.display_name, team, token, deadline: deadline.toISOString() };
}

async function event(conn, gameId, playerId, type, data) {
  await conn.query('INSERT INTO game_events (game_id, player_id, event_type, event_data) VALUES (?, ?, ?, ?)', [gameId, playerId, type, JSON.stringify(data)]);
}

async function joinQueue(uuid, team, name) {
  if (!['white', 'black'].includes(team)) throw new AppError('Choose White or Black.', 'INVALID_TEAM');
  const player = await ensurePlayer(uuid, name);
  return withGameLock(async (conn, game) => {
    const gameId = await getGameId(conn);
    if (game.game_status !== 'active') throw new AppError('This game has ended.', 'GAME_OVER');
    const [[playerState]] = await conn.query('SELECT id,preferred_team FROM players WHERE player_uuid=? FOR UPDATE', [uuid]);
    if (playerState.preferred_team && playerState.preferred_team !== team) {
      throw new AppError(`Your team is already set to ${playerState.preferred_team.toUpperCase()}.`, 'TEAM_LOCKED', 409);
    }
    if (!playerState.preferred_team) await conn.query('UPDATE players SET preferred_team=? WHERE id=?', [team, playerState.id]);
    if (player.id === game.last_successful_player_id && team === game.current_turn) {
      throw new AppError('Wait for the opposing team to complete a move before joining that team.', 'WAIT_FOR_OPPONENT', 409);
    }
    const [[existing]] = await conn.query(`SELECT * FROM queue_entries WHERE game_id=? AND player_id=? AND queue_status IN ('waiting','assigned') FOR UPDATE`, [gameId, player.id]);
    if (existing) {
      if (existing.team !== team) throw new AppError('You are already queued for the other team. Leave your queue first.', 'ALREADY_QUEUED');
      return { assigned: existing.queue_status === 'assigned', player };
    }
    const [[pos]] = await conn.query('SELECT COALESCE(MAX(queue_position),0)+1 AS next_position FROM queue_entries WHERE game_id=? AND team=?', [gameId, team]);
    await conn.query(`INSERT INTO queue_entries (game_id, player_id, team, queue_position, queue_status) VALUES (?, ?, ?, ?, 'waiting')`, [gameId, player.id, team, pos.next_position]);
    await event(conn, gameId, player.id, 'player_joined', { team });
    const assignment = await assignNext(conn, game, gameId);
    const [[q]] = await conn.query(`SELECT queue_status FROM queue_entries WHERE game_id=? AND player_id=? AND queue_status IN ('waiting','assigned')`, [gameId, player.id]);
    return { assigned: q?.queue_status === 'assigned', player, assignment };
  });
}

async function restorePreferredQueue(uuid) {
  const [[player]] = await pool.query('SELECT preferred_team FROM players WHERE player_uuid=?', [uuid]);
  return player?.preferred_team ? joinQueue(uuid, player.preferred_team) : null;
}

async function leaveQueue(uuid) {
  const [[player]] = await pool.query('SELECT id FROM players WHERE player_uuid=?', [uuid]);
  if (!player) return;
  return withGameLock(async (conn, game) => {
    const gameId = await getGameId(conn);
    const [[entry]] = await conn.query(`SELECT * FROM queue_entries WHERE game_id=? AND player_id=? AND queue_status IN ('waiting','assigned') FOR UPDATE`, [gameId, player.id]);
    if (!entry) return;
    if (entry.queue_status === 'assigned') {
      await conn.query("UPDATE turns SET status='cancelled', completed_at=UTC_TIMESTAMP(3) WHERE turn_token=? AND status='active'", [game.active_turn_token]);
      await conn.query('UPDATE games SET active_player_id=NULL, active_turn_token=NULL, active_deadline_at=NULL WHERE id=?', [gameId]);
    }
    await conn.query("UPDATE queue_entries SET queue_status='left' WHERE id=?", [entry.id]);
    await event(conn, gameId, player.id, 'player_left', { team: entry.team });
    await assignNext(conn, { ...game, active_player_id: null }, gameId);
  });
}

async function expireTurn(conn, game, gameId) {
  if (!game.active_player_id || !game.active_deadline_at) return false;
  const [[clock]] = await conn.query('SELECT UTC_TIMESTAMP(3) >= ? AS expired', [game.active_deadline_at]);
  if (!clock.expired) return false;
  await conn.query("UPDATE turns SET status='timed_out', completed_at=UTC_TIMESTAMP(3) WHERE turn_token=? AND status='active'", [game.active_turn_token]);
  await conn.query("UPDATE queue_entries SET queue_status='timed_out' WHERE game_id=? AND player_id=? AND queue_status='assigned'", [gameId, game.active_player_id]);
  await event(conn, gameId, game.active_player_id, 'turn_expired', { team: game.current_turn });
  await conn.query('UPDATE games SET active_player_id=NULL, active_turn_token=NULL, active_deadline_at=NULL WHERE id=?', [gameId]);
  await assignNext(conn, { ...game, active_player_id: null }, gameId);
  return true;
}

async function submitMove(uuid, token, moveInput, idempotencyKey) {
  const result = await withGameLock(async (conn, game) => {
    const gameId = await getGameId(conn);
    const [[player]] = await conn.query('SELECT id,display_name FROM players WHERE player_uuid=?', [uuid]);
    if (!player) throw new AppError('Unknown guest identity.', 'UNKNOWN_PLAYER', 401);
    const [[duplicate]] = idempotencyKey ? await conn.query(`SELECT m.san,m.from_square,m.to_square,m.promotion,m.fen_after_move,m.move_number,m.team,p.display_name
      FROM moves m JOIN players p ON p.id=m.player_id WHERE m.game_id=? AND m.player_id=? AND m.idempotency_key=? LIMIT 1`, [gameId, player.id, idempotencyKey]) : [[]];
    if (duplicate) {
      if (duplicate.from_square !== moveInput.from || duplicate.to_square !== moveInput.to || duplicate.promotion !== (moveInput.promotion || null)) throw new AppError('This idempotency key was already used for a different move.', 'IDEMPOTENCY_CONFLICT', 409);
      return { duplicate: true, move: { san: duplicate.san, from: duplicate.from_square, to: duplicate.to_square }, fen: duplicate.fen_after_move, moveNumber: duplicate.move_number, playerName: duplicate.display_name, status: game.game_status, nextTeam: game.current_turn };
    }
    const [[turn]] = game.active_turn_token ? await conn.query("SELECT * FROM turns WHERE turn_token=? AND status='active' FOR UPDATE", [game.active_turn_token]) : [[]];
    if (turn) {
      const [[clock]] = await conn.query('SELECT UTC_TIMESTAMP(3) >= ? AS expired, (? = ?) AS deadline_matches', [turn.deadline_at, turn.deadline_at, game.active_deadline_at]);
      if (!clock.deadline_matches) throw new AppError('The active turn deadline is inconsistent.', 'TURN_STATE_INVALID', 409);
      if (clock.expired) {
        await expireTurn(conn, game, gameId);
        return { rejection: new AppError('Your move time expired.', 'TURN_EXPIRED', 409) };
      }
    }
    if (!player || !turn || !game.active_player_id || game.active_player_id !== player.id || turn.player_id !== player.id || turn.team !== game.current_turn || game.active_turn_token !== token || turn.turn_token !== token) throw new AppError('You do not hold the active turn.', 'NOT_YOUR_TURN', 409);
    let result;
    try { result = applyMove(game.fen, moveInput, game.current_turn); }
    catch (error) { throw new AppError(error.message, 'ILLEGAL_MOVE', 422); }
    await conn.query("UPDATE turns SET status='completed', completed_at=UTC_TIMESTAMP(3) WHERE id=?", [turn.id]);
    await conn.query("UPDATE queue_entries SET queue_status='completed' WHERE game_id=? AND player_id=? AND queue_status='assigned'", [gameId, player.id]);
    const nextTeam = result.chess.turn() === 'w' ? 'white' : 'black';
    const moveNumber = result.chess.moveNumber();
    await conn.query(`INSERT INTO moves (game_id,player_id,team,from_square,to_square,promotion,san,fen_after_move,move_number,idempotency_key)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [gameId, player.id, game.current_turn, result.move.from, result.move.to, result.move.promotion || null, result.move.san, result.fen, moveNumber, idempotencyKey || null]);
    await conn.query(`UPDATE games SET fen=?,pgn=?,current_turn=?,move_number=?,game_status=?,game_version=game_version+1,last_successful_team_move=?,last_successful_player_id=?,active_player_id=NULL,active_turn_token=NULL,active_deadline_at=NULL WHERE id=?`, [result.fen, result.pgn, nextTeam, moveNumber, result.status, game.current_turn, player.id, gameId]);
    if (result.status !== 'active') await conn.query("UPDATE queue_entries SET queue_status='left' WHERE game_id=? AND queue_status='waiting'", [gameId]);
    await event(conn, gameId, player.id, 'move_executed', { san: result.move.san, from: result.move.from, to: result.move.to, status: result.status });
    let assignment = null;
    if (result.status === 'active') assignment = await assignNext(conn, { ...game, fen: result.fen, pgn: result.pgn, current_turn: nextTeam, move_number: moveNumber, last_successful_player_id: player.id, active_player_id: null }, gameId);
    return { move: result.move, fen: result.fen, pgn: result.pgn, status: result.status, moveNumber, nextTeam, playerName: player.display_name, assignment, gameVersion: game.game_version + 1 };
  });
  if (result.rejection) throw result.rejection;
  return result;
}

async function recoverAndAllocate() {
  return withGameLock(async (conn, game) => {
    const gameId = await getGameId(conn);
    if (game.active_player_id) return expireTurn(conn, game, gameId);
    else if (!game.active_player_id) return Boolean(await assignNext(conn, game, gameId));
    return false;
  });
}

async function tick() { return recoverAndAllocate(); }

async function baseSnapshot() {
  const [[game]] = await pool.query('SELECT g.*,UTC_TIMESTAMP(3) AS server_now FROM games g JOIN universal_state u ON u.current_game_id=g.id WHERE u.id=1');
  const gameId = game.id;
  const [moves] = await pool.query(`SELECT m.id,m.team,m.from_square,m.to_square,m.promotion,m.san,m.fen_after_move,m.move_number,m.created_at,p.display_name
    FROM moves m JOIN players p ON p.id=m.player_id WHERE m.game_id=? ORDER BY m.id`, [gameId]);
  const [queues] = await pool.query(`SELECT q.team,q.player_id,q.queue_position,p.display_name FROM queue_entries q JOIN players p ON p.id=q.player_id WHERE q.game_id=? AND q.queue_status='waiting' ORDER BY q.team,q.queue_position`, [gameId]);
  const [counts] = await pool.query(`SELECT team,COUNT(*) AS total FROM queue_entries WHERE game_id=? AND queue_status='waiting' GROUP BY team`, [gameId]);
  const [onlineRows] = await pool.query('SELECT COUNT(*) AS total FROM players WHERE last_seen_at > UTC_TIMESTAMP() - INTERVAL 90 SECOND');
  const [[participants]] = await pool.query('SELECT COUNT(DISTINCT player_id) AS total FROM moves WHERE game_id=?', [gameId]);
  const [teamParticipants] = await pool.query('SELECT team,COUNT(DISTINCT player_id) AS total FROM moves WHERE game_id=? GROUP BY team', [gameId]);
  const [[duration]] = await pool.query('SELECT TIMESTAMPDIFF(SECOND,created_at,UTC_TIMESTAMP()) AS seconds FROM games WHERE id=?', [gameId]);
  const activePlayer = game.active_player_id ? (await pool.query('SELECT display_name FROM players WHERE id=?', [game.active_player_id]))[0][0] : null;
  return {
    fen: game.fen, pgn: game.pgn, currentTurn: game.current_turn, moveNumber: game.move_number,
    status: game.game_status, activePlayer: activePlayer?.display_name || null,
    deadline: game.active_deadline_at ? new Date(game.active_deadline_at).toISOString() : null,
    serverNow: new Date(game.server_now).toISOString(),
    turnSeconds: game.turn_seconds, moves: moves.reverse(), queues, gameVersion: game.game_version,
    totalMoves: moves.length, totalParticipants: Number(participants.total),
    teamParticipants: { white: 0, black: 0, ...Object.fromEntries(teamParticipants.map(x => [x.team, Number(x.total)])) },
    durationSeconds: Number(duration.seconds), startedAt: new Date(game.created_at).toISOString(),
    queueCounts: { white: 0, black: 0, ...Object.fromEntries(counts.map(x => [x.team, Number(x.total)])) },
    online: Number(onlineRows[0].total), gameId
  };
}

async function personalStates(gameId, uuids) {
  const unique = [...new Set(uuids.filter(Boolean))];
  if (!unique.length) return new Map();
  const placeholders = unique.map(() => '?').join(',');
  const [rows] = await pool.query(`SELECT p.player_uuid,p.preferred_team,q.player_id,q.team,q.queue_status,q.queue_position,t.turn_token,t.deadline_at
    FROM players p
    LEFT JOIN queue_entries q ON q.game_id=? AND q.player_id=p.id AND q.queue_status IN ('waiting','assigned')
    LEFT JOIN turns t ON t.game_id=? AND t.player_id=p.id AND t.status='active'
    WHERE p.player_uuid IN (${placeholders})`, [gameId, gameId, ...unique]);
  const output = new Map(unique.map(uuid => [uuid, { queue: null, turn: null, preferredTeam: null }]));
  for (const row of rows) {
    const item = output.get(row.player_uuid);
    item.preferredTeam = row.preferred_team;
    if (row.player_id) item.queue = { player_id: row.player_id, team: row.team, queue_status: row.queue_status, queue_position: row.queue_position };
    if (row.turn_token) item.turn = { token: row.turn_token, deadline: new Date(row.deadline_at).toISOString() };
  }
  return output;
}

async function snapshot(uuid = null) {
  const base = await baseSnapshot();
  if (!uuid) {
    delete base.gameId;
    return base;
  }
  const players = await personalStates(base.gameId, [uuid]);
  delete base.gameId;
  return { ...base, me: players.get(uuid) || null };
}

async function snapshotsForPlayers(uuids) {
  const base = await baseSnapshot();
  const players = await personalStates(base.gameId, uuids);
  delete base.gameId;
  return { base, players };
}

async function updatePresence(uuid) {
  await pool.query('UPDATE players SET last_seen_at=UTC_TIMESTAMP() WHERE player_uuid=?', [uuid]);
}

async function setTimer(seconds) {
  return withGameLock(async (conn, game) => {
    const gameId = await getGameId(conn);
    await conn.query('UPDATE games SET turn_seconds=? WHERE id=?', [seconds, gameId]);
    await event(conn, gameId, null, 'timer_changed', { seconds });
  });
}

async function startNewGame() {
  return withGameLock(async (conn, game) => {
    if (game.game_status === 'active') throw new AppError('The current game must finish before a new one can start.', 'GAME_STILL_ACTIVE', 409);
    const [[clock]] = await conn.query('SELECT UTC_TIMESTAMP(3) AS now');
    const [created] = await conn.query(`INSERT INTO games (game_uuid,fen,pgn,current_turn,move_number,game_status,turn_seconds,created_at)
      VALUES (?,?,?,'white',1,'active',?,?)`, [randomUUID(), new Chess().fen(), '', game.turn_seconds, clock.now]);
    await conn.query('UPDATE universal_state SET current_game_id=? WHERE id=1', [created.insertId]);
    await event(conn, created.insertId, null, 'game_started', { previousGameId: game.id });
    return { gameId: created.insertId };
  });
}

async function eventCursor() {
  const [[row]] = await pool.query(`SELECT COALESCE(MAX(e.id),0) AS cursor FROM game_events e
    JOIN universal_state u ON u.current_game_id=e.game_id WHERE u.id=1`);
  return Number(row.cursor);
}

module.exports = { initialize, ensurePlayer, joinQueue, restorePreferredQueue, leaveQueue, submitMove, snapshot, snapshotsForPlayers, tick, eventCursor, updatePresence, withGameLock, setTimer, startNewGame };
