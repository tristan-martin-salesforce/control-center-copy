/**
 * Read parity: every read method of the DataSource on the mock and on Postgres, same seed, same clock.
 * Each response validates against the route's contract schema and is equivalent after the documented
 * normalizations (normalize.ts N1–N4); per-method differences are listed in DIFFERENCES.md.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { routes, type ItemsPayload, type RouteKey, type ScansPayload } from '../../../src/contract';
import type { DbHandle } from '../../../src/db/client';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { loadBoth, openTestDb, type Loaded } from './helpers';
import { BE1B } from './helpers';
import { both, byId, dropKeys, sortAt, workOrder, type ParityOptions } from './parity';
import { closedCursor, closedKeyOf, parseClosedCursor } from '../../../src/server/datasource/db/reads/page';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle);
  // D-RANK: parity ranks with the mock's scorer on both sides; ENGINES-core (the default) is tested in tests/integration
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
});
afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await handle?.close();
});

const S = () => L.seed;
const firstItem = (pred: (w: Loaded['seed']['workItems'][number]) => boolean) => S().workItems.find(pred)!.id;

/** Home row ids embed an entity id after a prefix ("gap:connector:<id>", "ini:<id>"); translate the tail on the mock side. */
function homeIds(v: unknown, side: 'mock' | 'db'): unknown {
  if (side === 'db') return v;
  const tr = (id: string) => id.replace(/^((?:gap:connector|ini):)(.+)$/, (_m, p: string, tail: string) => p + (L.idMap.get(tail) ?? tail));
  const walk = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, k === 'id' && typeof y === 'string' ? tr(y) : walk(y)])) : x;
  return walk(v);
}

/** The Closed keyset cursor decoded, with the mock's seed id translated to the db's (the harness can't see inside it). */
function closedCursorShape(v: unknown, side: 'mock' | 'db'): unknown {
  const o = v as { nextCursor?: string | null };
  if (typeof o.nextCursor !== 'string') return v;
  const k = parseClosedCursor(o.nextCursor);
  return { ...o, nextCursor: k ? { ...k, id: side === 'mock' ? (L.idMap.get(k.id) ?? k.id) : k.id } : o.nextCursor };
}

