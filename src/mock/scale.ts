/**
 * Smoke at scale (C9, 01-activity-at-scale §7): the example seed multiplied at load time, so the mock app can be run,
 * crawled and screenshotted at a realistic volume. Placeholders only: every new row is a copy of an example row (the
 * example's names, accounts and opps) with a derived id (`<id>_x<k>`), never a new name or a real id.
 *
 *   dev     CC_SEED_SCALE=7 CC_DATA=mock PORT=4372 npm run dev:web
 *   crawl   npm run smoke:crawl -- --mock --scale 7 --port 4372 [--persona ae]
 *   shot    npm run shot -- /activity --port 4372   (against a server started with CC_SEED_SCALE=7)
 *
 * At scale n: activity rows ×n spread over the last 6 weeks with mixed attribution states (a sure suggestion, an unsure
 * one on an account with 2–3 open opps, no suggestion, a missing task type, internal, ready, handed off, logged, one
 * not found in Org62), work items ×n/2 and inbox asks (Slack/email) ×n/2 (needs-reply and FYI), and at n ≥ 4 a VDP
 * with 60+ items to fix (src/mock/vdp.ts reads `seedScale()`). Deterministic: a seeded PRNG, no clock. n = 1 (the
 * default) returns the seed untouched.
 *
 * C6: Activity ▸ Sending at scale: five logging batches (Outbox canvas items) over the scaled rows: one waiting for
 * your Apply, one sent with 4 of 6 checked in Org62 and 2 not found, and three finished this week (`scaleBatches`).
 */
import { addDays, format, parseISO } from 'date-fns';
import type { ActivityEntry, Draft, Seed, WorkItemRecord } from '@/contract';
import { NOT_IN_ORG62_FLAG } from '@/engines/activity/org62-check';

export const MAX_SEED_SCALE = 50;

/** CC_SEED_SCALE as a whole number 1..50 (anything else: 1). */
export function seedScale(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.CC_SEED_SCALE ?? '1');
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_SEED_SCALE) : 1;
}

/** mulberry32: a small seeded PRNG (stable screenshots). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function shiftIso(v: string, days: number): string;
function shiftIso(v: string | null, days: number): string | null;
function shiftIso(v: string | null, days: number): string | null {
  if (!v || !days) return v;
  if (DAY.test(v)) return format(addDays(parseISO(v), days), 'yyyy-MM-dd');
  if (INSTANT.test(v)) return addDays(new Date(v), days).toISOString();
  return v;
}

/** The attribution states a copied row cycles through (the original rows keep theirs). */
const STATES = ['sure', 'unsure', 'none', 'no_type', 'internal', 'approved', 'logged', 'sure', 'unsure', 'handed_off'] as const;
type State = (typeof STATES)[number];

function attributed(row: ActivityEntry, state: State, seed: Seed, r: () => number): ActivityEntry {
  const open = seed.opps.filter((o) => o.isOpen);
  const byAcc = new Map<string, typeof open>();
  for (const o of open) byAcc.set(o.accountId, [...(byAcc.get(o.accountId) ?? []), o]);
  const multi = [...byAcc.values()].filter((os) => os.length >= 2);
  const accName = (id: string) => seed.accounts.find((a) => a.id === id)?.name ?? null;
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const base: ActivityEntry = { ...row, internal: false, issues: [], suggestion: null, excludedReason: null, dismissSource: null };
  const unset = { oppId: null, oppName: null, accountName: null };
  switch (state) {
    case 'sure': {
      const o = pick(open);
      const accountName = accName(o.accountId);
      return { ...base, ...unset, status: 'needs_input', accountName, taskType: row.taskType ?? 'Discovery', suggestion: { kind: 'opp', oppId: o.id, oppName: o.name, accountName, taskType: null, confidence: 0.92, reason: 'The meeting’s account has one open opp you work', basis: 'rules', at: null } };
    }
    case 'unsure': {
      const os = pick(multi.length ? multi : [open]);
      const o = pick(os);
      const accountName = accName(o.accountId);
      return { ...base, ...unset, status: 'needs_input', accountName, taskType: row.taskType ?? 'Solution Design', suggestion: { kind: 'opp', oppId: o.id, oppName: o.name, accountName, taskType: null, confidence: 0.45, reason: `${os.length} open opps on this account; the title fits this one best`, basis: 'ai', at: seed.meta.asOf } };
    }
    case 'none':
      return { ...base, ...unset, status: 'needs_input' };
    case 'no_type':
      return { ...base, status: 'needs_input', taskType: null, issues: ['Needs a task type'] };
    case 'internal':
      return { ...base, ...unset, status: 'proposed', internal: true, taskType: pick(['Asset Creation', 'Personal Development']) };
    case 'approved':
      return { ...base, status: row.oppId ? 'approved' : 'needs_input' };
    case 'logged':
      return row.oppId ? { ...base, status: 'logged', loggedAt: row.end } : { ...base, status: 'needs_input' };
    case 'handed_off':
      return { ...base, status: row.oppId ? 'synced_to_canvas' : 'needs_input' };
  }
}

