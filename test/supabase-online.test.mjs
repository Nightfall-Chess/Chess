import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Supabase room creation, joining, and resignation use transactional server functions", async () => {
  const [migration, edgeFunction] = await Promise.all([
    readFile(new URL("../supabase/migrations/20261117170000_repair_online_room_transactions.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/functions/online/index.ts", import.meta.url), "utf8")
  ]);
  for (const action of ["online_create_room", "online_join_room", "online_resign_room", "online_commit_move"]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${action}\\(`, "i"));
    assert.match(edgeFunction, new RegExp(`db\\.rpc\\("${action}"`));
  }
  assert.match(migration, /where id = p_room_id\s+for update/i);
  assert.match(migration, /version = version \+ 1/i);
  assert.match(migration, /v_room\.status <> 'waiting'/i);
  assert.match(edgeFunction, /db\.rpc\("online_commit_move"/);
  assert.match(migration, /set status = 'finished'/i);
});
