import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createZstdDecompress } from "node:zlib";

const INDEX_STRIDE = 128;
const MAX_PAGE_SIZE = 50;

export function parseCsvRecord(line) {
  const fields = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        value += '"';
        index++;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === "," && !quoted) {
      fields.push(value);
      value = "";
    } else if (character === '"' && value === "") {
      quoted = true;
    } else {
      value += character;
    }
  }
  if (quoted) return null;
  fields.push(value);
  return fields;
}

function validFen(fen) {
  const fields = fen.trim().split(/\s+/);
  if (fields.length !== 6 || !["w", "b"].includes(fields[1])) return false;
  if (!/^(?:-|K?Q?k?q?)$/.test(fields[2]) || !/^(?:-|[a-h][36])$/.test(fields[3])) return false;
  if (!/^\d+$/.test(fields[4]) || !/^[1-9]\d*$/.test(fields[5])) return false;
  const ranks = fields[0].split("/");
  if (ranks.length !== 8) return false;
  let whiteKings = 0;
  let blackKings = 0;
  for (const rank of ranks) {
    let squares = 0;
    for (const token of rank) {
      if (/[1-8]/.test(token)) squares += Number(token);
      else if (/[pnbrqk]/i.test(token)) {
        squares++;
        if (token === "K") whiteKings++;
        if (token === "k") blackKings++;
      } else return false;
    }
    if (squares !== 8) return false;
  }
  return whiteKings === 1 && blackKings === 1;
}

export function normalizePuzzleRow(fields, columns) {
  if (!fields || fields.length !== columns.size) return null;
  const get = name => fields[columns.get(name)];
  const id = get("PuzzleId");
  const fen = get("FEN");
  const moves = get("Moves")?.trim().split(/\s+/);
  const rating = Number(get("Rating"));
  const themes = get("Themes")?.trim().split(/\s+/).filter(Boolean);
  if (!/^[\w-]{1,32}$/.test(id || "")
    || !validFen(fen || "")
    || !Number.isInteger(rating) || rating < 0 || rating > 4000
    || !moves || moves.length < 2 || moves.some(move => !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move))
    || !themes || themes.some(theme => !/^[A-Za-z][A-Za-z0-9]*$/.test(theme))) return null;
  return { id, rating, fen, moves, themes };
}

function getSignature(stats) {
  return `${stats.size}-${Math.trunc(stats.mtimeMs)}`;
}

