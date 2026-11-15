const { z } = require('zod');
const gameService = require('../services/gameService');
const { AppError } = require('../utils/errors');

const router = require('express').Router();

router.get('/state', async (req, res, next) => {
  try { res.json(await gameService.snapshot()); }
  catch (e) { next(e); }
});
router.post('/admin/timer', async (req, res, next) => {
  try {
    if (!process.env.ADMIN_TOKEN || req.get('x-admin-token') !== process.env.ADMIN_TOKEN) throw new AppError('Admin authorization required.', 'FORBIDDEN', 403);
    const seconds = z.number().int().min(5).max(120).parse(req.body.seconds);
    await gameService.setTimer(seconds);
    req.app.get('io').emit('state_changed'); res.json({ turnSeconds: seconds });
  } catch (e) { next(e); }
});
router.post('/admin/new-game', async (req, res, next) => {
  try {
    if (!process.env.ADMIN_TOKEN || req.get('x-admin-token') !== process.env.ADMIN_TOKEN) throw new AppError('Admin authorization required.', 'FORBIDDEN', 403);
    const result = await gameService.startNewGame();
    const io = req.app.get('io');
    io.emit('game_over');
    io.emit('state_changed');
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});
module.exports = router;
