import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { WebSocket } from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));

async function startChessServer(t) {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  await once(probe, "close");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(address.port) },
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