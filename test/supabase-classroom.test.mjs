import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chess.js";
import { applyClassroomMove, classroomCanMoveColor } from "../supabase/functions/_shared/classroom-domain.mjs";

function roomPosition(fen = new Chess().fen()) {
  const chess = new Chess(fen);
  return {
    chess,
    state: {
      fen: chess.fen(),
      pgn: "",
      moves: [],
      redo_stack: [],
      selected_ply: 0,
      annotations: [{ id: "annotation" }]
    }
  };
}

test("classroom move permissions distinguish white, black, host, and view-only participants", () => {
  assert.equal(classroomCanMoveColor({ role: "student", permission: "white" }, "w"), true);
  assert.equal(classroomCanMoveColor({ role: "student", permission: "white" }, "b"), false);
  assert.equal(classroomCanMoveColor({ role: "student", permission: "view" }, "w"), false);
  assert.equal(classroomCanMoveColor({ role: "student", permission: "both" }, "b"), true);
  assert.equal(classroomCanMoveColor({ role: "host", permission: "control" }, "b"), true);
  assert.equal(classroomCanMoveColor({ role: "student", permission: "control" }, "w"), true);
});

test("authoritative move application records legal state and rejects illegal or stale input", () => {
  const { chess, state } = roomPosition();
  const result = applyClassroomMove(chess, state, { from: "e2", to: "e4" });
  assert.equal(result.fen, chess.fen());
  assert.equal(result.moves[0].san, "e4");
  assert.equal(result.selected_ply, 1);
  assert.deepEqual(result.redo_stack, []);
  assert.deepEqual(result.annotations, []);

  assert.throws(() => applyClassroomMove(new Chess(), state, { from: "e2", to: "e5" }), { message: "ILLEGAL_MOVE" });
  assert.throws(() => applyClassroomMove(new Chess(), { ...state, selected_ply: 1 }, { from: "e2", to: "e4" }), {
    message: "RETURN_TO_LIVE_POSITION"
  });
  assert.throws(() => applyClassroomMove(new Chess(), state, { from: "e2", to: "e4", promotion: "k" }), {
    message: "ILLEGAL_MOVE"
  });
});

test("classroom chess validation supports castling, captures, and promotion", () => {
  const castle = roomPosition("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  const castleState = applyClassroomMove(castle.chess, castle.state, { from: "e1", to: "g1" });
  assert.equal(castleState.moves[0].san, "O-O");
  assert.equal(castleState.fen.includes("R4RK1"), true);

  const capture = roomPosition("4k3/8/8/8/8/8/p7/R3K3 w Q - 0 1");
  const captureState = applyClassroomMove(capture.chess, capture.state, { from: "a1", to: "a2" });
  assert.equal(captureState.moves[0].captured, "p");

  const promotion = roomPosition("7k/P7/8/8/8/8/8/7K w - - 0 1");
  const promotionState = applyClassroomMove(promotion.chess, promotion.state, {
    from: "a7", to: "a8", promotion: "q"
  });
  assert.equal(promotionState.moves[0].promotion, "q");
  assert.equal(promotion.chess.get("a8").type, "q");
});
