import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

test("procedural sound patterns cover game, interface, and achievement events", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const match = html.match(/const soundPatterns=(\{[\s\S]*?\n      \});\n      function playEventSound/);
  assert.ok(match, "the event-pattern table should be present");
  const patterns = runInNewContext(`(${match[1]})`);
  const requiredEvents = [
    "move", "capture", "captureCheck", "check", "checkmate", "castle", "promotion",
    "illegal", "gameStart", "victory", "defeat", "draw", "resignation", "bestMove",
    "brilliant", "mistake", "blunder", "puzzleSuccess", "puzzleFailure", "buttonClick",
    "menuOpen", "menuClose", "dropdown", "notification", "achievement"
  ];

  for (const event of requiredEvents) assert.ok(patterns[event], `missing ${event} sound`);
  for (const pattern of Object.values(patterns)) {
    assert.ok(["game", "interface", "achievement"].includes(pattern.channel));
    assert.ok(pattern.notes.length > 0);
    for (const [frequency, duration, waveform, volume, delay] of pattern.notes) {
      assert.ok(frequency > 0 && duration > 0 && volume > 0 && volume <= 1 && delay >= 0);
      assert.ok(["sine", "triangle", "square", "sawtooth"].includes(waveform));
    }
  }
  for (const id of ["effectsVolume", "uiSoundVolume", "achievementVolume", "achievementSoundsToggle"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /savePreference\("audio"/);
  assert.match(html, /playEventSound\(preview\.dataset\.soundPreview,true\)/);
});
