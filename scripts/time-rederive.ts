/**
 * Re-derive the Time rows of a date range with the current engine (2026-11-14: engaged time, no caps, internal
 * meetings logged, Travel buffers 120 / 60 min).
 *
 *   npm run time:rederive -- --from 2026-11-01 [--to 2026-11-14] [--transcripts] [--json] [--apply]
 *
 * Default: a dry run, read-only (one READ ONLY transaction): per day the hours before and after, the rows that would be
 * added, changed or removed, and the update candidates (rows already in Org62 whose hours would change: never edited
 * in place; the landings model carries them to the next canvas, D-70).
 *
 * --transcripts  sessions whose item has no prompt times yet (the scanner re-reads them once) take them from the local
 *                Claude transcripts (~/.claude/projects), read-only.
 * --engaged '<json>'  try other engaged-time parameters in the dry run (calibration; e.g. '{"gapMin":15}'): never
 *                with --apply, which uses the calibrated defaults (src/engines/activity/engaged.ts).
 * --apply        after the dry run, the same week pass the worker runs, over these days: it rewrites only the rows the
 *                projections own (never the user's: approved, edited, on a canvas, in Org62). Never against a database
 *                you have not backed up.
 *
 * Uses DATABASE_URL (default postgres://localhost:5432/command_center) and prints the database name, never the URL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';

import { turnsOfTranscript } from '../src/connectors/claude/transcript';
import type { EngagedParams } from '../src/engines/activity/engaged';
import { createDb, databaseName, resolveDatabaseUrl } from '../src/db/client';
import { recomputeWeeks, rederiveWeeks, type RederiveReport } from '../src/projections/run';
import { DbDataSource } from '../src/server/datasource/db';
import { projectionStore } from '../src/server/datasource/db/store/projections.run';

const arg = (name: string): string | undefined => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
};
const has = (name: string) => process.argv.slice(2).includes(name);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** sessionExternalId → its turns, from the local transcripts (read-only; built once). */
function transcriptTurns(): (id: string) => { at: string; runEndsAt: string }[] | null {
  const root = join(homedir(), '.claude', 'projects');
  const paths = new Map<string, string>();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    /* no transcripts here */
  }
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(join(root, d)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) paths.set(f.slice(0, -'.jsonl'.length), join(root, d, f));
  }
  const cache = new Map<string, { at: string; runEndsAt: string }[] | null>();
  return (id) => {
    if (cache.has(id)) return cache.get(id)!;
    const p = paths.get(id);
    let out: { at: string; runEndsAt: string }[] | null = null;
    if (p) {
      try {
        out = turnsOfTranscript(readFileSync(p, 'utf8')).map(([at, runEndsAt]) => ({ at, runEndsAt }));
      } catch {
        out = null;
      }
    }
    cache.set(id, out);
    return out;
  };
}

const h = (n: number) => (Math.round(n * 100) / 100).toFixed(2).padStart(6);
const sum = (xs: readonly { durationHours: number }[]) => Math.round(xs.reduce((s, x) => s + x.durationHours, 0) * 100) / 100;

function print(r: RederiveReport, title: string) {
  console.log(title);
  console.log('  day          before   after   model │ meetings   solo travel onsite  org62 │ internal');
  for (const d of r.days)
    console.log(`  ${d.day}  ${h(d.before)}  ${h(d.after)}  ${h(d.afterModel)} │   ${h(d.split.meetings)} ${h(d.split.solo)} ${h(d.split.travel)} ${h(d.split.onsite)} ${h(d.split.org62)} │   ${h(d.split.internal)}`);
  console.log(`  total       ${h(r.totals.before)}  ${h(r.totals.after)}  ${h(r.totals.afterModel)}`);
  const counted = (s: string) => !['excluded', 'dismissed', 'dropped'].includes(s);
  const addedLive = r.added.filter((x) => counted(x.status));
  console.log(`  rows: +${addedLive.length} added (${sum(addedLive)} h${r.added.length > addedLive.length ? `; ${r.added.length - addedLive.length} more excluded` : ''}) · ~${r.changed.length} changed · -${r.removed.length} removed (${sum(r.removed.filter((x) => counted(x.status)))} h)`);
  const dh = Math.round(r.candidates.reduce((s, c) => s + (c.to - c.from), 0) * 100) / 100;
  console.log(`  update candidates (in Org62, never edited here): ${r.candidates.length}, ${dh >= 0 ? '+' : ''}${dh} h (${Math.round(r.candidates.reduce((s, c) => s + c.from, 0) * 100) / 100} h → ${Math.round(r.candidates.reduce((s, c) => s + c.to, 0) * 100) / 100} h)`);
  for (const c of r.candidates) console.log(`    Event ${c.org62EventId}: ${c.from} h → ${c.to} h · ${c.reason.slice(0, 120)}`);
  if (r.held.length) console.log(`  your rows not in Org62 yet whose hours would change (left as they are): ${r.held.length}`);
  for (const x of r.held) console.log(`    ${x.dedupeKey} (${x.status}): ${x.from} h → ${x.to} h`);
  if (has('--rows')) {
    for (const x of r.added) console.log(`    + ${x.startsAt.slice(0, 16)} ${x.durationHours} h ${x.status} ${x.seTaskType ?? '-'} · ${x.subject.slice(0, 70)}`);
    for (const x of r.changed) console.log(`    ~ ${x.to.startsAt.slice(0, 16)} ${x.from.durationHours} → ${x.to.durationHours} h (${x.fields.join(', ')}) · ${x.to.subject.slice(0, 70)}`);
    for (const x of r.removed) console.log(`    - ${x.startsAt.slice(0, 16)} ${x.durationHours} h ${x.status} · ${x.subject.slice(0, 70)}`);
  }
  if (r.errors.length) console.log(`  errors: ${r.errors.join(', ')}`);
}

