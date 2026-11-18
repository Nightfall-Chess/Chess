import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Chess } from "chess.js";
import { WebSocket, WebSocketServer } from "ws";
import { createPuzzleDataset } from "./puzzle-dataset.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const puzzleArchivePath = resolve(root, process.env.CHESS_PUZZLE_ARCHIVE || "lichess_db_puzzle.csv.zst");
const puzzles = createPuzzleDataset({ archivePath: puzzleArchivePath });
const roomRetentionMs = 24 * 60 * 60 * 1000;
const allowedOnlineOrigins = new Set((process.env.ONLINE_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean));
const rooms = new Map();
const roomCodeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".nnue", "application/octet-stream"],
  [".json", "application/json; charset=utf-8"]
]);

function getPuzzleCorsHeaders(request) {
  const origin = request.headers.origin;
  if (!origin) return {};
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
  } catch {
    return {};
  }
}

const server = createServer((request, response) => {
  let pathname;
  try {
    pathname = new URL(request.url || "/", "http://localhost").pathname;
  } catch {
    response.writeHead(400).end("Invalid request URL");
    return;
  }
  if (pathname === "/api/puzzles/status" || pathname === "/api/puzzles") {
    const corsHeaders = getPuzzleCorsHeaders(request);
    if (request.method === "OPTIONS") {
      if (!corsHeaders["Access-Control-Allow-Origin"]) {
        response.writeHead(403).end("Cross-origin puzzle requests are limited to localhost.");
        return;
      }
      response.writeHead(204, corsHeaders).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { ...corsHeaders, Allow: "GET, OPTIONS" }).end("Method not allowed");
      return;
    }
    const url = new URL(request.url || "/", "http://localhost");
    const operation = pathname === "/api/puzzles/status"
      ? puzzles.getStatus()
      : puzzles.getPage(
        Number(url.searchParams.get("offset") || 0),
        Number(url.searchParams.get("limit") || 16)
      );
    operation.then(payload => {
      if (!response.destroyed) {
        response.writeHead(200, {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff"
        }).end(JSON.stringify(payload));
      }
    }).catch(error => {
      if (response.destroyed) return;
      const badRequest = error instanceof RangeError;
      const missingArchive = error.code === "ENOENT" && error.path === puzzleArchivePath;
      const unavailable = error.code === "ENOENT";
      const message = missingArchive
        ? "The Lichess puzzle archive is missing. Download lichess_db_puzzle.csv.zst from https://database.lichess.org/#puzzles, place it in the project root, and restart the server."
        : error.message;
      response.writeHead(badRequest ? 400 : missingArchive ? 503 : unavailable ? 404 : 500, {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      }).end(JSON.stringify({ error: message }));
      if (!badRequest && !unavailable) console.error("Puzzle dataset request failed:", error);
    });
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }
  let requested;
  try {
    requested = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end("Invalid request path");
    return;
  }
  const file = resolve(root, `.${requested}`);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const stats = statSync(file);
    if (!stats.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
    const cacheControl = requested === "/index.html" ? "no-cache" : "public, max-age=3600";
    const modifiedSince = request.headers["if-modified-since"];
    const notModified = request.headers["if-none-match"] === etag
      || (!request.headers["if-none-match"] && modifiedSince && !Number.isNaN(Date.parse(modifiedSince))
        && Math.floor(stats.mtimeMs / 1000) * 1000 <= Date.parse(modifiedSince));
    if (notModified) {
      response.writeHead(304, {
        "Cache-Control": cacheControl,
        ETag: etag,
        "Last-Modified": stats.mtime.toUTCString(),
        "X-Content-Type-Options": "nosniff"
      }).end();
      return;
    }
    response.writeHead(200, {
      "Content-Length": stats.size,
      "Content-Type": mimeTypes.get(extname(file).toLowerCase()) || "application/octet-stream",
      "Cache-Control": cacheControl,
      ETag: etag,
      "Last-Modified": stats.mtime.toUTCString(),
      "X-Content-Type-Options": "nosniff"
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(file).pipe(response);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(500).end("Unable to serve file");
    console.error(error);
  }
});

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 8192 });
const heartbeatIntervalMs = Math.max(1000, Math.min(60000, Number(process.env.ONLINE_HEARTBEAT_MS) || 15000));

function isAllowedOnlineOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (allowedOnlineOrigins.has(origin)) return true;
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    return (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(hostname))
      || (url.protocol === "http:" && origin === `http://${request.headers.host}`);
  } catch {
    return false;
  }
}

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  if (pathname !== "/ws/online" || !isAllowedOnlineOrigin(request)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, client => websocketServer.emit("connection", client, request));
});

function send(client, payload) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function generateRoomCode() {
  const limit = Math.floor(256 / roomCodeAlphabet.length) * roomCodeAlphabet.length;
  while (true) {
    let code = "";
    for (const byte of randomBytes(16)) {
      if (byte >= limit) continue;
      code += roomCodeAlphabet[byte % roomCodeAlphabet.length];
      if (code.length === 7) break;
    }
    if (code.length === 7 && !rooms.has(code)) return code;
  }
}

