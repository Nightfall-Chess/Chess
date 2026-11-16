import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import { Chess } from "npm:chess.js@1.4.0";

const URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INITIAL_FEN = new Chess().fen();
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Max-Age": "86400"
};
const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
type Obj = Record<string, unknown>;

function reply(status: number, body: Obj) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
async function hash(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}
function code() {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  return [...bytes].map(x => alphabet[x % alphabet.length]).join("");
}
function cleanName(value: unknown, fallback: string) {
  return typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 24) || fallback : fallback;
}
function roomId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("ROOM_NOT_FOUND");
  return value;
}
async function requirePlayer(db: any, id: string, userId: string) {
  const { data, error } = await db.from("online_players").select("color,display_name").eq("room_id", id).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("NOT_A_PLAYER");
  return data;
}
async function snapshot(db: any, id: string, userId: string) {
  const player = await requirePlayer(db, id, userId);
  const [roomResult, stateResult, playersResult] = await Promise.all([
    db.from("online_rooms").select("id,status,expires_at").eq("id", id).single(),
    db.from("online_game_state").select("fen,pgn,moves,version,result").eq("room_id", id).single(),
    db.from("online_players").select("user_id,color,display_name,joined_at").eq("room_id", id).order("joined_at")
  ]);
  if (roomResult.error || stateResult.error || playersResult.error) throw new Error("DATABASE_ERROR");
  if (!roomResult.data || new Date(roomResult.data.expires_at).getTime() < Date.now()) throw new Error("ROOM_NOT_FOUND");
  return { ...roomResult.data, ...stateResult.data, players: playersResult.data, myColor: player.color, myName: player.display_name };
}
async function broadcast(db: any, id: string, event: string, payload: Obj) {
  const channel = db.channel(`online:${id}`, { config: { private: true } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Realtime subscribe timeout")), 8000);
      channel.subscribe((status: string, error?: Error) => {
        if (status === "SUBSCRIBED") { clearTimeout(timer); resolve(); }
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { clearTimeout(timer); reject(error || new Error(status)); }
      });
    });
    const result = await channel.send({ type: "broadcast", event, payload });
    if (result !== "ok") throw new Error(`Broadcast: ${result}`);
  } catch (error) {
    console.error("Online state persisted; realtime notification failed:", error);
  } finally {
    await db.removeChannel(channel);
  }
}
async function main(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply(405, { code: "METHOD_NOT_ALLOWED" });
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return reply(401, { code: "AUTH_REQUIRED" });
  const identity = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: auth } } });
  const { data: userData, error: userError } = await identity.auth.getUser();
  if (userError || !userData.user) return reply(401, { code: "AUTH_REQUIRED" });
  let body: Obj;
  try { body = await req.json(); } catch { return reply(400, { code: "INVALID_REQUEST" }); }
  const db = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const userId = userData.user.id;
  try {
    let data: Obj;
    let event: string | null = null;
    let eventRoom = "";
    if (body.action === "create") {
      const invite = code();
      const id = crypto.randomUUID();
      const name = cleanName(body.name, "Player");
      const { error: roomError } = await db.from("online_rooms").insert({ id, code_hash: await hash(invite), host_id: userId });
      if (roomError) throw roomError;
      const { error: playerError } = await db.from("online_players").insert({ room_id: id, user_id: userId, color: "w", display_name: name });
      if (playerError) throw playerError;
      const { error: stateError } = await db.from("online_game_state").insert({ room_id: id, fen: INITIAL_FEN });
      if (stateError) throw stateError;
      data = { room: await snapshot(db, id, userId), invitationCode: invite };
    } else if (body.action === "join") {
      const invite = typeof body.invitationCode === "string" ? body.invitationCode.trim().toUpperCase() : "";
      if (!/^[A-Z0-9]{7}$/.test(invite)) throw new Error("ROOM_NOT_FOUND");
      const { data: room, error } = await db.from("online_rooms").select("id,status,expires_at").eq("code_hash", await hash(invite)).maybeSingle();
      if (error || !room || room.status === "finished" || new Date(room.expires_at).getTime() < Date.now()) throw new Error("ROOM_NOT_FOUND");
      const id = room.id;
      const existing = await db.from("online_players").select("color").eq("room_id", id).eq("user_id", userId).maybeSingle();
      if (existing.data) {
        data = { room: await snapshot(db, id, userId) };
      } else {
        if (room.status !== "waiting") throw new Error("ROOM_FULL");
        const { error: addError } = await db.from("online_players").insert({ room_id: id, user_id: userId, color: "b", display_name: cleanName(body.name, "Player 2") });
        if (addError) throw new Error("ROOM_FULL");
        const { error: updateError } = await db.from("online_rooms").update({ status: "playing", updated_at: new Date().toISOString() }).eq("id", id).eq("status", "waiting");
        if (updateError) throw updateError;
        data = { room: await snapshot(db, id, userId) };
        event = "joined"; eventRoom = id;
      }
    } else if (body.action === "snapshot") {
      const id = roomId(body.roomId);
      data = { room: await snapshot(db, id, userId) };
    } else if (body.action === "move") {
      const id = roomId(body.roomId);
      const player = await requirePlayer(db, id, userId);
      const { data: saved, error } = await db.from("online_game_state").select("fen,pgn,moves,version").eq("room_id", id).single();
      if (error || !saved) throw new Error("ROOM_NOT_FOUND");
      if (Number(saved.version) !== Number(body.expectedVersion)) throw new Error("STALE_VERSION");
      const movesBefore = Array.isArray(saved.moves) ? saved.moves : [];
      const chess = new Chess();
      for (const previous of movesBefore) {
        chess.move({ from: previous.from, to: previous.to, ...(previous.promotion ? { promotion: previous.promotion } : {}) });
      }
      if (chess.fen() !== saved.fen) throw new Error("DATABASE_ERROR");
      if (chess.turn() !== player.color) throw new Error("NOT_YOUR_TURN");
      const from = typeof body.from === "string" ? body.from : "";
      const to = typeof body.to === "string" ? body.to : "";
      const promotion = typeof body.promotion === "string" && /^[qrbn]$/.test(body.promotion) ? body.promotion : undefined;
      const played = chess.move({ from, to, ...(promotion ? { promotion } : {}) });
      if (!played) throw new Error("ILLEGAL_MOVE");
      const moves = [...movesBefore, { from: played.from, to: played.to, san: played.san, promotion: played.promotion || null }];
      const result = chess.isCheckmate() ? (chess.turn() === "w" ? "Black wins by checkmate" : "White wins by checkmate")
        : chess.isStalemate() ? "Draw by stalemate"
        : chess.isThreefoldRepetition() ? "Draw by repetition"
        : chess.isInsufficientMaterial() ? "Draw by insufficient material"
        : chess.isDraw() ? "Draw" : null;
      const nextVersion = Number(saved.version) + 1;
      const { data: updated, error: updateError } = await db.from("online_game_state")
        .update({ fen: chess.fen(), pgn: chess.pgn(), moves, version: nextVersion, result, updated_at: new Date().toISOString() })
        .eq("room_id", id).eq("version", saved.version).select("room_id").maybeSingle();
      if (updateError) throw updateError;
      if (!updated) throw new Error("STALE_VERSION");
      if (result) await db.from("online_rooms").update({ status: "finished", updated_at: new Date().toISOString() }).eq("id", id);
      data = { room: await snapshot(db, id, userId), san: played.san };
      event = "state"; eventRoom = id;
    } else if (body.action === "resign") {
      const id = roomId(body.roomId);
      const player = await requirePlayer(db, id, userId);
      const winner = player.color === "w" ? "Black" : "White";
      const result = `${winner} wins by resignation`;
      const { error } = await db.from("online_game_state").update({ result, updated_at: new Date().toISOString() }).eq("room_id", id).is("result", null);
      if (error) throw error;
      await db.from("online_rooms").update({ status: "finished", updated_at: new Date().toISOString() }).eq("id", id);
      data = { room: await snapshot(db, id, userId) };
      event = "state"; eventRoom = id;
    } else {
      throw new Error("UNKNOWN_ACTION");
    }
    if (event && eventRoom) await broadcast(db, eventRoom, event, { at: Date.now() });
    return reply(200, data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "DATABASE_ERROR";
    const known = new Set(["ROOM_NOT_FOUND","ROOM_FULL","NOT_A_PLAYER","STALE_VERSION","NOT_YOUR_TURN","ILLEGAL_MOVE","UNKNOWN_ACTION"]);
    const code = known.has(message) ? message : "DATABASE_ERROR";
    if (code === "DATABASE_ERROR") console.error("Online game request failed:", error);
    return reply(code === "ROOM_NOT_FOUND" ? 404 : 400, { code, message: ({
      ROOM_NOT_FOUND: "Room not found or invite code is invalid.",
      ROOM_FULL: "This room already has two players or is no longer waiting.",
      NOT_A_PLAYER: "You are not a player in this room.",
      STALE_VERSION: "The board changed. Syncing the latest position.",
      NOT_YOUR_TURN: "It is not your turn.",
      ILLEGAL_MOVE: "That move is not legal.",
      DATABASE_ERROR: "Online service error. Please try again."
    } as Record<string,string>)[code] || code });
  }
}
Deno.serve(main);
