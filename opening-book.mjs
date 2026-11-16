export function openingsAtPosition(records, ply) {
  if (!Array.isArray(records) || !Number.isSafeInteger(ply) || ply < 1) return [];
  return records.filter(record => record && Array.isArray(record.m) && record.m.length === ply);
}

export function isBookPositionMove(records, ply) {
  return openingsAtPosition(records, ply + 1).length > 0;
}
