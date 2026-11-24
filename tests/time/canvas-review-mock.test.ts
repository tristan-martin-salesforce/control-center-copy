/**
 * 2026-11-13 audit B1 + B2 (and B4) on the mock DataSource: ONE canvas per batch (rows, DCs and VDP use cases together), and
 * the review before Apply: every row by kind, read from the work order; Remove (back to waiting) and Edit (kept on
 * the row's record, the work order re-rendered), each undoable; an edit after the preview invalidates its confirm.
 * The Postgres side is tests/time/canvas-review-db.test.ts. Placeholders only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, Seed, type RouteKey, type RouteOutput } from '@/contract';
import { ucRowsIn } from '@/engines/activity/use-cases';
import { canvasInputOf } from '@/lib/canvas/payload';
import type { VdpSnapshot } from '@/lib/vdp/types';
import { mockOrg62IdFor } from '@/mock/org62-opps';
import { MockDataSource } from '@/server/datasource/mock';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const fast = { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 };

let ds: MockDataSource;
beforeEach(() => {
  ds = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
});
afterEach(() => ds.dispose());

async function call<K extends RouteKey>(key: K, input: unknown): Promise<RouteOutput<K>> {
  const out = await (ds[key as keyof MockDataSource] as (i: unknown) => Promise<unknown>).call(ds, input);
  const r = routes[key].response.safeParse(out);
  if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
  return out as RouteOutput<K>;
}

/** The placeholder VDP lists the opp with my 100% DC (as VDP does once the opp is added), so its use cases go. */
function linkFirstVdpOpp(): void {
  const snaps = (ds as unknown as { vdpSnapshots(): VdpSnapshot[] }).vdpSnapshots();
  const opp = mockOrg62IdFor('opp_acme_p2');
  snaps[0]!.salesforceOpportunityIds = [opp];
  snaps[0]!.salesforceOpportunityId = opp;
  const o = ds.store.get('opps', 'opp_acme_p2')!;
  ds.store._set('opps', { ...o, dcAssigned: true, myDc: { split: 100, role: 'AI + Data Architect', org62DcId: 'a0XXX0000000DC1AAA', lastSeenAt: '2026-11-10T00:00:00.000Z' } });
}

const markdownOf = async (draftId: string) => canvasInputOf(((await call('getDraft', { params: { id: draftId } })) as { destination: Parameters<typeof canvasInputOf>[0] }).destination).markdown;

/** A staged batch with Event rows, one DC request and the VDP's two use cases. */
async function staged() {
  linkFirstVdpOpp();
  await call('createDcRequest', { body: { opp: 'opp_umbrella_af', split: 100, comment: 'Built the POC with the customer team' } });
  const b = await call('stageLogBatch', { body: {} });
  expect(b.entity.draftIds).toHaveLength(1); // B1: one canvas per batch
  const id = b.entity.draftIds[0]!;
  return { id, review: await call('getCanvasReview', { params: { id } }) };
}

describe('B1: one canvas per batch (mock)', () => {
  it('rows, the DC and the use cases ride on ONE canvas, titled with what it carries', async () => {
    const { id, review } = await staged();
    expect(review.counts.events).toBeGreaterThan(0);
    expect(review.counts.dcs).toBe(1);
    expect(review.counts.useCases).toBe(2);
    expect(review.title).toMatch(/^Activity log · .+ · \d+ rows? · 1 DC · 2 use cases$/);
    expect(ucRowsIn(await markdownOf(id)).creates).toHaveLength(2);
  });
});

