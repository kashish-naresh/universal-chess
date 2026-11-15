♟️ Universal Chess
One board. Two teams. Unlimited participation.

A real-time, team-based chess application where anyone can join a team queue, participate in turns, and return to play again. Every successful move hands control to the opposing team, creating a shared chess experience where multiple guests collaborate to play a single match.

Built with Node.js, Express, Socket.IO, Chess.js, and MySQL, with transactional turn management, persistent queues, and multi-instance concurrency support.

<p align="center">
<img src="https://img.shields.io/badge/Node.js-20%2B-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 20+"/>
<img src="https://img.shields.io/badge/Express.js-Framework-black?style=for-the-badge&logo=express" alt="Express"/>
<img src="https://img.shields.io/badge/Socket.IO-Realtime-010101?style=for-the-badge&logo=socket.io" alt="Socket.IO"/>
<img src="https://img.shields.io/badge/MySQL-8.0%2B-4479A1?style=for-the-badge&logo=mysql&logoColor=white" alt="MySQL"/>
<img src="https://img.shields.io/badge/Chess.js-Rules-green?style=for-the-badge" alt="Chess.js"/>
</p>

✨ Features
♟️ Universal Team Chess — Multiple guests collaborate on one shared chessboard.
🔄 Repeat Participation — Players can rejoin their saved team queue after completing a turn.
⚡ Real-Time Updates — Socket.IO broadcasts moves, queue changes, and game events.
⏱️ Timed Turns — Configurable turn timers with automatic timeout handling.
🔐 Persistent Guest Identity — UUID-based identity survives refreshes and browser tabs.
🛡️ Server-Side Validation — All moves are validated against the authoritative database FEN.
🔒 Transactional Concurrency — MySQL row locks prevent simultaneous turn ownership and conflicting moves.
🔁 Idempotent Moves — Unique move keys protect against duplicate submissions and retries.
💾 Persistent Game State — Queues, turns, move history, and deadlines survive restarts.
🌗 Dark & Light Themes — Instant theme switching with saved preferences.
🐳 Docker Support — Run the application and MySQL using Docker Compose.
☁️ Oracle Cloud Ready — Deploy containerized application instances against a shared MySQL database.
🎮 How It Works

Universal Chess operates as a shared match between two teams.

A guest joins either the Sun or Moon team.
The player enters their team's FIFO waiting queue.
When their team gets control, the next eligible player receives a timed turn.
The player submits a legal chess move.
The move is validated and committed to the database.
Control passes to the opposing team.
The process repeats until checkmate, stalemate, or a draw.

Timeouts do not change teams. Instead, the next eligible player on the same team receives the opportunity.

🏗️ Architecture
Technology Stack
Technology	Purpose
Node.js 20+	Backend runtime
Express.js	HTTP server and REST API
Socket.IO	Real-time communication
Chess.js	Chess rules and move validation
MySQL 8.0+	Persistent game state and transactions
Vanilla JavaScript	Frontend and chessboard
Docker	Containerized deployment
Game State Machine
mermaid
stateDiagram-v2
    [*] --> Waiting
    Waiting --> Active: Allocate player
    Active --> Completed: Legal move
    Active --> TimedOut: Deadline reached
    Completed --> Waiting: Switch teams
    TimedOut --> Waiting: Next player, same team
    Completed --> Finished: Checkmate / Draw
    Finished --> [*]

Database-Driven Concurrency

The database is the source of truth. Every queue, turn, and move mutation executes inside a MySQL transaction.

The singleton games row acts as the cross-process mutex.

A move transaction follows this sequence:

Lock the singleton universal_state pointer.
Lock the current games row using SELECT ... FOR UPDATE.
Lock the active turns row.
Validate the game UUID, player identity, team, turn token, and database deadline.
Validate the requested move against the stored FEN.
Update FEN, PGN, move history, and game version.
Record the corresponding event.
Complete the current turn and allocate the next eligible player.
Commit the transaction.

This ensures that concurrent requests serialize correctly, including requests handled by different Node.js processes.

Important Correctness Guarantees
Clients never provide an authoritative board position.
Only the active player with the current opaque turn token can submit a move.
A completed turn token cannot authorize another submission.
A unique per-move idempotency key protects retries.
A player cannot make another move for their team until the opposing team completes a legal move.
The last successful player is excluded from the immediate opposing turn.
Historical blocked queue entries are skipped during allocation.
Timed-out players retain their team and can rejoin at the back of the queue.
Disconnecting does not silently revoke an active turn.
Database deadlines remain authoritative across reconnects and restarts.
👥 Queue & Identity System

