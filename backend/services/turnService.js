const { randomUUID } = require('node:crypto');

function createTurn(player, team, seconds, now = Date.now()) {
  return { playerId: player.id, team, token: randomUUID(), assignedAt: new Date(now), deadlineAt: new Date(now + seconds * 1000), status: 'active' };
}

module.exports = { createTurn, isExpired: (turn, now = Date.now()) => new Date(turn.deadlineAt).getTime() <= now };
