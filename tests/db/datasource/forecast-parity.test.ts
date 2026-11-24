/**
 * Parity for Time ▸ Forecast (lane A): the mock's placeholder Specialist Forecasts loaded into `specialist_forecasts`
 * (same ids; opp and account ids translated), both DataSources switched to the AE persona, then the same reads and
 * writes on both, compared after the standard normalizations: getForecast (the queue, Deal Role fixes, the missing
 * record), getForecastRecord, patchForecast (edit, approve, a Deal Role fix), the placeholder drafts (the mock drafts
 * at once; the db's queued `forecast.draft` jobs run with the fake model), and stageForecast (ONE canvas, then
 * nothing staged twice). Expected differences, normalized away: `mode` (mock / live), the sync line (the mock has no
 * Org62 read), what is left of today's budget, and the canvas's footer label.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../../../src/db/client';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { specialistForecasts } from '../../../src/db/schema';
import { runForecastDraftJob } from '../../../src/jobs/handlers/forecast-sync';
import type { JobContext } from '../../../src/jobs/types';
import { DbDataSource } from '../../../src/server/datasource/db';
import { interimRanker } from '../../../src/server/datasource/db/rank';
import { MOCK_OWNER_ORG62_ID } from '../../../src/server/forecast/mock-records';
import { BE1B, loadBoth, openTestDb, type Loaded } from './helpers';
import { both } from './parity';

let handle: DbHandle;
let L: Loaded;
let db: DbDataSource;

/** The documented differences: the mock has no Org62 read and no budget line. */
const shape = (v: unknown): unknown => {
  if (!v || typeof v !== 'object') return v;
  const o = { ...(v as Record<string, unknown>) };
  if ('mode' in o && 'sync' in o) {
    delete o.mode;
    delete o.sync;
    o.drafting = { ...(o.drafting as Record<string, unknown>), dayLeftUsd: 0 };
  }
  return o;
};

/** Runtime ids the shared normalizer leaves (the mock's `d_…` drafts) and the placeholders it made: one token. */
const runtimeIds = (v: unknown): unknown =>
  typeof v === 'string' ? (/^(d_[A-Za-z0-9_-]{6,}|<id\d+>)$/.test(v) ? '<rid>' : v) : Array.isArray(v) ? v.map(runtimeIds) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, runtimeIds(x)])) : v;
const staged = (v: unknown): unknown => runtimeIds(shape(v));

async function setAe(ds: { getSettings: (i: never) => Promise<{ persona: { version: number } }>; patchSettings: (i: never) => Promise<unknown> }) {
  const s = await ds.getSettings({} as never);
  await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s.persona.version, value: { id: 'ae' } } } as never);
}

beforeAll(async () => {
  if (!BE1B) return;
  handle = openTestDb();
  L = await loadBoth(handle);
  db = new DbDataSource({ handle, userId: L.userId, clock: { now: () => L.now }, ranker: interimRanker });
  await setAe(L.mock as never);
  await setAe(db as never);
  // the mock's placeholder records → the mirror (same record ids; the seed's opp and account ids translated)
  const recs = L.mock.forecast.all();
  for (const r of recs) {
    await handle.db.insert(specialistForecasts).values({
      id: r.id,
      ownerUserId: L.userId,
      org62Id: r.org62Id,
      name: r.name,
      url: r.url,
      org62OpportunityId: r.org62OpportunityId,
      opportunityId: r.opportunityId ? (L.idMap.get(r.opportunityId) ?? null) : null,
      accountId: r.accountId ? (L.idMap.get(r.accountId) ?? null) : null,
      opportunityName: r.opportunityName,
      accountName: r.accountName,
      oppStage: r.oppStage,
      oppNextStep: r.oppNextStep,
      oppCloseDate: r.oppCloseDate,
      notes: r.notes,
      prevNotes: r.prevNotes,
      mgrNotes: r.mgrNotes,
      dealRole: r.dealRole,
      judgement: r.judgement,
      forecastStatus: r.forecastStatus,
      amount: r.amount,
      stage: r.stage,
      closeDate: r.closeDate,
      fiscalQuarter: r.fiscalQuarter,
      ownerOrg62Id: r.ownerOrg62Id,
      lastModifiedAt: r.lastModifiedAt ? new Date(r.lastModifiedAt) : null,
      notesUpdatedAt: r.notesUpdatedAt ? new Date(r.notesUpdatedAt) : null,
      syncedAt: new Date(r.syncedAt),
    });
  }
  // the canvas names the same owner on both sides
  await withChangeSet({ db: handle.db, userId: L.userId, actor: actors.system('forecast-parity'), reason: 'test fixture: the placeholder Org62 user id' }, async (tx) => {
    await tx.execute(sql`insert into person_identities (owner_user_id, person_id, system, external_id, method)
                         select ${L.userId}, u.person_id, 'org62_user', ${MOCK_OWNER_ORG62_ID}, 'user' from users u where u.id = ${L.userId}
                         and not exists (select 1 from person_identities pi where pi.person_id = u.person_id and pi.system = 'org62_user')`);
  });
});

