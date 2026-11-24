/**
 * D-67 on the mock DataSource: VDP use cases ride the logging batch as Use_Case__c rows, are held by the canvas item
 * until Apply (never on two canvases), come back when it is rejected, and getUseCaseSync shows where each one stands.
 * The Postgres side of the same cases is tests/db/vdp/use-cases-db.test.ts. Placeholders only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, Seed, type RouteKey, type RouteOutput } from '@/contract';
import { ucRowsIn } from '@/engines/activity/use-cases';
import { canvasInputOf } from '@/lib/canvas/payload';
import type { VdpSnapshot } from '@/lib/vdp/types';
import type { Org62UseCase } from '@/engines/activity/use-cases';
import { mockOrg62IdFor } from '@/mock/org62-opps';
import { MockDataSource } from '@/server/datasource/mock';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const fast = { enrichMs: 1e8, stepMs: 1e8, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 };

let ds: MockDataSource;
beforeEach(() => {
  ds = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
});

/**
 * The placeholder seed's opps carry no Org62 link, so the first placeholder VDP lists no opp (and its account has two
 * open opps of mine: the plan never guesses). Link one, as VDP does once the opp is added (D-59 add_opportunity_ids).
 */
function linkFirstVdpOpp(split: number | null = 100): string {
  const snaps = (ds as unknown as { vdpSnapshots(): VdpSnapshot[] }).vdpSnapshots();
  const opp = mockOrg62IdFor('opp_acme_p2');
  snaps[0]!.salesforceOpportunityIds = [opp];
  snaps[0]!.salesforceOpportunityId = opp;
  // D-63: a use case goes only on an open opp with my 100% DC
  const o = ds.store.get('opps', 'opp_acme_p2')!;
  ds.store._set('opps', { ...o, dcAssigned: split !== null, myDc: split === null ? null : { split, role: 'AI + Data Architect', org62DcId: 'a0XXX0000000DC1AAA', lastSeenAt: '2026-11-10T00:00:00.000Z' } });
  return opp;
}

/** What an Org62 read would have found (the mock never calls Org62). */
const setRecords = (records: Org62UseCase[]) => ((ds as unknown as { ucRecords: Org62UseCase[] }).ucRecords = records);
afterEach(() => ds.dispose());

async function call<K extends RouteKey>(key: K, input: unknown): Promise<RouteOutput<K>> {
  const out = await (ds[key as keyof MockDataSource] as (i: unknown) => Promise<unknown>).call(ds, input);
  const r = routes[key].response.safeParse(out);
  if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
  return out as RouteOutput<K>;
}

const markdownOf = async (draftId: string) => {
  const d = (await call('getDraft', { params: { id: draftId } })) as { destination: Parameters<typeof canvasInputOf>[0] };
  return canvasInputOf(d.destination).markdown;
};

