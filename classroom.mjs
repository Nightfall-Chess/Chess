import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Chess } from "chess.js";
import { WebSocketServer, WebSocket } from "ws";

const ROOM_ID_BYTES = 18;
const TOKEN_BYTES = 32;
const MAX_NAME_LENGTH = 24;
const MAX_ROOM_NAME_LENGTH = 80;
const MAX_PASSWORD_LENGTH = 96;
const MAX_AVATAR_LENGTH = 32_768;
const MAX_PGN_LENGTH = 100_000;
const MAX_ANNOTATIONS = 128;
const MAX_PARTICIPANTS = 64;
const MAX_ROOM_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_DISCONNECTED_MS = 30 * 60 * 1000;
const HISTORY_LIMIT = 128;
const MESSAGE_LIMIT = 40;
const MESSAGE_WINDOW_MS = 10_000;
const PERMISSIONS = new Set(["view", "white", "black", "both", "control"]);
const ANNOTATION_COLORS = new Set(["violet", "gold", "blue", "red"]);
const SQUARE = /^[a-h][1-8]$/;
const ROOM_ID = /^[A-Za-z0-9_-]{20,32}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;
const AVATAR_DATA_URL = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function randomId(bytes = TOKEN_BYTES) {
  return randomBytes(bytes).toString("base64url");
}

function cleanText(value, maximum, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maximum) || fallback;
}

function cleanAvatar(value) {
  return typeof value === "string" && value.length <= MAX_AVATAR_LENGTH && AVATAR_DATA_URL.test(value)
    ? value
    : "";
}

function passwordDigest(password, salt) {
  return scryptSync(password, salt, 32);
}

function hasRoomPassword(room, supplied) {
  if (!room.passwordHash) return true;
  if (typeof supplied !== "string" || supplied.length > MAX_PASSWORD_LENGTH) return false;
  return timingSafeEqual(room.passwordHash, passwordDigest(supplied, room.passwordSalt));
}

function safeSend(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function publicParticipant(participant, hostId) {
  return {
    id: participant.id,
    name: participant.name,
    avatar: participant.avatar || "",
    role: participant.id === hostId ? "host" : "student",
    permission: participant.id === hostId ? "control" : participant.permission,
    connected: Boolean(participant.socket && participant.socket.readyState === WebSocket.OPEN)
  };
}

function describeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    locked: room.locked,
    closed: room.closed,
    orientation: room.orientation,
    fen: room.chess.fen(),
    turn: room.chess.turn(),
    version: room.version,
    selectedPly: room.selectedPly,
    canRedo: room.redoStack.length > 0,
    pgn: room.chess.pgn(),
    moves: room.chess.history({ verbose: true }).map(move => ({
      color: move.color,
      from: move.from,
      to: move.to,
      san: move.san,
      captured: move.captured || null,
      promotion: move.promotion || null,
      before: move.before,
      after: move.after
    })),
    legalMoves: room.chess.moves({ verbose: true }).map(move => ({
      from: move.from,
      to: move.to,
      promotion: move.promotion || null
    })),
    annotations: room.annotations.map(annotation => ({ ...annotation })),
    participants: [...room.participants.values()].map(participant => publicParticipant(participant, room.hostId))
  };
}

function createRoomState(id, name, password) {
  const salt = randomBytes(16);
  const room = {
    id,
    name,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    passwordSalt: salt,
    passwordHash: password ? passwordDigest(password, salt) : null,
    locked: false,
    closed: false,
    version: 0,
    hostId: "",
    participants: new Map(),
    chess: new Chess(),
    redoStack: [],
    selectedPly: 0,
    orientation: "w",
    annotations: [],
    requests: new Map()
  };
  const host = {
    id: randomId(12),
    token: randomId(),
    name: "",
    avatar: "",
    permission: "control",
    socket: null,
    disconnectedAt: null
  };
  room.hostId = host.id;
  room.participants.set(host.id, host);
  return { room, host };
}

function moveHasPermission(participant, hostId, color) {
  if (participant.id === hostId || participant.permission === "control" || participant.permission === "both") return true;
  return participant.permission === (color === "w" ? "white" : "black");
}

function validatePgn(pgn) {
  if (typeof pgn !== "string" || pgn.length === 0 || pgn.length > MAX_PGN_LENGTH) {
    throw new Error("INVALID_PGN");
  }
  const chess = new Chess();
  chess.loadPgn(pgn, { strict: true });
  return chess;
}

