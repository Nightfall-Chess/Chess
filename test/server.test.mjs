import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { WebSocket } from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));

async function startChessServer(t, { heartbeatIntervalMs } = {}) {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  await once(probe, "close");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(address.port),
      ...(heartbeatIntervalMs ? { ONLINE_HEARTBEAT_MS: String(heartbeatIntervalMs) } : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Chess server did not start: ${output}`)), 5000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("Nightfall Chess available at")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(`Chess server exited before starting (code ${code}): ${output}`));
    });
  });
  return `ws://127.0.0.1:${address.port}/ws/online`;
}

async function openWebSocket(url) {
  const socket = new WebSocket(url);
  await once(socket, "open");
  return socket;
}

function nextMessage(socket, predicate = () => true, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for a WebSocket message."));
    }, timeoutMs);
    const onMessage = data => {
      const payload = JSON.parse(data.toString());
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(payload);
    };
    socket.on("message", onMessage);
  });
}

test("puzzle API CORS allows loopback pages and rejects other origins", async t => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  await once(probe, "close");

  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], {
    cwd: root,
    env: { ...process.env, PORT: String(address.port) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });

  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Puzzle server did not start: ${output}`)), 5000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("Nightfall Chess available at")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", chunk => { output += chunk; });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(`Puzzle server exited before starting (code ${code}): ${output}`));
    });
  });

  const endpoint = `http://127.0.0.1:${address.port}/api/puzzles/status`;
  const allowedOrigin = "http://127.0.0.1:5501";
  const allowed = await fetch(endpoint, { method: "OPTIONS", headers: { Origin: allowedOrigin } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.equal(allowed.headers.get("access-control-allow-methods"), "GET, OPTIONS");

  const denied = await fetch(endpoint, { method: "OPTIONS", headers: { Origin: "https://example.com" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});


test("self-hosted rooms enforce seats, validate moves, sync, resign, and resume", async t => {
    const url = await startChessServer(t);
    const sockets = new Set();
    const connect = async () => {
      const socket = await openWebSocket(url);
      sockets.add(socket);
      t.after(() => socket.close());
      return socket;
    };
    const host = await connect();
    const createdPromise = nextMessage(host, message => message.type === "created");
    host.send(JSON.stringify({ type: "create", name: "Host", timeControlSeconds: 300 }));
    const created = await createdPromise;
    assert.match(created.room.code, /^[A-Z0-9]{7}$/);
    assert.equal(created.color, "w");
    assert.equal(created.room.status, "waiting");

    const guest = await connect();
    const joinedPromise = nextMessage(guest, message => message.type === "joined");
    guest.send(JSON.stringify({ type: "join", code: created.room.code, name: "Guest" }));
    const joined = await joinedPromise;
    assert.equal(joined.color, "b");
    assert.equal(joined.room.status, "playing");
    assert.equal(joined.room.players.length, 2);

    const third = await connect();
    const fullRoomError = nextMessage(third, message => message.type === "error");
    third.send(JSON.stringify({ type: "join", code: created.room.code, name: "Third player" }));
    assert.match((await fullRoomError).message, /two players/);

    const wrongTurn = nextMessage(guest, message => message.type === "error");
    guest.send(JSON.stringify({ type: "move", expectedVersion: joined.room.version, from: "e7", to: "e5" }));
    assert.match((await wrongTurn).message, /not your turn/);

    const hostMove = nextMessage(host, message => message.type === "state" && message.room.moves.length === 1);
    const guestMove = nextMessage(guest, message => message.type === "state" && message.room.moves.length === 1);
    host.send(JSON.stringify({ type: "move", expectedVersion: joined.room.version, from: "e2", to: "e4" }));
    const [hostAfterMove, guestAfterMove] = await Promise.all([hostMove, guestMove]);
    assert.equal(hostAfterMove.room.fen, guestAfterMove.room.fen);
    assert.equal(hostAfterMove.room.moves[0].san, "e4");
    assert.equal(hostAfterMove.room.turn, "b");
    assert.ok(hostAfterMove.room.clocks.w < 300000);
    assert.ok(hostAfterMove.room.clocks.b <= 300000 && hostAfterMove.room.clocks.b > 290000);

    const staleMove = nextMessage(guest, message => message.type === "error");
    guest.send(JSON.stringify({ type: "move", expectedVersion: joined.room.version, from: "e7", to: "e5" }));
    assert.match((await staleMove).message, /game changed/);

    const guestResigned = nextMessage(host, message => message.type === "state" && Boolean(message.room.result));
    guest.send(JSON.stringify({ type: "resign" }));
    const finished = await guestResigned;
    assert.equal(finished.room.result, "White wins by resignation");

    await new Promise(resolve => {
      if (host.readyState === WebSocket.CLOSED) return resolve();
      host.once("close", resolve);
      host.close();
    });
    const reconnectedHost = await connect();
    const resumedPromise = nextMessage(reconnectedHost, message => message.type === "resumed");
    reconnectedHost.send(JSON.stringify({ type: "resume", code: created.room.code, token: created.token }));
    const resumed = await resumedPromise;
    assert.equal(resumed.color, "w");
    assert.equal(resumed.room.result, finished.room.result);
    assert.equal(resumed.room.moves.length, 1);
  });

  test("self-hosted server ends a timed game authoritatively", async t => {
    const url = await startChessServer(t);
    const host = await openWebSocket(url);
    const guest = await openWebSocket(url);
    t.after(() => { host.close(); guest.close(); });
    const createdPromise = nextMessage(host, message => message.type === "created");
    host.send(JSON.stringify({ type: "create", name: "Host", timeControlSeconds: 1 }));
    const created = await createdPromise;
    const joinedPromise = nextMessage(guest, message => message.type === "joined");
    guest.send(JSON.stringify({ type: "join", code: created.room.code, name: "Guest" }));
    await joinedPromise;
    const timeout = await nextMessage(host, message => message.type === "state" && Boolean(message.room.result), 4000);
    assert.equal(timeout.room.result, "Black wins by timeout");
    assert.equal(timeout.room.clocks.w, 0);
    assert.equal(timeout.room.clocks.b, 1000);
  });

test("self-hosted room joins serialize concurrent guests and recover after abrupt disconnect", async t => {
  const url = await startChessServer(t);
  const open = async () => {
    const socket = await openWebSocket(url);
    t.after(() => socket.close());
    return socket;
  };
  const host = await open();
  const createdPromise = nextMessage(host, message => message.type === "created");
  host.send(JSON.stringify({ type: "create", name: "Host", timeControlSeconds: 0 }));
  const created = await createdPromise;
  const firstGuest = await open();
  const secondGuest = await open();
  const firstResultPromise = nextMessage(firstGuest, message => message.type === "joined" || message.type === "error");
  const secondResultPromise = nextMessage(secondGuest, message => message.type === "joined" || message.type === "error");
  firstGuest.send(JSON.stringify({ type: "join", code: created.room.code, name: "First guest" }));
  secondGuest.send(JSON.stringify({ type: "join", code: created.room.code, name: "Second guest" }));
  const results = await Promise.all([firstResultPromise, secondResultPromise]);
  const joinedIndex = results.findIndex(message => message.type === "joined");
  assert.notEqual(joinedIndex, -1);
  const joined = results[joinedIndex];
  assert.equal(results[1 - joinedIndex].type, "error");
  assert.equal(joined.color, "b");

  const guestSocket = joinedIndex === 0 ? firstGuest : secondGuest;
  const disconnectedPromise = nextMessage(host, message =>
    message.type === "state" && !message.room.players.find(player => player.color === "b").connected
  );
  guestSocket.terminate();
  await disconnectedPromise;

  const reconnect = await open();
  const resumedPromise = nextMessage(reconnect, message => message.type === "resumed");
  reconnect.send(JSON.stringify({ type: "resume", code: created.room.code, token: joined.token }));
  const resumed = await resumedPromise;
  assert.equal(resumed.color, "b");
  assert.equal(resumed.room.status, "playing");
});

test("self-hosted games synchronize en passant, castling, and promotion", async t => {
  const url = await startChessServer(t);
  const host = await openWebSocket(url);
  const guest = await openWebSocket(url);
  t.after(() => { host.close(); guest.close(); });
  const createdPromise = nextMessage(host, message => message.type === "created");
  host.send(JSON.stringify({ type: "create", name: "Host", timeControlSeconds: 0 }));
  const created = await createdPromise;
  const joinedPromise = nextMessage(guest, message => message.type === "joined");
  guest.send(JSON.stringify({ type: "join", code: created.room.code, name: "Guest" }));
  const joined = await joinedPromise;

  let version = joined.room.version;
  let room = joined.room;
  const play = async (color, from, to, promotion) => {
    const sender = color === "w" ? host : guest;
    const hostState = nextMessage(host, message => message.type === "state" && message.room.version === version + 1);
    const guestState = nextMessage(guest, message => message.type === "state" && message.room.version === version + 1);
    sender.send(JSON.stringify({ type: "move", expectedVersion: version, from, to, ...(promotion ? { promotion } : {}) }));
    const [whiteView, blackView] = await Promise.all([hostState, guestState]);
    assert.equal(whiteView.room.fen, blackView.room.fen);
    room = whiteView.room;
    version = room.version;
  };

  for (const [color, from, to] of [
    ["w", "e2", "e4"], ["b", "a7", "a6"],
    ["w", "e4", "e5"], ["b", "d7", "d5"],
    ["w", "e5", "d6"], ["b", "c7", "d6"],
    ["w", "g1", "f3"], ["b", "b8", "c6"],
    ["w", "f1", "c4"], ["b", "g8", "f6"],
    ["w", "e1", "g1"]
  ]) await play(color, from, to);
  assert.equal(room.moves[4].san, "exd6");
  assert.equal(room.moves.at(-1).san, "O-O");
  assert.match(room.fen, / b kq - /);

  const promotionHost = await openWebSocket(url);
  const promotionGuest = await openWebSocket(url);
  t.after(() => { promotionHost.close(); promotionGuest.close(); });
  const promotionCreatedPromise = nextMessage(promotionHost, message => message.type === "created");
  promotionHost.send(JSON.stringify({ type: "create", name: "Host", timeControlSeconds: 0 }));
  const promotionCreated = await promotionCreatedPromise;
  const promotionJoinedPromise = nextMessage(promotionGuest, message => message.type === "joined");
  promotionGuest.send(JSON.stringify({ type: "join", code: promotionCreated.room.code, name: "Guest" }));
  const promotionJoined = await promotionJoinedPromise;
  let promotionVersion = promotionJoined.room.version;
  let promotionRoom;
  for (const [color, from, to, promotion] of [
    ["w", "a2", "a4"], ["b", "h7", "h5"],
    ["w", "a4", "a5"], ["b", "h5", "h4"],
    ["w", "a5", "a6"], ["b", "h4", "h3"],
    ["w", "a6", "b7"], ["b", "h3", "g2"],
    ["w", "b7", "a8", "q"]
  ]) {
    const sender = color === "w" ? promotionHost : promotionGuest;
    const snapshotPromise = nextMessage(promotionHost, message => message.type === "state" && message.room.version === promotionVersion + 1);
    sender.send(JSON.stringify({ type: "move", expectedVersion: promotionVersion, from, to, ...(promotion ? { promotion } : {}) }));
    promotionRoom = (await snapshotPromise).room;
    promotionVersion = promotionRoom.version;
  }
  assert.equal(promotionRoom.moves.at(-1).promotion, "q");
  assert.match(promotionRoom.moves.at(-1).san, /Q/);
  assert.match(promotionRoom.fen, /^Qn/);
});

test("self-hosted server accepts only one copy of a raced move", async t => {
  const url = await startChessServer(t);
  const host = await openWebSocket(url);
  const guest = await openWebSocket(url);
  t.after(() => { host.close(); guest.close(); });
  const createdPromise = nextMessage(host, message => message.type === "created");
  host.send(JSON.stringify({ type: "create", name: "Host", timeControlSeconds: 0 }));
  const created = await createdPromise;
  const joinedPromise = nextMessage(guest, message => message.type === "joined");
  guest.send(JSON.stringify({ type: "join", code: created.room.code, name: "Guest" }));
  const joined = await joinedPromise;
  const updatePromise = nextMessage(guest, message => message.type === "state" && message.room.moves.length === 1);
  const rejectionPromise = nextMessage(host, message => message.type === "error");
  const move = JSON.stringify({ type: "move", expectedVersion: joined.room.version, from: "e2", to: "e4" });
  host.send(move);
  host.send(move);
  const update = await updatePromise;
  assert.equal(update.room.moves.length, 1);
  assert.match((await rejectionPromise).message, /not your turn|game changed/);
});

test("self-hosted server sends WebSocket heartbeats", async t => {
  const url = await startChessServer(t, { heartbeatIntervalMs: 1000 });
  const socket = await openWebSocket(url);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server heartbeat was not received.")), 3000);
    socket.once("ping", () => { clearTimeout(timer); resolve(); });
  });
});

test("self-hosted server synchronizes checkmate and closes the result", async t => {
  const url = await startChessServer(t);
  const host = await openWebSocket(url);
  const guest = await openWebSocket(url);
  t.after(() => { host.close(); guest.close(); });
  const createdPromise = nextMessage(host, message => message.type === "created");
  host.send(JSON.stringify({ type: "create", name: "Host", timeControlSeconds: 0 }));
  const created = await createdPromise;
  const joinedPromise = nextMessage(guest, message => message.type === "joined");
  guest.send(JSON.stringify({ type: "join", code: created.room.code, name: "Guest" }));
  let room = (await joinedPromise).room;
  for (const [player, from, to] of [
    [host, "f2", "f3"], [guest, "e7", "e5"],
    [host, "g2", "g4"], [guest, "d8", "h4"]
  ]) {
    const updatePromise = nextMessage(host, message => message.type === "state" && message.room.moves.length === room.moves.length + 1);
    player.send(JSON.stringify({ type: "move", expectedVersion: room.version, from, to }));
    room = (await updatePromise).room;
  }
  assert.equal(room.status, "finished");
  assert.equal(room.result, "Black wins by checkmate");
  assert.equal(room.moves.at(-1).san, "Qh4#");
});