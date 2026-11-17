import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("online room-code copying is available to room creation and match controls", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /async function copyRoomCode\(\) \{[\s\S]*?\n      \}\s+async function ensureOnlineApi\(\) \{/);
  assert.match(html, /await copyRoomCode\(\);/);
  assert.match(html, /copyMatchRoomCodeButton"\)\.addEventListener\("click",\(\)=>\{void copyRoomCode\(\);\}\)/);
});

test("online matches block local engine assistance and local new-game controls", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /async function showMoveAssistance\(kind\) \{\s*if\(mode==="online"\|\|/);
  assert.match(html, /hintButton"\)\.hidden=mode==="online"/);
  assert.match(html, /suggestButton"\)\.hidden=mode==="online"/);
  assert.match(html, /newGameCard"\)\.hidden=mode==="online"\|\|!gameOver/);
  assert.match(html, /newGameTop"\)\.hidden=mode==="online"\|\|!gameOver/);
  assert.match(html, /function startGame\(\) \{\s*if\(mode==="online"\)/);
});

test("the requested footer copy and Persian translations are present", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.includes("<span>Online fixes</span>"));
  assert.ok(html.includes("<span>Created by Love 😇</span>"));
  assert.ok(html.includes("<span>All copyrights belongs to Orbit Studios. ©️</span>"));
  assert.ok(html.includes('"Online fixes":"بهبودهای آنلاین"'));
});
