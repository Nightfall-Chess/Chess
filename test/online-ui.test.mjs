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

test("removed footer labels stay removed while the remaining creator credit is preserved", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(html.includes("<span>Online fixes</span>"), false);
  assert.equal(html.includes("<span>All copyrights belongs to Orbit Studios. ©️</span>"), false);
  assert.ok(html.includes("<span>Created by Love 😇</span>"));
  assert.equal(html.includes('"Online fixes":"بهبودهای آنلاین"'), false);
});


test("online opening badges update in place without rebuilding player cards on clock ticks", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /const stableMarkup=markup[\s\S]*?container\.dataset\.playerMarkup!==stableMarkup/);
  assert.match(html, /const openingNode=container\.querySelector\("\.player-opening"\)/);
  assert.match(html, /openingNode\.textContent!==nextLabel\)openingNode\.textContent=nextLabel/);
  assert.match(html, /class="player-opening"[^>]* hidden><\/div>/);
});

test("chat input and messages preserve automatic mixed Persian and English direction", async () => {
  const [chat, css] = await Promise.all([
    readFile(new URL("../orbit-chat.js", import.meta.url), "utf8"),
    readFile(new URL("../orbit-chat.css", import.meta.url), "utf8")
  ]);
  assert.match(chat, /id="ncInput" dir="auto"/);
  assert.match(chat, /class="nc-tx" dir="auto"/);
  assert.doesNotMatch(chat, /input\.scrollLeft\s*=\s*(?:0|input\.scrollWidth)/);
  assert.match(css, /#ncChatDock \.nc-form input#ncInput[\s\S]*?overflow-x:auto/);
  assert.match(css, /#ncChatDock \.nc-msg \.nc-tx[\s\S]*?unicode-bidi:plaintext/);
});

test("online chessboard orientation follows the player's assigned color", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /humanColor=ownColor;orientation=ownColor;onlineMyColor=ownColor/);
});
