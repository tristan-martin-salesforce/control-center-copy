/**
 * The Needs-you queue (GET /needs, 01 R1) on the mock and on Postgres: the same seed and frozen clock give the same
 * rows per kind, the same row ids (the seed ids translated), the same primary verbs and routes, and a decide through
 * the queue runs the same route with an audit id on both, whose Undo brings the row back. The composition is one pure
 * pass both DataSources run (src/server/datasource/db/needs.ts), so a difference here is a difference in an
 * underlying read. One documented difference: use cases to add (use_case_candidate) are extracted at once on the
 * mock and by the worker's queued `use_cases.extract` job on the db, so a fresh db has none; that kind is compared
 * apart (the db's are a subset of the mock's). DC suggestions are the same (the mock runs the batch at once, the db
 * queues it for the worker): their rows and the verbs they add to a merged row are left out of the comparison.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NeedsPayload, type NeedRow } from '../../../src/contract';
import type { DbHandle } from '../../../src/db/client';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import type { DataSource } from '../../../src/server/datasource/types';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;

const list = async (ds: DataSource) => NeedsPayload.parse(await ds.listNeeds({} as never));
/** A mock row id in the db's ids: `kind:sourceId`, each id segment of the source translated. */
const TAGS = new Set(['vdp', 'new', 'account', 'dep', 'guide']);
const tr = (id: string) => id.split(':').map((p, i) => (i === 0 || TAGS.has(p) ? p : (L.idMap.get(p) ?? p))).join(':');
const QUEUED = new Set(['use_case_candidate', 'dc_suggestion']);
const own = (r: NeedRow) => r.verbs.filter((v) => v.call?.route !== 'decideDcSuggestion' && v.call?.route !== 'decideUseCaseCandidate' && !(v.id === 'edit' && v.feature === 'dealContributions'));
const shapeOf = (r: NeedRow) => ({ kind: r.kind, primary: r.verbs.find((v) => v.primary)?.id, routes: own(r).map((v) => v.call?.route ?? 'href').join(','), groupKey: r.groupKey });

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle);
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
});

afterAll(async () => {
  if (BE1B) await handle?.close();
});

describe.runIf(BE1B)('Needs-you queue parity: mock ↔ db', () => {
  it('the same rows per kind, ids and verbs', async () => {
    const m = await list(L.mock);
    const d = await list(db);
    expect(d.partial).toEqual([]);
    const strip = (b: Record<string, number>) => ({ ...b, use_case_candidate: 0, dc_suggestion: 0 });
    expect(strip(d.byKind)).toEqual(strip(m.byKind));
    for (const k of QUEUED) expect(d.byKind[k as "dc_suggestion"] ?? 0).toBeLessThanOrEqual(m.byKind[k as "dc_suggestion"] ?? 0);
    const mine = new Map(m.rows.filter((r) => !QUEUED.has(r.kind)).map((r) => [tr(r.id), shapeOf(r)]));
    const theirs = new Map(d.rows.filter((r) => !QUEUED.has(r.kind)).map((r) => [r.id, shapeOf(r)]));
    expect([...theirs.keys()].sort()).toEqual([...mine.keys()].sort());
    for (const [id, s] of mine) expect(theirs.get(id), id).toEqual(s);
  });

  it('a decide runs the same route on both, audited, and Undo brings the row back', async () => {
    const m = await list(L.mock);
    const r = m.rows.find((x) => x.kind === 'triage_guess' && x.verbs.find((v) => v.primary)?.id === 'accept');
    expect(r).toBeTruthy();
    const mr = await L.mock.decideNeedRow({ params: { id: r!.id }, body: { verb: 'accept' } } as never);
    const dr = await db.decideNeedRow({ params: { id: tr(r!.id) }, body: { verb: 'accept' } } as never);
    expect(dr.entity.route).toBe(mr.entity.route);
    expect(dr.auditId).toBeTruthy();
    expect((await list(db)).rows.some((x) => x.id === tr(r!.id))).toBe(false);
    await db.undoAudit({ params: { id: dr.auditId! }, body: {} } as never);
    expect((await list(db)).rows.some((x) => x.id === tr(r!.id))).toBe(true);
    await L.mock.undoAudit({ params: { id: mr.auditId! }, body: {} } as never);
  });
});
