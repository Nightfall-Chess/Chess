import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { createPuzzleDataset, normalizePuzzleRow, parseCsvRecord } from "../puzzle-dataset.mjs";

const header = "PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate";
const firstPuzzle = "00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1819,77,95,10446,crushing hangingPiece long middlegame,https://lichess.org/game/787zsVup/black#48,,";

test("CSV parsing handles quoted commas and escaped quotes", () => {
  assert.deepEqual(parseCsvRecord('one,"two,three","say ""hello"""'), ["one", "two,three", 'say "hello"']);
  assert.equal(parseCsvRecord('"unfinished'), null);
});

test("dataset rows require valid FEN, metadata, and UCI move lists", () => {
  const columns = new Map(header.split(",").map((name, index) => [name, index]));
  assert.equal(normalizePuzzleRow(parseCsvRecord(firstPuzzle), columns)?.id, "00008");
  assert.equal(normalizePuzzleRow(parseCsvRecord(firstPuzzle.replace("1819", "not-a-rating")), columns), null);
  assert.equal(normalizePuzzleRow(parseCsvRecord(firstPuzzle.replace("f2g3", "z2g3")), columns), null);
  assert.equal(normalizePuzzleRow(parseCsvRecord(firstPuzzle.replace("r6k", "r7k")), columns), null);
});

test("compressed dataset is indexed on disk and pages keep source order", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nightfall-puzzle-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archivePath = join(directory, "puzzles.csv.zst");
  const rows = [
    header,
    firstPuzzle,
    firstPuzzle.replace("00008", "00009").replace("1819", "1770"),
    firstPuzzle.replace("00008", "bad-row").replace("1819", "not-a-rating"),
    firstPuzzle.replace("00008", "0000A").replace("1819", "1800")
  ].join("\n");
  await writeFile(archivePath, zstdCompressSync(Buffer.from(rows)));
  const dataset = createPuzzleDataset({ archivePath, cacheRoot: join(directory, "cache") });

  assert.deepEqual(await dataset.getStatus(), {
    ready: true,
    dataset: "puzzles.csv.zst",
    total: 3,
    invalidRows: 1
  });
  const page = await dataset.getPage(1, 1);
  assert.equal(page.puzzles[0].index, 1);
  assert.equal(page.puzzles[0].puzzle.id, "00009");
  assert.equal((await dataset.getPage(3, 10)).puzzles.length, 0);
  await assert.rejects(dataset.getPage(-1), RangeError);
  const archiveStats = await stat(archivePath);
  const manifest = JSON.parse(await readFile(join(directory, "cache", `lichess-${archiveStats.size}-${Math.trunc(archiveStats.mtimeMs)}`, "manifest.json"), "utf8"));
  assert.equal(manifest.checkpointStride, 128);
});


test("a stale or malformed on-disk manifest is rebuilt instead of reused", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nightfall-puzzle-stale-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archivePath = join(directory, "puzzles.csv.zst");
  const rows = [header, firstPuzzle].join("\n");
  await writeFile(archivePath, zstdCompressSync(Buffer.from(rows)));
  const archiveStats = await stat(archivePath);
  const cachePath = join(directory, "cache", `lichess-${archiveStats.size}-${Math.trunc(archiveStats.mtimeMs)}`);
  await mkdir(cachePath, { recursive: true });
  await writeFile(join(cachePath, "manifest.json"), JSON.stringify({
    schemaVersion: 0,
    signature: "stale-signature",
    total: 999
  }));
  await writeFile(join(cachePath, "puzzles.ndjson"), "not valid JSON\n");

  const dataset = createPuzzleDataset({ archivePath, cacheRoot: join(directory, "cache") });
  const status = await dataset.getStatus();
  assert.equal(status.ready, true);
  assert.equal(status.total, 1);
  const page = await dataset.getPage(0, 1);
  assert.equal(page.puzzles[0].puzzle.id, "00008");
});