/** Read calls: [route, input, options]. Inputs use seed ids; the harness translates them for the db side. */
const READS: [RouteKey, () => Record<string, unknown>, ParityOptions?][] = [
  ['getToday', () => ({})],
  ['getHome', () => ({ query: {} }), { shape: homeIds }],
  ['getHome', () => ({ query: { wide: '1' } }), { shape: homeIds }],
  // planning the next working day: the same day, capacity and carried work on both sides
  ['getHome', () => ({ query: { day: 'next' } }), { shape: homeIds }],
  // Why is this still open?: the check payload, with the additive reopenUndoId (null on both: nothing was undone)
  ['getResolutionCheck', () => ({ params: { id: firstItem((w) => w.state === 'open') } })],
  ['listItems', () => ({ query: {} }), { shape: sortAt(['items'], workOrder) }],
  ['listItems', () => ({ query: { tab: 'done' } })],
  ['listItems', () => ({ query: { tab: 'promises' } })],
  ['listItems', () => ({ query: { tab: 'snoozed' } })],
  ['listItems', () => ({ query: { tab: 'asked_of_me', q: 'a' } })],
  ['listItems', () => ({ query: { account: S().accounts[0]!.id } })],
  ['listItems', () => ({ query: { source: 'slack' } }), { shape: sortAt(['items'], workOrder) }],
  ['getItem', () => ({ params: { id: firstItem((w) => !!w.nbaId && !!w.initiativeId) } }), { shape: sortAt(['siblings'], byId) }],
  ['getItem', () => ({ params: { id: firstItem((w) => w.state === 'done') } }), { shape: sortAt(['siblings'], byId) }],
  ['getItemEvidence', () => ({ params: { id: S().evidence[0]!.workItemId } })],
  // a Slack snippet in mrkdwn: the same mention names on both sides (the people directory)
  ['getItemEvidence', () => ({ params: { id: 'w_dana_reply' } })],
  ['getItem', () => ({ params: { id: 'w_dana_reply' } }), { shape: sortAt(['siblings'], byId) }],
  ['getItemNba', () => ({ params: { id: firstItem((w) => !!w.nbaId) } })],
  ['getInitiative', () => ({ params: { id: S().initiatives[0]!.id } })],
  ['getDraft', () => ({ params: { id: S().drafts[0]!.id } })],
  ['previewDraft', () => ({ params: { id: S().drafts[0]!.id }, body: {} })],
  // the message a draft replies to (thread context + evidence on both sides; db reads the thread's source items too)
  ...(['dr_dana', 'dr_nudge_globex', 'dr_globex_sow', 'dr_sent_sso', 'dr_onepager', 'dr_priya', 'dr_chat_initech'] as const).map((id): [RouteKey, () => Record<string, unknown>] => ['getDraftSource', () => ({ params: { id } })]),
  ['getOutbox', () => ({})],
  ['getCalendar', () => ({ query: {} })],
  ['getAgents', () => ({})],
  ['getTools', () => ({})],
  ['getToolRun', () => ({ params: { id: S().toolRuns[0]!.id } })],
  ['getTime', () => ({ query: {} })],
  ['getDeals', () => ({})],
  ['getMissed', () => ({})],
  ['getAccount', () => ({ params: { accountId: S().accounts[0]!.id } }), { shape: (v) => sortAt(['runs'], byId)(sortAt(['items'], byId)(v)) }],
  ['getBriefs', () => ({})],
  ['listWatches', () => ({})],
  ['getTriage', () => ({})],
  ['getHealth', () => ({}), { shape: (v) => dropKeys(v, ['worker', 'disagreements']) }], // priority@2: the disagreeing items depend on id tie-breaks (mock and db ids differ)
  ['getScans', () => ({ query: {} })],
  ['getJobs', () => ({})],
  ['getEventLog', () => ({})],
  ['getSettings', () => ({})],
  ['previewPolicy', () => ({ body: {} })],
  ['previewPolicy', () => ({ body: { weights: { ...S().settings.policy.weights, customer_facing: 0, due_urgency: 10 } } })],
  ['getPolicyVersions', () => ({})],
  ['search', () => ({ query: { q: 'acme' } })],
  ['search', () => ({ query: { q: 'demo deck' } })],
  ['getSince', () => ({ query: {} })],
  ['listChatThreads', () => ({})],
  ['getChatThread', () => ({ params: { id: S().chatThreads[0]!.thread.id } })],
  // CONTRACT-1 additions
  ['getChatThread', () => ({ params: { id: S().chatThreads[S().chatThreads.length - 1]!.thread.id } })],
  ['getPeople', () => ({ query: {} })],
  ['getPeople', () => ({ query: { q: 'da' } })],
  ['getPeople', () => ({ query: { q: 'acme', limit: 5 } })],
  ['getPeople', () => ({ query: { slack: 'true' } })],
  ['getPeople', () => ({ query: { account: S().accounts[0]!.id } })],
  ['previewDraft', () => ({ params: { id: S().drafts[S().drafts.length - 1]!.id }, body: { mode: 'send' } })],
  // D-HIST: history `changes` come from audit row images (every column the change set wrote)
  ['getItemHistory', () => ({ params: { id: firstItem((w) => w.state === 'done' && w.doneBy === 'engine') } }), { shape: (v) => dropKeys(v, ['changes']) }],
  ['getBrief', () => ({ params: { id: S().briefs[0]!.id } })],
  // DB-UI: the reads the v2 pages and Details renderers make that the list above did not cover
  ['getCalendar', () => ({ query: wideWindow() })], // EventPanel: ±30 days, day-rounded
  ['getTime', () => ({ query: { week: isoDay(L.now.getTime() - 7 * 86_400_000) } })], // Time: the week before
  ['listItems', () => ({ query: { tab: 'all_open' } }), { shape: sortAt(['items'], workOrder) }], // EventPanel, Agents, Start in Claude
  ['listItems', () => ({ query: { tab: 'said_by_me' } }), { shape: sortAt(['items'], workOrder) }],
  ['listItems', () => ({ query: { tab: 'trainings' } }), { shape: sortAt(['items'], workOrder) }],
  // Work lists (19-read-twins "Work lists"): every filter the Work page sends (url-filters.ts itemsQueryOf), alone
  // and combined, on open and closed tabs; the db narrows account / opp / initiative in SQL, the view does the rest
  ['listItems', () => ({ query: { tab: 'asked_of_me' } }), { shape: sortAt(['items'], workOrder) }],
  ['listItems', () => ({ query: { initiative: S().initiatives[0]!.id } }), { shape: sortAt(['items'], workOrder) }],
  ['listItems', () => ({ query: { tab: 'done', initiative: S().initiatives[0]!.id } })],
  ['listItems', () => ({ query: { opp: S().workItems.find((w) => !!w.oppId)!.oppId! } }), { shape: sortAt(['items'], workOrder) }],
  ['listItems', () => ({ query: { tab: 'done', account: S().accounts[0]!.id } })],
  ['listItems', () => ({ query: { kind: 'commitment' } }), { shape: sortAt(['items'], workOrder) }],
  ['listItems', () => ({ query: { q: 'ACME' } }), { shape: sortAt(['items'], workOrder) }],
  ['listItems', () => ({ query: comboQuery() }), { shape: sortAt(['items'], workOrder) }],
  ['listItems', () => ({ query: { tab: 'snoozed', source: 'gmail', q: 'e' } })],
  ['listItems', () => ({ query: { account: S().accounts[0]!.id, initiative: S().initiatives[S().initiatives.length - 1]!.id } }), { shape: sortAt(['items'], workOrder) }],
  ['listItems', () => ({ query: { q: 'no item says this' } })],
  // post-2.0 Work list scope: the Closed tab paged (additive cursor/limit; the db pages in SQL, the mock in memory)
  // P25-6: the cursor is a keyset (closed, created, id): compared decoded, the mock's id translated; page 2 is below
  ['listItems', () => ({ query: { tab: 'done', limit: 2 } }), { shape: closedCursorShape }],
  ['getReadIn', () => ({ params: { type: 'work_item', id: S().workItems[0]!.id } })], // Details: the read-in section
  ['getReadIn', () => ({ params: { type: 'calendar_event', id: S().calendar.events[0]!.id } })],
  // MEETING-HOVER: the hover card and the meeting panel (agenda, organizer, answers, attachments, prep, names)
  ...['ev_acme_demo', 'ev_umbrella', 'ev_standup', 'ev_initech', 'ev_globex_pricing', 'ev_retro'].map((id): [RouteKey, () => Record<string, unknown>] => ['getCalendarEvent', () => ({ params: { id } })]),
  // jsonb sorts object keys, but these records are shown in key order: the Tools run form (manifest properties),
  // tool-run inputs (Tools rows, run panels) and NBA tool inputs (the NBA card)
  ['getTools', () => ({}), { shape: keyOrders }],
  ['getToolRun', () => ({ params: { id: S().toolRuns.find((t) => Object.keys(t.inputs).length > 1)!.id } }), { shape: keyOrders }],
  ['getItemNba', () => ({ params: { id: S().nbas.find((n) => Object.keys(n.toolInputs ?? {}).length > 2)!.workItemId } }), { shape: keyOrders }], // customer, name, eventId ≠ jsonb's name, eventId, customer
  // the Account page and panel list opps, initiatives, assets and briefs in payload order
  ...[1, 2, 3, 4].map((i): [RouteKey, () => Record<string, unknown>, ParityOptions] => ['getAccount', () => ({ params: { accountId: S().accounts[i]!.id } }), { shape: (v) => sortAt(['runs'], byId)(sortAt(['items'], byId)(v)) }]),
];

