import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("self-hosted server serves the site and exposes a health check", async t => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.mjs", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: "ignore"
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });

  const base = `http://127.0.0.1:${port}`;
  let response;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      response = await fetch(`${base}/api/health`);
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  assert.ok(response, "server should start and answer HTTP requests");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "nightfall-chess",
    sitePath: "/",
    websocketPath: "/ws/online"
  });

  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>شطرنج شبانه<\/title>/);
});
