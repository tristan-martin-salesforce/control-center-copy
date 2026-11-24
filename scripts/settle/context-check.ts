/**
 * Settle context check (no model calls): for items in the private answer key, does the context pack include the
 * message or event that decided the item? Prints ids, hits and pack sizes only.
 *
 *   npx tsx scripts/settle/context-check.ts <ids file>     # ids, one per line (first column)
 */
import { sql } from 'drizzle-orm';
import fs from 'node:fs';
import { inStateDir } from '../../src/lib/state-folder';
import { createDb, resolveDatabaseUrl } from '../../src/db/client';
import { buildSettleContext } from '../../src/engines/settle/context';
import { loadSettleRaw, loadSettleUser } from '../../src/engines/settle/load-db';
const SK = inStateDir('stress', 'settle-key');
const key = new Map<string, { item_id: string; deciding_source_item_id?: string | null }>();
for (const f of fs.readdirSync(SK + '/key')) for (const l of fs.readFileSync(SK + '/key/' + f, 'utf8').split('\n')) if (l.trim()) { const r = JSON.parse(l); key.set(r.item_id, r); }
const ids = fs.readFileSync(process.argv[2]!, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
const h = createDb({ url: resolveDatabaseUrl(), max: 2, applicationName: "command-center-settle-context-check" });
const u = await loadSettleUser(h.db);
let hit = 0, n = 0;
for (const id of ids) {
  const k = key.get(id); if (!k) continue;
  const raw = await loadSettleRaw(h.db, u.userId, id, { now: new Date() });
  if (!raw) continue;
  const c = buildSettleContext(raw, { now: new Date(), timezone: u.timezone, me: u.me });
  const src = new Set([c.ask?.sourceItemId, ...[...c.before, ...c.after, ...c.elsewhere].map((l) => l.sourceItemId)]);
  const evs = c.events.map((e) => e.calendarEventId);
  const d = k.deciding_source_item_id;
  let inCtx = d ? src.has(d) : false;
  // calendar deciding sources: match the calendar_events row by source_item_id
  if (!inCtx && d) { const r = await h.db.execute(sql`select id::text as id from calendar_events where source_item_id = ${d}::uuid`); const ce = (r.rows[0] as { id?: string } | undefined)?.id; if (ce && evs.includes(ce)) inCtx = true; }
  n++; if (inCtx) hit++;
  console.log(id.slice(0, 8), inCtx ? 'IN' : 'miss', `after=${c.after.length} omitted=${c.hints.omittedAfter} else=${c.elsewhere.length} ev=${c.events.length}`);
}
console.log({ hit, n });
await h.close();