/** Every Work filter at once, taken from one open item so the answer is not empty. */
function comboQuery(): Record<string, string> {
  const w = S().workItems.find((x) => x.state === 'open' && !!x.accountId && !!x.initiativeId && x.sources.length > 0)!;
  return { tab: 'all_open', account: w.accountId!, initiative: w.initiativeId!, source: w.sources[0]!.kind, kind: w.kind, q: w.title.slice(0, 5) };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function wideWindow(): { from: string; to: string } {
  const n = L.now;
  const day = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  return { from: new Date(day - 30 * 86_400_000).toISOString(), to: new Date(day + 31 * 86_400_000 - 1).toISOString() };
}
/** Adds the key order of every `properties` / `inputs` / `toolInputs` object as an array (diffPaths compares objects by key only). */
function keyOrders(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(keyOrders);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = keyOrders(x);
    if (['properties', 'inputs', 'toolInputs'].includes(k) && x && typeof x === 'object' && !Array.isArray(x)) out[`${k}KeyOrder`] = Object.keys(x);
  }
  return out;
}

describe.runIf(BE1B)('read parity: mock ↔ db on the same seed', () => {
  for (const [key, input, opts] of READS) {
    it(`${key} ${JSON.stringify(input.toString().slice(6, 80))}`, async () => {
      const r = await both(L, db, key, input(), opts);
      expect(r.diffs, r.diffs.join('\n')).toEqual([]);
    });
  }

  it('listItems Closed pages by each side\'s own keyset cursor alike, and a cursor whose row left the list skips nothing (P25-6)', async () => {
    const page = async (side: 'mock' | 'db', q: Record<string, unknown>) => (await (side === 'mock' ? L.mock : db).listItems({ query: routes.listItems.query!.parse({ tab: 'done', ...q }) } as never)) as ItemsPayload;
    const ids = (p: ItemsPayload, side: 'mock' | 'db') => p.items.map((i) => (side === 'mock' ? (L.idMap.get(i.id) ?? i.id) : i.id));
    const [m1, d1] = [await page('mock', { limit: 2 }), await page('db', { limit: 2 })];
    expect(m1.nextCursor && d1.nextCursor).toBeTruthy();
    const [m2, d2] = [await page('mock', { limit: 2, cursor: m1.nextCursor }), await page('db', { limit: 2, cursor: d1.nextCursor })];
    expect(ids(m2, 'mock')).toEqual(ids(d2, 'db'));
    expect(closedCursorShape(m2, 'mock')).toMatchObject({ nextCursor: (closedCursorShape(d2, 'db') as ItemsPayload).nextCursor });
    // the whole tab, then a cursor at page 1's last key whose row is gone (reopened): every later row still comes
    const whole = ids(await page('mock', {}), 'mock');
    const gone = closedCursor({ ...closedKeyOf(m1.items.at(-1)!), id: 'w_reopened_since_p25' });
    const [m3, d3] = [await page('mock', { limit: 200, cursor: gone }), await page('db', { limit: 200, cursor: gone })];
    expect(ids(m3, 'mock')).toEqual(ids(d3, 'db'));
    expect(ids(m3, 'mock')).toEqual(expect.arrayContaining(whole.slice(2)));
  });

  it('getScans pages to the oldest run by each side\'s keyset cursor alike (caps audit F-2)', async () => {
    const page = async (side: 'mock' | 'db', q: Record<string, unknown>) => (await (side === 'mock' ? L.mock : db).getScans({ query: routes.getScans.query!.parse(q) } as never)) as ScansPayload;
    const walk = async (side: 'mock' | 'db') => {
      const out: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 50; i++) {
        const p = await page(side, { limit: 2, ...(cursor ? { cursor } : {}) });
        out.push(...p.runs.map((r) => (side === 'mock' ? (L.idMap.get(r.id) ?? r.id) : r.id)));
        expect(p.total).toBe(S().scanRuns.length);
        if (!p.nextCursor) break;
        cursor = p.nextCursor;
      }
      return out;
    };
    const [m, d] = [await walk('mock'), await walk('db')];
    expect(m).toHaveLength(S().scanRuns.length); // every run, none twice
    expect(new Set(m).size).toBe(m.length);
    expect(d).toEqual(m);
  });

  it('getDeals: the summary and pipeline by fiscal quarter are the same on both, and not empty', async () => {
    const r = await both(L, db, 'getDeals', {});
    expect(r.diffs, r.diffs.join('\n')).toEqual([]);
    const p = (r.raw.db as { pipeline: { basis: string; categoryBasis: string; amountField: { field: string }; summary: { open: { count: number } }; quarters: unknown[]; rows: Array<{ via: string }> } }).pipeline;
    expect(p).toMatchObject({ basis: 'team_or_dc', categoryBasis: 'forecast', amountField: { field: 'Opportunity.Amount' } });
    expect(p.quarters).toHaveLength(5);
    // the seed's team or DC opps only (the two swept ones are on my accounts but not mine)
    const mine = S().opps.filter((o) => o.isOpen && (o.isMine || o.dcAssigned)).length;
    expect(p.summary.open.count).toBe(mine);
    expect(p.rows.every((x) => x.via !== 'forecast')).toBe(true);
  });
});