export function createPuzzleDataset({
  archivePath = resolve("lichess_db_puzzle.csv.zst"),
  cacheRoot = process.env.CHESS_PUZZLE_CACHE_DIR || join(tmpdir(), "nightfall-chess-puzzles")
} = {}) {
  let indexPromise;

  async function ensureIndex() {
    if (!indexPromise) {
      indexPromise = (async () => {
        const source = await stat(archivePath);
        const signature = getSignature(source);
        const cachePath = join(cacheRoot, `lichess-${signature}`);
        const manifestPath = join(cachePath, "manifest.json");
        try {
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          if (manifest.signature === signature && manifest.schemaVersion === 1) {
            return { cachePath, manifest };
          }
        } catch (error) {
          if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
        // A cache directory with a missing, malformed, or stale manifest is not
        // reusable. Remove it before the atomic rebuild so rename cannot mistake
        // a broken old directory for another process's completed cache.
        await rm(cachePath, { recursive: true, force: true });
        await mkdir(cacheRoot, { recursive: true });
        const stagePath = `${cachePath}.building-${process.pid}-${Date.now()}`;
        await mkdir(stagePath, { recursive: true });
        const dataStream = createWriteStream(join(stagePath, "puzzles.ndjson"), { flags: "wx" });
        const indexStream = createWriteStream(join(stagePath, "offsets.bin"), { flags: "wx" });
        let outputError = null;
        dataStream.on("error", error => { outputError ||= error; });
        indexStream.on("error", error => { outputError ||= error; });
        let dataOffset = 0;
        let count = 0;
        let invalidRows = 0;
        let header = null;
        let columns = null;
        let pendingIndex = Buffer.allocUnsafe(8192);
        let pendingIndexBytes = 0;
        try {
          const input = createReadStream(archivePath).pipe(createZstdDecompress());
          const lines = createInterface({ input, crlfDelay: Infinity });
          for await (const line of lines) {
            if (header === null) {
              header = parseCsvRecord(line)?.map(value => value.trim());
              if (!header) throw new Error("The Lichess puzzle CSV has an invalid header.");
              columns = new Map(header.map((value, index) => [value, index]));
              if (["PuzzleId", "FEN", "Moves", "Rating", "Themes"].some(name => !columns.has(name))) {
                throw new Error("The Lichess puzzle CSV is missing required columns.");
              }
              continue;
            }
            const puzzle = normalizePuzzleRow(parseCsvRecord(line), columns);
            if (!puzzle) {
              invalidRows++;
              continue;
            }
            if (count % INDEX_STRIDE === 0) {
              pendingIndex.writeBigUInt64LE(BigInt(dataOffset), pendingIndexBytes);
              pendingIndexBytes += 8;
              if (pendingIndexBytes === pendingIndex.length) {
                if (!indexStream.write(pendingIndex)) await once(indexStream, "drain");
                pendingIndex = Buffer.allocUnsafe(8192);
                pendingIndexBytes = 0;
              }
            }
            const record = Buffer.from(`${JSON.stringify(puzzle)}\n`);
            if (!dataStream.write(record)) await once(dataStream, "drain");
            dataOffset += record.length;
            count++;
            if (outputError) throw outputError;
          }
          if (header === null) throw new Error("The Lichess puzzle dataset is empty.");
          if (pendingIndexBytes) {
            if (!indexStream.write(pendingIndex.subarray(0, pendingIndexBytes))) await once(indexStream, "drain");
          }
          dataStream.end();
          indexStream.end();
          await Promise.all([once(dataStream, "finish"), once(indexStream, "finish")]);
          const manifest = {
            schemaVersion: 1,
            signature,
            source: basename(archivePath),
            total: count,
            invalidRows,
            checkpointStride: INDEX_STRIDE,
            indexedAt: new Date().toISOString()
          };
          const manifestFile = await open(join(stagePath, "manifest.json"), "wx");
          try { await manifestFile.writeFile(JSON.stringify(manifest)); }
          finally { await manifestFile.close(); }
          try {
            await rename(stagePath, cachePath);
          } catch (error) {
            if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
            await rm(stagePath, { recursive: true, force: true });
          }
          const savedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
          return { cachePath, manifest: savedManifest };
        } catch (error) {
          dataStream.destroy();
          indexStream.destroy();
          await rm(stagePath, { recursive: true, force: true });
          throw error;
        }
      })().catch(error => {
        indexPromise = null;
        throw error;
      });
    }
    return indexPromise;
  }

  async function getStatus() {
    const { manifest } = await ensureIndex();
    return { ready: true, dataset: manifest.source, total: manifest.total, invalidRows: manifest.invalidRows };
  }

  async function getPage(offset = 0, limit = 16) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Puzzle offset must be a non-negative integer.");
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Puzzle page size must be a positive integer.");
    const { cachePath, manifest } = await ensureIndex();
    const pageSize = Math.min(limit, MAX_PAGE_SIZE);
    if (offset >= manifest.total) return { offset, total: manifest.total, puzzles: [] };
    const checkpoint = Math.floor(offset / INDEX_STRIDE);
    const checkpointBuffer = Buffer.alloc(8);
    const indexFile = await open(join(cachePath, "offsets.bin"), "r");
    try {
      await indexFile.read(checkpointBuffer, 0, 8, checkpoint * 8);
    } finally {
      await indexFile.close();
    }
    const byteOffset = Number(checkpointBuffer.readBigUInt64LE(0));
    const stream = createReadStream(join(cachePath, "puzzles.ndjson"), { start: byteOffset });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const skip = offset - checkpoint * INDEX_STRIDE;
    const puzzles = [];
    let lineIndex = 0;
    for await (const line of lines) {
      if (lineIndex++ < skip) continue;
      puzzles.push({ index: offset + puzzles.length, puzzle: JSON.parse(line) });
      if (puzzles.length === pageSize) {
        lines.close();
        stream.destroy();
        break;
      }
    }
    return { offset, total: manifest.total, puzzles };
  }

  return { getStatus, getPage };
}
