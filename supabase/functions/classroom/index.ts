import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { Chess, type PieceSymbol, type Square } from "npm:chess.js@1.4.0";
import { applyClassroomMove, classroomCanMoveColor } from "../_shared/classroom-domain.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const MAX_BODY_BYTES = 24_000;
const MAX_PASSWORD_LENGTH = 96;
const MAX_MESSAGES = 100;
const ANNOTATION_COLORS = new Set(["violet", "gold", "blue", "red"]);
const SQUARE = /^[a-h][1-8]$/;
const INITIAL_FEN = new Chess().fen();
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Max-Age": "86400"
};

type JsonRecord = Record<string, unknown>;
type ActionResult = {
  data: JsonRecord;
  broadcast?: { roomId: string; event: string; payload: JsonRecord };
};

function response(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function cleanText(value: unknown, maximum: number, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maximum) || fallback;
}

function cleanAvatar(value: unknown) {
  return typeof value === "string" && value.length <= 32768
    && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : "";
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function digestHex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password: string) {
  if (!password) return null;
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error("INVALID_PASSWORD");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 210000 },
    key,
    256
  );
  return `pbkdf2$210000$${base64Url(salt)}$${base64Url(new Uint8Array(bits))}`;
}

async function passwordMatches(password: string, stored: string | null) {
  if (!stored) return true;
  const [algorithm, iterationText, saltText, expectedText] = stored.split("$");
  const iterations = Number(iterationText);
  if (algorithm !== "pbkdf2" || !Number.isSafeInteger(iterations) || iterations < 100000 || iterations > 500000) {
    throw new Error("PASSWORD_CONFIGURATION_INVALID");
  }
  if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(saltText), iterations },
    key,
    256
  ));
  const expected = fromBase64Url(expectedText);
  return bits.length === expected.length && bits.every((byte, index) => byte === expected[index]);
}

function createChess(state: JsonRecord) {
  const chess = new Chess();
  const pgn = typeof state.pgn === "string" ? state.pgn : "";
  if (pgn) chess.loadPgn(pgn, { strict: true });
  else chess.load(String(state.fen || INITIAL_FEN));
  return chess;
}

function snapshotStateRow(state: JsonRecord) {
  return {
    room_id: state.room_id,
    fen: state.fen,
    pgn: state.pgn,
    moves: state.moves,
    redo_stack: state.redo_stack,
    orientation: state.orientation,
    selected_ply: state.selected_ply,
    annotations: state.annotations,
    version: state.version,
    current_game_id: state.current_game_id,
    selected_game_id: state.selected_game_id,
    published_analysis: state.published_analysis
  };
}

function makeRoomSnapshot(room: JsonRecord, state: JsonRecord, members: JsonRecord[]) {
  const fen = String(state.fen);
  const chess = new Chess(fen);
  const moves = Array.isArray(state.moves) ? state.moves : [];
  return {
    id: room.id,
    name: room.name,
    locked: room.locked,
    closed: room.closed,
    orientation: state.orientation,
    fen,
    turn: fen.split(" ")[1] || "w",
    version: state.version,
    selectedPly: state.selected_ply,
    canRedo: Array.isArray(state.redo_stack) && state.redo_stack.length > 0,
    pgn: state.pgn,
    moves,
    legalMoves: chess.moves({ verbose: true }).map(move => ({
      from: move.from,
      to: move.to,
      promotion: move.promotion || null
    })),
    annotations: Array.isArray(state.annotations) ? state.annotations : [],
    participants: members.map(member => ({
      id: member.user_id,
      name: member.display_name,
      avatar: member.avatar_data_url || "",
      role: member.role,
      permission: member.permission,
      connected: false
    })),
    gameId: state.current_game_id,
    selectedGameId: state.selected_game_id,
    publishedAnalysis: state.published_analysis
  };
}

function databaseError(error: { message?: string; code?: string }) {
  const message = error.message || "";
  const code = [
    "ROOM_CLOSED", "MEMBERSHIP_REQUIRED", "STALE_VERSION", "MOVE_NOT_PERMITTED",
    "HOST_ONLY", "INVALID_PERMISSION", "PARTICIPANT_NOT_FOUND", "INVALID_LOCK_STATE",
    "INVALID_ANALYSIS", "INVALID_STATE", "UNKNOWN_ACTION", "INVALID_MESSAGE"
  ].find(value => message.includes(value));
  if (code) return code;
  if (error.code === "23505") return "DUPLICATE_REQUEST";
  return "CLASSROOM_DATABASE_ERROR";
}