export class ClassroomHub {
  constructor({ idleTimeoutMs = MAX_ROOM_AGE_MS, disconnectedTimeoutMs = MAX_DISCONNECTED_MS } = {}) {
    this.rooms = new Map();
    this.idleTimeoutMs = idleTimeoutMs;
    this.disconnectedTimeoutMs = disconnectedTimeoutMs;
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: 65_536,
      perMessageDeflate: false,
      clientTracking: true
    });
    this.webSocketServer.on("connection", socket => this.#onConnection(socket));
    this.sweepTimer = setInterval(() => this.#sweep(), 60_000);
    this.sweepTimer.unref();
    this.onUpgrade = (request, socket, head) => {
      let pathname;
      try {
        pathname = new URL(request.url || "/", "http://localhost").pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== "/classroom") return;
      if (!this.#isAllowedOrigin(request)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.webSocketServer.handleUpgrade(request, socket, head, client => {
        this.webSocketServer.emit("connection", client, request);
      });
    };
  }

  attach(server) {
    server.on("upgrade", this.onUpgrade);
    return this;
  }

  close() {
    clearInterval(this.sweepTimer);
    this.webSocketServer.close();
  }

  #isAllowedOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;
    let url;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const allowlist = (process.env.CLASSROOM_ALLOWED_ORIGINS || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);
    if (allowlist.includes(url.origin)) return true;
    const hostname = url.hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return true;
    const requestedHost = String(request.headers.host || "").split(":")[0].toLowerCase();
    return requestedHost === hostname;
  }

  #onConnection(socket) {
    socket.messageTimes = [];
    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", data => {
      const now = Date.now();
      socket.messageTimes = socket.messageTimes.filter(time => now - time < MESSAGE_WINDOW_MS);
      if (socket.messageTimes.length >= MESSAGE_LIMIT) {
        safeSend(socket, { type: "error", code: "RATE_LIMITED", message: "Too many classroom actions. Please wait a moment." });
        return;
      }
      socket.messageTimes.push(now);
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        safeSend(socket, { type: "error", code: "INVALID_MESSAGE", message: "Classroom message must be valid JSON." });
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        safeSend(socket, { type: "error", code: "INVALID_MESSAGE", message: "Classroom message must be an object." });
        return;
      }
      try {
        this.#handleMessage(socket, message);
      } catch (error) {
        const code = error.message || "CLASSROOM_ERROR";
        safeSend(socket, {
          type: "error",
          code,
          message: this.#errorMessage(code),
          ...(socket.room ? { room: describeRoom(socket.room) } : {})
        });
      }
    });
    socket.on("close", () => this.#disconnect(socket));
    socket.on("error", () => this.#disconnect(socket));
  }

  #handleMessage(socket, message) {
    if (!socket.participant) {
      if (message.type === "create") return this.#create(socket, message);
      if (message.type === "join") return this.#join(socket, message);
      throw new Error("JOIN_REQUIRED");
    }
    const { room, participant } = socket;
    if (room.closed || room.participants.get(participant.id) !== participant) throw new Error("ROOM_CLOSED");
    room.lastActiveAt = Date.now();
    const requestId = typeof message.requestId === "string" && REQUEST_ID.test(message.requestId)
      ? `${participant.id}:${message.requestId}`
      : null;
    if (requestId && room.requests.has(requestId)) {
      safeSend(socket, { type: "snapshot", room: describeRoom(room), duplicate: true });
      return;
    }
    if (message.type === "sync") {
      safeSend(socket, { type: "snapshot", room: describeRoom(room) });
      return;
    }
    if (!Number.isSafeInteger(message.baseVersion) || message.baseVersion !== room.version) {
      safeSend(socket, {
        type: "error",
        code: "STALE_VERSION",
        message: this.#errorMessage("STALE_VERSION"),
        room: describeRoom(room)
      });
      return;
    }
    switch (message.type) {
      case "move":
        this.#move(room, participant, message);
        break;
      case "undo":
        this.#requireHost(room, participant);
        {
          const lastMove = room.chess.history({ verbose: true }).at(-1);
          if (!lastMove) throw new Error("NOTHING_TO_UNDO");
          room.chess.undo();
          room.redoStack.push({
            from: lastMove.from,
            to: lastMove.to,
            ...(lastMove.promotion ? { promotion: lastMove.promotion } : {})
          });
        }
        room.selectedPly = room.chess.history().length;
        room.annotations = [];
        break;
      case "redo":
        this.#requireHost(room, participant);
        this.#redo(room);
        break;
      case "reset":
        this.#requireHost(room, participant);
        room.chess = new Chess();
        room.redoStack = [];
        room.selectedPly = 0;
        room.annotations = [];
        break;
      case "load":
        this.#requireHost(room, participant);
        this.#loadPosition(room, message);
        break;
      case "navigate":
        this.#requireHost(room, participant);
        if (!Number.isSafeInteger(message.ply) || message.ply < 0 || message.ply > room.chess.history().length) {
          throw new Error("INVALID_POSITION");
        }
        room.selectedPly = message.ply;
        break;
      case "orientation":
        this.#requireHost(room, participant);
        if (message.orientation !== "w" && message.orientation !== "b") throw new Error("INVALID_ORIENTATION");
        room.orientation = message.orientation;
        break;
      case "annotation":
        this.#annotate(room, message);
        break;
      case "permissions":
        this.#setPermission(room, participant, message);
        break;
      case "remove":
        this.#removeParticipant(room, participant, message);
        break;
      case "transfer":
        this.#transferHost(room, participant, message);
        break;
      case "lock":
        this.#requireHost(room, participant);
        if (typeof message.locked !== "boolean") throw new Error("INVALID_LOCK_STATE");
        room.locked = message.locked;
        break;
      case "close":
        this.#closeRoom(room, participant);
        return;
      default:
        throw new Error("UNKNOWN_ACTION");
    }
    room.version++;
    if (requestId) {
      room.requests.set(requestId, room.version);
      while (room.requests.size > HISTORY_LIMIT) room.requests.delete(room.requests.keys().next().value);
    }
    this.#broadcast(room);
  }

  #create(socket, message) {
    const roomName = cleanText(message.roomName, MAX_ROOM_NAME_LENGTH);
    if (!roomName) throw new Error("INVALID_ROOM_NAME");
    const name = cleanText(message.name, MAX_NAME_LENGTH, "Host");
    const password = message.password === undefined ? "" : message.password;
    if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) throw new Error("INVALID_PASSWORD");
    let id;
    do { id = randomId(ROOM_ID_BYTES); } while (this.rooms.has(id));
    const { room, host } = createRoomState(id, roomName, password);
    host.name = name;
    host.avatar = cleanAvatar(message.avatar);
    host.socket = socket;
    room.version = 1;
    socket.room = room;
    socket.participant = host;
    this.rooms.set(id, room);
    safeSend(socket, {
      type: "joined",
      token: host.token,
      participantId: host.id,
      role: "host",
      room: describeRoom(room)
    });
  }

  #join(socket, message) {
    if (typeof message.roomId !== "string" || !ROOM_ID.test(message.roomId)) throw new Error("ROOM_NOT_FOUND");
    const room = this.rooms.get(message.roomId);
    if (!room || room.closed) throw new Error("ROOM_NOT_FOUND");
    const token = typeof message.token === "string" && message.token.length <= 128 ? message.token : "";
    let participant = [...room.participants.values()].find(person => person.token === token);
    if (!participant) {
      if (room.locked) throw new Error("ROOM_LOCKED");
      if (!hasRoomPassword(room, message.password)) throw new Error("ROOM_PASSWORD_REQUIRED");
      if (room.participants.size >= MAX_PARTICIPANTS) throw new Error("ROOM_FULL");
      participant = {
        id: randomId(12),
        token: randomId(),
        name: cleanText(message.name, MAX_NAME_LENGTH, "Student"),
        avatar: cleanAvatar(message.avatar),
        permission: "view",
        socket: null,
        disconnectedAt: null
      };
      room.participants.set(participant.id, participant);
    }
    if (participant.socket && participant.socket !== socket) {
      participant.socket.close(4001, "Reconnected from another session");
    }
    participant.socket = socket;
    participant.disconnectedAt = null;
    if (message.name !== undefined) participant.name = cleanText(message.name, MAX_NAME_LENGTH, participant.name);
    if (message.avatar !== undefined) participant.avatar = cleanAvatar(message.avatar);
    socket.room = room;
    socket.participant = participant;
    room.lastActiveAt = Date.now();
    room.version++;
    safeSend(socket, {
      type: "joined",
      token: participant.token,
      participantId: participant.id,
      role: participant.id === room.hostId ? "host" : "student",
      room: describeRoom(room)
    });
    this.#broadcast(room, socket);
  }

  #move(room, participant, message) {
    if (room.selectedPly !== room.chess.history().length) throw new Error("RETURN_TO_LIVE_POSITION");
    if (typeof message.from !== "string" || !SQUARE.test(message.from)
      || typeof message.to !== "string" || !SQUARE.test(message.to)) throw new Error("INVALID_MOVE");
    const movingPiece = room.chess.get(message.from);
    if (!movingPiece) throw new Error("ILLEGAL_MOVE");
    if (!moveHasPermission(participant, room.hostId, movingPiece.color)) throw new Error("MOVE_NOT_PERMITTED");
    const promotion = message.promotion;
    if (promotion !== undefined && !["q", "r", "b", "n"].includes(promotion)) throw new Error("INVALID_PROMOTION");
    let move;
    try {
      move = room.chess.move({
        from: message.from,
        to: message.to,
        ...(promotion ? { promotion } : {})
      });
    } catch {
      throw new Error("ILLEGAL_MOVE");
    }
    room.redoStack = [];
    room.selectedPly = room.chess.history().length;
    room.annotations = [];
    return move;
  }

  #redo(room) {
    const next = room.redoStack.pop();
    if (!next) throw new Error("NOTHING_TO_REDO");
    const moves = room.chess.moves({ verbose: true }).filter(move => move.from === next.from && move.to === next.to);
    const move = moves.find(candidate => candidate.promotion === (next.promotion || undefined));
    if (!move) {
      room.redoStack = [];
      throw new Error("ILLEGAL_MOVE");
    }
    room.chess.move({ from: next.from, to: next.to, ...(next.promotion ? { promotion: next.promotion } : {}) });
    room.selectedPly = room.chess.history().length;
  }

  #loadPosition(room, message) {
    if (typeof message.fen === "string" && message.fen.trim()) {
      if (message.fen.length > 200) throw new Error("INVALID_FEN");
      try {
        room.chess = new Chess(message.fen.trim());
      } catch {
        throw new Error("INVALID_FEN");
      }
    } else if (typeof message.pgn === "string") {
      try {
        room.chess = validatePgn(message.pgn);
      } catch {
        throw new Error("INVALID_PGN");
      }
    } else {
      throw new Error("INVALID_POSITION");
    }
    room.redoStack = [];
    room.selectedPly = room.chess.history().length;
    room.annotations = [];
  }

  #annotate(room, message) {
    if (message.action === "clear") {
      room.annotations = [];
      return;
    }
    if (message.action === "arrow") {
      if (!SQUARE.test(message.from || "") || !SQUARE.test(message.to || "")
        || !ANNOTATION_COLORS.has(message.color)) throw new Error("INVALID_ANNOTATION");
      const existing = room.annotations.findIndex(item =>
        item.kind === "arrow" && item.from === message.from && item.to === message.to && item.color === message.color);
      if (existing >= 0) room.annotations.splice(existing, 1);
      else {
        if (room.annotations.length >= MAX_ANNOTATIONS) throw new Error("ANNOTATION_LIMIT");
        room.annotations.push({ id: randomId(9), kind: "arrow", from: message.from, to: message.to, color: message.color });
      }
      return;
    }
    if (message.action === "square") {
      if (!SQUARE.test(message.square || "") || !ANNOTATION_COLORS.has(message.color)) throw new Error("INVALID_ANNOTATION");
      const existing = room.annotations.findIndex(item =>
        item.kind === "square" && item.square === message.square && item.color === message.color);
      if (existing >= 0) room.annotations.splice(existing, 1);
      else {
        if (room.annotations.length >= MAX_ANNOTATIONS) throw new Error("ANNOTATION_LIMIT");
        room.annotations.push({ id: randomId(9), kind: "square", square: message.square, color: message.color });
      }
      return;
    }
    if (message.action === "remove") {
      if (typeof message.id !== "string") throw new Error("INVALID_ANNOTATION");
      room.annotations = room.annotations.filter(item => item.id !== message.id);
      return;
    }
    throw new Error("INVALID_ANNOTATION");
  }

  #setPermission(room, actor, message) {
    this.#requireHost(room, actor);
    if (typeof message.participantId !== "string" || !PERMISSIONS.has(message.permission)) {
      throw new Error("INVALID_PERMISSION");
    }
    const target = room.participants.get(message.participantId);
    if (!target || target.id === room.hostId) throw new Error("PARTICIPANT_NOT_FOUND");
    target.permission = message.permission;
  }

  #removeParticipant(room, actor, message) {
    this.#requireHost(room, actor);
    const target = room.participants.get(message.participantId);
    if (!target || target.id === room.hostId) throw new Error("PARTICIPANT_NOT_FOUND");
    room.participants.delete(target.id);
    if (target.socket) {
      safeSend(target.socket, { type: "removed", message: "The classroom host removed your access." });
      target.socket.close(4003, "Removed from classroom");
    }
  }

  #transferHost(room, actor, message) {
    this.#requireHost(room, actor);
    const target = room.participants.get(message.participantId);
    if (!target || target.id === actor.id) throw new Error("PARTICIPANT_NOT_FOUND");
    const previousHost = room.participants.get(room.hostId);
    if (previousHost) previousHost.permission = "view";
    room.hostId = target.id;
    target.permission = "control";
  }

  #closeRoom(room, actor) {
    this.#requireHost(room, actor);
    room.closed = true;
    for (const participant of room.participants.values()) {
      safeSend(participant.socket, { type: "closed", message: "The host closed this classroom." });
      if (participant.socket) participant.socket.close(4004, "Classroom closed");
    }
    this.rooms.delete(room.id);
  }

  #requireHost(room, participant) {
    if (participant.id !== room.hostId) throw new Error("HOST_ONLY");
  }

  #disconnect(socket) {
    const room = socket.room;
    const participant = socket.participant;
    if (!room || !participant || participant.socket !== socket) return;
    participant.socket = null;
    participant.disconnectedAt = Date.now();
    room.lastActiveAt = Date.now();
    room.version++;
    this.#broadcast(room);
  }

  #broadcast(room, except = null) {
    if (room.closed) return;
    const snapshot = { type: "snapshot", room: describeRoom(room) };
    const data = JSON.stringify(snapshot);
    for (const participant of room.participants.values()) {
      const socket = participant.socket;
      if (socket && socket !== except && socket.readyState === WebSocket.OPEN) socket.send(data);
    }
  }

  #sweep() {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (now - room.createdAt > this.idleTimeoutMs
        || [...room.participants.values()].every(person =>
          person.disconnectedAt && now - person.disconnectedAt > this.disconnectedTimeoutMs)) {
        for (const participant of room.participants.values()) {
          if (participant.socket) {
            safeSend(participant.socket, { type: "closed", message: "This classroom expired." });
            participant.socket.close(4004, "Classroom expired");
          }
        }
        this.rooms.delete(id);
      }
    }
  }

  #errorMessage(code) {
    const messages = {
      JOIN_REQUIRED: "Create or join a classroom first.",
      ROOM_NOT_FOUND: "Classroom not found. Check the invitation link and try again.",
      ROOM_LOCKED: "The host has locked this classroom.",
      ROOM_FULL: "This classroom has reached its participant limit.",
      ROOM_PASSWORD_REQUIRED: "This classroom requires the correct password.",
      ROOM_CLOSED: "This classroom is closed.",
      STALE_VERSION: "The classroom changed. The latest position has been synchronized.",
      MOVE_NOT_PERMITTED: "The host has not given you permission to move that color.",
      ILLEGAL_MOVE: "That move is not legal in the current position.",
      RETURN_TO_LIVE_POSITION: "Return to the latest move before continuing play.",
      NOTHING_TO_UNDO: "There are no moves to undo.",
      NOTHING_TO_REDO: "There are no moves to redo.",
      HOST_ONLY: "Only the classroom host can do that.",
      INVALID_MOVE: "The move coordinates are invalid.",
      INVALID_FEN: "The FEN position is invalid.",
      INVALID_PGN: "The PGN game is invalid.",
      INVALID_POSITION: "Provide a valid FEN position or PGN game.",
      INVALID_ROOM_NAME: "Enter a classroom name.",
      INVALID_PASSWORD: "The password is too long.",
      INVALID_PERMISSION: "Choose a valid participant permission.",
      INVALID_ORIENTATION: "Choose a valid board orientation.",
      INVALID_LOCK_STATE: "The lock setting is invalid.",
      PARTICIPANT_NOT_FOUND: "The participant is no longer in this classroom.",
      INVALID_ANNOTATION: "The board annotation is invalid.",
      ANNOTATION_LIMIT: "Remove an annotation before adding another.",
      INVALID_PROMOTION: "Choose a valid promotion piece.",
      UNKNOWN_ACTION: "This classroom action is not supported."
    };
    return messages[code] || "The classroom could not complete that action.";
  }
}

export function attachClassroom(server, options) {
  return new ClassroomHub(options).attach(server);
}
