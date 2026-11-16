import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bookMoveCandidates,
  buildOpeningIndexes,
  isBookMove,
  recognizeOpeningPosition
} from "../opening-index.mjs";

test("opening indexes recognize transposed positions and retrieve moves by played prefix", () => {
  const position = "same-position w KQkq";
  const entries = [
    { e: "C00", n: "French Defense", p: position, m: ["e2e4", "e7e6", "d2d4"] },
    { e: "B20", n: "Sicilian Defense", p: position, m: ["e2e4", "c7c5", "g1f3"] }
  ];
  const { positions, movesByPrefix } = buildOpeningIndexes(entries);

  assert.equal(recognizeOpeningPosition(positions, position, 3).n, "Sicilian Defense");
  assert.equal(recognizeOpeningPosition(positions, position, 2), null);
  assert.equal(isBookMove(movesByPrefix, ["e2e4", "c7c5"], "g1f3"), true);
  assert.equal(isBookMove(movesByPrefix, ["e2e4", "d7d5"], "g1f3"), false);
  assert.deepEqual([...bookMoveCandidates(movesByPrefix, ["e2e4"]).keys()].sort(), ["c7c5", "e7e6"]);
});