describe('VDP use cases on the logging canvas (mock)', () => {
  it('a VDP that lists no opp, on an account with two 100%-DC opps, waits with why (never a guess)', async () => {
    const snaps = (ds as unknown as { vdpSnapshots(): VdpSnapshot[] }).vdpSnapshots();
    snaps[0]!.salesforceOpportunityIds = [];
    snaps[0]!.salesforceOpportunityId = null;
    const s = await call('getUseCaseSync', {});
    expect(s.counts.create).toBe(0);
    expect(s.items.map((x) => [x.state, x.why])).toContainEqual(['skipped', expect.stringMatching(/lists no open opportunity with your 100% DC/)]);
    expect((await call('stageLogBatch', { body: {} })).entity.useCases.rows).toBe(0);
  });

  it('D-63: before my 100% DC on the opp, nothing goes (waiting for the DC, with Claim DC)', async () => {
    linkFirstVdpOpp(50);
    const s = await call('getUseCaseSync', {});
    expect(s.counts.create).toBe(0);
    expect(s.items[0]!.why).toMatch(/Waiting for your 100% DC on ACME · Headless Phase 2/);
  });

  it('getUseCaseSync lists the VDP’s titled use cases as creates, on its opp, with the read time', async () => {
    const opp = linkFirstVdpOpp();
    const s = await call('getUseCaseSync', {});
    expect(s.readAt).toBeTruthy();
    expect(s.items.length).toBeGreaterThanOrEqual(2);
    const creates = s.items.filter((x) => x.state === 'create');
    expect(creates.map((x) => x.title)).toEqual(['Unified customer profile', 'Service agent deflection']);
    expect(creates.every((x) => x.oppName === 'ACME · Headless Phase 2' && x.org62OpportunityId === opp)).toBe(true);
    expect(s.counts.create).toBe(2);
  });

  it('a batch carries them (one USE CASES TO CREATE table, OwnerId me), a second batch never repeats them, a reject frees them', async () => {
    linkFirstVdpOpp();
    const first = await call('stageLogBatch', { body: {} });
    expect(first.entity.useCases).toEqual({ rows: 2, later: 0 });
    const ids = first.entity.draftIds;
    const mds = await Promise.all(ids.map(markdownOf));
    const rows = mds.flatMap((m) => ucRowsIn(m).creates);
    expect(rows.map((r) => r.name)).toEqual(['Unified customer profile', 'Service agent deflection']);
    const md = mds.find((m) => m.includes('## USE CASES TO CREATE ('))!;
    expect(md).toMatch(/\*\*USE CASES TO CREATE:\*\* create one Use_Case__c per row with OwnerId `005XX0000000MOCKAA`/);
    expect(md).toContain('|Data Cloud|D360 Custom|Flex|');
    expect(md).toContain('|Agentforce|Agentforce Custom|Flex|');

    // held: listed as on a canvas, and not on the next batch
    const held = await call('getUseCaseSync', {});
    expect(held.items.filter((x) => x.state === 'in_canvas').map((x) => x.canvasDraftId)).toEqual(expect.arrayContaining([expect.stringMatching(/.+/)]));
    expect(held.counts.create).toBe(0);
    const canvas = (await call('getTime', { query: {} })).logCanvases.find((c) => ids.includes(c.draftId) && c.useCases > 0);
    expect(canvas?.useCases).toBe(2);

    // reject the canvas that carries them: they wait again
    const holder = ids[mds.findIndex((m) => m.includes('## USE CASES TO CREATE ('))]!;
    await call('rejectDraft', { params: { id: holder }, body: {} });
    expect((await call('getUseCaseSync', {})).counts.create).toBe(2);
  });

  it('a Use_Case__c no VDP use case is: an org62_only row and a create_use_case item under the VDP in the tree', async () => {
    const opp = linkFirstVdpOpp();
    setRecords([{ id: 'a1XXX0000000UCOAAA', opportunityId: opp, accountId: null, name: 'Claims triage agent', ownerId: '005XX0000000OTHAAA', createdById: '005XX0000000OTHAAA', stage: 'U02 - Ideation', goLive: null, product: 'Agentforce', createdAt: '2026-11-01T00:00:00.000Z', goneAt: null }]);
    const s = await call('getUseCaseSync', {});
    expect(s.items.find((x) => x.key === 'rec:a1XXX0000000UCO')).toMatchObject({ state: 'org62_only', track: 'agentforce', options: ['leave'] });
    const cov = await call('getVdpCoverage', {});
    const step = cov.vdps.flatMap((v) => v.steps).find((x) => x.apply?.key.endsWith(':org62_use_case:a1XXX0000000UCO'))!;
    expect(step).toMatchObject({ kind: 'create_use_case', section: 'use_cases', policy: 'suggest' });
    const node = cov.tree.flatMap((c) => c.vdps).find((v) => v.key === 'acme-corp-1')!;
    expect(node.sections.find((x) => x.kind === 'use_cases')!.items.map((i) => i.key)).toContain(step.apply!.key);
    // staged from the item (the user's push values), with Org62's title and track
    const staged = await call('draftVdpUpdate', { body: { itemKey: step.apply!.key, values: { priority: '3 - High', division: 'Service', persona: 'Ops lead', details_input: 'Placeholder details.' } } });
    expect(staged.entity.destination).toMatchObject({ action: 'vdp.create_use_case', input: { track: 'agentforce' } });
    // Leave it: the row is left as it is and the VDP item goes
    await call('decideNeed', { body: { rule: 'use_case', subjectIds: ['rec:a1XXX0000000UCO'], kind: 'not_needed', reason: 'Not ours' } });
    expect((await call('getUseCaseSync', {})).items.find((x) => x.key === 'rec:a1XXX0000000UCO')!.state).toBe('left');
  });

  it('a new use case whose title either system already has is refused (409), never staged', async () => {
    linkFirstVdpOpp();
    const slug = (ds as unknown as { vdpSnapshots(): VdpSnapshot[] }).vdpSnapshots()[0]!.slug;
    await expect(call('draftVdpUpdate', { body: { vdpSlug: slug, op: 'create_use_case', field: 'title', value: 'unified customer profile' } })).rejects.toThrow(/Already a use case: “Unified customer profile” on VDP/);
    setRecords([{ id: 'a1XXX0000000UCOAAA', opportunityId: mockOrg62IdFor('opp_acme_p2'), accountId: null, name: 'Claims triage agent', ownerId: '005XX0000000OTHAAA', createdById: null, stage: null, goLive: null, product: 'Agentforce', createdAt: null, goneAt: null }]);
    await expect(call('draftVdpUpdate', { body: { vdpSlug: slug, op: 'create_use_case', field: 'title', value: 'Claims Triage Agent' } })).rejects.toThrow(/in Org62/);
    const ok = await call('draftVdpUpdate', { body: { vdpSlug: slug, op: 'create_use_case', field: 'title', value: 'Lead scoring' } });
    expect(ok.entity.destination.kind).toBe('action');
    // and the staged one is now "on its way": a second one is refused too
    await expect(call('draftVdpUpdate', { body: { vdpSlug: slug, op: 'create_use_case', field: 'title', value: 'lead scoring' } })).rejects.toThrow(/staged for VDP/);
  });

  it('the AE preset (VDP not in its preconfiguration) takes no use cases', async () => {
    linkFirstVdpOpp();
    const s = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s.persona.version, value: { id: 'ae' } } } as never);
    expect((await ds.getSettings({} as never)).persona.id).toBe('ae');
    const r = await call('stageLogBatch', { body: {} });
    expect(r.entity.useCases.rows).toBe(0);
    for (const id of r.entity.draftIds) expect(await markdownOf(id)).not.toContain('Use_Case__c');
  });
});
