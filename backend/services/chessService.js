const { Chess } = require('chess.js');

function fromFen(fen) { return new Chess(fen); }

function applyMove(fen, input, team) {
  const chess = fromFen(fen);
  if (chess.turn() !== team[0]) throw new Error(`It is ${chess.turn() === 'w' ? 'white' : 'black'}'s turn.`);
  const piece = chess.get(input.from);
  if (!piece || piece.color !== team[0]) throw new Error('You can only move a piece belonging to your team.');
  let move;
  try { move = chess.move({ from: input.from, to: input.to, ...(input.promotion ? { promotion: input.promotion } : {}) }); }
  catch { move = null; }
  if (!move) throw new Error('That is not a legal chess move.');
  const status = chess.isCheckmate() ? 'checkmate' : chess.isStalemate() ? 'stalemate' : chess.isDraw() ? 'draw' : 'active';
  return { chess, move, fen: chess.fen(), pgn: chess.pgn(), status };
}

module.exports = { fromFen, applyMove };
