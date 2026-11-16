import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Classroom and achievements remain reachable through explicit navigation", async () => {
  const [html, css] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../nightfall-redesign.css", import.meta.url), "utf8")
  ]);

  assert.match(html, /id="classroomTop"[^>]*>[^<]*Classroom/);
  assert.match(html, /classroomTop"\)\.addEventListener\("click",openClassroom\)/);
  assert.match(html, /data-lobby-page="achievements">Achievements<\/button>/);
  assert.match(html, /id="showAchievementDetails"[^>]*>View all achievements<\/button>/);
  assert.match(html, /showAchievementDetails"\)\.addEventListener\("click",openAchievementDetails\)/);
  assert.match(html, /!?\["play","puzzles","progress","achievements"\]\.includes\(page\)/);
  assert.ok(css.includes('#lobby[data-page="achievements"] .lobby-dashboard > :not(.profile-stats):not(#journeyCard) { display: none;'));
});

test("application startup does not call an undefined audio-preferences loader", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /loadAudioPreferencesFromArchive/);

  const startAt = html.indexOf("function startGame() {");
  const endAt = html.indexOf("function undo() {", startAt);
  const startGame = startAt >= 0 && endAt > startAt ? html.slice(startAt, endAt) : "";
  assert.ok(startGame, "Could not locate startGame");
  assert.doesNotMatch(startGame, /loadRecentGames|loadProfileStats|registerOfflineSupport|loadMusicSettings/);
  assert.match(startGame, /if\(mode==="ai"\)void ensureStockfish\(\)/);
  assert.match(startGame, /playEventSound\("gameStart"\)/);
});
