/**
 * Score a rescanned database against the private answer key. Item ids change on a rescan, so key items map onto new
 * items by their origin messages (source external ids). Reads only; prints counts and short ids, no titles.
 *
 *   npx tsx scripts/settle/score-rescan.ts [--detail <file.md>]
 *
 * For every key item (not unsure): was it created again, and where did it end up?
 *   closed for you · closed (other) · live (open / in progress / waiting) · Triage (suggested) · Looks done · gone
 * Buckets as in score.ts: owed (still_yours), ask (gone_quiet), settled (the rest).
 */
import fs from 'node:fs';
import path from 'node:path';
import { inStateDir } from '../../src/lib/state-folder';

import { sql } from 'drizzle-orm';

import { createDb, resolveDatabaseUrl } from '../../src/db/client';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const SK = inStateDir('stress', 'settle-key');
const readJsonl = <T>(f: string): T[] =>
  fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

interface KeyRow {
  item_id: string;
  verdict: string;
  confidence: string;
}
interface OldItem {
  item_id: string;
  title: string;
  origins: Array<{ external_id: string; source: string }>;
}
const bucket = (v: string) => (v === 'still_yours' ? 'owed' : v === 'gone_quiet' ? 'ask' : 'settled');

const key = new Map<string, KeyRow>();
for (const f of fs.readdirSync(path.join(SK, 'key')).filter((f) => f.endsWith('.jsonl'))) for (const r of readJsonl<KeyRow>(path.join(SK, 'key', f))) key.set(r.item_id, r);
const old = readJsonl<OldItem>(path.join(SK, 'items.jsonl'));

const handle = createDb({ url: resolveDatabaseUrl(), max: 2, applicationName: 'settle-score-rescan' });
try {
  const rows = (
    await handle.db.execute<{ id: string; status: string; done_by: string | null; ext: string; created_at: string }>(sql`
      select w.id::text as id, w.status::text as status, w.done_by::text as done_by, s.source::text || ':' || s.external_id as ext, w.created_at::text as created_at
        from work_items w join work_item_evidence e on e.work_item_id = w.id and e.role = 'origin' join source_items s on s.id = e.source_item_id`)
  ).rows;
  const byExt = new Map<string, Set<string>>();
  const items = new Map<string, { status: string; doneBy: string | null }>();
  for (const r of rows) {
    byExt.set(r.ext, (byExt.get(r.ext) ?? new Set()).add(r.id));
    items.set(r.id, { status: r.status, doneBy: r.done_by });
  }
  const allItems = (await handle.db.execute<{ id: string; status: string; done_by: string | null }>(sql`select id::text as id, status::text as status, done_by::text as done_by from work_items`)).rows;
  for (const r of allItems) if (!items.has(r.id)) items.set(r.id, { status: r.status, doneBy: r.done_by });

  const place = (s: { status: string; doneBy: string | null }) =>
    s.status === 'done' ? (s.doneBy === 'engine' ? 'closed_for_you' : 'closed_other') : s.status === 'dismissed' || s.status === 'merged' ? 'closed_other' : s.status === 'suggested' ? 'triage' : s.status === 'likely_done' ? 'looks_done' : 'live';
  const tally: Record<string, Record<string, number>> = {};
  const mapped = new Set<string>();
  const wrong: string[] = [];
  for (const o of old) {
    const k = key.get(o.item_id);
    if (!k || k.confidence === 'unsure') continue;
    const hits = new Set<string>();
    for (const og of o.origins ?? []) for (const id of byExt.get(`${og.source}:${og.external_id}`) ?? []) hits.add(id);
    const b = bucket(k.verdict);
    let where = 'not_created';
    if (hits.size) {
      // several new items from the same origin: the "best" outcome counts (a closed one, else live)
      const places = [...hits].map((id) => place(items.get(id)!));
      where = places.includes('live') ? 'live' : places.includes('triage') ? 'triage' : places.includes('looks_done') ? 'looks_done' : places.includes('closed_for_you') ? 'closed_for_you' : 'closed_other';
      for (const id of hits) mapped.add(id);
    }
    tally[b] ??= {};
    tally[b][where] = (tally[b][where] ?? 0) + 1;
    if (b === 'owed' && (where === 'closed_for_you' || where === 'closed_other')) wrong.push(o.item_id.slice(0, 8));
  }
  const unmappedNew: Record<string, number> = {};
  for (const [id, s] of items) if (!mapped.has(id)) unmappedNew[place(s)] = (unmappedNew[place(s)] ?? 0) + 1;
  const settled = tally.settled ?? {};
  const owed = tally.owed ?? {};
  const liveMapped = (settled.live ?? 0) + (owed.live ?? 0) + (tally.ask?.live ?? 0);
  console.log(
    JSON.stringify(
      {
        keyItemsByOutcome: tally,
        wrongCloses: wrong,
        clicksOnKnownItems: (settled.live ?? 0) + (settled.triage ?? 0) + (settled.looks_done ?? 0),
        liveListKnownPrecision: liveMapped ? `${owed.live ?? 0}/${liveMapped}` : null,
        newItemsNotInKey: unmappedNew,
        totalItems: items.size,
      },
      null,
      2,
    ),
  );
  if (opt('detail')) fs.writeFileSync(opt('detail')!, JSON.stringify({ tally, wrong, unmappedNew }, null, 2), { mode: 0o600 });
} finally {
  await handle.close();
}
