export function buildOpeningIndexes(entries) {
  const positions = new Map();
  const movesByPrefix = new Map();

  for (const entry of entries) {
    const records = positions.get(entry.p) || [];
    records.push(entry);
    positions.set(entry.p, records);

    for (let ply = 0; ply < entry.m.length; ply++) {
      const prefix = entry.m.slice(0, ply).join(" ");
      let candidates = movesByPrefix.get(prefix);
      if (!candidates) {
        candidates = new Map();
        movesByPrefix.set(prefix, candidates);
      }
      const move = entry.m[ply];
      candidates.set(move, (candidates.get(move) || 0) + 1);
    }
  }

  return { positions, movesByPrefix };
}

export function recognizeOpeningPosition(positions, key, ply) {
  const candidates = positions.get(key) || [];
  return candidates
    .filter(entry => entry.m.length <= ply)
    .sort((a, b) => (ply - a.m.length) - (ply - b.m.length)
      || a.e.localeCompare(b.e)
      || a.n.localeCompare(b.n))[0] || null;
}

export function isBookMove(movesByPrefix, prefix, move) {
  return movesByPrefix.get(prefix.join(" "))?.has(move) === true;
}

export function bookMoveCandidates(movesByPrefix, prefix) {
  return movesByPrefix.get(prefix.join(" ")) || new Map();
}