async function main(request: Request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return response(405, { code: "METHOD_NOT_ALLOWED", message: "Use POST." });
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Classroom Edge Function is missing Supabase environment variables.");
    return response(503, { code: "SERVER_CONFIGURATION", message: "Classroom service is not configured." });
  }
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return response(401, { code: "AUTH_REQUIRED", message: "Sign in to use Classroom." });
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
    return response(413, { code: "REQUEST_TOO_LARGE", message: "Classroom request is too large." });
  }
  let body: JsonRecord;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return response(400, { code: "INVALID_REQUEST", message: "Classroom request is not valid JSON." });
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.action !== "string") {
    return response(400, { code: "INVALID_REQUEST", message: "Classroom action is required." });
  }

  const identityClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } }
  });
  const { data: identity, error: identityError } = await identityClient.auth.getUser();
  if (identityError || !identity.user) return response(401, { code: "AUTH_REQUIRED", message: "Your session has expired. Reconnect and try again." });
  const userId = identity.user.id;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    const result = await handleAction(admin, userId, body);
    if (result.broadcast) await broadcast(admin, result.broadcast.roomId, result.broadcast.event, result.broadcast.payload);
    return response(200, result.data);
  } catch (error) {
    const code = databaseError(error as { message?: string; code?: string });
    const knownCodes = new Set([
      "ROOM_NOT_FOUND", "ROOM_LOCKED", "ROOM_PASSWORD_REQUIRED", "ROOM_FULL", "ROOM_CLOSED",
      "MEMBERSHIP_REQUIRED", "STALE_VERSION", "MOVE_NOT_PERMITTED", "HOST_ONLY", "ILLEGAL_MOVE",
      "RETURN_TO_LIVE_POSITION", "NOTHING_TO_UNDO", "NOTHING_TO_REDO", "INVALID_FEN", "INVALID_PGN",
      "INVALID_POSITION", "INVALID_ORIENTATION", "INVALID_ANNOTATION", "ANNOTATION_LIMIT",
      "INVALID_PERMISSION", "PARTICIPANT_NOT_FOUND", "INVALID_LOCK_STATE", "INVALID_ANALYSIS",
      "INVALID_PASSWORD", "INVALID_ROOM_NAME", "DUPLICATE_REQUEST", "MESSAGE_TOO_LONG", "INVALID_MESSAGE",
      "UNKNOWN_ACTION"
    ]);
    const resolved = knownCodes.has(code) ? code : (error instanceof Error && knownCodes.has(error.message) ? error.message : code);
    if (!knownCodes.has(resolved)) console.error("Classroom request failed:", error);
    return response(resolved === "ROOM_NOT_FOUND" ? 404 : resolved === "AUTH_REQUIRED" ? 401 : 400, {
      code: resolved,
      message: publicErrorMessage(resolved)
    });
  }
}