Each guest receives a UUID stored in browser localStorage.

The first team selected is permanently associated with that guest's player record.

On reconnect:

The saved team is restored.
Existing waiting queue entries are preserved.
An active turn can be resumed using the same guest identity.
Completed and timed-out queue entries remain historical.
A guest can join again at the back of their saved team's queue.

There is no daily move limit.

📁 Project Structure
text
universal-chess/
│
├── database/
│   ├── schema.sql
│   └── migrations/
│
├── public/
│   ├── index.html
│   ├── css/
│   └── js/
│
├── src/
│   ├── server/
│   ├── services/
│   ├── sockets/
│   └── database/
│
├── tests/
│
├── .env.example
├── .dockerignore
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md


Adjust this tree to match the actual repository structure.

🚀 Getting Started
Prerequisites
Node.js 20 or newer
MySQL 8.0 or newer
npm
1. Clone the Repository
bash
git clone https://github.com/YOUR_USERNAME/universal-chess.git
cd universal-chess

2. Create the Database

Load the database schema:

bash
mysql -u root -p < database/schema.sql


The schema creates the universal_chess database.

Create a dedicated runtime user:

sql
CREATE USER 'chess'@'localhost'
IDENTIFIED BY 'change-me';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX
ON universal_chess.*
TO 'chess'@'localhost';

3. Configure Environment Variables

Copy the example environment file:

bash
cp .env.example .env


Configure your MySQL credentials and private admin token.

Example:

env
NODE_ENV=development
PORT=3000

MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=chess
MYSQL_PASSWORD=change-me
MYSQL_DATABASE=universal_chess

MOVE_TIMER_SECONDS=30
ADMIN_TOKEN=replace-with-a-strong-private-token


Use the actual variable names defined in .env.example.

Important: Never commit .env or expose your ADMIN_TOKEN.

4. Install Dependencies
bash
npm install

5. Start the Application

Development mode:

bash
npm run dev


Production mode:

bash
npm start


Open your browser:

text
http://localhost:3000

🐳 Docker Deployment

Run the entire application with Docker Compose.

Requirements
Docker Engine
Docker Compose plugin
Start

Configure .env with a strong MYSQL_PASSWORD and private ADMIN_TOKEN, then run:

bash
docker compose up --build -d


Open:

text
http://localhost:3000

Useful Commands

View application logs:

bash
docker compose logs -f app


Stop containers:

bash
docker compose down


Stop containers and delete the database volume:

bash
docker compose down -v


Warning: The -v option deletes the local MySQL data volume.

Docker Compose initializes the named mysql_data volume using database/schema.sql. Subsequent starts reuse the existing database, while the application applies additive migrations at startup.

☁️ Oracle Cloud Deployment

Universal Chess supports deployment using Oracle Cloud Infrastructure Registry (OCIR) and an Oracle Cloud compute instance or container service.

1. Build the Docker Image

Replace the placeholders with your OCIR region, tenancy namespace, repository, and tag.

bash
docker build \
  -t <region-key>.ocir.io/<tenancy-namespace>/<repository>:<tag> .

2. Push to OCIR
bash
docker push \
  <region-key>.ocir.io/<tenancy-namespace>/<repository>:<tag>

3. Configure Production Environment

Configure the deployed container with:

env
NODE_ENV=production
PORT=3000

MYSQL_HOST=<private-database-endpoint>
MYSQL_PORT=3306
MYSQL_USER=<database-user>
MYSQL_PASSWORD=<database-password>
MYSQL_DATABASE=universal_chess

PUBLIC_URL=https://your-domain.com
ADMIN_TOKEN=<strong-private-token>


Also configure MOVE_TIMER_SECONDS if required.

4. Production Recommendations
Use a managed MySQL database with backups.
Keep database connectivity on a private network where possible.
Enable TLS according to your database service configuration.
Place Node.js behind an HTTPS reverse proxy.
Expose application traffic only through the reverse proxy.
Set PUBLIC_URL to the public HTTPS origin.
Keep environment variables and secrets private.
Run multiple application instances when needed.

Multi-instance support: Database-level locking and the shared event log keep turn ownership consistent across multiple Node.js processes.

