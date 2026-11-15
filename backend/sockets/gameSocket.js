const { z } = require('zod');
const gameService = require('../services/gameService');
const { AppError } = require('../utils/errors');

module.exports = function attachGameSockets(io) {
  let observedEventCursor = 0;
  const permitAction = socket => {
    const now = Date.now();
    if (!socket.data.actionWindow || now - socket.data.actionWindow.startedAt >= 10_000) socket.data.actionWindow = { startedAt: now, count: 0 };
    socket.data.actionWindow.count += 1;
    return socket.data.actionWindow.count <= 35;
  };
  io.use(async (socket, next) => {
    const uuid = socket.handshake.auth?.playerUuid;
    if (uuid && !z.string().uuid().safeParse(uuid).success) return next(new Error('Invalid guest identity'));
    try {
      socket.data.playerUuid = uuid || null;
      if (uuid) {
        const player = await gameService.ensurePlayer(uuid, socket.handshake.auth?.displayName);
        socket.data.preferredTeam = player.preferred_team;
      }
      next();
    } catch (e) { next(e); }
  });
  const broadcastState = async () => {
    const sockets = await io.fetchSockets();
    const { base, players } = await gameService.snapshotsForPlayers(sockets.map(socket => socket.data.playerUuid));
    for (const socket of sockets) socket.emit('game_state', { ...base, online: sockets.length, me: players.get(socket.data.playerUuid) || null });
  };
  io.on('connection', async socket => {
    const refresh = async () => {
      if (socket.data.playerUuid) await gameService.updatePresence(socket.data.playerUuid);
      socket.emit('game_state', await gameService.snapshot(socket.data.playerUuid));
    };
    if (socket.data.playerUuid && socket.data.preferredTeam) {
      try { await gameService.restorePreferredQueue(socket.data.playerUuid); }
      catch (error) { if (error.code !== 'GAME_OVER') console.error('Could not restore the guest queue:', error.message); }
    }
    await refresh();
    await broadcastState();
    socket.on('request_game_state', () => { if (permitAction(socket)) refresh(); });
    socket.on('heartbeat', async (ack) => {
      try { if (!permitAction(socket)) throw new AppError('Too many actions. Please wait a moment.', 'RATE_LIMITED', 429); if (socket.data.playerUuid) await gameService.updatePresence(socket.data.playerUuid); if (ack) ack({ ok: true }); }
      catch (e) { if (ack) ack({ ok: false, error: e.message }); }
    });
    socket.on('join_team', async (payload, ack = () => {}) => {
      try {
        if (!permitAction(socket)) throw new AppError('Too many actions. Please wait a moment.', 'RATE_LIMITED', 429);
        const input = z.object({ team: z.enum(['white','black']), displayName: z.string().max(40).optional() }).parse(payload);
        if (!socket.data.playerUuid) throw new AppError('Reconnect with a guest identity first.');
        const result = await gameService.joinQueue(socket.data.playerUuid, input.team, input.displayName);
        ack({ ok: true, ...result }); await broadcastState();
      } catch (e) { ack({ ok: false, error: e.message, code: e.code }); }
    });
    socket.on('leave_queue', async (ack = () => {}) => {
      try { if (!permitAction(socket)) throw new AppError('Too many actions. Please wait a moment.', 'RATE_LIMITED', 429); if (!socket.data.playerUuid) throw new AppError('No guest identity.'); await gameService.leaveQueue(socket.data.playerUuid); ack({ ok: true }); await broadcastState(); }
      catch (e) { ack({ ok: false, error: e.message }); }
    });
    socket.on('submit_move', async (payload, ack = () => {}) => {
      try {
        if (!permitAction(socket)) throw new AppError('Too many actions. Please wait a moment.', 'RATE_LIMITED', 429);
        const input = z.object({ turnToken: z.string().uuid(), idempotencyKey: z.string().uuid(), from: z.string().regex(/^[a-h][1-8]$/), to: z.string().regex(/^[a-h][1-8]$/), promotion: z.enum(['q','r','b','n']).optional() }).parse(payload);
        if (!socket.data.playerUuid) throw new AppError('No guest identity.');
        const result = await gameService.submitMove(socket.data.playerUuid, input.turnToken, input, input.idempotencyKey);
        ack({ ok: true, san: result.move.san });
        io.emit('move_executed', { san: result.move.san, from: result.move.from, to: result.move.to, player: result.playerName });
        await broadcastState();
      } catch (e) { ack({ ok: false, error: e.message, code: e.code }); }
    });
    socket.on('disconnect', async () => { if (socket.data.playerUuid) await gameService.updatePresence(socket.data.playerUuid).catch(() => {}); await broadcastState().catch(() => {}); });
  });
  gameService.eventCursor().then(cursor => { observedEventCursor = cursor; }).catch(error => console.error('Could not load game event cursor:', error.message));
  const interval = setInterval(async () => {
    try {
      const changed = await gameService.tick();
      const cursor = await gameService.eventCursor();
      if (changed || cursor > observedEventCursor) await broadcastState();
      observedEventCursor = cursor;
    } catch (e) { console.error('Timer tick failed:', e.message); }
  }, 250);
  interval.unref();
};
