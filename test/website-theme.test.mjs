import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, themes, visual, worker, redesign, contrast] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../nightfall-themes.css", import.meta.url), "utf8"),
  readFile(new URL("../nightfall-visual-system.css", import.meta.url), "utf8"),
  readFile(new URL("../service-worker.js", import.meta.url), "utf8"),
  readFile(new URL("../nightfall-redesign.css", import.meta.url), "utf8"),
  readFile(new URL("../nightfall-theme-contrast.css", import.meta.url), "utf8")
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
  const themeLink = html.indexOf('href="./nightfall-themes.css?v=5"');
  const visualLink = html.indexOf('href="./nightfall-visual-system.css?v=1"');
  const orbitLink = html.indexOf('href="./orbit-enhancements.css?v=1"');
  assert.ok(themeLink > orbitLink, "theme tokens must load after Orbit effects");
  assert.ok(visualLink > themeLink, "visual system must load after theme tokens");
  assert.match(worker, /const CACHE_VERSION = "nightfall-v\\d+"/);
  assert.ok(worker.includes('"./nightfall-themes.css?v=5"'));
  assert.ok(worker.includes('"./nightfall-visual-system.css?v=1"'));
  assert.ok(worker.includes('"./nightfall-theme-contrast.css?v=5"'));
  assert.ok(html.includes('href="./nightfall-theme-contrast.css?v=5"'));
  assert.ok(worker.includes('"./assets/nightfall-king-mask.svg"'));
  assert.ok(html.includes('class="hero-king-art"'));
  assert.ok(visual.includes('#gameScreen.layout'));
  assert.ok(visual.includes('#lobby[data-page=play] .lobby-dashboard'));
  assert.ok(!redesign.includes('#lobby[data-page="play"] .lobby-dashboard > :not(.profile-stats)'));
});

test("tablet settings navigation and secondary copy stay readable", () => {
  assert.match(contrast, /\.settings-head p/);
  assert.match(contrast, /\.header-actions \.classroom-nav-button/);
  assert.match(contrast, /@media \(max-width: 1100px\)/);
  assert.match(contrast, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(contrast, /overflow-x: auto/);
});

test("sound controls are grouped into responsive, accessible channels", () => {
  const audioStart = html.indexOf('data-settings-content="audio"');
  const audioEnd = html.indexOf('data-settings-content="language"', audioStart);
  const audioPanel = html.slice(audioStart, audioEnd);
  assert.equal((audioPanel.match(/class="audio-channel-card/g) || []).length, 4);
  for (const id of ["musicToggle", "musicTrack", "musicVolume", "effectsToggle", "gameVolume", "uiSoundsToggle", "uiVolume", "achievementVolume", "masterMuteToggle", "previewSoundButton"]) {
    assert.ok(audioPanel.includes(`id="${id}"`), `sound settings are missing ${id}`);
  }
  assert.match(contrast, /\.audio-settings-grid\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(contrast, /@media \(max-width: 700px\)/);
});

test("visual theme styles cover game, training, analysis, classroom and dialog surfaces", () => {
  for (const selector of [
    ".lobby-hero", ".home-shortcut", ".settings-nav", ".settings-panel",
    ".board-frame", ".board-status", ".online-card", ".lesson-content",
    ".puzzle-area", ".analysis-dialog", ".classroom-chat-card",
    ".achievement-island", ".music-island", ".site-theme-option"
  ]) assert.ok(themes.includes(selector), `missing visual coverage for ${selector}`);
});
