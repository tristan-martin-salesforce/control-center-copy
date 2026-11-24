/**
 * Mutation parity: the same mutation, in the same order, on the mock and on Postgres. Responses validate
 * against the contract and are equivalent after normalization; follow-up reads stay equivalent. Covers the
 * cases the brief names: a version conflict, undo, a locked field yielding a proposal, resolve handed_off,
 * dry-run dispatch, policy preview / apply / revert, and capture — then every other mutation route once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { routes, type RouteDef, type RouteKey } from '../../../src/contract';
import type { DbHandle } from '../../../src/db/client';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { AppError } from '../../../src/server/errors';
import type { DataSource } from '../../../src/server/datasource/types';
import { PREPARED_LAUNCH_EVENT } from '../../../src/server/datasource/types/agents';
import { translateHrefs } from '../../../src/server/datasource/db/translate';
import { diffPaths, loadBoth, openTestDb, translateIds, type Loaded } from './helpers';
import { BE1B } from './helpers';
import { normalizeValue, placeholders, translateComposite } from './normalize';
import { both, byId, dropKeys, sortAt, stableIds, workOrder, type ParityOptions } from './parity';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle, { reset: true });
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
const T = (id: string) => L.idMap.get(id) ?? id;

/** Like `both`, but with separate inputs (runtime ids differ between the two sides). */
async function bothWith<K extends RouteKey>(key: K, mockInput: Record<string, unknown>, dbInput: Record<string, unknown>, opts: ParityOptions = {}) {
  const def: RouteDef = routes[key];
  const parse = (v: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    if (def.params) out.params = def.params.parse(v.params ?? {});
    if (def.query) out.query = def.query.parse(v.query ?? {});
    if (def.body) out.body = def.body.parse(v.body);
    return out;
  };
  const call = async (ds: DataSource, inp: Record<string, unknown>) => {
    const out = await (ds[key] as unknown as (i: unknown) => Promise<unknown>).call(ds, parse(inp));
    const r = def.response.safeParse(out);
    if (!r.success) throw new Error(`${ds.kind} ${key}: contract validation failed ${JSON.stringify(r.error.issues.slice(0, 3))}`);
    return r.data as Record<string, unknown>;
  };
  const m = await call(L.mock, mockInput);
  const d = await call(db, dbInput);
  const stable = stableIds(L);
  const norm = (v: unknown, side: 'mock' | 'db') => {
    let x = normalizeValue(side === 'mock' ? translateComposite(translateHrefs(translateIds(v, L.idMap), L.idMap), L.idMap) : v);
    x = placeholders(x, stable, { times: opts.times });
    return opts.shape ? opts.shape(x, side) : x;
  };
  return { raw: { mock: m, db: d }, diffs: diffPaths(norm(m, 'mock'), norm(d, 'db'), '$', [], 60) };
}

async function bothError<K extends RouteKey>(key: K, input: Record<string, unknown>) {
  const def: RouteDef = routes[key];
  const parse = (v: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    if (def.params) out.params = def.params.parse(v.params ?? {});
    if (def.body) out.body = def.body.parse(v.body);
    return out;
  };
  const run = async (ds: DataSource, inp: Record<string, unknown>) => {
    try {
      await (ds[key] as unknown as (i: unknown) => Promise<unknown>).call(ds, parse(inp));
      return null;
    } catch (e) {
      return e as AppError;
    }
  };
  return { mock: await run(L.mock, input), db: await run(db, translateIds(input, L.idMap)) };
}

const expectSame = (diffs: string[]) => expect(diffs, diffs.join('\n')).toEqual([]);
const item = (pred: (w: Loaded['seed']['workItems'][number]) => boolean) => S().workItems.find(pred)!;
/** Receipts list per-field lines from each side's own change model (mock ops vs audit rows): D-RCPT. */
const noReceipt = (v: unknown) => dropKeys(v, ['receipt']);
const todayShape = (v: unknown) => v;