function scaleActivity(seed: Seed, n: number, r: () => number): ActivityEntry[] {
  const out = [...seed.activity];
  // copies k = 1..n-1, spread back over six weeks (upcoming rows land in the past with their new state)
  for (let k = 1; k < n; k++) {
    for (const [i, row] of seed.activity.entries()) {
      const days = -Math.min(41, Math.round((k * 35) / Math.max(1, n - 1)) + Math.floor(r() * 5));
      const shifted: ActivityEntry = {
        ...row,
        id: `${row.id}_x${k}`,
        version: 1,
        date: shiftIso(row.date, days),
        start: shiftIso(row.start, days),
        end: shiftIso(row.end, days),
        updatedAt: shiftIso(row.updatedAt, days),
        loggedAt: shiftIso(row.loggedAt, days),
        verifiedAt: shiftIso(row.verifiedAt, days),
        sources: row.sources.map((s) => ({ ...s, externalId: s.externalId ? `${s.externalId}_x${k}` : s.externalId })),
      };
      out.push(attributed(shifted, STATES[(k * 7 + i) % STATES.length]!, seed, r));
    }
  }
  // one handed-off row that Org62 could not find (the batch ran, no Event came back)
  const lost = out.find((a) => a.id.includes('_x') && a.status === 'synced_to_canvas');
  if (lost) Object.assign(lost, { status: 'verify_failed', issues: ['Not in Org62: the canvas ran, but Org62 has no Event for this row (Slackbot skipped or failed it)'] });
  return out;
}

/** Rows × factor: copies of the base rows (round-robin), each with a derived id and no NBA, run or asset link. */
function copies(rows: WorkItemRecord[], factor: number, r: () => number, edit: (w: WorkItemRecord, k: number) => WorkItemRecord = (w) => w): WorkItemRecord[] {
  const extra = Math.max(0, Math.round(rows.length * factor) - rows.length);
  const out: WorkItemRecord[] = [];
  for (let j = 0; j < extra; j++) {
    const w = rows[j % rows.length]!;
    const k = Math.floor(j / rows.length) + 1;
    const days = -Math.floor(r() * 21);
    const copy: WorkItemRecord = { ...w, id: `${w.id}_x${k}`, version: 1, nbaId: null, runIds: [], assetIds: [], createdAt: shiftIso(w.createdAt, days), updatedAt: shiftIso(w.updatedAt, days), due: shiftIso(w.due, days), ageDays: w.ageDays - days, seenAt: null };
    out.push(edit(copy, k));
  }
  return out;
}

const isInbox = (w: WorkItemRecord) => w.kind === 'ask' && w.sources.some((s) => s.kind === 'slack' || s.kind === 'gmail');

/** One logging batch as an Outbox admin item (the shape `logCanvasesOf` reads). Placeholders only. */
function batchDraft(seed: Seed, k: number, status: Draft['status'], rows: readonly ActivityEntry[], at: string): Draft {
  const base = seed.drafts[0]!;
  const hours = Math.round(rows.reduce((s, e) => s + e.durationH, 0) * 100) / 100;
  const title = `Activity log · batch ${k}`;
  const applied = status !== 'ready';
  return {
    ...base,
    id: `dr_scale_batch_${k}`,
    version: 1,
    workItemId: null,
    nbaId: null,
    destination: { kind: 'action', action: 'slack_canvas.create', target: { label: title, url: null }, input: { title, markdown: `# ${title}\n`, eventIds: rows.map((e) => e.id), hours, updates: 0, updateIds: [], part: 1, parts: 1 }, changes: [], text: null },
    mode: 'draft',
    status,
    threadContext: [],
    userTouched: false,
    createdAt: shiftIso(at, -1),
    updatedAt: at,
    savedAt: null,
    scheduledFor: null,
    attempts: applied ? [{ id: `att_scale_batch_${k}`, at, mode: 'draft', dryRun: false, outcome: 'sent' }] : [],
    verification: null,
    rejectedReason: null,
    resultUrl: applied ? `https://example.slack.com/docs/T0PLACE/F0SCALE${k}` : null,
  } as Draft;
}