async function handleAction(admin: ReturnType<typeof createClient>, userId: string, body: JsonRecord): Promise<ActionResult> {
  const action = body.action;
  if (action === "create") {
    const name = cleanText(body.name, 24, "Host");
    const roomName = cleanText(body.roomName, 80);
    const password = typeof body.password === "string" ? body.password : "";
    if (!roomName) throw new Error("INVALID_ROOM_NAME");
    if (password.length > MAX_PASSWORD_LENGTH) throw new Error("INVALID_PASSWORD");
    const inviteCode = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    const roomId = crypto.randomUUID();
    const gameId = crypto.randomUUID();
    const { error } = await admin.rpc("create_classroom_room", {
      p_room_id: roomId,
      p_owner_id: userId,
      p_name: roomName,
      p_invite_code_hash: await digestHex(inviteCode),
      p_password_hash: await hashPassword(password),
      p_game_id: gameId,
      p_start_fen: INITIAL_FEN,
      p_display_name: name,
      p_avatar_data_url: cleanAvatar(body.avatar)
    });
    if (error) throw error;
    const room = await getSnapshot(admin, roomId, userId);
    return { data: { room, userId, invitationCode: inviteCode } };
  }

  if (action === "join") {
    const invitationCode = typeof body.invitationCode === "string" ? body.invitationCode : "";
    const requestedRoomId = typeof body.roomId === "string" ? body.roomId : "";
    let roomId = "";
    let roomSecrets: JsonRecord | null = null;
    if (invitationCode) {
      if (invitationCode.length > 100) throw new Error("ROOM_NOT_FOUND");
      const { data: secret, error: secretError } = await admin.from("classroom_room_secrets")
        .select("room_id,password_hash").eq("invite_code_hash", await digestHex(invitationCode)).maybeSingle();
      if (secretError || !secret) throw new Error("ROOM_NOT_FOUND");
      roomSecrets = secret as JsonRecord;
      roomId = String(secret.room_id);
    } else if (requestedRoomId) {
      const { data: member } = await admin.from("classroom_room_members")
        .select("room_id").eq("room_id", requestedRoomId).eq("user_id", userId).maybeSingle();
      if (!member) throw new Error("ROOM_NOT_FOUND");
      roomId = requestedRoomId;
    } else {
      throw new Error("ROOM_NOT_FOUND");
    }
    const { data: room, error } = await admin.from("classroom_rooms")
      .select("id,owner_id,name,locked,closed,expires_at")
      .eq("id", roomId).maybeSingle();
    if (error || !room || room.closed || new Date(room.expires_at).getTime() <= Date.now()) throw new Error("ROOM_NOT_FOUND");
    const { data: existing } = await admin.from("classroom_room_members").select("user_id")
      .eq("room_id", room.id).eq("user_id", userId).maybeSingle();
    const name = cleanText(body.name, 24, "Student");
    const avatar = cleanAvatar(body.avatar);
    if (!existing) {
      if (room.locked) throw new Error("ROOM_LOCKED");
      const password = typeof body.password === "string" ? body.password : "";
      const passwordHash=typeof roomSecrets?.password_hash==="string"?roomSecrets.password_hash:null;
      if (!await passwordMatches(password,passwordHash)) throw new Error("ROOM_PASSWORD_REQUIRED");
    }
    const { error: joinError } = await admin.rpc("join_classroom_room", {
      p_room_id: room.id,
      p_user_id: userId,
      p_display_name: name,
      p_avatar_data_url: avatar,
      p_invitation_verified: Boolean(invitationCode)
    });
    if (joinError) throw joinError;
    const snapshot = await getSnapshot(admin, room.id, userId);
    return {
      data: { room: snapshot, userId },
      broadcast: { roomId: room.id, event: "members", payload: { version: snapshot.version } }
    };
  }

  if (action === "snapshot" || action === "messages") {
    const roomId = requireRoomId(body.roomId);
    await requireMember(admin, roomId, userId);
    if (action === "snapshot") return { data: { room: await getSnapshot(admin, roomId, userId) } };
    const { data, error } = await admin.from("classroom_room_messages")
      .select("id,user_id,display_name,body,created_at")
      .eq("room_id", roomId).order("created_at", { ascending: false }).limit(MAX_MESSAGES);
    if (error) throw error;
    return { data: { messages: (data || []).reverse() } };
  }

  if (action === "message") {
    const roomId = requireRoomId(body.roomId);
    const member = await requireMember(admin, roomId, userId);
    if (typeof body.body !== "string" || body.body.length > 1000) throw new Error("MESSAGE_TOO_LONG");
    const text = cleanText(body.body, 1000);
    if (!text) throw new Error("INVALID_MESSAGE");
    const messageId = typeof body.requestId === "string" && /^[0-9a-f-]{36}$/i.test(body.requestId)
      ? body.requestId : crypto.randomUUID();
    const { error } = await admin.rpc("create_classroom_message", {
      p_room_id: roomId, p_user_id: userId, p_message_id: messageId, p_body: text
    });
    if (error) throw error;
    const message = { id: messageId, user_id: userId, display_name: member.display_name, body: text, created_at: new Date().toISOString() };
    return { data: { message }, broadcast: { roomId, event: "chat", payload: { messageId } } };
  }

  if (action === "rotate-invite") {
    const roomId = requireRoomId(body.roomId);
    await requireHost(admin, roomId, userId);
    const invitationCode = base64Url(crypto.getRandomValues(new Uint8Array(24)));
    const { error } = await admin.from("classroom_room_secrets").update({
      invite_code_hash: await digestHex(invitationCode)
    }).eq("room_id", roomId);
    if (error) throw error;
    return { data: { invitationCode } };
  }

  if (action === "games") {
    const roomId = requireRoomId(body.roomId);
    await requireMember(admin, roomId, userId);
    const { data, error } = await admin.from("classroom_room_games")
      .select("id,pgn,final_fen,moves,created_at,updated_at")
      .eq("room_id", roomId).order("updated_at", { ascending: false }).limit(50);
    if (error) throw error;
    return { data: { games: data || [] } };
  }

  if (action === "mutate") {
    return await mutate(admin, userId, body);
  }

  throw new Error("UNKNOWN_ACTION");
}