function roomResult(game, winnerColor, reason) {
  if (winnerColor) return `${winnerColor === "w" ? "White" : "Black"} wins by ${reason}`;
  if (game.isStalemate()) return "Draw by stalemate";
  if (game.isThreefoldRepetition()) return "Draw by repetition";
  if (game.isInsufficientMaterial()) return "Draw by insufficient material";
  if (game.isDrawByFiftyMoves()) return "Draw by the fifty-move rule";
  return "Draw by agreement";
}

function remainingClock(room, color, now = Date.now()) {
  const elapsed = room.status === "playing" && room.game.turn() === color && room.turnStartedAt
    ? now - room.turnStartedAt
    : 0;
  return Math.max(0, room.clocks[color] - elapsed);
}

function roomSnapshot(room) {
  const now = Date.now();
  return {
    id: room.id,
    code: room.code,
    status: room.status,
    version: room.version,
    players: room.players.filter(Boolean).map(player => ({
      color: player.color,
      name: player.name,
      connected: Boolean(player.client)
    })),
    moves: room.game.history({ verbose: true }).map(move => ({
      from: move.from,
      to: move.to,
      promotion: move.promotion,
      san: move.san
    })),
    fen: room.game.fen(),
    turn: room.game.turn(),
    clocks: { w: remainingClock(room, "w", now), b: remainingClock(room, "b", now) },
    timeControlSeconds: room.timeControlSeconds,
    startedAt: room.startedAt ? new Date(room.startedAt).toISOString() : "",
    result: room.result,
    rematchRequests: (room.rematchRequests || []).map(color => ({ color, name: room.players[color === "w" ? 0 : 1]?.name || (color === "w" ? "White" : "Black") }))
  };
}

function broadcastRoom(room) {
  const message = { type: "state", room: roomSnapshot(room) };
  for (const player of room.players) if (player?.client) send(player.client, message);
}

function finishRoom(room, winnerColor, reason) {
  if (room.status !== "playing") return;
  for (const color of ["w", "b"]) room.clocks[color] = remainingClock(room, color);
  room.turnStartedAt = 0;
  room.result = roomResult(room.game, winnerColor, reason);
  room.status = "finished";
  room.rematchRequests = [];
  room.version++;
  broadcastRoom(room);
}

function joinPlayer(room, color, name, client) {
  const player = room.players[color === "w" ? 0 : 1];
  if (!player) {
    const created = { color, name, token: randomBytes(32).toString("base64url"), client };
    room.players[color === "w" ? 0 : 1] = created;
    if (room.players.every(Boolean)) {
      room.status = "playing";
      room.turnStartedAt = Date.now();
      room.startedAt = room.turnStartedAt;
      room.version++;
    }
    return created;
  }
  player.client = client;
  player.disconnectedAt = 0;
  return player;
}

function bindPlayer(client, room, player) {
  client.room = room;
  client.player = player;
  player.client = client;
}

function reject(client, message) {
  send(client, { type: "error", message });
}

