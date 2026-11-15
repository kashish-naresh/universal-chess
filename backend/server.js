require('dotenv').config();
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Server } = require('socket.io');
const gameService = require('./services/gameService');
const gameRouter = require('./controllers/gameController');
const attachGameSockets = require('./sockets/gameSocket');
const pool = require('./config/database');

async function main() {
  await gameService.initialize();
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], connectSrc: ["'self'", 'ws:', 'wss:'] } } }));
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));
  app.use('/api/game', gameRouter);
  app.use(express.static(path.join(__dirname, '..', 'frontend')));
  app.use((err, req, res, next) => {
    if (err.name === 'ZodError') return res.status(400).json({ error: 'Invalid request data.', details: err.issues.map(x => x.message) });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error.' : err.message, code: err.code });
  });
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : false }, maxHttpBufferSize: 1e5 });
  app.set('io', io);
  attachGameSockets(io);
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`Universal Chess listening on http://localhost:${port}`));
  const shutdown = async () => { server.close(); await pool.end(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
main().catch(error => { console.error('Startup failed:', error); process.exit(1); });