function requireRoomId(body: unknown) {
  if (typeof body !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body)) {
    throw new Error("ROOM_NOT_FOUND");
  }
  return body;
}

async function requireMember(admin: ReturnType<typeof createClient>, roomId: string, userId: string) {
  const { data, error } = await admin.from("classroom_room_members")
    .select("user_id,role,permission,display_name")
    .eq("room_id", roomId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("MEMBERSHIP_REQUIRED");
  return data;
}

async function requireHost(admin: ReturnType<typeof createClient>, roomId: string, userId: string) {
  const member = await requireMember(admin, roomId, userId);
  if (member.role !== "host") throw new Error("HOST_ONLY");
  return member;
}

async function getSnapshot(admin: ReturnType<typeof createClient>, roomId: string, userId: string) {
  await requireMember(admin, roomId, userId);
  const [roomResult, stateResult, membersResult] = await Promise.all([
    admin.from("classroom_rooms").select("id,owner_id,name,locked,closed,expires_at").eq("id", roomId).single(),
    admin.from("classroom_room_state").select("*").eq("room_id", roomId).single(),
    admin.from("classroom_room_members")
      .select("user_id,role,permission,display_name,avatar_data_url,joined_at")
      .eq("room_id", roomId).order("joined_at", { ascending: true })
  ]);
  if (roomResult.error) throw roomResult.error;
  if (stateResult.error) throw stateResult.error;
  if (membersResult.error) throw membersResult.error;
  const room = roomResult.data as JsonRecord;
  if (room.closed || new Date(String(room.expires_at)).getTime() <= Date.now()) throw new Error("ROOM_CLOSED");
  return makeRoomSnapshot(room, stateResult.data as JsonRecord, membersResult.data as JsonRecord[]);
}

async function mutate(admin: ReturnType<typeof createClient>, userId: string, body: JsonRecord): Promise<ActionResult> {
  const roomId = requireRoomId(body.roomId);
  const action = typeof body.operation === "string" ? body.operation : "";
  const requestId = typeof body.requestId === "string" && /^[0-9a-f-]{36}$/i.test(body.requestId)
    ? body.requestId : crypto.randomUUID();
  const baseVersion = Number(body.baseVersion);
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) throw new Error("STALE_VERSION");
  const room = await getRoomAndState(admin, roomId, userId);
  const state = room.state;
  const member = room.member;
  let chess = createChess(state);
  const next = {
    fen: state.fen,
    pgn: state.pgn || "",
    moves: Array.isArray(state.moves) ? [...state.moves] : [],
    redo_stack: Array.isArray(state.redo_stack) ? [...state.redo_stack] : [],
    orientation: state.orientation,
    selected_ply: state.selected_ply,
    annotations: Array.isArray(state.annotations) ? [...state.annotations] : [],
    current_game_id: state.current_game_id,
    selected_game_id: state.selected_game_id,
    published_analysis: state.published_analysis
  };
  if (action === "move") {
    const from = String(body.from || "");
    const to = String(body.to || "");
    if (!SQUARE.test(from) || !SQUARE.test(to)) throw new Error("ILLEGAL_MOVE");
    const movingPiece = chess.get(from as Square);
    if (!movingPiece) throw new Error("ILLEGAL_MOVE");
    if (!classroomCanMoveColor(member, movingPiece.color)) throw new Error("MOVE_NOT_PERMITTED");
    Object.assign(next, applyClassroomMove(chess, next, {
      from,
      to,
      ...(typeof body.promotion === "string" ? { promotion: body.promotion } : body.promotion === undefined ? {} : { promotion: "" })
    }));
  } else if (action === "undo") {
    const lastMove = chess.history({ verbose: true }).at(-1);
    if (!lastMove) throw new Error("NOTHING_TO_UNDO");
    chess.undo();
    next.redo_stack.push({ from: lastMove.from, to: lastMove.to, ...(lastMove.promotion ? { promotion: lastMove.promotion } : {}) });
    next.selected_ply = chess.history().length;
  } else if (action === "redo") {
    const redo = next.redo_stack.pop();
    if (!redo) throw new Error("NOTHING_TO_REDO");
    const move = redo as { from: string; to: string; promotion?: string };
    try {
      chess.move({ from: move.from as Square, to: move.to as Square, ...(move.promotion ? { promotion: move.promotion as PieceSymbol } : {}) });
    } catch {
      throw new Error("ILLEGAL_MOVE");
    }
    next.selected_ply = chess.history().length;
  } else if (action === "reset") {
    chess = new Chess();
    next.fen = chess.fen();
    next.pgn = "";
    next.moves = [];
    next.redo_stack = [];
    next.selected_ply = 0;
    next.annotations = [];
    next.current_game_id = crypto.randomUUID();
    next.selected_game_id = next.current_game_id;
    next.published_analysis = null;
  } else if (action === "load") {
    const fresh = new Chess();
    try {
      if (typeof body.fen === "string" && body.fen.trim()) fresh.load(body.fen.trim());
      else if (typeof body.pgn === "string" && body.pgn.length <= 100000) fresh.loadPgn(body.pgn, { strict: true });
      else throw new Error("INVALID_POSITION");
    } catch {
      throw new Error(typeof body.fen === "string" && body.fen.trim() ? "INVALID_FEN" : "INVALID_PGN");
    }
    chess = fresh;
    next.fen = fresh.fen();
    next.pgn = fresh.pgn();
    next.moves = fresh.history({ verbose: true });
    next.redo_stack = [];
    next.selected_ply = next.moves.length;
    next.annotations = [];
    next.current_game_id = crypto.randomUUID();
    next.selected_game_id = next.current_game_id;
    next.published_analysis = null;
  } else if (action === "select-game") {
    const gameId = typeof body.gameId === "string" ? body.gameId : "";
    if (!/^[0-9a-f-]{36}$/i.test(gameId)) throw new Error("INVALID_POSITION");
    const { data: game, error } = await admin.from("classroom_room_games")
      .select("id,pgn,final_fen,moves").eq("room_id", roomId).eq("id", gameId).maybeSingle();
    if (error) throw error;
    if (!game) throw new Error("INVALID_POSITION");
    const selected = new Chess();
    try {
      if (game.pgn) selected.loadPgn(game.pgn, { strict: true });
      else selected.load(game.final_fen);
    } catch {
      throw new Error("INVALID_POSITION");
    }
    chess = selected;
    next.fen = selected.fen();
    next.pgn = selected.pgn();
    next.moves = selected.history({ verbose: true });
    next.redo_stack = [];
    next.selected_ply = next.moves.length;
    next.annotations = [];
    next.current_game_id = game.id;
    next.selected_game_id = game.id;
    next.published_analysis = null;
  } else if (action === "navigate") {
    const ply = Number(body.ply);
    if (!Number.isSafeInteger(ply) || ply < 0 || ply > next.moves.length) throw new Error("INVALID_POSITION");
    next.selected_ply = ply;
  } else if (action === "orientation") {
    if (body.orientation !== "w" && body.orientation !== "b") throw new Error("INVALID_ORIENTATION");
    next.orientation = body.orientation;
  } else if (action === "annotation") {
    applyAnnotation(next.annotations, body, requestId);
  } else if (action === "permissions" || action === "remove" || action === "transfer") {
    if (typeof body.participantId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.participantId)) {
      throw new Error("PARTICIPANT_NOT_FOUND");
    }
    if (action === "permissions" && !["view", "white", "black", "both", "control"].includes(String(body.permission))) {
      throw new Error("INVALID_PERMISSION");
    }
  } else if (action === "lock") {
    if (typeof body.locked !== "boolean") throw new Error("INVALID_LOCK_STATE");
  } else if (action === "close") {
    next.published_analysis = null;
  } else if (action === "publish-analysis") {
    if (member.role !== "host") throw new Error("HOST_ONLY");
    next.published_analysis = validateAnalysis(body.analysis);
  } else {
    throw new Error("UNKNOWN_ACTION");
  }

  if (["move", "undo", "redo", "load", "reset"].includes(action)) {
    next.fen = chess.fen();
    next.pgn = chess.pgn();
    next.moves = chess.history({ verbose: true });
  }
  const { error } = await admin.rpc("commit_classroom_action", {
    p_room_id: roomId,
    p_actor_id: userId,
    p_base_version: baseVersion,
    p_event_id: requestId,
    p_action: ({
      "publish-analysis": "publish_analysis",
      "select-game": "select_game"
    } as Record<string, string>)[action] || action,
    p_state: next,
    p_payload: body
  });
  if (error) throw new Error(databaseError(error));

  if (action === "remove" && body.participantId === userId) {
    throw new Error("MEMBERSHIP_REQUIRED");
  }
  const snapshot = action === "close"
    ? { ...makeRoomSnapshot(room.room, state, await getMembers(admin, roomId)), closed: true, version: Number(state.version) + 1, publishedAnalysis: null }
    : await getSnapshot(admin, roomId, userId);
  return {
    data: { room: snapshot },
    broadcast: {
      roomId,
      event: action === "remove" ? "removed" : action === "close" ? "closed" : "state",
      payload: {
        eventId: requestId,
        version: snapshot.version,
        targetUserId: action === "remove" ? body.participantId : undefined
      }
    }
  };
}