describe.runIf(BE1B)('mutation parity: mock ↔ db, same mutations in the same order', () => {
  it('rerankToday', async () => {
    expectSame((await both(L, db, 'rerankToday', { body: {} }, { times: true })).diffs);
    expectSame((await both(L, db, 'getToday', {}, { shape: todayShape })).diffs);
  });

  it('captureItem (insert + enqueued enrichment)', async () => {
    const r = await both(L, db, 'captureItem', { body: { text: 'Draft the #acme security FAQ ~30m' } }, { times: true });
    expectSame(r.diffs);
    expectSame((await both(L, db, 'listItems', { query: {} }, { shape: sortAt(['items'], workOrder) })).diffs);
  });

  it('patchItem locks the edited fields; a stale ifVersion is a 409 with details.current', async () => {
    const w = item((x) => x.state === 'open' && x.kind === 'ask' && !!x.due);
    expectSame((await both(L, db, 'patchItem', { params: { id: w.id }, body: { ifVersion: w.version, patch: { title: `${w.title} (edited)`, due: w.due } } }, { times: true })).diffs);
    const e = await bothError('patchItem', { params: { id: w.id }, body: { ifVersion: w.version, patch: { title: 'stale' } } });
    expect(e.mock).toBeInstanceOf(AppError);
    expect(e.db).toBeInstanceOf(AppError);
    expect(e.db!.code).toBe('conflict');
    expect(e.db!.status).toBe(409);
    const cur = (d: AppError) => normalizeValue(placeholders((d.details as { current: unknown }).current, stableIds(L), { times: true }));
    expectSame(diffPaths(cur({ ...e.mock!, details: translateHrefs(translateIds(e.mock!.details, L.idMap), L.idMap) } as AppError), cur(e.db!)));
  });

  it('an engine write to a user-locked field becomes a proposal; apply keeps the field locked', async () => {
    const w = item((x) => x.state === 'open' && x.kind === 'ask' && !!x.due);
    const due = new Date(Date.parse(w.due!) + 3_600_000).toISOString();
    const mm = L.mock.engineUpdateItem(w.id, { due }, 'New info: moved an hour');
    const dd = await db.engineUpdateItem(T(w.id), { due }, 'New info: moved an hour');
    expect(mm.proposalIds.length).toBe(1);
    expect(dd.proposalIds.length).toBe(1);
    expect(dd.applied).toEqual(mm.applied);
    expectSame((await both(L, db, 'getItemNba', { params: { id: w.id } })).diffs);
    const r = await bothWith('applyProposal', { params: { id: mm.proposalIds[0] }, body: {} }, { params: { id: dd.proposalIds[0] }, body: {} }, { times: true });
    expectSame(r.diffs);
    expectSame((await both(L, db, 'getItem', { params: { id: w.id } }, { shape: sortAt(['siblings'], byId) })).diffs);
  });

  it('undo restores the edit field by field; undoing the undo is redo', async () => {
    const w = item((x) => x.state === 'in_progress');
    const cur = (await L.mock.getItem({ params: { id: w.id } })).item;
    const m1 = await L.mock.patchItem({ params: { id: w.id }, body: { ifVersion: cur.version, patch: { notes: 'Bring the HDMI adapter' } } });
    const d1 = await db.patchItem({ params: { id: T(w.id) }, body: { ifVersion: cur.version, patch: { notes: 'Bring the HDMI adapter' } } });
    expect(d1.entity.notes).toBe('Bring the HDMI adapter');
    const u = await bothWith('undoAudit', { params: { id: m1.auditId }, body: {} }, { params: { id: d1.auditId }, body: {} }, { times: true, shape: (v) => dropKeys(v, ['changes', 'related', 'receipt']) });
    expectSame(u.diffs);
    expectSame((await both(L, db, 'getItem', { params: { id: w.id } }, { times: true, shape: sortAt(['siblings'], byId) })).diffs);
    const redo = await bothWith('undoAudit', { params: { id: u.raw.mock.auditId }, body: {} }, { params: { id: u.raw.db.auditId }, body: {} }, { times: true, shape: (v) => dropKeys(v, ['changes', 'related', 'receipt']) });
    expectSame(redo.diffs);
    const after = await db.getItem({ params: { id: T(w.id) } });
    expect(after.item.notes).toBe('Bring the HDMI adapter');
  });

  it('resolve handed_off moves ownership and makes me a watcher', async () => {
    const w = item((x) => x.state === 'open' && x.kind === 'task');
    const cur = (await L.mock.getItem({ params: { id: w.id } })).item;
    const r = await both(L, db, 'itemAction', { params: { id: w.id, verb: 'resolve' }, body: { ifVersion: cur.version, resolution: 'handed_off', detail: { personName: 'Kim Tran' } } }, { times: true });
    expectSame(r.diffs);
  });

  it('itemAction verbs: snooze, reopen, accept, dismiss, not-now, done, not-done (and its undo), confirm-done', async () => {
    const live = item((x) => x.state === 'open' && x.kind === 'commitment' && !x.isBackground);
    const ver = async (id: string) => (await L.mock.getItem({ params: { id } })).item.version;
    expectSame((await both(L, db, 'itemAction', { params: { id: live.id, verb: 'snooze' }, body: { ifVersion: await ver(live.id), until: new Date(L.now.getTime() + 86_400_000).toISOString() } }, { times: true })).diffs);
    const done = item((x) => x.state === 'done' && x.doneBy === 'user');
    expectSame((await both(L, db, 'itemAction', { params: { id: done.id, verb: 'reopen' }, body: { ifVersion: await ver(done.id), note: 'Not finished' } }, { times: true })).diffs);
    const sug = S().workItems.filter((x) => x.state === 'suggested');
    expectSame((await both(L, db, 'itemAction', { params: { id: sug[0]!.id, verb: 'accept' }, body: { ifVersion: await ver(sug[0]!.id) } }, { times: true })).diffs);
    expectSame((await both(L, db, 'itemAction', { params: { id: sug[1]!.id, verb: 'dismiss' }, body: { ifVersion: await ver(sug[1]!.id), reason: 'not_mine' } }, { times: true })).diffs);
    const other = item((x) => x.state === 'open' && x.kind === 'ask' && x.id !== live.id && !x.userLockedFields.length && !!x.accountId);
    expectSame((await both(L, db, 'itemAction', { params: { id: other.id, verb: 'not-now' }, body: { ifVersion: await ver(other.id), reason: 'later' } }, { times: true })).diffs);
    const likely = item((x) => x.state === 'likely_done');
    // LD-1: Not done steps back to the live state (neither side logged one: in_progress), and Undo restores it.
    const nd = await bothWith('itemAction', { params: { id: likely.id, verb: 'not-done' }, body: { ifVersion: await ver(likely.id) } }, { params: { id: T(likely.id), verb: 'not-done' }, body: { ifVersion: await ver(likely.id) } }, { times: true });
    expectSame(nd.diffs);
    expect((nd.raw.db as { entity: { state: string; likelyDone: unknown } }).entity).toMatchObject({ state: 'in_progress', likelyDone: null });
    const und = await bothWith('undoAudit', { params: { id: nd.raw.mock.auditId }, body: {} }, { params: { id: nd.raw.db.auditId }, body: {} }, { times: true, shape: (v) => dropKeys(v, ['changes', 'related', 'receipt']) });
    expectSame(und.diffs);
    expect((await db.getItem({ params: { id: T(likely.id) } })).item.state).toBe('likely_done');
    expectSame((await both(L, db, 'itemAction', { params: { id: likely.id, verb: 'confirm-done' }, body: { ifVersion: await ver(likely.id) } }, { times: true })).diffs);
    const ip = item((x) => x.state === 'waiting_on_others');
    expectSame((await both(L, db, 'itemAction', { params: { id: ip.id, verb: 'done' }, body: { ifVersion: await ver(ip.id) } }, { times: true })).diffs);
    expectSame((await both(L, db, 'getToday', {}, { times: true })).diffs);
  });

  it('markItemSeen clears new markers (no undo id)', async () => {
    const w = S().workItems.find((x) => x.newEvidenceCount > 0) ?? S().workItems[0]!;
    expectSame((await both(L, db, 'markItemSeen', { params: { id: w.id }, body: {} }, { times: true })).diffs);
    expectSame((await both(L, db, 'getItemEvidence', { params: { id: w.id } }, { times: true })).diffs);
  });

  it('regenerateNba rewrites an untouched draft in place', async () => {
    const n = S().nbas.find((x) => x.draftId && !S().drafts.find((d) => d.id === x.draftId)!.userTouched)!;
    expectSame((await both(L, db, 'regenerateNba', { params: { id: n.id }, body: { instruction: 'shorter' } }, { times: true })).diffs);
  });

  it('patchDraft autosaves (one burst), then preview + dry-run dispatch renders without sending', async () => {
    const d0 = S().drafts.find((x) => x.status === 'drafting')!;
    const d = await L.mock.getDraft({ params: { id: d0.id } });
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi Dana, confirmed for 13:00. See you then.' }] }] };
    const p = await both(L, db, 'patchDraft', { params: { id: d.id }, body: { ifVersion: d.version, doc } }, { times: true });
    expectSame(p.diffs);
    const pv = await both(L, db, 'previewDraft', { params: { id: d.id }, body: { mode: 'draft' } });
    expectSame(pv.diffs);
    const token = (await L.mock.previewDraft({ params: { id: d.id }, body: { mode: 'draft' } })).confirmToken;
    const dbToken = (await db.previewDraft({ params: { id: T(d.id) }, body: { mode: 'draft' } })).confirmToken;
    const v = (await L.mock.getDraft({ params: { id: d.id } })).version;
    const r = await bothWith('dispatchDraft', { params: { id: d.id }, body: { ifVersion: v, mode: 'draft', confirmToken: token } }, { params: { id: T(d.id) }, body: { ifVersion: v, mode: 'draft', confirmToken: dbToken } }, { times: true });
    expectSame(r.diffs);
    expect(r.raw.db.dryRun).toBe(true);
    expect((r.raw.db.attempt as { outcome: string }).outcome).toBe('rendered');
    // nothing was queued for a send adapter
    const jobs = await db.getJobs({} as never);
    expect(jobs.jobs.some((j) => j.type === 'outbox.dispatch')).toBe(false);
    expectSame((await both(L, db, 'getOutbox', {}, { times: true })).diffs);
  });

  it('policy preview → apply (new version + visible re-rank) → revert', async () => {
    const pol = S().settings.policy;
    const weights = { ...pol.weights, customer_facing: 1, due_urgency: 9 };
    expectSame((await both(L, db, 'previewPolicy', { body: { weights } })).diffs);
    const cur = (await L.mock.getSettings({} as never)).policy;
    const a = await both(L, db, 'applyPolicy', { body: { ifVersion: cur.version, weights, rules: cur.rules, note: 'Due dates first' } }, { times: true, shape: noReceipt });
    expectSame(a.diffs);
    expectSame((await both(L, db, 'getPolicyVersions', {}, { times: true })).diffs);
    expectSame((await both(L, db, 'getToday', {}, { times: true })).diffs);
    const after = (await L.mock.getSettings({} as never)).policy;
    const r = await both(L, db, 'revertPolicy', { body: { ifVersion: after.version, toVersion: cur.version } }, { times: true, shape: noReceipt });
    expectSame(r.diffs);
    expectSame((await both(L, db, 'listItems', { query: {} }, { times: true, shape: sortAt(['items'], workOrder) })).diffs);
  });
});

