// Queue ordering is persisted in queue_entries and allocated while gameService holds the game row lock.
const orderByPosition = entries => [...entries].sort((a, b) => a.queue_position - b.queue_position || a.id - b.id);
const nextEligible = (entries, team, excludedPlayerId = null) => orderByPosition(entries).find(entry =>
  entry.team === team && entry.queue_status === 'waiting' && entry.player_id !== excludedPlayerId
) || null;
module.exports = { orderByPosition, nextEligible };