/**
 * DB-UI: the same reads after every table's rows were rewritten in reverse order. An UPDATE moves a row to the
 * end of its heap, so a fresh database returns unordered SELECTs in insertion order only by accident; a seeded
 * database that has seen re-ranks and edits does not (the Account page listed Renewal before Expansion, and its
 * order changed after the next write). Every read must order explicitly.
 */
describe.runIf(BE1B)('read parity after rows move in the heap (updated in place, reverse order)', () => {
  let shuffled: DbDataSource;
  beforeAll(async () => {
    await reverseHeapOrder(handle);
    shuffled = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
  });
  afterAll(async () => {
    await shuffled?.dispose();
  });
  for (const [key, input, opts] of READS) {
    it(`${key} ${JSON.stringify(input.toString().slice(6, 80))}`, async () => {
      const r = await both(L, shuffled, key, input(), opts);
      expect(r.diffs, r.diffs.join('\n')).toEqual([]);
    });
  }
});

/**
 * Getting started counts outcomes (src/guide/checklist.ts): the DC outcome ticks on a DC request made in the app. Both
 * DataSources pass that count, so GET /guide's done / total match with one request present. Last in the file: it
 * writes (and undoes) a request.
 */
describe.runIf(BE1B)('getGuide parity with one DC request', () => {
  it('done / total and the DC step match on both, before and after a request', async () => {
    type G = { done: number; total: number; items: Array<{ id: string; state: string }> };
    const guide = async () => {
      const r = await both(L, db, 'getGuide', {});
      const raw = r.raw as unknown as { mock: G; db: G };
      expect([raw.db.done, raw.db.total]).toEqual([raw.mock.done, raw.mock.total]);
      const dc = (g: G) => g.items.find((i) => i.id === 'dc')?.state;
      expect(dc(raw.db)).toBe(dc(raw.mock));
      return raw.mock;
    };
    const before = await guide();
    const swept = new Set(S().missedOpps.map((m) => m.oppId));
    const opp = S().opps.find((o) => !o.dcAssigned && o.isOpen && !swept.has(o.id))!;
    const body = (id: string) => ({ body: { opp: id, split: 50, comment: 'Built the demo for it' } }) as never;
    const m = (await L.mock.createDcRequest(body(opp.id))) as unknown as { auditId: string };
    const d = (await db.createDcRequest(body(L.idMap.get(opp.id) ?? opp.id))) as unknown as { auditId: string };
    const after = await guide();
    expect(after.items.find((i) => i.id === 'dc')?.state).toBe('done');
    expect([after.done, after.total]).toEqual([before.done + (before.items.find((i) => i.id === 'dc')?.state === 'done' ? 0 : 1), before.total]);
    await L.mock.undoAudit({ params: { id: m.auditId }, body: {} } as never);
    await db.undoAudit({ params: { id: d.auditId }, body: {} } as never);
  });
});