afterAll(async () => {
  if (!BE1B) return;
  L?.mock.dispose();
  await db?.dispose();
  await handle?.close();
});

const ctxFor = (recordId: string, id: number): JobContext =>
  ({ job: { id, ownerUserId: L.userId, kind: 'forecast.draft', queue: 'forecast', payload: { recordId }, attempts: 1, maxAttempts: 1, timeoutSeconds: 300, generation: null, dedupeKey: null, correlationId: null, cancelRequestedAt: null }, signal: new AbortController().signal, db: handle.db, userId: L.userId, clock: () => L.now, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({}) as never, services: {} }) as unknown as JobContext;

describe.runIf(BE1B)('Time ▸ Forecast parity: mock ↔ db on the same Specialist Forecasts', () => {
  it('getForecast: the queue, the Deal Role fixes, the missing record, the table', async () => {
    const r = await both(L, db, 'getForecast', {}, { shape });
    expect(r.diffs, r.diffs.join('\n')).toEqual([]);
    const v = r.raw.db as { active: boolean; counts: { due: number; roles: number; missing: number } };
    expect(v.active).toBe(true);
    expect(v.counts).toMatchObject({ due: 3, roles: 2, missing: 1 });
  });

  it('getDeals for an AE: the summary and pipeline count the same Specialist Forecasts, at ForecastAmount__c', async () => {
    const r = await both(L, db, 'getDeals', {});
    expect(r.diffs, r.diffs.join('\n')).toEqual([]);
    const p = (r.raw.db as { pipeline: { basis: string; amountField: { field: string }; summary: { open: { amount: number; count: number } }; rows: Array<{ forecastId: string | null }> } }).pipeline;
    expect(p).toMatchObject({ basis: 'specialist_forecast', amountField: { field: 'SpecialistForecast__c.ForecastAmount__c' } });
    const recs = L.mock.forecast.all();
    expect(p.rows.map((x) => x.forecastId).sort()).toEqual(recs.map((x) => x.id).sort());
    expect(p.summary.open.amount).toBe(recs.reduce((s, x) => s + (x.amount ?? 0), 0));
  });

  it('getForecastRecord for every record', async () => {
    for (const rec of L.mock.forecast.all()) {
      const r = await both(L, db, 'getForecastRecord', { params: { id: rec.id } }, { times: true });
      expect(r.diffs, `${rec.name}\n${r.diffs.join('\n')}`).toEqual([]);
    }
  });

  it('patchForecast: write a note, approve it, approve a Deal Role fix, discard', async () => {
    const [a, b, , d] = L.mock.forecast.all();
    for (const [id, body] of [
      [a!.id, { notes: 'Compelling event: placeholder · In quarter: yes · Next step: order form · Risk: none' }],
      [a!.id, { notesState: 'approved' }],
      [d!.id, { dealRole: 'Assist' }],
      [b!.id, { notes: 'to be discarded' }],
      [b!.id, { discardNotes: true }],
    ] as const) {
      const r = await both(L, db, 'patchForecast', { params: { id }, body }, { times: true });
      expect(r.diffs, `${JSON.stringify(body)}\n${r.diffs.join('\n')}`).toEqual([]);
    }
    const v = await both(L, db, 'getForecast', {}, { shape, times: true });
    expect(v.diffs, v.diffs.join('\n')).toEqual([]);
  });

  it('Draft all: the mock drafts at once; the db queues jobs, which the fake model drafts the same way', async () => {
    const m = await L.mock.draftForecastNotes({ body: {} } as never);
    const d = await db.draftForecastNotes({ body: {} } as never);
    expect(d.entity.queued).toEqual(m.entity.drafted);
    expect(d.entity.skipped).toEqual(m.entity.skipped);
    let n = 100;
    for (const id of d.entity.queued) expect(await runForecastDraftJob(ctxFor(id, (n += 1)), { live: false })).toMatchObject({ drafted: true });
    await handle.db.execute(sql`delete from jobs where kind = 'forecast.draft'`);
    const v = await both(L, db, 'getForecast', {}, { shape, times: true });
    expect(v.diffs, v.diffs.join('\n')).toEqual([]);
  });

  it('stageForecast: ONE canvas, then nothing is staged twice', async () => {
    const first = await both(L, db, 'stageForecast', { body: {} }, { times: true, shape: staged });
    expect(first.diffs, first.diffs.join('\n')).toEqual([]);
    expect(first.raw.db).toMatchObject({ entity: { notes: 1, roles: 1 } });
    const again = await both(L, db, 'stageForecast', { body: {} }, { times: true, shape: staged });
    expect(again.diffs, again.diffs.join('\n')).toEqual([]);
    expect(again.raw.db).toMatchObject({ entity: { draftId: null, waiting: { updates: 2 } } });
    const v = await both(L, db, 'getForecast', {}, { shape: staged, times: true });
    expect(v.diffs, v.diffs.join('\n')).toEqual([]);
  });
});
