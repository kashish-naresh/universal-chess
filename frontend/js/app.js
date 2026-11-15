(() => {
  const pieces = { wk:'♔',wq:'♕',wr:'♖',wb:'♗',wn:'♘',wp:'♙',bk:'♚',bq:'♛',br:'♜',bb:'♝',bn:'♞',bp:'♟' };
  const $ = id => document.getElementById(id);
  const idKey = 'universal-chess-player';
  const preferences = window.UniversalChessPreferences;
  document.documentElement.dataset.theme = preferences.loadTheme(localStorage);
  let playerUuid = localStorage.getItem(idKey);
  if (!playerUuid) { playerUuid = crypto.randomUUID(); localStorage.setItem(idKey, playerUuid); }
  const teamCacheKey = `universal-chess-team:${playerUuid}`;
  let socket, state, chess, selected = null, legalTargets = [], turnToken = null, toastTimeout, timerInterval, serverClockOffset = 0, personalStateReady = false;
  const socketReady = () => typeof io === 'function';
  const ChessCtor = () => window.Chess;

  function notify(message) {
    const el = $('toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toastTimeout); toastTimeout = setTimeout(() => el.classList.remove('show'), 2800);
  }
  function requestState() {
    if (!socketReady()) return;
    if (!socket) {
      socket = io({ auth: { playerUuid } });
      socket.on('connect', () => { $('connection-status').textContent = 'LIVE'; $('connection-dot').classList.add('connected'); socket.emit('request_game_state'); });
      socket.on('game_state', render);
      socket.on('state_changed', requestState);
      socket.on('move_executed', m => { $('last-move').textContent = `${m.san} · ${m.player}`; });
      socket.on('connect_error', () => { $('connection-status').textContent = 'RECONNECTING'; $('connection-dot').classList.remove('connected'); $('status-text').textContent = 'Reconnecting to the shared game…'; });
      socket.on('disconnect', () => { $('connection-status').textContent = 'RECONNECTING'; $('connection-dot').classList.remove('connected'); $('status-text').textContent = 'Connection lost · reconnecting'; });
    } else socket.emit('request_game_state');
  }
  async function fetchState() {
    try { const response = await fetch('/api/game/state'); if (!response.ok) throw new Error(); render(await response.json()); }
    catch { $('status-text').textContent = 'Waiting for the game server…'; }
  }
  function render(next) {
    if (!next) return;
    if (Object.prototype.hasOwnProperty.call(next, 'me')) personalStateReady = true;
    else if (state?.me) next = { ...next, me: state.me };
    const previousTurn = turnToken;
    const previousMoveCount = state?.totalMoves ?? state?.moves?.length ?? 0;
    const previousVersion = state?.gameVersion;
    const previousQueuePosition = state?.me?.queue?.queue_position ?? null;
    const previousFen = chess?.fen();
    const previousTurnWasMine = Boolean(turnToken);
    state = next;
    if (state.serverNow) serverClockOffset = new Date(state.serverNow).getTime() - Date.now();
    if (ChessCtor()) { chess = new (ChessCtor())(state.fen); }
    $('online-count').textContent = state.online;
    $('move-count').textContent = state.totalMoves ?? state.moves.length;
    $('white-waiting').textContent = state.queueCounts.white;
    $('black-waiting').textContent = state.queueCounts.black;
    $('white-count').textContent = state.queueCounts.white;
    $('black-count').textContent = state.queueCounts.black;
    $('move-number').textContent = `MOVE ${String(state.moveNumber).padStart(2, '0')}`;
    const turnName = state.currentTurn.toUpperCase();
    $('turn-text').textContent = state.status === 'active' ? (state.activePlayer ? `${turnName} · ACTIVE` : `${turnName} TO MOVE`) : state.status.toUpperCase();
    $('turn-piece').textContent = state.currentTurn === 'white' ? '♙' : '♟';
    $('status-text').textContent = state.status === 'active' ? (state.activePlayer ? `${state.activePlayer} has ${state.turnSeconds}s to move` : `Waiting for a ${turnName.toLowerCase()} player`) : `Game ${state.status}`;
    $('status-dot').classList.toggle('active', Boolean(state.activePlayer));
    $('white-indicator').classList.toggle('active', state.currentTurn === 'white');
    $('black-indicator').classList.toggle('active', state.currentTurn === 'black');
    $('white-player').textContent = state.currentTurn === 'white' && state.activePlayer ? state.activePlayer : `${state.queueCounts.white} WAITING`;
    $('black-player').textContent = state.currentTurn === 'black' && state.activePlayer ? state.activePlayer : `${state.queueCounts.black} WAITING`;
    $('participant-total').textContent = state.totalParticipants || 0;
    $('white-player-total').textContent = state.teamParticipants?.white || 0;
    $('black-player-total').textContent = state.teamParticipants?.black || 0;
    $('duration-total').textContent = formatDuration(state.durationSeconds || 0);
    const activeMove = state.me?.turn;
    const selectedTeam = personalStateReady ? state.me?.preferredTeam || null : localStorage.getItem(teamCacheKey);
    turnToken = activeMove?.token || null;
    if (previousTurn && !turnToken && (state.totalMoves ?? state.moves.length) === previousMoveCount && state.me && !state.me.queue) notify('You missed your turn. Rejoin the team queue to try again.');
    $('my-queue').querySelector('strong').textContent = activeMove ? 'YOUR TURN · MAKE ONE MOVE' : state.me?.queue ? `${state.me.queue.team.toUpperCase()} · ${state.me.queue.queue_status === 'assigned' ? 'TURN ACTIVE' : `POSITION ${state.me.queue.queue_position}`}` : selectedTeam ? `${selectedTeam.toUpperCase()} · READY TO REJOIN` : 'YOU ARE WATCHING';
    $('my-queue').querySelector('small').textContent = activeMove ? 'Select a piece and move before the clock expires.' : state.me?.queue ? 'Your position and active turn are saved to this identity.' : selectedTeam ? `Your team is saved. Rejoin ${selectedTeam} whenever you are ready.` : 'Pick a team to join the next opportunity.';
    $('leave-queue').hidden = !state.me?.queue;
    $('join-white').hidden = !personalStateReady || Boolean(state.me?.queue) || Boolean(selectedTeam && selectedTeam !== 'white') || state.status !== 'active';
    $('join-black').hidden = !personalStateReady || Boolean(state.me?.queue) || Boolean(selectedTeam && selectedTeam !== 'black') || state.status !== 'active';
    $('join-white').querySelector('.join-label').textContent = selectedTeam === 'white' ? 'REJOIN WHITE' : 'JOIN WHITE';
    $('join-black').querySelector('.join-label').textContent = selectedTeam === 'black' ? 'REJOIN BLACK' : 'JOIN BLACK';
    renderQueues(); renderHistory(); renderBoard(); startTimer();
    if (previousVersion != null && state.gameVersion > previousVersion && previousFen) animateLastMove();
    if (state.me?.queue?.queue_position <= 2 && (previousQueuePosition == null || previousQueuePosition > 2)) notify('Your team’s turn is coming up.');
    if (!previousTurnWasMine && turnToken) notify('It’s your turn. Make one legal move before the clock runs out.');
    const ended = state.status !== 'active';
    $('game-over').hidden = !ended;
    if (ended) {
      $('game-result').textContent = state.status.toUpperCase();
      $('game-over-detail').textContent = state.status === 'checkmate' ? `${state.currentTurn === 'white' ? 'Black' : 'White'} wins by checkmate.` : `The game ended by ${state.status}.`;
      const final = state.moves.at(-1); $('final-move').textContent = final ? `${final.san} · ${final.display_name}` : 'No moves were played.';
    }
  }
  function formatDuration(seconds) { const mins = Math.floor(seconds / 60); const hours = Math.floor(mins / 60); return hours ? `${hours}h ${mins % 60}m` : `${mins}m`; }
  function renderQueues() {
    for (const team of ['white','black']) {
      const list = $(`${team}-list`); list.replaceChildren();
      const people = state.queues.filter(q => q.team === team);
      if (!people.length) { const li = document.createElement('li'); li.className = 'queue-empty'; li.textContent = 'Queue is clear'; list.append(li); }
      people.slice(0, 6).forEach((p, i) => {
        const li = document.createElement('li'); if (state.me?.queue?.player_id === p.player_id) li.classList.add('me');
        const num = document.createElement('span'); num.textContent = `${i + 1}.`;
        const name = document.createElement('span'); name.textContent = p.display_name;
        li.append(num, name); list.append(li);
      });
    }
  }
  function renderHistory() {
    const rows = $('move-history'); rows.replaceChildren(); $('history-total').textContent = state.moves.length;
    if (!state.moves.length) { const empty = document.createElement('div'); empty.className = 'empty-history'; empty.textContent = 'The first move is yours to make.'; rows.append(empty); $('last-move').textContent = 'Waiting for the opening move'; return; }
    const chronological = state.moves;
    for (let i = 0; i < chronological.length; i += 2) {
      const row = document.createElement('div'); row.className = 'history-row';
      const number = document.createElement('span'); number.className = 'num'; number.textContent = `${Math.floor(i / 2) + 1}.`;
      const white = document.createElement('span'); white.className = 'move'; white.textContent = chronological[i].san;
      const black = document.createElement('span'); black.className = 'move'; black.textContent = chronological[i + 1]?.san || '';
      const by = document.createElement('span'); by.className = 'by'; by.textContent = `${chronological[i + 1] ? `B · ${chronological[i + 1].display_name}` : `${chronological[i].team.toUpperCase()} · ${chronological[i].display_name}`}`;
      row.append(number, white, black, by); rows.append(row);
    }
    const last = chronological.at(-1); $('last-move').textContent = `${last.san} · ${last.display_name}`;
  }
  function renderBoard() {
    const board = $('board'); board.replaceChildren();
    if (!chess) { board.classList.add('loading'); return; }
    board.classList.remove('loading');
    const ranks = chess.board();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const squareName = `${'abcdefgh'[c]}${8-r}`, piece = ranks[r][c];
      const cell = document.createElement('button'); cell.type = 'button'; cell.className = `square ${(r+c)%2===0?'light-square':'dark-square'}`; cell.setAttribute('aria-label', `${squareName}${piece ? ` ${piece.color === 'w' ? 'white' : 'black'} ${piece.type}` : ''}`);
      cell.dataset.square = squareName;
      if (selected === squareName) cell.classList.add('selected');
      const last = state.moves.at(-1); if (last && (last.from_square === squareName || last.to_square === squareName)) cell.classList.add('last');
      const checked = chess.isCheck ? chess.isCheck() : chess.in_check ? chess.in_check() : false;
      if (checked && piece?.type === 'k' && piece.color === chess.turn()) cell.classList.add('in-check');
      if (piece) { const span = document.createElement('span'); span.className = `piece ${piece.color==='w'?'white-piece':'black-piece'}`; span.textContent = pieces[piece.color + piece.type]; span.draggable = true; span.addEventListener('dragstart', e => { if (!turnToken || piece.color !== state.currentTurn[0]) { e.preventDefault(); return; } selected = squareName; legalTargets = chess.moves({ square: squareName, verbose: true }).map(m => m.to); cell.classList.add('selected'); paintLegalTargets(); e.dataTransfer.setData('text/plain', squareName); }); cell.append(span); }
      if (legalTargets.includes(squareName)) { const marker = document.createElement('span'); marker.className = piece ? 'legal-capture' : 'legal-dot'; cell.append(marker); }
      if (legalTargets.includes(squareName)) cell.classList.add('legal-target');
      cell.addEventListener('click', () => clickSquare(squareName));
      cell.addEventListener('dragover', e => { if (turnToken) e.preventDefault(); });
      cell.addEventListener('drop', e => { e.preventDefault(); const from = e.dataTransfer.getData('text/plain'); if (from) attemptMove(from, squareName); });
      board.append(cell);
    }
    $('rank-labels').innerHTML = '<span>8</span><span>7</span><span>6</span><span>5</span><span>4</span><span>3</span><span>2</span><span>1</span>';
    $('file-labels').innerHTML = '<span>a</span><span>b</span><span>c</span><span>d</span><span>e</span><span>f</span><span>g</span><span>h</span>';
  }
  function animateLastMove() {
    const move = state.moves.at(-1), mover = move && chess?.get(move.to_square);
    const target = move && document.querySelector(`[data-square="${move.to_square}"] .piece`);
    const source = move && document.querySelector(`[data-square="${move.from_square}"]`);
    if (!move || !mover || !target || !source || !target.animate) return;
    const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
    const ghost = document.createElement('span');
    ghost.className = `piece ${mover.color === 'w' ? 'white-piece' : 'black-piece'}`;
    ghost.textContent = pieces[mover.color + mover.type];
    ghost.style.cssText = `position:fixed;z-index:100;left:${from.left + from.width/2}px;top:${from.top + from.height/2}px;transform:translate(-50%,-50%);font-size:${Math.min(from.width,to.width)*.78}px;pointer-events:none`;
    document.body.append(ghost); target.style.opacity = '0';
    const dx = to.left + to.width/2 - from.left - from.width/2, dy = to.top + to.height/2 - from.top - from.height/2;
    const animation = ghost.animate([{transform:'translate(-50%,-50%) translate(0,0)'},{transform:`translate(-50%,-50%) translate(${dx}px,${dy}px)`}], {duration:260,easing:'cubic-bezier(.2,.75,.3,1)'});
    animation.onfinish = () => { ghost.remove(); target.style.opacity = ''; };
  }
  function showLegal(square) {
    if (!chess) return;
    legalTargets = chess.moves({ square, verbose: true }).map(m => m.to);
    renderBoard();
  }
  function paintLegalTargets() {
    for (const target of legalTargets) {
      const cell = document.querySelector(`[data-square="${target}"]`);
      if (!cell) continue;
      cell.classList.add('legal-target');
      const marker = document.createElement('span');
      marker.className = chess.get(target) ? 'legal-capture' : 'legal-dot';
      cell.append(marker);
    }
  }
  function clickSquare(square) {
    if (!turnToken) { notify(state.me?.queue ? 'Wait for your turn to make a move.' : 'Join a team to take part.'); return; }
    const targetPiece = chess.get(square);
    if (!selected) {
      const piece = chess.get(square);
      if (!piece || piece.color !== state.currentTurn[0]) return;
      selected = square; showLegal(square); return;
    }
    if (selected === square) { selected = null; legalTargets = []; renderBoard(); return; }
    if (targetPiece?.color === state.currentTurn[0]) { selected = square; showLegal(square); return; }
    if (legalTargets.includes(square)) attemptMove(selected, square);
    else { selected = null; legalTargets = []; renderBoard(); }
  }
  function attemptMove(from, to) {
    if (!turnToken || !legalTargets.includes(to)) return;
    const piece = chess.get(from); let promotion;
    if (piece?.type === 'p' && (to.endsWith('8') || to.endsWith('1'))) promotion = 'q';
    const token = turnToken;
    socket.emit('submit_move', { turnToken: token, idempotencyKey: crypto.randomUUID(), from, to, ...(promotion ? { promotion } : {}) }, response => {
      if (!response?.ok) notify(response?.error || 'Move could not be submitted.');
      else notify(`Move played: ${response.san}`);
      selected = null; legalTargets = []; requestState();
    });
  }
  function startTimer() {
    clearInterval(timerInterval);
    const update = () => {
      if (state?.startedAt) $('duration-total').textContent = formatDuration(Math.floor(((Date.now() + serverClockOffset) - new Date(state.startedAt).getTime()) / 1000));
      if (!state?.deadline || !state.activePlayer) { $('timer').innerHTML = '--<small>s</small>'; $('timer').classList.remove('urgent'); $('clock-progress').style.transform = 'scaleX(0)'; return; }
      const left = Math.max(0, Math.ceil((new Date(state.deadline).getTime() - (Date.now() + serverClockOffset)) / 1000));
      $('timer').innerHTML = `${String(left).padStart(2,'0')}<small>s</small>`;
      $('timer').classList.toggle('urgent', left <= 5);
      const total = Math.max(1, state.turnSeconds || 15);
      $('clock-progress').style.transform = `scaleX(${left / total})`;
    };
    update(); timerInterval = setInterval(update, 200);
  }
  function join(team) {
    const displayName = localStorage.getItem('universal-chess-name') || `Guest ${playerUuid.slice(0,4)}`;
    if (socket?.connected) socket.emit('join_team', { team, displayName }, response => { if (!response?.ok) notify(response?.error || 'Could not join queue.'); else { localStorage.setItem(teamCacheKey, team); notify(response.assigned ? 'You have the move. Make it count!' : `Joined the ${team} queue.`); requestState(); } });
    else notify('Reconnecting before joining the queue.');
  }
  $('join-white').addEventListener('click', () => join('white'));
  $('join-black').addEventListener('click', () => join('black'));
  const themeButton = $('theme-toggle');
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    preferences.saveTheme(localStorage, theme);
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#0b100e' : '#edf1ec';
    const next = theme === 'dark' ? 'light' : 'dark';
    themeButton.textContent = theme === 'dark' ? '☼' : '☾';
    themeButton.setAttribute('aria-label', `Switch to ${next} theme`);
    themeButton.title = `Switch to ${next} theme`;
  }
  themeButton.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  applyTheme(document.documentElement.dataset.theme);
  $('leave-queue').addEventListener('click', () => { if (socket) socket.emit('leave_queue', r => { if (!r?.ok) notify(r?.error || 'Could not leave.'); else { notify('You left the queue.'); requestState(); } }); });
  async function copyPgn() { try { await navigator.clipboard.writeText(state?.pgn || ''); notify(state?.pgn ? 'Game PGN copied.' : 'No moves to copy yet.'); } catch { notify('Clipboard access is unavailable.'); } }
  $('copy-pgn').addEventListener('click', copyPgn);
  $('copy-pgn-side').addEventListener('click', copyPgn);
  $('copy-final-pgn').addEventListener('click', copyPgn);
  $('download-pgn').addEventListener('click', () => {
    const blob = new Blob([state?.pgn || ''], { type: 'application/x-chess-pgn' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'universal-chess.pgn'; link.click(); URL.revokeObjectURL(link.href);
  });
  $('new-game').addEventListener('click', async () => {
    const token = window.prompt('Enter the admin token to start a new game:'); if (!token) return;
    try {
      const response = await fetch('/api/game/admin/new-game', { method:'POST', headers:{'Content-Type':'application/json','x-admin-token':token}, body:'{}' });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to start a new game.');
      notify('A new shared game has started.'); requestState();
    } catch (error) { notify(error.message); }
  });
  document.querySelectorAll('.panel-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.panel-tab').forEach(item => item.classList.toggle('active', item === tab));
    document.querySelectorAll('.panel-content').forEach(panel => { panel.hidden = panel.id !== tab.dataset.panel; });
  }));
  fetchState(); requestState();
  setInterval(() => { if (socket?.connected) socket.emit('heartbeat'); }, 30_000);
  setInterval(() => { if (!socket?.connected) fetchState(); }, 8_000);
})();