async function getRoomAndState(admin: ReturnType<typeof createClient>, roomId: string, userId: string) {
  const member = await requireMember(admin, roomId, userId);
  const [{ data: room, error: roomError }, { data: state, error: stateError }] = await Promise.all([
    admin.from("classroom_rooms").select("id,owner_id,name,locked,closed,expires_at").eq("id", roomId).single(),
    admin.from("classroom_room_state").select("*").eq("room_id", roomId).single()
  ]);
  if (roomError) throw roomError;
  if (stateError) throw stateError;
  if (room.closed || new Date(room.expires_at).getTime() <= Date.now()) throw new Error("ROOM_CLOSED");
  return { room, state: snapshotStateRow(state), member };
}

async function getMembers(admin: ReturnType<typeof createClient>, roomId: string) {
  const { data, error } = await admin.from("classroom_room_members")
    .select("user_id,role,permission,display_name,avatar_data_url,joined_at")
    .eq("room_id", roomId).order("joined_at", { ascending: true });
  if (error) throw error;
  return (data || []) as JsonRecord[];
}

function applyAnnotation(annotations: JsonRecord[], body: JsonRecord, id: string) {
  const action = body.annotationAction;
  if (action === "clear") {
    annotations.splice(0);
    return;
  }
  if (action === "remove") {
    const index = annotations.findIndex(item => item.id === body.id);
    if (index >= 0) annotations.splice(index, 1);
    return;
  }
  const color = String(body.color || "");
  let annotation: JsonRecord;
  if (action === "arrow" && SQUARE.test(String(body.from || "")) && SQUARE.test(String(body.to || ""))) {
    annotation = { id, kind: "arrow", from: body.from, to: body.to, color };
  } else if (action === "square" && SQUARE.test(String(body.square || ""))) {
    annotation = { id, kind: "square", square: body.square, color };
  } else {
    throw new Error("INVALID_ANNOTATION");
  }
  if (!ANNOTATION_COLORS.has(color)) throw new Error("INVALID_ANNOTATION");
  const existing = annotations.findIndex(item =>
    item.kind === annotation.kind && item.color === color
      && (item.kind === "arrow" ? item.from === annotation.from && item.to === annotation.to : item.square === annotation.square));
  if (existing >= 0) annotations.splice(existing, 1);
  else {
    if (annotations.length >= 128) throw new Error("ANNOTATION_LIMIT");
    annotations.push(annotation);
  }
}

