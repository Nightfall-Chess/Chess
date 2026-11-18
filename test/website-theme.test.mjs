import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, themes, worker] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../nightfall-themes.css", import.meta.url), "utf8"),
  readFile(new URL("../service-worker.js", import.meta.url), "utf8")
]);

test("website themes live in their own Settings section", () => {
  assert.match(html, /data-settings-panel="themes"/);
  assert.match(html, /data-settings-content="themes"/);
  const themesStart = html.indexOf('data-settings-content="themes"');
  const themesEnd = html.indexOf("</section>", themesStart);
  assert.ok(themesStart >= 0 && themesEnd > themesStart);
  assert.ok(html.slice(themesStart, themesEnd).includes('id="siteThemeOptions"'));

  const appearanceStart = html.indexOf('data-settings-content="appearance"');
  const appearanceEnd = html.indexOf("</section>", appearanceStart);
  assert.ok(appearanceStart >= 0 && appearanceEnd > appearanceStart);
  assert.ok(!html.slice(appearanceStart, appearanceEnd).includes('id="siteThemeOptions"'));
  assert.ok(html.includes('id="boardThemeOptions"'));
  assert.ok(html.includes('id="pieceThemeOptions"'));
});

test("all six complete website themes have centralized design tokens", () => {
  for (const theme of ["default", "night-sky", "midnight", "royal", "emerald", "aurora"]) {
    assert.ok(html.includes(theme), `index.html is missing theme ${theme}`);
    assert.ok(themes.includes(`html[data-theme="${theme}"]`), `theme stylesheet is missing ${theme}`);
  }
  for (const token of [
    "--theme-bg", "--theme-panel", "--theme-panel-raised", "--theme-line",
    "--theme-text", "--theme-muted", "--theme-accent", "--theme-secondary",
    "--theme-gold", "--theme-shadow", "--theme-backdrop", "--theme-card-gradient",
    "--theme-hero-gradient", "--theme-button-gradient", "--theme-focus"
  ]) assert.ok(themes.includes(token), `missing design token ${token}`);
});

test("the final theme stylesheet loads after other visual effects and is precached", () => {
  const themeLink = html.indexOf('href="./nightfall-themes.css?v=4"');
  const orbitLink = html.indexOf('href="./orbit-enhancements.css?v=1"');
  assert.ok(themeLink > orbitLink, "theme layer must load after Orbit's optional hover effects");
  assert.match(worker, /nightfall-v39/);
  assert.ok(worker.includes('"./nightfall-themes.css?v=4"'));
});

test("visual theme styles cover game, training, analysis, classroom and dialog surfaces", () => {
  for (const selector of [
    ".lobby-hero", ".home-shortcut", ".settings-nav", ".settings-panel",
    ".board-frame", ".board-status", ".online-card", ".lesson-content",
    ".puzzle-area", ".analysis-dialog", ".classroom-chat-card",
    ".achievement-island", ".music-island", ".site-theme-option"
  ]) assert.ok(themes.includes(selector), `missing visual coverage for ${selector}`);
});
