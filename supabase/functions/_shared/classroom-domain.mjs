const SQUARE = /^[a-h][1-8]$/;
const PROMOTIONS = new Set(["q", "r", "b", "n"]);

export function classroomCanMoveColor(member, color) {
  if (!member || (color !== "w" && color !== "b")) return false;
  if (member.role === "host" || member.permission === "control" || member.permission === "both") return true;
  return member.permission === (color === "w" ? "white" : "black");
}

export function applyClassroomMove(chess, state, { from, to, promotion }) {
  if (Number(state.selected_ply) !== state.moves.length) throw new Error("RETURN_TO_LIVE_POSITION");
  if (typeof from !== "string" || !SQUARE.test(from) || typeof to !== "string" || !SQUARE.test(to)) {
    throw new Error("ILLEGAL_MOVE");
  }
  if (promotion !== undefined && !PROMOTIONS.has(promotion)) throw new Error("ILLEGAL_MOVE");
  if (!chess.get(from)) throw new Error("ILLEGAL_MOVE");
  try {
    chess.move({ from, to, ...(promotion ? { promotion } : {}) });
  } catch {
    throw new Error("ILLEGAL_MOVE");
  }
  return {
    fen: chess.fen(),
    pgn: chess.pgn(),
    moves: chess.history({ verbose: true }),
    redo_stack: [],
    selected_ply: chess.history().length,
    annotations: []
  };
}
