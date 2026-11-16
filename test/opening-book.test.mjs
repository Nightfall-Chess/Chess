import assert from "node:assert/strict";
import { test } from "node:test";
import { isBookPositionMove, openingsAtPosition } from "../opening-book.mjs";

test("opening position lookup recognizes transpositions independent of move order", () => {
  const records = [
    { m: ["e2e4", "e7e5", "g1f3", "b8c6"], n: "Four Knights Game" },
    { m: ["g1f3", "b8c6", "e2e4", "e7e5"], n: "Transposed Four Knights Game" },
    { m: ["e2e4", "c7c5"], n: "Sicilian Defense" }
  ];

  assert.deepEqual(openingsAtPosition(records, 4), records.slice(0, 2));
  assert.equal(isBookPositionMove(records, 3), true);
  assert.equal(isBookPositionMove(records, 0), false);
  assert.deepEqual(openingsAtPosition(records, 0), []);
});
