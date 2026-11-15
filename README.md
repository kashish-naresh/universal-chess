# Universal Chess

A shared chess match where guests can rejoin their team queue and participate repeatedly. Every successful move passes the opportunity to the other team. Node.js, Express, Socket.IO, Chess.js, and MySQL power the application.

## Architecture and correctness

The game is a small state machine: `waiting for current team` → `turn active` → (`move completed` and switch teams | `timed out` and try the next player on the same team). A completed checkmate, stalemate, or draw ends the game. Waiting queue rows are ordered by monotonically increasing position per team.

The single `games` row is the cross-process mutex. Every queue/turn/move mutation runs in a MySQL transaction and locks that row with `SELECT ... FOR UPDATE`. The service validates the UUID, active player, opaque turn token, deadline, team, and requested move against the stored FEN while holding the lock. Only then does it update FEN/PGN, write the move and event, complete the turn, and allocate the next turn. Concurrent submissions serialize; a second submission sees that its token is no longer active. Clients never supply an authoritative board position. The queue and active deadline survive restarts; startup reclaims expired turns and allocates the next one.

Guest identity is a UUID in `localStorage`, reused by refreshes and tabs. The first team a guest chooses is saved on their existing player record and cannot be changed; reconnects restore that team's waiting or active queue entry. Completed and timed-out queue entries are historical; a player can join again at the back of their saved team's queue. There is no daily move cap. A player can never make a second move for their team until the opponent has completed a legal move. A timeout does not switch teams; it allocates the same team's next waiting player. Disconnecting does not silently revoke a turn; the database deadline remains authoritative, and the same guest can reconnect and resume their active turn.

The header sun/moon button switches between dark (default) and light themes instantly. The selection is saved in `localStorage` and restored on refresh.

Every move transaction locks the singleton `universal_state` pointer and current `games` row, then locks the active `turns` row. The database clock determines deadlines. The last successful player cannot join the immediate opposing turn; the allocator also skips any historical blocked entry. After the opponent completes a move, the player is eligible again under normal FIFO order. A unique per-move idempotency key protects retries, while the turn token prevents later submissions from reusing completed permission. These locks and constraints work across multiple Node processes.

## Requirements

- Node.js 20 or newer
- MySQL 8.0+

## Setup

1. Create a MySQL database and user, then load `database/schema.sql`:

   ```sh
   mysql -u root -p < database/schema.sql
   ```

   The schema creates the `universal_chess` database. For example, create the runtime user from a MySQL admin session with `CREATE USER 'chess'@'localhost' IDENTIFIED BY 'change-me';` and `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON universal_chess.* TO 'chess'@'localhost';`. Match those credentials in `.env`.

2. Copy `.env.example` to `.env` and set MySQL credentials and a private `ADMIN_TOKEN`.
3. Install and run:

   ```sh
   npm install
   npm run dev
   ```

4. Open `http://localhost:3000`. `npm start` runs without the file watcher.

## Docker

Docker Engine and the Docker Compose plugin are required. Copy `.env.example` to `.env`, set a strong `MYSQL_PASSWORD` and private `ADMIN_TOKEN`, then start the app and its local MySQL database:

```sh
docker compose up --build -d
```

Open `http://localhost:3000`. Compose initializes a named `mysql_data` volume from `database/schema.sql`; the app applies its additive migrations at startup. Later starts reuse the database volume. View logs with `docker compose logs -f app`, and stop the services with `docker compose down`. `docker compose down -v` also deletes the local database volume.

The image listens on port 3000. Set `PORT` to change the host port mapping and set `PUBLIC_URL` to the public HTTPS origin when serving it behind an HTTPS reverse proxy. Keep `.env` private.

### Oracle Cloud

Build and push the image to Oracle Cloud Infrastructure Registry (OCIR), then deploy it on an Oracle Cloud compute instance or container service with a reachable MySQL database. The image contains only the Node app; the Compose MySQL service is for local development. Configure the deployed container with `NODE_ENV=production`, `PORT=3000`, `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `PUBLIC_URL`, and `ADMIN_TOKEN`. Use the Oracle database's private endpoint and TLS/network settings as required by that database service. Allow inbound traffic only through your HTTPS reverse proxy, and set `PUBLIC_URL` to that HTTPS origin for Socket.IO origin checks.

Example image build and push (replace the OCIR region, tenancy namespace, repository, and tag):

```sh
docker build -t <region-key>.ocir.io/<tenancy-namespace>/<repository>:<tag> .
docker push <region-key>.ocir.io/<tenancy-namespace>/<repository>:<tag>
```

On startup the app applies the additive `002_repeat_participation` migration under a MySQL advisory lock, backfills game versions from the existing move log, and points the universal game state at the existing game. It does not drop tables or rewrite player/move records. The account needs `ALTER`, `INDEX`, and `CREATE` privileges in addition to table reads and writes for startup migrations. For a hosted deployment, set `PUBLIC_URL` to the app's HTTPS origin and place the Node process behind an HTTPS reverse proxy. Keep `.env` private, use a managed MySQL instance with backups, and run one or more app instances; the database lock keeps turn ownership consistent across instances.

## Configuration

`MOVE_TIMER_SECONDS` sets the initial timer, clamped to 5–120 seconds. Change the live timer with `POST /api/game/admin/timer`, JSON `{"seconds":20}`, and header `x-admin-token: <ADMIN_TOKEN>`. The value is stored on the game row, so it persists. Changing it does not extend a turn already in progress.

## Tests

Run `npm test` for deterministic chess, queue, turn, and theme preference tests. The MySQL integration scenario is skipped unless `TEST_MYSQL_DATABASE` is set to a dedicated database name ending in `_test`; it then verifies saved team selection, rejoining with the same active turn, turn exclusion, simultaneous requests, timeout allocation, reconnect/restart recovery, idempotent retries, and row locking through separate database connections. The test adds a new isolated game row and does not drop test or application records.

```powershell
$env:TEST_MYSQL_DATABASE = 'universal_chess_test'
npm test
```

## API and events

Read-only game state is available under `/api/game/state`; queue and move mutations are accepted only through Socket.IO events (`join_team`, `leave_queue`, `submit_move`) and validated against the connection's guest identity and database state. Other socket events include `request_game_state` and `heartbeat`; each process polls the shared MySQL event log so clients connected to different Node processes receive changes. Admin endpoints allow changing the timer and starting a new game after the current game ends. Prior games and their histories remain stored.

## Known deployment detail

The chessboard is rendered in vanilla JavaScript with Unicode chess pieces; Chess.js handles legal destinations in the browser and enforces all actual legality on the server. The client loads its lightweight rules helper from cdnjs, while the server uses the npm package. Deploy behind same-origin HTTPS so the browser and WebSocket remain encrypted.