/** The launch prompt carries `[cc:<work item id>]`, url-encoded: translate it for comparison. */
function translateEncodedIds(v: unknown): unknown {
  let s = JSON.stringify(v);
  const ids = [...L.idMap.keys()].sort((a, b) => b.length - a.length);
  for (const id of ids) s = s.split(`cc%3A${id}`).join(`cc%3A${L.idMap.get(id)}`).split(`[cc:${id}]`).join(`[cc:${L.idMap.get(id)}]`);
  return JSON.parse(s);
}

describe.runIf(BE1B)('mutation parity: every other mutation route', () => {
  it('launchAgent records a launching session (no simulated progress in db mode)', async () => {
    const w = item((x) => x.state === 'open' && x.kind === 'task' && !x.runIds.length);
    const m = await L.mock.launchAgent({ body: { workItemId: w.id } });
    const d = await db.launchAgent({ body: { workItemId: T(w.id) } });
    expect([m.run.lastEvent, d.run.lastEvent]).toEqual([PREPARED_LAUNCH_EVENT, PREPARED_LAUNCH_EVENT]); // prepared, not "Opening…" (SEC-10)
    const norm = (v: unknown, side: 'mock' | 'db') => placeholders(normalizeValue(side === 'mock' ? translateEncodedIds(translateIds(v, L.idMap)) : v), stableIds(L), { times: true });
    expectSame(diffPaths(norm(m, 'mock'), norm(d, 'db')));
    expectSame((await both(L, db, 'getAgents', {}, { times: true, shape: (v) => translateEncodedIds(v) })).diffs);
  });

  it('answerAgent then cancelAgent on the waiting app run', async () => {
    const run = S().agentRuns.find((r) => r.kind === 'app_run' && r.state === 'waiting_on_you')!;
    expectSame((await both(L, db, 'answerAgent', { params: { id: run.id }, body: { answer: 'Synthetic (5k patients)' } }, { times: true })).diffs);
    expectSame((await both(L, db, 'cancelAgent', { params: { id: run.id }, body: {} }, { times: true })).diffs);
  });

  it('startToolRun records a queued run + its Agents mirror and enqueues tool.run', async () => {
    const tr = S().toolRuns.find((t) => t.adapterId === 'talk-track')!;
    const m = await L.mock.startToolRun({ params: { id: 'talk-track' }, body: { inputs: { customer: 'ACME Corp', name: 'Phase 2 walkthrough' }, workItemId: tr.workItemId ?? undefined } });
    const d = await db.startToolRun({ params: { id: 'talk-track' }, body: { inputs: { customer: 'ACME Corp', name: 'Phase 2 walkthrough' }, workItemId: tr.workItemId ? T(tr.workItemId) : undefined } });
    const norm = (v: unknown, side: 'mock' | 'db') => placeholders(normalizeValue(side === 'mock' ? translateIds(v, L.idMap) : v), stableIds(L), { times: true });
    expectSame(diffPaths(norm(m, 'mock'), norm(d, 'db')));
    const jobs = await db.getJobs({} as never);
    expect(jobs.jobs.some((j) => j.type === 'tool.run' && j.status === 'queued')).toBe(true);
    expectSame((await both(L, db, 'getTools', {}, { times: true })).diffs);
  });

  it('patchActivity locks the edited fields; syncCanvas in dry-run renders the payload only', async () => {
    const a = S().activity.find((x) => x.status === 'proposed')!;
    expectSame((await both(L, db, 'patchActivity', { params: { id: a.id }, body: { ifVersion: a.version, patch: { description: 'ACE solution design review', durationH: 1.25 } } }, { times: true })).diffs);
    expectSame((await both(L, db, 'syncCanvas', { body: { confirm: true } }, { times: true })).diffs);
    expectSame((await both(L, db, 'getTime', { query: {} }, { times: true })).diffs);
  });

  it('D-64: the picker\'s Internal on a held row, then Dismiss all from a repo, Undo and Remove: the same rows on both', async () => {
    const held = L.mock.store.get('activity', 'ac_wed_hooli')!;
    expect(held.status).toBe('needs_input');
    const p = await both(L, db, 'patchActivity', { params: { id: held.id }, body: { ifVersion: held.version, patch: { internal: true, status: 'approved' } } }, { times: true });
    expectSame(p.diffs);
    expect((p.raw.mock as { entity: { internal: boolean } }).entity.internal).toBe(true);
    // the seed's repo block: its source names it on both sides (the db from the row's ext, the mock from the row)
    const body = (id: string) => ({ body: { entryId: id } });
    const d = await bothWith('dismissFromSource', body('ac_tue_repo'), body(T('ac_tue_repo')), { times: true });
    expectSame(d.diffs);
    expectSame((await both(L, db, 'listTimeDismissRules', {}, { times: true })).diffs);
    expectSame((await both(L, db, 'getActivityLog', { query: {} }, { times: true })).diffs);
    const ids = d.raw as unknown as { mock: { auditId: string }; db: { auditId: string } };
    await L.mock.undoAudit({ params: { id: ids.mock.auditId }, body: {} } as never);
    await db.undoAudit({ params: { id: ids.db.auditId }, body: {} } as never);
    expectSame((await both(L, db, 'listTimeDismissRules', {}, { times: true })).diffs);
    expectSame((await both(L, db, 'getActivityLog', { query: {} }, { times: true })).diffs);
    expectSame((await bothWith('dismissFromSource', body('ac_tue_repo'), body(T('ac_tue_repo')), { times: true })).diffs);
    expectSame((await both(L, db, 'removeTimeDismissRule', { body: { key: 'repo:demo-kit' } }, { times: true })).diffs);
    expectSame((await both(L, db, 'getActivityLog', { query: {} }, { times: true })).diffs);
  });

  it('claimMissed adds the DC request (one Claim verb); dismissMissed records the reason', async () => {
    const [m1, m2] = S().missedOpps.filter((x) => x.status === 'new');
    const c = await both(L, db, 'claimMissed', { params: { id: m1!.id }, body: {} }, { times: true, shape: noReceipt });
    expectSame(c.diffs);
    expectSame((await both(L, db, 'dismissMissed', { params: { id: m2!.id }, body: { reason: 'not_mine', note: 'Other SE owns it' } }, { times: true })).diffs);
    expectSame((await both(L, db, 'getDeals', {}, { times: true })).diffs);
  });

  it('D-58: createDcRequest → listDcRequests; a second live request is a 409 on both; undo', async () => {
    // not an opp the claimMissed case above already has a DC request on (one request in flight per opp)
    const swept = new Set(S().missedOpps.map((m) => m.oppId));
    const opp = S().opps.find((o) => !o.dcAssigned && o.isOpen && !swept.has(o.id))!;
    // `opp` is a free id field the harness doesn't translate: each side gets its own id
    const body = (id: string, split: number, comment: string) => ({ body: { opp: id, split, comment } });
    const c = await bothWith('createDcRequest', body(opp.id, 50, 'Built the demo for it'), body(T(opp.id), 50, 'Built the demo for it'), { times: true });
    expectSame(c.diffs);
    expectSame((await both(L, db, 'listDcRequests', {}, { times: true })).diffs);
    const dupMock = await L.mock.createDcRequest(body(opp.id, 20, 'again') as never).then(() => null, (e: AppError) => e.code);
    const dupDb = await db.createDcRequest(body(T(opp.id), 20, 'again') as never).then(() => null, (e: AppError) => e.code);
    expect([dupMock, dupDb]).toEqual(['conflict', 'conflict']);
    const ids = c.raw as unknown as { mock: { auditId: string }; db: { auditId: string } };
    await L.mock.undoAudit({ params: { id: ids.mock.auditId }, body: {} } as never);
    await db.undoAudit({ params: { id: ids.db.auditId }, body: {} } as never);
    expectSame((await both(L, db, 'listDcRequests', {}, { times: true })).diffs);
  });

  it('needs you: decideNeed (a DC gap per opp, a Home row) → getDeals / getAccount / getHome drop the rows; undo and clear bring them back, the same on both', async () => {
    const gap = (await L.mock.getDeals({} as never)).needs.find((n) => n.section === 'fix' && n.opps.some((g) => g.onTeam))!;
    const oppId = gap.opps.find((g) => g.onTeam)!.oppId;
    // subjectIds are free id fields the harness doesn't translate: each side gets its own id
    const body = (id: string) => ({ body: { rule: 'dc_gap', subjectIds: [id], kind: 'not_needed', reason: 'Not my deal' } });
    const d = await bothWith('decideNeed', body(oppId), body(T(oppId)), { times: true });
    expectSame(d.diffs);
    expect((d.raw.db as { entity: { decisions: Array<{ baseline: unknown }> } }).entity.decisions[0]!.baseline).toMatchObject({ onTeam: true, hoursQtd: gap.opps.find((g) => g.oppId === oppId)!.hoursQtd, quarter: expect.stringMatching(/^FY\d{2} Q[1-4]$/), at: expect.any(String) }); // DC-30: and its quarter; D-103 (d): the last call and when
    expectSame((await both(L, db, 'listNeedDecisions', {}, { times: true })).diffs);
    expectSame((await both(L, db, 'getDeals', {}, { times: true })).diffs);
    expectSame((await both(L, db, 'getAccount', { params: { accountId: gap.accountId } }, { times: true, shape: (v) => sortAt(['runs'], byId)(sortAt(['items'], byId)(v)) })).diffs);
    expect((await db.getDeals({} as never)).needs.flatMap((n) => n.opps.map((g) => g.oppId))).not.toContain(T(oppId));
    const ids = d.raw as unknown as { mock: { auditId: string }; db: { auditId: string } };
    expect(ids.db.auditId).toBeTruthy();
    await L.mock.undoAudit({ params: { id: ids.mock.auditId }, body: {} } as never);
    await db.undoAudit({ params: { id: ids.db.auditId }, body: {} } as never);
    expectSame((await both(L, db, 'listNeedDecisions', {}, { times: true })).diffs);
    // the missed-opp Dismiss earlier in this file is remembered as a `missed_opp` decision (D-103 (d)); Undo leaves it
    expect((await db.listNeedDecisions({} as never)).decisions.filter((d) => d.rule !== 'missed_opp')).toEqual([]);
    expectSame((await both(L, db, 'getDeals', {}, { times: true })).diffs);
    // a Home Log & fix row: Not now until a date, then brought back with clearNeedDecision
    const home = { body: { rule: 'home:missed_dc', subjectIds: ['gap:missed_dc'], kind: 'snooze', until: new Date(L.now.getTime() + 86_400_000).toISOString() } };
    // the Log & fix count (rows are capped): the set-aside row leaves it on both, and comes back on both
    const fixCount = async (ds: { getHome: DataSource['getHome'] }) => (await ds.getHome({ query: { wide: true } } as never)).sections.find((s) => s.id === 'fix')?.count ?? 0;
    const before = { mock: await fixCount(L.mock), db: await fixCount(db) };
    expect(before.mock).toBe(before.db);
    expectSame((await both(L, db, 'decideNeed', home, { times: true })).diffs);
    expect({ mock: await fixCount(L.mock), db: await fixCount(db) }).toEqual({ mock: before.mock - 1, db: before.db - 1 });
    expectSame((await both(L, db, 'clearNeedDecision', { body: { rule: 'home:missed_dc', subjectIds: ['gap:missed_dc'] } }, { times: true })).diffs);
    expect({ mock: await fixCount(L.mock), db: await fixCount(db) }).toEqual(before);
    expectSame((await both(L, db, 'listNeedDecisions', {}, { times: true })).diffs);
  });

  it('D-58 fix: edit and withdraw a waiting DC request, the same on both (shared rules)', async () => {
    const swept = new Set(S().missedOpps.map((m) => m.oppId));
    const opp = S().opps.find((o) => !o.dcAssigned && o.isOpen && !swept.has(o.id))!;
    const body = (id: string) => ({ body: { opp: id, split: 50, comment: 'Built the demo for it' } });
    const c = await bothWith('createDcRequest', body(opp.id), body(T(opp.id)), { times: true });
    expectSame(c.diffs);
    const raw = c.raw as unknown as { mock: { entity: { id: string } }; db: { entity: { id: string } } };
    const id = { mock: raw.mock.entity.id, db: raw.db.entity.id };
    const e = await bothWith('patchDcRequest', { params: { id: id.mock }, body: { split: 80, comment: 'Built the demo and the sizing' } }, { params: { id: id.db }, body: { split: 80, comment: 'Built the demo and the sizing' } }, { times: true });
    expectSame(e.diffs);
    expect((e.raw as unknown as { db: { entity: { splitPercent: number; kind: string } } }).db.entity).toMatchObject({ splitPercent: 80, kind: 'add' });
    expectSame((await bothWith('withdrawDcRequest', { params: { id: id.mock }, body: {} }, { params: { id: id.db }, body: {} }, { times: true })).diffs);
    expectSame((await both(L, db, 'listDcRequests', {}, { times: true })).diffs);
    // a withdrawn request can't be edited, on both
    const m = await L.mock.patchDcRequest({ params: { id: id.mock }, body: { split: 70 } } as never).then(() => null, (x: AppError) => x.code);
    const d = await db.patchDcRequest({ params: { id: id.db }, body: { split: 70 } } as never).then(() => null, (x: AppError) => x.code);
    expect([m, d]).toEqual(['conflict', 'conflict']);
  });

  it('highlight promote / task / dismiss', async () => {
    const hs = S().briefs.flatMap((b) => b.highlights).filter((h) => h.status === 'new' || h.status === 'seen');
    expectSame((await both(L, db, 'promoteHighlight', { params: { id: hs[0]!.id }, body: { ifVersion: hs[0]!.version } }, { times: true })).diffs);
    expectSame((await both(L, db, 'taskFromHighlight', { params: { id: hs[1]!.id }, body: {} }, { times: true })).diffs);
    expectSame((await both(L, db, 'dismissHighlight', { params: { id: hs[2]!.id }, body: { reason: 'not relevant' } }, { times: true })).diffs);
    expectSame((await both(L, db, 'getBriefs', {}, { times: true })).diffs);
  });

  it('createWatch / patchWatch', async () => {
    expectSame((await both(L, db, 'createWatch', { body: { targetKind: 'search', target: 'zero copy', label: 'Search: zero copy', cadence: 'every_4h', style: 'brief' } }, { times: true })).diffs);
    const w = S().watches[0]!;
    expectSame((await both(L, db, 'patchWatch', { params: { id: w.id }, body: { ifVersion: w.version, patch: { cadence: 'since_last_open', enabled: false } } }, { times: true })).diffs);
    expectSame((await both(L, db, 'listWatches', {}, { times: true })).diffs);
  });

  it('triage accept (mapping, missed opp), dismiss, merge', async () => {
    const [q1, q2] = S().mappings;
    expectSame((await both(L, db, 'acceptTriage', { params: { id: q1!.id }, body: { choiceId: q1!.choices[0]!.id } }, { times: true })).diffs);
    expectSame((await both(L, db, 'dismissTriage', { params: { id: q2!.id }, body: { reason: 'not useful' } }, { times: true })).diffs);
    const triage = await L.mock.getTriage({} as never);
    const mo = triage.groups.flatMap((g) => g.items).find((i) => i.kind === 'missed_opp' && L.idMap.has(i.id));
    if (mo) expectSame((await both(L, db, 'acceptTriage', { params: { id: mo.id }, body: {} }, { times: true })).diffs);
    const wi = triage.groups.flatMap((g) => g.items).filter((i) => i.kind === 'work_item' && L.idMap.has(i.id));
    if (wi.length) {
      const into = item((x) => x.state === 'open' && x.kind === 'ask');
      expectSame((await both(L, db, 'mergeTriage', { params: { id: wi[0]!.id }, body: { intoId: into.id } }, { times: true, shape: noReceipt })).diffs);
    }
    expectSame((await both(L, db, 'getTriage', {}, { times: true })).diffs);
  });

  it('reauthConnector starts catch-up; scanConnector records a run (D-SCAN: queued for the worker, not simulated)', async () => {
    const broken = S().connectors.find((c) => c.state === 'auth_needed' && c.reauth)!;
    expectSame((await both(L, db, 'reauthConnector', { params: { id: broken.id }, body: {} }, { times: true })).diffs);
    const ok = S().connectors.find((c) => c.state === 'ok')!;
    const s = await both(L, db, 'scanConnector', { params: { id: ok.id }, body: { scope: 'manual' } }, { times: true, shape: (v) => dropKeys(v, ['status']) });
    expectSame(s.diffs);
    expect((s.raw.mock as { entity: { status: string } }).entity.status).toBe('running');
    expect((s.raw.db as { entity: { status: string } }).entity.status).toBe('queued');
  });

  it('retryJob / ackEvent (D-UNAUDITED: jobs and app_events are not audited, so no undo id)', async () => {
    const j = S().jobs.find((x) => x.status === 'dead')!;
    const r = await both(L, db, 'retryJob', { params: { id: j.id }, body: {} }, { times: true, shape: (v) => dropKeys(v, ['auditId']) });
    expectSame(r.diffs);
    expect((r.raw.db as { auditId: unknown }).auditId).toBeNull();
    expect((await db.retryJob({ params: { id: L.idMap.get(S().jobs.find((x) => x.status === 'cancelled')!.id)! }, body: {} } as never)).auditId).toBeNull();
    const e = S().eventLog.find((x) => !x.acknowledged)!;
    expectSame((await both(L, db, 'ackEvent', { params: { id: e.id }, body: {} }, { times: true, shape: (v) => dropKeys(v, ['auditId']) })).diffs);
  });

  it('patchSettings: display, budgets (spend follows), dry-run off needs confirm', async () => {
    const s = S().settings;
    expectSame((await both(L, db, 'patchSettings', { params: { section: 'display' }, body: { ifVersion: s.display.version, value: { density: 'compact' } } }, { times: true })).diffs);
    expectSame((await both(L, db, 'patchSettings', { params: { section: 'budgets' }, body: { ifVersion: s.budgets.version, value: { softUsd: 3 } } }, { times: true })).diffs);
    // D-55: the persona section (absent in the seed: both sides read the SE default, version 1)
    expectSame((await both(L, db, 'patchSettings', { params: { section: 'persona' }, body: { ifVersion: 1, value: { id: 'ae', thresholds: { staleNotesDays: 10 } } } }, { times: true })).diffs);
    const e = await bothError('patchSettings', { params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun: false } } });
    expect(e.mock?.code).toBe('validation');
    expect(e.db?.code).toBe('validation');
    expectSame((await both(L, db, 'getHealth', {}, { times: true, shape: (v) => dropKeys(v, ['worker', 'disagreements']) })).diffs); // priority@2: which items disagree depends on the engines' id tie-breaks (mock and db ids differ)
  });

  it('SEC-6: sending.autopilotAssetHosts reads the default list on both sides, and a patch saves the same list', async () => {
    const before = await both(L, db, 'getSettings', {}, { times: true });
    expectSame(before.diffs);
    const cur = before.raw.mock as unknown as { sending: { version: number; autopilotAssetHosts: string[] } };
    expect(cur.sending.autopilotAssetHosts).toContain('docs.google.com');
    expect((before.raw.db as unknown as typeof cur).sending.autopilotAssetHosts).toEqual(cur.sending.autopilotAssetHosts);
    const p = await both(L, db, 'patchSettings', { params: { section: 'sending' }, body: { ifVersion: cur.sending.version, value: { autopilotAssetHosts: ['docs.google.com', 'Loom.com'] } } }, { times: true, shape: (v) => dropKeys(v, ['auditId']) });
    expectSame(p.diffs);
    expect((p.raw.db as { entity: { sending: { autopilotAssetHosts: string[] } } }).entity.sending.autopilotAssetHosts).toEqual(['docs.google.com', 'loom.com']);
    const after = await both(L, db, 'getSettings', {}, { times: true });
    expectSame(after.diffs);
    expect((after.raw.db as unknown as typeof cur).sending.autopilotAssetHosts).toEqual(['docs.google.com', 'loom.com']);
    const bad = await bothError('patchSettings', { params: { section: 'sending' }, body: { ifVersion: cur.sending.version + 1, value: { autopilotAssetHosts: ['1.2.3.4'] } } });
    expect(bad.mock?.code).toBe('validation');
    expect(bad.db?.code).toBe('validation');
  });

  it('D-55 persona switch: the policy reseeds, the record-type override clears, VDP leaves Health, and Undo restores all', async () => {
    // the previous test switched the persona to ae: both sides reseeded the AE starter policy
    const afterAe = await both(L, db, 'getSettings', {}, { times: true });
    expectSame(afterAe.diffs);
    const sAe = afterAe.raw.mock as unknown as { persona: { version: number; id: string }; policy: { role: string; version: number }; time: { version: number } };
    expect(sAe.persona.id).toBe('ae');
    expect(sAe.policy.role).toBe('ae');
    expectSame((await both(L, db, 'getPolicyVersions', {}, { times: true })).diffs);
    // a hand-set record type id, then back to SE: reseeded again, the override cleared, VDP back on Health
    const setRt = await both(L, db, 'patchSettings', { params: { section: 'time' }, body: { ifVersion: sAe.time.version, value: { logging: { mode: 'on_demand', canvas: 'per_batch', autoAt: '17:30', approveComplete: true, sharedCanvasId: null, org62RecordTypeId: '012XX0000000RTYAAA' } } } }, { times: true });
    expectSame(setRt.diffs);
    const sw = await both(L, db, 'patchSettings', { params: { section: 'persona' }, body: { ifVersion: sAe.persona.version, value: { id: 'se' } } }, { times: true, shape: (v) => dropKeys(v, ['auditId']) });
    expectSame(sw.diffs);
    const sSe = sw.raw.mock as unknown as { entity: { persona: { id: string }; policy: { role: string; version: number }; time: { logging: { org62RecordTypeId: string | null } } } };
    expect(sSe.entity.policy.role).toBe('se_ic');
    expect(sSe.entity.policy.version).toBe(sAe.policy.version + 1);
    expect(sSe.entity.time.logging.org62RecordTypeId).toBeNull();
    expect((sw.raw.db as { entity: { time: { logging: { org62RecordTypeId: string | null } } } }).entity.time.logging.org62RecordTypeId).toBeNull();
    expectSame((await both(L, db, 'getHealth', {}, { times: true, shape: (v) => dropKeys(v, ['worker', 'disagreements']) })).diffs); // priority@2: which items disagree depends on the engines' id tie-breaks (mock and db ids differ)
    // Undo on both sides: back to the AE, its policy and the override
    await L.mock.undoAudit({ params: { id: (sw.raw.mock as { auditId: string }).auditId } } as never);
    await db.undoAudit({ params: { id: (sw.raw.db as { auditId: string }).auditId } } as never);
    const undone = await both(L, db, 'getSettings', {}, { times: true });
    expectSame(undone.diffs);
    const u = undone.raw.db as unknown as { persona: { id: string }; policy: { role: string; version: number }; time: { logging: { org62RecordTypeId: string | null } } };
    expect(u.persona.id).toBe('ae');
    expect(u.policy.role).toBe('ae');
    expect(u.policy.version).toBe(sAe.policy.version);
    expect(u.time.logging.org62RecordTypeId).toBe('012XX0000000RTYAAA');
    expectSame((await both(L, db, 'getHealth', {}, { times: true, shape: (v) => dropKeys(v, ['worker', 'disagreements']) })).diffs); // priority@2: which items disagree depends on the engines' id tie-breaks (mock and db ids differ)
    expectSame((await both(L, db, 'getOutbox', {}, { times: true })).diffs);
    // the rest of the suite runs as the SE (the seed's persona)
    const back = await both(L, db, 'patchSettings', { params: { section: 'persona' }, body: { ifVersion: (undone.raw.mock as { persona: { version: number } }).persona.version, value: { id: 'se' } } }, { times: true, shape: (v) => dropKeys(v, ['auditId']) });
    expectSame(back.diffs);
  });

  it('rejectProposal keeps the user value', async () => {
    const w = (await L.mock.listItems({ query: { tab: 'all_open' } } as never)).items.find((x) => x.userLockedFields.includes('title'))!;
    const mm = L.mock.engineUpdateItem(w.id, { title: 'Engine title' }, 'New info: retitle');
    const dd = await db.engineUpdateItem(T(w.id), { title: 'Engine title' }, 'New info: retitle');
    const r = await bothWith('rejectProposal', { params: { id: mm.proposalIds[0] }, body: {} }, { params: { id: dd.proposalIds[0] }, body: {} }, { times: true });
    expectSame(r.diffs);
    expect((await db.getItem({ params: { id: T(w.id) } })).item.title).toBe(w.title);
  });

  it('undo of a capture removes the item', async () => {
    const m = await L.mock.captureItem({ body: { text: 'Throwaway capture' } });
    const d = await db.captureItem({ body: { text: 'Throwaway capture' } });
    const u = await bothWith('undoAudit', { params: { id: m.auditId }, body: {} }, { params: { id: d.auditId }, body: {} }, { times: true, shape: (v) => dropKeys(v, ['changes', 'related', 'receipt']) });
    expectSame(u.diffs);
    await expect(db.getItem({ params: { id: d.entity.id } })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('createChatThread (CONTRACT-1): an untitled thread with its context as auto chips', async () => {
    const acc = S().accounts[0]!;
    const r = await both(L, db, 'createChatThread', { body: { context: [{ type: 'account', id: acc.id, label: acc.name }, { type: 'bogus', id: 'x', label: 'dropped' }] } }, { times: true });
    expectSame(r.diffs);
    expectSame((await both(L, db, 'listChatThreads', {}, { times: true })).diffs);
  });

  it('chat ops (CONTRACT-1): patch / resolve / capture as actor chat land the same item on both sides', async () => {
    type Ops = { patchItem: (id: string, p: unknown, r: string) => unknown; resolveItem: (id: string, r: string, d?: unknown) => unknown; capture: (t: string) => unknown };
    const mockOps = (L.mock as unknown as { chatOps(): Ops }).chatOps();
    const dbOps = db.chatOps();
    const cmp = async (m: unknown, d: unknown) => {
      const norm = (v: unknown, side: 'mock' | 'db') => placeholders(normalizeValue(side === 'mock' ? translateHrefs(translateIds(v, L.idMap), L.idMap) : v), stableIds(L), { times: true });
      // receipts list per-field lines from each side's own change model (D-RCPT); proposals carry runtime ids
      const shape = (v: unknown) => dropKeys(v, ['receipt', 'proposals']);
      expectSame(diffPaths(shape(norm(m, 'mock')), shape(norm(await d, 'db'))));
    };
    const w = item((x) => x.state === 'open' && x.userLockedFields.length === 0 && x.kind === 'task');
    await cmp(mockOps.patchItem(w.id, { notes: 'From chat' }, 'Noted'), dbOps.patchItem(T(w.id), { notes: 'From chat' }, 'Noted'));
    const v = item((x) => x.state === 'open' && x.userLockedFields.length === 0 && x.id !== w.id);
    await cmp(mockOps.resolveItem(v.id, 'not_needed'), dbOps.resolveItem(T(v.id), 'not_needed'));
    await cmp(mockOps.capture('Book the Denver trip ~20m'), dbOps.capture('Book the Denver trip ~20m'));
  });

  it('D-CHAT: POST /chat streams start, then upstream_unavailable until BE-6; both messages persist', async () => {
    const thread = (await db.listChatThreads({} as never)).threads.find((t) => t.isDefault)!;
    const before = (await db.getChatThread({ params: { id: thread.id } })).messages.length;
    const out: { type: string; [k: string]: unknown }[] = [];
    for await (const ev of db.chat({ body: { text: 'What should I do first?', context: [] }, signal: new AbortController().signal } as never)) out.push(ev as never);
    expect(out.map((e) => e.type)).toEqual(['start', 'error']);
    expect(out[0]).toMatchObject({ threadId: thread.id }); // Assistant v2: Auto routing picks the tier
    expect(['haiku', 'sonnet', 'opus']).toContain(out[0]!.model as string);
    expect(out[1]).toEqual({ type: 'error', error: { code: 'upstream_unavailable', message: 'chat backend not wired (BE-6)', retryable: true } });
    const after = await db.getChatThread({ params: { id: thread.id } });
    expect(after.messages).toHaveLength(before + 2);
    const [u, a] = after.messages.slice(-2);
    expect(u).toMatchObject({ id: out[0]!.userMessageId, role: 'user', text: 'What should I do first?' });
    expect(a).toMatchObject({ id: out[0]!.messageId, role: 'assistant', status: 'error', model: out[0]!.model as string, parts: [{ type: 'error', error: { code: 'upstream_unavailable' } }] });
  });

  it('D-81 as amended: a follow-up in a thread routes as a follow-up on both DataSources (previous turn + day line)', async () => {
    const routesOf = async (ds: DataSource) => {
      const thread = await ds.createChatThread({ body: { title: 'Routing parity', context: [] } } as never);
      const send = async (text: string) => {
        const out: { type: string; route?: unknown }[] = [];
        for await (const ev of ds.chat({ body: { threadId: thread.id, text, context: [] }, signal: new AbortController().signal } as never)) out.push(ev as never);
        return out.find((e) => e.type === 'start')!.route;
      };
      return [await send('draft a reply to Dana about the pricing'), await send('make it shorter')];
    };
    const [m, d] = [await routesOf(L.mock), await routesOf(db)];
    expect(m[0]).toMatchObject({ intent: 'draft', model: 'sonnet' });
    expect(m[1]).toMatchObject({ intent: 'draft', tier: 'balanced', model: 'sonnet', why: 'a follow-up to a draft', override: false });
    expect(d).toEqual(m);
  });

  it('D-DEV: dev routes exist only in mock mode', async () => {
    for (const k of ['getScenario', 'controlScenario', 'getDevFail', 'setDevFail', 'devEngineChange'] as const) {
      await expect((db[k] as (i: unknown) => Promise<unknown>).call(db, { body: {} })).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(db.failRate()).toBe(0);
  });

  it('events: an audited write arrives as a live event (pg NOTIFY → SSE)', async () => {
    const ac = new AbortController();
    const seen: { topic: string; ids: string[] }[] = [];
    const iter = db.events({ signal: ac.signal } as never)[Symbol.asyncIterator]();
    const pending = iter.next();
    await new Promise((r) => setTimeout(r, 200));
    const w = (await db.listItems({ query: { tab: 'all_open' } } as never)).items[0]!;
    await db.patchItem({ params: { id: w.id }, body: { ifVersion: w.version, patch: { notes: 'live event check' } } });
    const timeout = () => new Promise<null>((res) => setTimeout(() => res(null), 3000));
    let r = await Promise.race([pending, timeout()]);
    for (let n = 0; r && !r.done && n < 30; n++) {
      seen.push(r.value as { topic: string; ids: string[] });
      if (seen.some((e) => e.topic === 'item' && e.ids.includes(w.id))) break;
      r = await Promise.race([iter.next(), timeout()]);
    }
    ac.abort();
    expect(seen.some((e) => e.topic === 'item' && e.ids.includes(w.id))).toBe(true);
  });
});