Database Migrations

On startup, the application:

Acquires a MySQL advisory lock.
Applies the additive 002_repeat_participation migration.
Backfills game versions from the existing move log.
Points the universal game state at the existing game.

Existing player and move records are preserved. The migration does not drop tables or rewrite historical records.

The runtime database account must have ALTER, INDEX, and CREATE privileges for startup migrations.

⚙️ Configuration
Turn Timer

The MOVE_TIMER_SECONDS environment variable controls the initial turn duration.

Minimum: 5 seconds
Maximum: 120 seconds

The live timer can also be changed through the admin API.

Endpoint

http
POST /api/game/admin/timer


Headers

http
Content-Type: application/json
x-admin-token: YOUR_ADMIN_TOKEN


Request Body

json
{
  "seconds": 20
}


The updated value is stored in the game row and persists across restarts.

Changing the timer does not extend a turn that is already in progress.

🔌 API & Socket Events
HTTP API
Method	Endpoint	Description
GET	/api/game/state	Retrieve read-only game state
POST	/api/game/admin/timer	Update the game timer

Admin endpoints also support starting a new game after the current game ends.

Socket.IO Events
Event	Direction	Description
join_team	Client → Server	Join the saved team queue
leave_queue	Client → Server	Leave the waiting queue
submit_move	Client → Server	Submit a chess move
request_game_state	Client → Server	Request the latest game state
heartbeat	Client → Server	Maintain connection activity

The server broadcasts game updates through Socket.IO.

Each process also polls the shared MySQL event log so clients connected to different application instances receive game changes.

Queue and move mutations are accepted only through Socket.IO and validated against the connection's guest identity and database state.

🧪 Testing

Run the test suite:

bash
npm test


The deterministic tests cover:

Chess rules and move validation.
Queue allocation.
Turn management.
Theme preferences.
MySQL Integration Tests

The integration scenario is skipped unless TEST_MYSQL_DATABASE is configured with a dedicated database name ending in _test.

PowerShell:

powershell
$env:TEST_MYSQL_DATABASE = 'universal_chess_test'
npm test


The integration scenario verifies:

Saved team selection.
Rejoining with the same active turn.
Turn exclusion.
Simultaneous move requests.
Timeout allocation.
Reconnect and restart recovery.
Idempotent retries.
Row locking across separate database connections.

The test creates an isolated game row and does not drop test or application records.

Important: Use a dedicated test database, never your production database.

🔐 Security & Reliability

Universal Chess is designed around server-authoritative game state.

Concern	Implementation
Guest identity	Persistent UUID
Team selection	Saved player record
Move authorization	Opaque turn token
Chess legality	Server-side Chess.js validation
Concurrent requests	MySQL transactions and row locks
Duplicate requests	Unique idempotency keys
Turn expiration	Database-authoritative deadlines
Restart recovery	Persistent queue and turn state
Multi-instance consistency	Shared MySQL state and event log
Transport security	Same-origin HTTPS deployment
Chessboard Rendering

The frontend renders the chessboard using vanilla JavaScript and Unicode chess pieces.

Chess.js provides legal destination assistance in the browser, while the server independently validates every submitted move against the authoritative stored FEN.

The browser loads its lightweight rules helper from cdnjs, while the backend uses the npm package.

For production, deploy behind same-origin HTTPS to keep browser traffic and WebSocket connections encrypted.

🌗 Theme Support

Universal Chess includes two visual themes:

🌙 Dark mode — Default theme.
☀️ Light mode — Instantly switchable.

The sun/moon header button switches themes without reloading the application.

The selected preference is saved in localStorage and restored on refresh.

🛣️ Future Improvements

Potential additions to expand the platform:

Spectator mode.
Player statistics and leaderboards.
Match replay and move navigation.
Team chat.
Custom game timers.
More detailed game analytics.
Improved mobile chessboard experience.
🤝 Contributing

Contributions, suggestions, and bug reports are welcome!

Fork the repository.
Create a feature branch.
Commit your changes.
Open a pull request.

Please include relevant tests when modifying game logic, queue allocation, or transaction handling.

📜 License

Add your preferred open-source license to the repository before publishing.

<p align="center">
<b>♟️ Universal Chess</b>
<br/>
One game. Two teams. Everyone gets a move.
<br/><br/>
Built with ❤️ using Node.js, Socket.IO, Chess.js, and MySQL.
</p>
