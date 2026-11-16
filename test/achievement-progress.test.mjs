import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceAchievementProgress } from "../achievement-progress.mjs";

test("achievement tiers persist dates once and queue only newly reached milestones", () => {
  const stages = [[1, "First win", "نخستین برد"], [5, "Five wins", "پنج برد"], [10, "Ten wins", "ده برد"]];
  const definition = { key: "wins", value: 6, stages };
  let timestamp = 0;
  const first = advanceAchievementProgress([definition], {}, () => `2026-01-0${++timestamp}T00:00:00.000Z`);

  assert.equal(first.changed, true);
  assert.equal(first.progress.wins.level, 2);
  assert.equal(first.progress.wins.earnedAt.length, 2);
  assert.deepEqual(first.notifications.map(item => item.title), ["First win", "Five wins"]);

  const unchanged = advanceAchievementProgress([definition], first.progress);
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.notifications, []);

  const next = advanceAchievementProgress([{ ...definition, value: 10 }], unchanged.progress);
  assert.equal(next.progress.wins.level, 3);
  assert.equal(next.progress.wins.earnedAt.length, 3);
  assert.deepEqual(next.notifications.map(item => item.level), [3]);
});