function validateAnalysis(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_ANALYSIS");
  const input = value as JsonRecord;
  if (!Number.isSafeInteger(input.depth) || Number(input.depth) < 1 || Number(input.depth) > 40
    || !Number.isSafeInteger(input.score) || Number(input.score) < -100000 || Number(input.score) > 100000
    || !Array.isArray(input.lines) || input.lines.length > 4) {
    throw new Error("INVALID_ANALYSIS");
  }
  const lines = input.lines.map(line => {
    if (!line || typeof line !== "object" || Array.isArray(line)) throw new Error("INVALID_ANALYSIS");
    const candidate = line as JsonRecord;
    const pv = Array.isArray(candidate.pv) ? candidate.pv : [];
    if (pv.length > 80 || pv.some(move => typeof move !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(move))) {
      throw new Error("INVALID_ANALYSIS");
    }
    return {
      scoreType: candidate.scoreType === "mate" ? "mate" : "cp",
      score: Number.isSafeInteger(candidate.score) ? Number(candidate.score) : Number(input.score),
      depth: Number.isSafeInteger(candidate.depth) ? Number(candidate.depth) : Number(input.depth),
      pv
    };
  });
  return {
    depth: Number(input.depth),
    scoreType: input.scoreType === "mate" ? "mate" : "cp",
    score: Number(input.score),
    lines,
    positionFen: typeof input.positionFen === "string" && input.positionFen.length <= 200 ? input.positionFen : ""
  };
}