async function run(): Promise<number> {
  const from = arg('--from');
  if (!from || !DAY_RE.test(from)) {
    console.error('usage: npm run time:rederive -- --from YYYY-MM-DD [--to YYYY-MM-DD] [--transcripts] [--rows] [--json] [--apply]');
    return 2;
  }
  const url = resolveDatabaseUrl();
  const handle = createDb({ url, max: 2, applicationName: 'command-center-time-rederive' });
  try {
    const u = await handle.db.execute<{ id: string; tz: string }>(sql`select id, timezone as tz from users where is_active order by created_at limit 1`);
    const user = u.rows[0];
    if (!user) throw new Error(`no user in ${databaseName(url)}`);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: user.tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const to = arg('--to') ?? today;
    if (!DAY_RE.test(to) || to < from) throw new Error('--to: a YYYY-MM-DD on or after --from');
    const turnsOf = has('--transcripts') ? transcriptTurns() : undefined;
    const engaged = arg('--engaged') ? (JSON.parse(arg('--engaged')!) as Partial<EngagedParams>) : undefined;
    if (engaged && has('--apply')) throw new Error('--engaged is for dry runs only: --apply uses the calibrated defaults');
    const dry = await rederiveWeeks({ store: projectionStore(handle.db), userId: user.id, from, to, ...(turnsOf ? { turnsOf } : {}), ...(engaged ? { engaged } : {}) });
    if (has('--json')) console.log(JSON.stringify(dry, null, 2));
    else print(dry, `Re-derive ${from} → ${to} (${databaseName(url)}): dry run, nothing written`);
    if (!has('--apply')) return dry.errors.length ? 1 : 0;
    const days: string[] = dry.days.map((d) => d.day);
    const r = await recomputeWeeks({ store: projectionStore(handle.db), userId: user.id, days, ...(turnsOf ? { turnsOf } : {}) });
    console.log(`applied: weeks ${r.weeks.join(', ')}${r.errors.length ? ` · errors ${r.errors.join(', ')}` : ''}`);
    const post = await rederiveWeeks({ store: projectionStore(handle.db), userId: user.id, from, to, ...(turnsOf ? { turnsOf } : {}) });
    if (!has('--json')) print(post, 'After --apply (what is left: the user\'s rows and the update candidates)');
    // D-70: rows already in Org62 are never edited here; their new hours wait in Log it as updates for your approval
    if (post.candidates.length) {
      const ds = new DbDataSource({ handle, userId: user.id, clock: { now: () => new Date() } });
      const p = await ds.proposeEventUpdates({ body: { candidates: post.candidates.map((c) => ({ ...c, from: String(c.from), to: String(c.to) })) } } as never);
      const res = p as unknown as { proposed: string[]; skipped: Array<{ why: string }> };
      console.log(`proposed in Log it: ${res.proposed.length} update(s)${res.skipped.length ? ` · skipped ${res.skipped.length} (${[...new Set(res.skipped.map((s) => s.why))].join('; ')})` : ''}`);
    }
    return r.errors.length ? 1 : 0;
  } finally {
    await handle.close();
  }
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  });