function handleMessage(client, message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    reject(client, "Invalid request.");
    return;
  }
  if (message.type === "create") {
    if (client.room) return reject(client, "This connection already belongs to a room.");
    const seconds = Number(message.timeControlSeconds ?? 300);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) return reject(client, "Time control must be between 0 and 3600 seconds.");
    const requestedColor = String(message.color || "w").toLowerCase();
    if (!["w", "b", "random"].includes(requestedColor)) return reject(client, "Choose white, black, or random for your room color.");
    const hostColor = requestedColor === "random" ? (randomBytes(1)[0] % 2 === 0 ? "w" : "b") : requestedColor;
    const room = {
      id: randomUUID(),
      code: generateRoomCode(),
      status: "waiting",
      version: 1,
      game: new Chess(),
      players: [null, null],
      clocks: { w: seconds * 1000, b: seconds * 1000 },
      timeControlSeconds: seconds,
      turnStartedAt: 0,
      result: "",
      rematchRequests: [],
      createdAt: Date.now()
    };
    const player = joinPlayer(room, hostColor, sanitizeName(message.name), client);
    rooms.set(room.code, room);
    bindPlayer(client, room, player);
    return send(client, { type: "created", room: roomSnapshot(room), token: player.token, color: player.color });
  }
  if (message.type === "join") {
    if (client.room) return reject(client, "This connection already belongs to a room.");
    const code = String(message.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return reject(client, "Room not found.");
    const host = room.players.find(Boolean);
    if (!host) return reject(client, "The room host is not available.");
    const guestColor = host.color === "w" ? "b" : "w";
    const guestSeat = guestColor === "w" ? 0 : 1;
    if (room.status !== "waiting" || room.players[guestSeat]) {
      return reject(client, "This room already has two players or has finished.");
    }
    const player = joinPlayer(room, guestColor, sanitizeName(message.name), client);
    bindPlayer(client, room, player);
    send(client, { type: "joined", room: roomSnapshot(room), token: player.token, color: player.color });
    broadcastRoom(room);
    return;
  }
  if (message.type === "resume") {
    if (client.room) return reject(client, "This connection already belongs to a room.");
    const room = rooms.get(String(message.code || "").trim().toUpperCase());
    const player = room?.players.find(seat => seat && safeEqual(seat.token, message.token));
    if (!room || !player) return reject(client, "The saved room session is no longer available.");
    if (player.client && player.client !== client) {
      player.client.close(4001, "Session resumed in another connection");
    }
    bindPlayer(client, room, player);
    send(client, { type: "resumed", room: roomSnapshot(room), token: player.token, color: player.color });
    broadcastRoom(room);
    return;
  }
  if (message.type === "ping") return send(client, { type: "pong", at: message.at });
  const room = client.room;
  const player = client.player;
  if (!room || !player || player.client !== client) return reject(client, "Join or create a room first.");
  if (message.type === "move") {
    if (room.status !== "playing") return reject(client, "The game is not active.");
    if (room.game.turn() !== player.color) return reject(client, "It is not your turn.");
    const remaining = remainingClock(room, player.color);
    if (room.timeControlSeconds > 0 && remaining <= 0) {
      finishRoom(room, player.color === "w" ? "b" : "w", "timeout");
      return reject(client, "Your clock has expired.");
    }
    if (Number(message.expectedVersion) !== room.version) return reject(client, "The game changed; synchronize before moving.");
    let move;
    try {
      move = room.game.move({
        from: String(message.from || ""),
        to: String(message.to || ""),
        ...(message.promotion ? { promotion: String(message.promotion).toLowerCase() } : {})
      });
    } catch {
      move = null;
    }
    if (!move) return reject(client, "That move is illegal.");
    if (room.timeControlSeconds > 0) {
      room.clocks[player.color] = remaining;
      room.turnStartedAt = Date.now();
    }
    room.version++;
    if (room.game.isGameOver()) {
      if (room.game.isCheckmate()) finishRoom(room, player.color, "checkmate");
      else finishRoom(room, null, "draw");
    } else broadcastRoom(room);
    return;
  }
  if (message.type === "rematch") {
    if (room.status === "playing") {
      // A second rematch click can arrive just after the other player already
      // started the new game. Return the authoritative state instead of an error.
      broadcastRoom(room);
      return;
    }
    if (room.status !== "finished") return reject(client, "The current game is not ready for a rematch.");
    if (!room.players.every(Boolean) || !room.players.some(seat => seat === player)) {
      return reject(client, "Both players must still belong to this room.");
    }
    if (!room.rematchRequests.includes(player.color)) room.rematchRequests.push(player.color);
    if (room.rematchRequests.length === 2) {
      room.game = new Chess();
      room.clocks = { w: room.timeControlSeconds * 1000, b: room.timeControlSeconds * 1000 };
      room.status = "playing";
      room.result = "";
      room.rematchRequests = [];
      room.turnStartedAt = Date.now();
      room.startedAt = room.turnStartedAt;
    }
    room.version++;
    broadcastRoom(room);
    return;
  }
  if (message.type === "resign") {
    if (room.status !== "playing") return reject(client, "The game is not active.");
    finishRoom(room, player.color === "w" ? "b" : "w", "resignation");
    return;
  }
  reject(client, "Unsupported request.");
}

function sanitizeName(value) {
  const name = String(value || "Player").trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40);
  return name || "Player";
}

websocketServer.on("connection", client => {
  client.isAlive = true;
  client.on("pong", () => { client.isAlive = true; });
  client.on("error", error => console.error("Online WebSocket connection failed:", error));
  client.on("message", data => {
    try {
      handleMessage(client, JSON.parse(data.toString()));
    } catch (error) {
      console.error("Online room request failed:", error);
      reject(client, "The server could not process that request.");
    }
  });
  client.on("close", () => {
    const { room, player } = client;
    if (!room || !player || player.client !== client) return;
    player.client = null;
    player.disconnectedAt = Date.now();
    room.version++;
    broadcastRoom(room);
  });
});

const heartbeatTimer = setInterval(() => {
  for (const client of websocketServer.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, heartbeatIntervalMs);
heartbeatTimer.unref();

const clockTimer = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.status === "playing") {
      const turn = room.game.turn();
      if (room.timeControlSeconds > 0 && remainingClock(room, turn, now) <= 0) {
        finishRoom(room, turn === "w" ? "b" : "w", "timeout");
      } else {
        broadcastRoom(room);
      }
    }
    const lastDisconnectedAt = Math.max(room.createdAt, ...room.players.map(player => player?.disconnectedAt || 0));
    if (now - lastDisconnectedAt > roomRetentionMs && room.players.every(player => !player?.client)) rooms.delete(code);
  }
}, 1000);
clockTimer.unref();

server.listen(port, host, () => {
  console.log(`Nightfall Chess available at http://127.0.0.1:${port}`);
});