async function broadcast(admin: ReturnType<typeof createClient>, roomId: string, event: string, payload: JsonRecord) {
  const channel = admin.channel(`classroom:${roomId}`, { config: { private: true } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Realtime channel subscription timed out.")), 8000);
      channel.subscribe((status: string, error: Error | undefined) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(timer);
          reject(error || new Error(`Realtime channel status: ${status}`));
        }
      });
    });
    const result = await channel.send({ type: "broadcast", event, payload });
    if (result !== "ok") throw new Error(`Realtime broadcast returned ${result}.`);
  } catch (error) {
    console.error("Classroom state was saved but its realtime notification failed:", error);
  } finally {
    await admin.removeChannel(channel);
  }
}

function publicErrorMessage(code: string) {
  const messages: Record<string, string> = {
    ROOM_NOT_FOUND: "Classroom not found or invitation is invalid.",
    ROOM_LOCKED: "The host has locked this classroom to new members.",
    ROOM_PASSWORD_REQUIRED: "The room password is incorrect or required.",
    ROOM_FULL: "This classroom has reached its participant limit.",
    ROOM_CLOSED: "This classroom is closed or expired.",
    MEMBERSHIP_REQUIRED: "You no longer have access to this classroom.",
    STALE_VERSION: "The classroom changed. The latest position is being synchronized.",
    MOVE_NOT_PERMITTED: "You do not have permission to move that color.",
    HOST_ONLY: "Only the classroom host can do that.",
    ILLEGAL_MOVE: "That move is not legal in this position.",
    RETURN_TO_LIVE_POSITION: "Return to the latest move before continuing play.",
    NOTHING_TO_UNDO: "There is no move to undo.",
    NOTHING_TO_REDO: "There is no move to redo.",
    INVALID_FEN: "The FEN position is invalid.",
    INVALID_PGN: "The PGN game is invalid.",
    INVALID_POSITION: "The requested position is invalid.",
    INVALID_ORIENTATION: "The board orientation is invalid.",
    INVALID_ANNOTATION: "The board annotation is invalid.",
    ANNOTATION_LIMIT: "The classroom has reached its annotation limit.",
    INVALID_PERMISSION: "That participant permission is invalid.",
    PARTICIPANT_NOT_FOUND: "The participant is no longer in this classroom.",
    INVALID_LOCK_STATE: "The requested lock state is invalid.",
    INVALID_ANALYSIS: "The published engine analysis is invalid.",
    INVALID_PASSWORD: "The room password is too long.",
    MESSAGE_TOO_LONG: "The chat message is too long.",
    INVALID_MESSAGE: "Enter a non-empty chat message.",
    DUPLICATE_REQUEST: "That request was already processed."
  };
  return messages[code] || "The classroom could not complete that action.";
}

Deno.serve(main);
