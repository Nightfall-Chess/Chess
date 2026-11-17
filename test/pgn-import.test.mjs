import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePgn } from "../pgn-import.mjs";

test("PGN importer parses headers and ignores comments, variations, and annotations", () => {
  const parsed = parsePgn(`\uFEFF[Event "Club \\"Open\\""]
[White "Alice"]
[Black "Bob"]
[Result "1-0"]

1. e4 {main line} e5 (1... c5 2. Nf3) 2. Nf3 Nc6 $1 3. Bb5!? a6 1-0`);

  assert.deepEqual(parsed.headers, { Event: 'Club "Open"', White: "Alice", Black: "Bob", Result: "1-0" });
  assert.deepEqual(parsed.moves, ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
  assert.equal(parsed.result, "1-0");
});

test("PGN importer accepts unfinished games and rejects malformed comments and results", () => {
  assert.equal(parsePgn("1. d4 d5 *").result, "*");
  assert.throws(() => parsePgn("1. e4 {unfinished"), /unclosed comment/);
  assert.throws(() => parsePgn("1. e4 1-0 e5"), /moves after its game result/);
  assert.throws(() => parsePgn("1. e4 (1... c5"), /unclosed variation/);
});
