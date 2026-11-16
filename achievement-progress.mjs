export function advanceAchievementProgress(definitions, progress, createTimestamp = () => new Date().toISOString()) {
  if (!Array.isArray(definitions) || !progress || typeof progress !== "object" || Array.isArray(progress)) {
    throw new TypeError("Achievement definitions and progress are required.");
  }

  const updated = { ...progress };
  const notifications = [];
  let changed = false;

  for (const definition of definitions) {
    if (typeof definition.key !== "string" || !Number.isSafeInteger(definition.value)
      || definition.value < 0 || !Array.isArray(definition.stages)) {
      throw new TypeError("Achievement definition is invalid.");
    }
    const previous = progress[definition.key] || { level: 0, earnedAt: [] };
    const level = definition.stages.reduce((count, stage) => definition.value >= stage[0] ? count + 1 : count, 0);
    if (level <= previous.level) continue;

    const earnedAt = [...previous.earnedAt];
    for (let index = previous.level; index < level; index++) {
      earnedAt[index] = createTimestamp();
      notifications.push({ key: definition.key, level: index + 1, title: definition.stages[index][1], titleFa: definition.stages[index][2] });
    }
    updated[definition.key] = { level, earnedAt };
    changed = true;
  }

  return { progress: updated, notifications, changed };
}