/**
 * Five batches over the scaled rows (C6): 1 waiting for your Apply (8 rows), 1 sent with 6 rows, 4 checked in Org62 and
 * 2 not found, and 3 finished this week (every row logged). Rows are taken from the copies only (`_x`), never the base.
 */
function scaleBatches(seed: Seed, activity: ActivityEntry[]): { activity: ActivityEntry[]; drafts: Draft[] } {
  const asOf = seed.meta.asOf;
  // the batches' rows: copies whose example row has an opportunity, given it back (placeholders: the example's own
  // account, opp and task type). Logged and handed-off copies first, then held rows, every third one, so lane 1 keeps
  // its mix; the one C9 marked not found stays as it is.
  const baseOf = new Map(seed.activity.map((a) => [a.id, a] as const));
  const withOpp = (a: ActivityEntry): ActivityEntry | null => {
    const b = baseOf.get(a.id.replace(/_x\d+$/, ''));
    return b?.oppId ? { ...a, oppId: b.oppId, oppName: b.oppName, accountName: b.accountName, taskType: a.taskType ?? b.taskType ?? 'Discovery', internal: false, suggestion: null } : null;
  };
  const copiesOf = (f: (a: ActivityEntry) => boolean) => activity.filter((a) => a.id.includes('_x') && f(a)).map(withOpp).filter((a): a is ActivityEntry => !!a);
  const held = copiesOf((a) => a.status === 'needs_input' && !a.internal).filter((_, i) => i % 3 === 0);
  const pool = [...copiesOf((a) => a.status === 'logged'), ...copiesOf((a) => a.status === 'synced_to_canvas' && !a.issues.length), ...held];
  const ready = copiesOf((a) => a.status === 'approved');
  const take = (n: number) => pool.splice(0, n);
  const byId = new Map(activity.map((a, i) => [a.id, i] as const));
  const put = (e: ActivityEntry) => (activity[byId.get(e.id)!] = e);
  const drafts: Draft[] = [];
  const plan: Array<{ status: Draft['status']; n: number; daysAgo: number; rows: (e: ActivityEntry, i: number) => ActivityEntry }> = [
    { status: 'ready', n: 8, daysAgo: 0, rows: (e) => ({ ...e, status: 'approved', loggedAt: null, issues: [] }) },
    { status: 'sent', n: 6, daysAgo: 1, rows: (e, i) => (i < 4 ? { ...e, status: 'logged', loggedAt: e.loggedAt ?? e.end, issues: [] } : { ...e, status: 'synced_to_canvas', loggedAt: null, issues: [NOT_IN_ORG62_FLAG] }) },
    { status: 'verified', n: 5, daysAgo: 2, rows: (e) => ({ ...e, status: 'logged', loggedAt: e.loggedAt ?? e.end, issues: [] }) },
    { status: 'verified', n: 4, daysAgo: 2, rows: (e) => ({ ...e, status: 'logged', loggedAt: e.loggedAt ?? e.end, issues: [] }) },
    { status: 'verified', n: 3, daysAgo: 3, rows: (e) => ({ ...e, status: 'logged', loggedAt: e.loggedAt ?? e.end, issues: [] }) },
  ];
  for (const [k, b] of plan.entries()) {
    const first = b.status === 'ready' ? ready.splice(0, b.n) : [];
    const rows = [...first, ...take(b.n - first.length)];
    if (rows.length < b.n) break;
    // a pending batch holds its rows by itself (store.ts derives `canvasDraftId` from the drafts)
    const out = rows.map((e, i) => b.rows(e, i));
    out.forEach(put);
    drafts.push(batchDraft(seed, k + 1, b.status, out, shiftIso(asOf, -b.daysAgo)));
  }
  return { activity, drafts };
}

/** The seed at scale `n` (see the header). Pure; n ≤ 1 returns `seed` itself. */
export function scaleSeed(seed: Seed, n: number): Seed {
  if (!(n > 1)) return seed;
  const r = prng(0xc9 * 1000 + n);
  const inbox = seed.workItems.filter(isInbox);
  const work = seed.workItems.filter((w) => !isInbox(w));
  const { activity, drafts } = scaleBatches(seed, scaleActivity(seed, n, r));
  const moreWork = copies(work, n / 2, r);
  // inbox: about two in three need a reply; the rest are FYI (looped in as a watcher, nothing asked of you)
  const asks = copies(inbox, n / 2, r, (w) => (r() < 0.35 ? { ...w, title: `FYI: ${w.title}`, involvement: 'watcher', priority: 'low', due: null } : w));
  return { ...seed, meta: { ...seed.meta, label: `${seed.meta.label} ×${n}` }, activity, drafts: [...seed.drafts, ...drafts], workItems: [...seed.workItems, ...moreWork, ...asks] };
}
