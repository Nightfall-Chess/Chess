import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { attachClassroom } from "../classroom.mjs";

class ClassroomClient {
  constructor(socket) {
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.on("message", data => {
      const message = JSON.parse(data.toString());
      const waiterIndex = this.waiters.findIndex(waiter => waiter.matches(message));
      if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1)[0].resolve(message);
      else this.messages.push(message);
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(type, predicate = () => true, label = type) {
    const index = this.messages.findIndex(message => message.type === type && predicate(message));
    if (index >= 0) return this.messages.splice(index, 1)[0];
    return new Promise((resolve, reject) => {
      const waiter = {
        matches: message => message.type === type && predicate(message),
        resolve: message => {
          clearTimeout(waiter.timer);
          resolve(message);
        },
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter(current => current !== waiter);
          reject(new Error(`Timed out waiting for ${label}; pending messages: ${JSON.stringify(this.messages)}.`));
        }, 3000)
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    this.socket.close();
    return new Promise(resolve => this.socket.once("close", resolve));
  }
}

async function createFixture(t) {
  const server = createServer();
  const hub = attachClassroom(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const clients = new Set();
  t.after(async () => {
    await Promise.all([...clients].map(client => client.close()));
    hub.close();
    server.close();
    await once(server, "close");
  });
  return {
    url: `ws://127.0.0.1:${port}/classroom`,
    connect: async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/classroom`, { origin: "http://localhost:5500" });
      await once(socket, "open");
      const client = new ClassroomClient(socket);
      clients.add(client);
      return client;
    }
  };
}

async function createRoom(fixture, options = {}) {
  const host = await fixture.connect();
  host.send({ type: "create", roomName: "Night class", name: "Teacher", ...options });
  const joined = await host.waitFor("joined");
  return { host, joined, room: joined.room, token: joined.token };
}

test("private rooms authenticate guests, share authoritative moves, and reject stale moves", async t => {
  const fixture = await createFixture(t);
  const avatar = "data:image/png;base64,aGVsbG8=";
  const { host, room, token } = await createRoom(fixture, { password: "moonlight", avatar });
  assert.match(room.id, /^[A-Za-z0-9_-]{20,32}$/);
  assert.equal(token.length, 43);
  assert.equal(room.participants[0].avatar, avatar);
  const rejected = await fixture.connect();
  rejected.send({ type: "join", roomId: room.id, name: "Guest", password: "wrong" });
  assert.equal((await rejected.waitFor("error")).code, "ROOM_PASSWORD_REQUIRED");
  const student = await fixture.connect();
  student.send({ type: "join", roomId: room.id, name: "Student", password: "moonlight", avatar });
  const studentJoined = await student.waitFor("joined");
  await host.waitFor("snapshot", () => true, "host room-join snapshot");
  assert.equal(studentJoined.role, "student");
  assert.equal(studentJoined.room.participants.length, 2);
  assert.equal(studentJoined.room.participants[1].permission, "view");
  assert.equal(studentJoined.room.participants[1].avatar, avatar);

  student.send({ type: "move", from: "e2", to: "e4", baseVersion: studentJoined.room.version, requestId: "denied" });
  assert.equal((await student.waitFor("error")).code, "MOVE_NOT_PERMITTED");

  host.send({
    type: "permissions",
    participantId: studentJoined.participantId,
    permission: "white",
    baseVersion: studentJoined.room.version,
    requestId: "grant-white"
  });
  const permitted = await host.waitFor("snapshot", () => true, "host permission snapshot");
  await student.waitFor("snapshot", () => true, "student permission snapshot");
  student.send({ type: "move", from: "e2", to: "e4", baseVersion: permitted.room.version, requestId: "move-e4" });
  const moved = await student.waitFor("snapshot", () => true, "student move snapshot");
  const shared = await host.waitFor("snapshot", () => true, "host move snapshot");
  assert.equal(moved.room.fen, shared.room.fen);
  assert.equal(moved.room.moves[0].san, "e4");
  assert.equal(moved.room.turn, "b");

  host.send({ type: "move", from: "e7", to: "e5", baseVersion: moved.room.version, requestId: "move-e5" });
  const afterReply = await host.waitFor("snapshot", () => true, "host reply snapshot");
  assert.equal((await student.waitFor("snapshot", () => true, "student reply snapshot")).room.fen, afterReply.room.fen);
  host.send({ type: "move", from: "d7", to: "d5", baseVersion: moved.room.version, requestId: "stale-move" });
  assert.equal((await host.waitFor("error")).code, "STALE_VERSION");
});

test("permissions protect host controls; moves are checked and undo/redo stay ordered", async t => {
  const fixture = await createFixture(t);
  const { host, room } = await createRoom(fixture);
  const student = await fixture.connect();
  student.send({ type: "join", roomId: room.id, name: "Student" });
  const joined = await student.waitFor("joined");
  await host.waitFor("snapshot");
  student.send({ type: "reset", baseVersion: joined.room.version, requestId: "unauthorized-reset" });
  assert.equal((await student.waitFor("error")).code, "HOST_ONLY");

  host.send({ type: "move", from: "e2", to: "e5", baseVersion: joined.room.version, requestId: "illegal" });
  assert.equal((await host.waitFor("error")).code, "ILLEGAL_MOVE");
  host.send({ type: "move", from: "e2", to: "e4", baseVersion: joined.room.version, requestId: "host-e4" });
  let state = (await host.waitFor("snapshot", message => message.room.version > joined.room.version)).room;
  host.send({ type: "move", from: "e7", to: "e5", baseVersion: state.version, requestId: "host-e5" });
  state = (await host.waitFor("snapshot")).room;
  host.send({ type: "undo", baseVersion: state.version, requestId: "undo-e5" });
  state = (await host.waitFor("snapshot")).room;
  assert.equal(state.moves.length, 1);
  host.send({ type: "redo", baseVersion: state.version, requestId: "redo-e5" });
  state = (await host.waitFor("snapshot")).room;
  assert.deepEqual(state.moves.map(move => move.san), ["e4", "e5"]);
  host.send({ type: "redo", baseVersion: state.version, requestId: "redo-empty" });
  assert.equal((await host.waitFor("error")).code, "NOTHING_TO_REDO");
});

test("FEN, PGN, navigation, orientation, and annotations synchronize safely", async t => {
  const fixture = await createFixture(t);
  const { host, room } = await createRoom(fixture);
  const student = await fixture.connect();
  student.send({ type: "join", roomId: room.id, name: "Student" });
  let state = (await student.waitFor("joined")).room;
  await host.waitFor("snapshot");

  host.send({ type: "annotation", action: "arrow", from: "e2", to: "e4", color: "violet", baseVersion: state.version, requestId: "arrow" });
  state = (await host.waitFor("snapshot")).room;
  assert.equal(state.annotations.length, 1);
  assert.equal((await student.waitFor("snapshot")).room.annotations[0].to, "e4");
  host.send({ type: "annotation", action: "square", square: "d4", color: "gold", baseVersion: state.version, requestId: "highlight" });
  state = (await host.waitFor("snapshot")).room;
  assert.equal(state.annotations.length, 2);

  host.send({
    type: "load",
    pgn: "1. e4 e5 2. Nf3 Nc6",
    baseVersion: state.version,
    requestId: "load-pgn"
  });
  state = (await host.waitFor("snapshot")).room;
  assert.deepEqual(state.moves.map(move => move.san), ["e4", "e5", "Nf3", "Nc6"]);
  assert.equal(state.annotations.length, 0);

  host.send({ type: "navigate", ply: 2, baseVersion: state.version, requestId: "navigate" });
  state = (await host.waitFor("snapshot")).room;
  assert.equal(state.selectedPly, 2);
  host.send({ type: "move", from: "b1", to: "c3", baseVersion: state.version, requestId: "historical-move" });
  assert.equal((await host.waitFor("error")).code, "RETURN_TO_LIVE_POSITION");
  host.send({ type: "orientation", orientation: "b", baseVersion: state.version, requestId: "flip" });
  state = (await host.waitFor("snapshot")).room;
  assert.equal(state.orientation, "b");
  host.send({
    type: "load",
    fen: "invalid position",
    baseVersion: state.version,
    requestId: "invalid-fen"
  });
  assert.equal((await host.waitFor("error")).code, "INVALID_FEN");
});

test("participants reconnect with their token and room hosts can lock, transfer, and close", async t => {
  const fixture = await createFixture(t);
  const { host, room, token } = await createRoom(fixture);
  const student = await fixture.connect();
  student.send({ type: "join", roomId: room.id, name: "Student" });
  const joined = await student.waitFor("joined");
  await host.waitFor("snapshot");
  const participantId = joined.participantId;
  const reconnectToken = joined.token;
  await student.close();
  const disconnected = await host.waitFor("snapshot");
  assert.equal(disconnected.room.participants.find(person => person.id === participantId).connected, false);

  const reconnected = await fixture.connect();
  reconnected.send({ type: "join", roomId: room.id, token: reconnectToken });
  const resumed = await reconnected.waitFor("joined");
  assert.equal(resumed.participantId, participantId);
  assert.equal(resumed.token, reconnectToken);
  await host.waitFor("snapshot");
  const originalHostId = joined.room.participants.find(person => person.role === "host").id;

  host.send({ type: "lock", locked: true, baseVersion: resumed.room.version, requestId: "lock-room" });
  const locked = await host.waitFor("snapshot");
  await reconnected.waitFor("snapshot");
  assert.equal(locked.room.locked, true);
  const stranger = await fixture.connect();
  stranger.send({ type: "join", roomId: room.id, name: "Late guest" });
  assert.equal((await stranger.waitFor("error")).code, "ROOM_LOCKED");

  host.send({ type: "transfer", participantId, baseVersion: locked.room.version, requestId: "transfer-host" });
  const transferred = await reconnected.waitFor("snapshot");
  assert.equal(transferred.room.participants.find(person => person.id === participantId).role, "host");
  assert.equal(transferred.room.participants.find(person => person.id === originalHostId).role, "student");
  host.send({ type: "close", baseVersion: transferred.room.version, requestId: "former-host-close" });
  assert.equal((await host.waitFor("error")).code, "HOST_ONLY");
  reconnected.send({ type: "close", baseVersion: transferred.room.version, requestId: "close-room" });
  assert.equal((await reconnected.waitFor("closed")).type, "closed");
  assert.equal(token.length, 43);
});

test("origin checks reject cross-site websocket upgrades", async t => {
  const fixture = await createFixture(t);
  const socket = new WebSocket(fixture.url, { origin: "https://not-allowed.example" });
  const [, response] = await once(socket, "unexpected-response");
  assert.equal(response.statusCode, 403);
  response.destroy();
});