describe('B2: the review before Apply (mock)', () => {
  it('lists every row by kind with the fields Slackbot sets, read from the work order', async () => {
    const { id, review } = await staged();
    const md = await markdownOf(id);
    expect(review.editable).toBe(true);
    expect(review.bytes).toBe(new TextEncoder().encode(md).length);
    const e = review.events[0]!;
    expect(e.entry?.id).toBe(e.entryId);
    expect(md).toContain(`|${e.n}|${e.subject}|${e.startUtc}|${e.endUtc}|`);
    expect(e.note).not.toMatch(/CC#/);
    expect(review.dcs[0]).toMatchObject({ kind: 'add', split: 100, comment: 'Built the POC with the customer team', requestId: expect.any(String) });
    expect(review.useCases.map((u) => u.name)).toEqual(['Unified customer profile', 'Service agent deflection']);
    expect(review.useCases[0]!.source).toMatch(/^Source: VDP .* · CC-UC#/);
    expect(review.options.ucStages).toContain('U03 - Scoping');
  });

  it('Remove: the row leaves the canvas and goes back to waiting; Undo puts it back', async () => {
    const { id, review } = await staged();
    const ev = review.events[0]!;
    const uc = review.useCases[0]!;
    const dc = review.dcs[0]!;
    const r = await call('removeCanvasRows', { params: { id }, body: { ifVersion: review.version, keys: [ev.key, uc.key, dc.key] } });
    expect(r.entity.version).toBe(review.version + 1);
    expect(r.entity.counts).toMatchObject({ events: review.counts.events - 1, dcs: 0, useCases: 1 });
    expect(r.entity.title).toMatch(/ · 1 use case$/);
    const md = await markdownOf(id);
    expect(md).not.toContain(`CC#${ev.entryId}`);
    expect(md).not.toContain('## DEAL CONTRIBUTIONS TO CREATE');
    // back to waiting: the Event is approved and free for the next batch, the use case and the DC wait again
    const row = (await call('getTime', { query: {} })).entries.find((x) => x.id === ev.entryId);
    if (row) expect(row.canvasDraftId).toBeUndefined();
    expect(ds.store.get('activity', ev.entryId!)!.status).toBe('approved');
    expect((await call('getUseCaseSync', {})).counts.create).toBe(1);
    expect((await call('listDcRequests', {})).requests.find((x) => x.id === dc.requestId)?.stage).toBe('waiting');
    await call('undoAudit', { params: { id: r.auditId! }, body: {} });
    const back = await call('getCanvasReview', { params: { id } });
    expect(back.counts).toEqual(review.counts);
    expect((await call('getUseCaseSync', {})).counts.create).toBe(0);
  });

  it('never empties a canvas (Reject it instead), and refuses a stale version', async () => {
    const { id, review } = await staged();
    const all = [...review.events, ...review.dcs, ...review.useCases, ...review.updates].map((x) => x.key);
    await expect(call('removeCanvasRows', { params: { id }, body: { ifVersion: review.version, keys: all } })).rejects.toThrow(/Reject the canvas instead/);
    await expect(call('removeCanvasRows', { params: { id }, body: { ifVersion: review.version + 9, keys: [all[0]] } })).rejects.toThrow(/changed since you opened it/);
  });

  it('Edit an Event: kept on the Time row (hours, note) and the line re-rendered; the old confirm no longer applies', async () => {
    const { id, review } = await staged();
    const pv = await call('previewDraft', { params: { id }, body: { mode: 'send' } });
    const ev = review.events[0]!;
    const r = await call('editCanvasRow', { params: { id }, body: { ifVersion: review.version, key: ev.key, event: { entryVersion: ev.entry!.version, durationH: 2.5, note: 'Walked the team through the demo. Next step: pricing' } } });
    const after = r.entity.events.find((x) => x.key === ev.key)!;
    expect(after).toMatchObject({ hours: 2.5, note: 'Walked the team through the demo. Next step: pricing' });
    const row = ds.store.get('activity', ev.entryId!)!;
    expect(row).toMatchObject({ durationH: 2.5, logNote: 'Walked the team through the demo. Next step: pricing' });
    expect(row.userLockedFields).toEqual(expect.arrayContaining(['durationH', 'logNote']));
    // still on this canvas (an edit from the review does not unstage the row)
    expect(await markdownOf(id)).toContain(`Walked the team through the demo. Next step: pricing · CC#${ev.entryId}`);
    // Apply uses the latest payload: the confirm made before the edit is refused
    await expect(call('dispatchDraft', { params: { id }, body: { ifVersion: pv.version, mode: 'send', confirmToken: pv.confirmToken } })).rejects.toThrow();
    await expect(call('dispatchDraft', { params: { id }, body: { ifVersion: r.entity.version, mode: 'send', confirmToken: pv.confirmToken } })).rejects.toThrow(/confirm/i);
    // a stale row version is a conflict
    await expect(call('editCanvasRow', { params: { id }, body: { ifVersion: r.entity.version, key: ev.key, event: { entryVersion: ev.entry!.version, durationH: 1 } } })).rejects.toThrow();
  });

  it('Edit a DC (split) and a use case (name, stage): kept on the request and the override, survive a reject and re-stage', async () => {
    const { id, review } = await staged();
    const dc = review.dcs[0]!;
    const r1 = await call('editCanvasRow', { params: { id }, body: { ifVersion: review.version, key: dc.key, dc: { split: 50, comment: 'Shared the POC with the partner SE' } } });
    expect(r1.entity.dcs[0]).toMatchObject({ split: 50, comment: 'Shared the POC with the partner SE' });
    expect(ds.store.get('dcRequests', dc.requestId!)).toMatchObject({ splitPercent: 50, comment: 'Shared the POC with the partner SE' });
    const uc = r1.entity.useCases[0]!;
    const r2 = await call('editCanvasRow', { params: { id }, body: { ifVersion: r1.entity.version, key: uc.key, useCase: { name: 'Unified customer profile (pilot)', stage: 'U04 - Validation', notes: 'Pilot first in one region' } } });
    const u = r2.entity.useCases.find((x) => x.key === uc.key)!;
    expect(u).toMatchObject({ name: 'Unified customer profile (pilot)', stage: 'U04 - Validation', notes: 'Pilot first in one region', source: uc.source });
    await expect(call('editCanvasRow', { params: { id }, body: { ifVersion: r2.entity.version, key: uc.key, useCase: { stage: 'Discovery' } } })).rejects.toThrow(/one of Org62's values/);
    // reject and stage again: the edits are on their records, so the next canvas has them
    await call('rejectDraft', { params: { id }, body: {} });
    const again = await call('stageLogBatch', { body: {} });
    const md = await markdownOf(again.entity.draftIds[0]!);
    expect(md).toContain('|Unified customer profile (pilot)|');
    expect(md).toContain('|U04 - Validation|');
    expect(md).toMatch(/## DEAL CONTRIBUTIONS TO CREATE[^]*\n\|\d+\|[^|]+\|[^|]+\|AI \+ Data Architect\|50\|/);
  });
});

describe('B4: an old proposal never overwrites newer data (mock)', () => {
  it('applies while its field is what it was proposed over; refuses once you changed that field', async () => {
    const w = ds.store.get('workItems', 'w_priya_forecast')!;
    // another field moved the item on: the proposal still applies to its own field
    await call('patchItem', { params: { id: w.id }, body: { ifVersion: w.version, patch: { title: `${w.title} (Q4)` } } });
    expect((await call('applyProposal', { params: { id: 'prop_priya_due' }, body: {} })).entity.status).toBe('applied');
  });

  it('a due date you set after the proposal is kept: 409, nothing applied', async () => {
    const w = ds.store.get('workItems', 'w_priya_forecast')!;
    await call('patchItem', { params: { id: w.id }, body: { ifVersion: w.version, patch: { due: '2026-11-06T16:00:00.000Z' } } });
    await expect(call('applyProposal', { params: { id: 'prop_priya_due' }, body: {} })).rejects.toThrow(/Changed since this was proposed/);
    expect(ds.store.get('workItems', 'w_priya_forecast')!.due).toBe('2026-11-06T16:00:00.000Z');
  });
});
