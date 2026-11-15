const test = require('node:test');
const assert = require('node:assert/strict');
const { Chess } = require('chess.js');
const { applyMove } = require('../backend/services/chessService');
const { nextEligible, orderByPosition } = require('../backend/services/queueService');
const { createTurn, isExpired } = require('../backend/services/turnService');
const { remainingSeconds } = require('../backend/services/timerService');
const preferences = require('../frontend/js/preferences');

test('accepts a legal move and returns the authoritative resulting FEN', () => {
  const result = applyMove(new Chess().fen(), { from: 'e2', to: 'e4' }, 'white');
  assert.equal(result.move.san, 'e4');
  assert.equal(result.chess.turn(), 'b');
  assert.equal(result.status, 'active');
});

test('allows the same White guest to play again after a successful Black response', () => {
  const aliceFirst = applyMove(new Chess().fen(), { from: 'e2', to: 'e4' }, 'white');
  assert.throws(() => applyMove(aliceFirst.fen, { from: 'd2', to: 'd4' }, 'white'), /black's turn/);
  const blackReply = applyMove(aliceFirst.fen, { from: 'e7', to: 'e5' }, 'black');
  const aliceAgain = applyMove(blackReply.fen, { from: 'g1', to: 'f3' }, 'white');
  assert.equal(aliceAgain.move.san, 'Nf3');
});

test('rejects illegal moves and moves by the wrong team', () => {
  const fen = new Chess().fen();
  assert.throws(() => applyMove(fen, { from: 'e2', to: 'e5' }, 'white'), /legal/);
  assert.throws(() => applyMove(fen, { from: 'e7', to: 'e5' }, 'white'), /belonging to your team/);
});

test('honors FIFO ordering and allocates only the currently eligible team', () => {
  const entries = [
    { id: 3, team: 'black', queue_position: 1, queue_status: 'waiting' },
    { id: 2, team: 'white', queue_position: 2, queue_status: 'waiting' },
    { id: 1, team: 'white', queue_position: 1, queue_status: 'waiting' },
    { id: 4, team: 'white', queue_position: 0, queue_status: 'timed_out' }
  ];
  assert.deepEqual(orderByPosition(entries).map(x => x.id), [4, 1, 3, 2]);
  assert.equal(nextEligible(entries, 'white').id, 1);
  assert.equal(nextEligible(entries, 'black').id, 3);
});

test('skips the last successful player for the immediate opposing opportunity', () => {
  const entries = [
    { id: 1, player_id: 11, team: 'black', queue_position: 1, queue_status: 'waiting' },
    { id: 2, player_id: 12, team: 'black', queue_position: 2, queue_status: 'waiting' }
  ];
  assert.equal(nextEligible(entries, 'black', 11).player_id, 12);
});

test('assigns a unique timed turn and expires it at its deadline', () => {
  const turn = createTurn({ id: 7 }, 'white', 15, 1_000);
  assert.equal(turn.deadlineAt.getTime(), 16_000);
  assert.equal(isExpired(turn, 15_999), false);
  assert.equal(isExpired(turn, 16_000), true);
  assert.notEqual(turn.token, createTurn({ id: 7 }, 'white', 15, 1_000).token);
  assert.equal(remainingSeconds(turn.deadlineAt, 1_100), 15);
});

test('a submitted move after deadline is rejected by deadline guard', () => {
  const turn = createTurn({ id: 7 }, 'white', 15, 1_000);
  assert.equal(isExpired(turn, 16_001), true);
});

test('a timeout keeps the current team eligible for its next queued player', () => {
  const entries = [
    { id: 1, team: 'black', queue_position: 1, queue_status: 'timed_out' },
    { id: 2, team: 'black', queue_position: 2, queue_status: 'waiting' },
    { id: 3, team: 'white', queue_position: 1, queue_status: 'waiting' }
  ];
  assert.equal(nextEligible(entries, 'black').id, 2);
  assert.equal(nextEligible(entries, 'white').id, 3);
});

test('disconnect leaves the active turn available until its server deadline; recovery keeps stored FEN', () => {
  const savedFen = new Chess().fen();
  const active = createTurn({ id: 9 }, 'black', 15, 100);
  // A socket disconnect is not a turn mutation. Restart recovery compares the stored deadline.
  assert.equal(active.status, 'active');
  assert.equal(isExpired(active, 101), false);
  assert.equal(new Chess(savedFen).fen(), savedFen);
  assert.equal(isExpired(active, 15_100), true);
});

test('recognizes checkmate as a terminal game state', () => {
  const mate = new Chess('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  assert.equal(mate.isCheckmate(), true);
  assert.throws(() => applyMove(mate.fen(), { from: 'a2', to: 'a3' }, 'white'));
});

test('recognizes stalemate as a terminal draw', () => {
  const stalemate = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(stalemate.isStalemate(), true);
  assert.equal(stalemate.isGameOver(), true);
});

test('theme preference defaults to dark and survives a fresh page runtime', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(preferences.loadTheme(storage), 'dark');
  preferences.saveTheme(storage, 'light');
  assert.equal(preferences.loadTheme(storage), 'light');
  preferences.saveTheme(storage, 'dark');
  assert.equal(preferences.loadTheme(storage), 'dark');
});
