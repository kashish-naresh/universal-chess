const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const testDatabase = process.env.TEST_MYSQL_DATABASE;
if (testDatabase) process.env.MYSQL_DATABASE = testDatabase;

test('MySQL serialized turn, requeue, timeout, retry, recovery, and process locking', { skip: !testDatabase }, async () => {
  assert.match(testDatabase, /(?:^|_)test$/i, 'TEST_MYSQL_DATABASE must end in _test to prevent using a production database');
  const pool = require('../backend/config/database');
  const gameService = require('../backend/services/gameService');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8')
    .replace(/^CREATE DATABASE[^;]+;/im, '').replace(/^USE\s+[^;]+;/im, '');
  for (const statement of schema.split(';').map(x => x.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) await pool.query(statement);
  await gameService.initialize();

  const gameId = randomUUID();
  const [created] = await pool.query(`INSERT INTO games (game_uuid,fen,pgn,current_turn,move_number,game_status,turn_seconds)
    VALUES (?,?,'','white',1,'active',15)`, [gameId, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1']);
  await pool.query('UPDATE universal_state SET current_game_id=? WHERE id=1', [created.insertId]);

  const aliceId = randomUUID(), bobId = randomUUID(), charlieId = randomUUID(), daveId = randomUUID();
  await Promise.all([
    gameService.ensurePlayer(aliceId, 'Alice test'), gameService.ensurePlayer(bobId, 'Bob test'),
    gameService.ensurePlayer(charlieId, 'Charlie test'), gameService.ensurePlayer(daveId, 'Dave test')
  ]);

  assert.equal(await gameService.restorePreferredQueue(aliceId), null, 'a genuinely new guest has no saved team');
  const white = await gameService.joinQueue(aliceId, 'white');
  assert.equal(white.assigned, true);
  const firstToken = (await gameService.snapshot(aliceId)).me.turn.token;
  assert.equal((await gameService.snapshot(aliceId)).me.preferredTeam, 'white');
  assert.equal((await gameService.ensurePlayer(aliceId, 'Alice test', 'black')).preferred_team, 'white');
  assert.equal((await gameService.restorePreferredQueue(aliceId)).assigned, true);
  assert.equal((await gameService.snapshot(aliceId)).me.turn.token, firstToken, 'reconnect preserves the active turn token');
  const firstKey = randomUUID();
  const e4 = await gameService.submitMove(aliceId, firstToken, { from:'e2',to:'e4' }, firstKey);
  assert.equal(e4.move.san, 'e4');
  assert.equal(e4.nextTeam, 'black');
  assert.equal((await gameService.submitMove(aliceId, firstToken, { from:'e2',to:'e4' }, firstKey)).duplicate, true);
  await assert.rejects(gameService.submitMove(aliceId, firstToken, { from:'d2',to:'d4' }, randomUUID()), /active turn/);

  // The previous mover cannot take the immediate opposite-team reply, even if they queue first.
  await assert.rejects(gameService.joinQueue(aliceId, 'black'), /opposing team to complete/);
  // Alice and Bob wait separately. Black's successful response restores White eligibility.
  assert.equal((await gameService.restorePreferredQueue(aliceId)).assigned, false);
  await assert.rejects(gameService.joinQueue(aliceId, 'black'), /team is already set to WHITE/);
  await gameService.joinQueue(bobId, 'white');
  assert.equal((await gameService.joinQueue(charlieId, 'black')).assigned, true);
  const blackToken = (await gameService.snapshot(charlieId)).me.turn.token;
  await gameService.submitMove(charlieId, blackToken, { from:'e7',to:'e5' }, randomUUID());
  const aliceAgain = await gameService.snapshot(aliceId);
  assert.ok(aliceAgain.me.turn, 'first White queue entry gets the next White opportunity');
  const nf3Key = randomUUID();
  await gameService.submitMove(aliceId, aliceAgain.me.turn.token, { from:'g1',to:'f3' }, nf3Key);

  // Reply, then send competing requests with separate MySQL connections through the real service.
  await gameService.joinQueue(charlieId, 'black');
  const nc6Token = (await gameService.snapshot(charlieId)).me.turn.token;
  await gameService.submitMove(charlieId, nc6Token, { from:'b8',to:'c6' }, randomUUID());
  const bobTurn = (await gameService.snapshot(bobId)).me.turn;
  assert.ok(bobTurn);
  const raced = await Promise.allSettled([
    gameService.submitMove(aliceId, bobTurn.token, { from:'d2',to:'d4' }, randomUUID()),
    gameService.submitMove(bobId, bobTurn.token, { from:'d2',to:'d4' }, randomUUID())
  ]);
  assert.equal(raced.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(raced.filter(x => x.status === 'rejected').length, 1);

  // Force an already-assigned Black turn past its deadline. Tick must keep Black and assign the next queued player.
  const blackOwnerUuid = (await gameService.snapshot()).currentTurn === 'black' ? charlieId : daveId;
  if (!(await gameService.snapshot(blackOwnerUuid)).me?.queue) await gameService.joinQueue(blackOwnerUuid, 'black');
  const activeBlack = (await gameService.snapshot(blackOwnerUuid)).me.turn;
  assert.ok(activeBlack);
  await gameService.joinQueue(daveId, 'black');
  await pool.query(`UPDATE games SET active_deadline_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND)
    WHERE id=(SELECT current_game_id FROM universal_state WHERE id=1)`);
  await gameService.tick();
  const timedOutState = await gameService.snapshot(daveId);
  assert.equal(timedOutState.currentTurn, 'black');
  assert.ok(timedOutState.me.turn);
  const reconnectToken = timedOutState.me.turn.token, reconnectDeadline = timedOutState.me.turn.deadline;
  await gameService.updatePresence(daveId);
  await gameService.initialize();
  const recovered = await gameService.snapshot(daveId);
  assert.equal(recovered.me.turn.token, reconnectToken);
  assert.equal(recovered.me.turn.deadline, reconnectDeadline);

  // Two independent connections serialize on the universal pointer/game rows like two Node workers.
  const c1 = await pool.getConnection(), c2 = await pool.getConnection();
  try {
    await c1.beginTransaction();
    const [[pointer]] = await c1.query('SELECT current_game_id FROM universal_state WHERE id=1 FOR UPDATE');
    const [[versionBefore]] = await c1.query('SELECT game_version FROM games WHERE id=? FOR UPDATE', [pointer.current_game_id]);
    const secondLock = (async () => {
      await c2.beginTransaction();
      const [[otherPointer]] = await c2.query('SELECT current_game_id FROM universal_state WHERE id=1 FOR UPDATE');
      const [[otherVersion]] = await c2.query('SELECT game_version FROM games WHERE id=? FOR UPDATE', [otherPointer.current_game_id]);
      await c2.rollback(); return otherVersion.game_version;
    })();
    await c1.query('UPDATE games SET game_version=game_version+1 WHERE id=?', [pointer.current_game_id]);
    await c1.commit();
    assert.equal(await secondLock, versionBefore.game_version + 1);
  } catch (error) { await c1.rollback(); throw error; }
  finally { c1.release(); c2.release(); await pool.end(); }
});
