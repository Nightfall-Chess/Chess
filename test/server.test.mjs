import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

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