/** Rewrites every row of every app table, last row first (a no-op SET on the first column; triggers off for the session). */
async function reverseHeapOrder(h: DbHandle): Promise<void> {
  await h.db.execute(sql`
    DO $$
    DECLARE t record; r record;
    BEGIN
      PERFORM set_config('session_replication_role', 'replica', true);
      FOR t IN
        SELECT c.relname AS tbl, a.attname AS col
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = 1
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE '%drizzle%'
      LOOP
        FOR r IN EXECUTE format('SELECT ctid AS c FROM %I ORDER BY ctid DESC', t.tbl) LOOP
          EXECUTE format('UPDATE %I SET %I = %I WHERE ctid = $1', t.tbl, t.col, t.col) USING r.c;
        END LOOP;
      END LOOP;
    END $$;
  `);
}

/** SEC-8: Settings ▸ Assistant's memory list (GET /chat/memory?scope=pinned): the same entries and source messages. */
describe.runIf(BE1B)('listChatMemory scope=pinned parity', () => {
  it('a preference and a pinned thread note resolve to the same source message on both; an unpinned note stays out', async () => {
    const hooli = S().chatThreads.find((t) => t.thread.title === 'Hooli NCE scoping')!.thread.id;
    const add = async (ds: { chatMemory: { add: (e: { threadId: string | null; kind: 'note' | 'preference'; text: string; pinned?: boolean }) => Promise<{ id: string }> } }, thread: string) => [
      await ds.chatMemory.add({ threadId: null, kind: 'preference', text: 'Globex pricing comes first', pinned: true }),
      await ds.chatMemory.add({ threadId: thread, kind: 'note', text: 'Retrieval layer is on pgvector', pinned: true }),
      await ds.chatMemory.add({ threadId: thread, kind: 'note', text: 'An unpinned scratch note', pinned: false }),
    ];
    const m = await add(L.mock, hooli);
    const d = await add(db, L.idMap.get(hooli)!);
    try {
      const r = await both(L, db, 'listChatMemory', { query: { scope: 'pinned' } }, { times: true, shape: (v) => dropKeys(v, ['id']) }); // the entries' own ids are written at request time
      expect(r.diffs, r.diffs.join('\n')).toEqual([]);
      const entries = (r.raw.db as { entries: Array<{ text: string; source: { threadTitle: string; excerpt: string } | null }> }).entries;
      expect(entries.map((e) => [e.text, e.source?.threadTitle])).toEqual([
        ['Globex pricing comes first', 'Today'],
        ['Retrieval layer is on pgvector', 'Hooli NCE scoping'],
      ]);
    } finally {
      for (const e of m) await L.mock.chatMemory.remove(e.id);
      for (const e of d) await db.chatMemory.remove(e.id);
    }
  });

  it('a stored source message id (0038) is exact on both: the preference shows the Hooli message, not the latest by time', async () => {
    const hooli = S().chatThreads.find((t) => t.thread.title === 'Hooli NCE scoping')!;
    const asked = hooli.messages.find((x) => x.role === 'user')!.id;
    const add = (ds: { chatMemory: { add: (e: { threadId: string | null; kind: 'preference'; text: string; pinned?: boolean; sourceMessageId?: string | null }) => Promise<{ id: string }> } }, source: string) =>
      ds.chatMemory.add({ threadId: null, kind: 'preference', text: 'Globex pricing comes first', pinned: true, sourceMessageId: source });
    const m = await add(L.mock, asked);
    const d = await add(db, L.idMap.get(asked)!);
    try {
      const r = await both(L, db, 'listChatMemory', { query: { scope: 'pinned' } }, { times: true, shape: (v) => dropKeys(v, ['id']) });
      expect(r.diffs, r.diffs.join('\n')).toEqual([]);
      const source = (r.raw.db as { entries: Array<{ source: { threadTitle: string; messageId: string } | null }> }).entries[0]!.source;
      expect(source).toMatchObject({ threadTitle: 'Hooli NCE scoping', messageId: L.idMap.get(asked) }); // the time fallback says 'Today'
    } finally {
      await L.mock.chatMemory.remove(m.id);
      await db.chatMemory.remove(d.id);
    }
  });
});
