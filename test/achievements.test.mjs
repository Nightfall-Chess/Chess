import assert from "node:assert/strict";
import { test } from "node:test";
import { getAchievementProgress } from "../achievements.mjs";

test("achievement tiers use completed game, learning, and reviewed-analysis data", () => {
  const games = Array.from({ length: 10 }, (_, index) => ({
    outcome: index < 5 ? "win" : "draw",
    resultText: index < 2 ? "Checkmate" : "Draw",
    entries: [{
      move: { castle: index === 0 ? "k" : undefined, promoteTo: index === 1 ? "q" : undefined },
      analysis: { label: index === 0 ? "Brilliant" : "Good" }
    }]
  }));
  const progress = getAchievementProgress({
    games,
    profile: { puzzlesSolved: 10, bestWinStreak: 5, bestDailyStreak: 7 },
    completedLessons: 5
  });
  const byId = Object.fromEntries(progress.map(item => [item.id, item]));

  assert.equal(byId.games.level, 2);
  assert.equal(byId.wins.level, 2);
  assert.equal(byId.checkmates.value, 2);
  assert.equal(byId.streak.level, 2);
  assert.equal(byId.puzzles.level, 2);
  assert.equal(byId.lessons.level, 2);
  assert.equal(byId.castling.value, 1);
  assert.equal(byId.promotion.value, 1);
  assert.equal(byId.brilliant.value, 1);
  assert.equal(byId.reviews.value, 10);
  assert.equal(byId.daily.level, 2);
});

test("achievement progress safely handles absent or incomplete records", () => {
  const progress = getAchievementProgress({ games: [] });
  assert.ok(progress.every(item => item.value === 0 && item.level === 0 && item.progress === 0));
});
