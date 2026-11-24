/**
 * VDP ▸ Changes and the badges, against the real mock DataSource (placeholder seed, never the real VDP):
 *   - every badge points at what it counts (the sidebar's Time number is the sum of the main tabs' badges)
 *   - a change the Assistant stages shows on the tree as staged, live
 *   - D-63, the tree (Company → VDP → items): the three shapes, the selection rules (a node ticks what is under it, a
 *     child of an unborn parent ticks its ancestors, unticking an unborn parent unticks its subtree, disabled and
 *     unfilled rows are skipped), the push order and request
 *   - D-63, the chained push: dependency order, new ids passed down, failure isolation, dry-run placeholders,
 *     idempotency (a re-push never creates a second company or VDP), each item its own Outbox item
 *   - withdrawn and stale staged changes; the mock side of the autopilot parity
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Draft, LiveEvent, VdpCoveragePayload } from '../../src/contract';
import { goneVdpDrafts, isStaleVdpDraft, VDP_STALE_AFTER_MS } from '../../src/engines/vdp/status';
import { timeBadges } from '../../src/components/time/badges';
import { canPush, pushableKeys, pushOrder, pushProgress, pushRequest, tickState, toggleRow, treeRows, whyNot, type TreeRow } from '../../src/components/time/vdp-tree-derive';
import { vdpActionPayload } from '../../src/lib/vdp/payload';
import { SimulatedOutboxTransport } from '../../src/outbox';
import { createMockDataSource } from '../../src/server/datasource/mock';

type Ds = ReturnType<typeof createMockDataSource>;
let ds: Ds;

beforeEach(() => {
  ds = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, reevalMs: 1e8, stepMs: 1e8, verifyMs: 1e8, chatTokenMs: 0 } });
  ds.clock.freeze(new Date(ds.loaded.seed.meta.asOf));
  ds.resetStore();
});
afterEach(() => ds.dispose());

const cov = () => ds.getVdpCoverage({} as never);
const rowsOf = async () => treeRows((await cov()).tree);
const byKey = (rows: TreeRow[], key: string) => rows.find((r) => r.key === key)!;
const NONE = {};
const live = async () => {
  const s = await ds.getSettings({} as never);
  await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun: false }, confirm: true } } as never);
};
const payloadOf = (d: Draft) => vdpActionPayload(d.destination as never);

describe('every badge points at what it counts', () => {
  it('the sidebar number is the sum of the main tabs; both waiting: the larger one, both tabs counted', () => {
    const b = timeBadges({ adminWaiting: 5, vdpOpen: 3, adminBySurface: { log: 1, forecast: 0, vdp: 4 } });
    expect(b).toMatchObject({ sidebar: 5, attn: true, time: 1, vdp: 4, log: 1, changes: 4, href: '/activity?view=vdp' });
    expect(b.time + b.vdp).toBe(b.sidebar);
    expect(timeBadges({ adminWaiting: 0, vdpOpen: 3, adminBySurface: { log: 0, forecast: 0, vdp: 0 } })).toMatchObject({ sidebar: 3, attn: false, vdp: 3, time: 0, href: '/activity?view=vdp' });
  });

  it('one staged VDP change: the badge is 1, it lands on VDP ▸ Changes, and the tree shows that change staged', async () => {
    await ds.draftVdpUpdate({ body: { itemKey: 'acme-corp-1:owners:ta', values: {} } } as never);
    const today = await ds.getToday({ query: {} } as never);
    expect(today.navCounts.adminBySurface.vdp).toBe(1);
    expect(timeBadges(today.navCounts)).toMatchObject({ href: '/activity?view=vdp', changes: 1 });
    expect((await rowsOf()).filter((r) => r.step?.state === 'staged').map((r) => r.key)).toEqual(['acme-corp-1:owners:ta']);
  });
});

describe('a change the Assistant stages shows on Changes, live', () => {
  it('draftVdpUpdate with the item key → the same row turns staged, with its draft; the Outbox events fire', async () => {
    const seen: LiveEvent[] = [];
    const off = ds.bus.subscribe((e) => seen.push(e));
    const made = (await ds.draftVdpUpdate({ body: { itemKey: 'opp:opp_acme_af:add', values: {} } } as never)).entity;
    off();
    const after = byKey(await rowsOf(), 'opp:opp_acme_af:add');
    expect(after.step).toMatchObject({ state: 'staged', draftId: made.draft.id });
    expect(seen.some((e) => e.topic === 'draft' || e.topic === 'outbox')).toBe(true);
  });
});

describe('D-63: the tree (Company → VDP → items)', () => {
  it('the three shapes: VDP lacks the company · VDP knows it, no VDP · both exist (only what is missing); D-69 each node’s company identity', async () => {
    const c = await cov();
    expect(c.tree.map((x) => [x.companyName, x.exists, x.node?.key ?? null, x.vdps.map((v) => [v.exists, v.node?.key ?? null])])).toEqual([
      ['Initech', false, 'account:acc_initech:create_company', [[false, 'account:acc_initech:create_vdp']]],
      ['Nexus Care', false, 'account:acc_nexus:create_company', [[false, 'account:acc_nexus:create_vdp']]],
      ['Cyberdyne Systems', true, null, [[false, 'account:acc_cyberdyne:create_vdp']]],
      ['Globex', true, null, [[false, 'account:acc_globex:create_vdp']]],
      ['Soylent Corporation', true, null, [[false, 'account:acc_soylent:create_vdp']]],
      ['ACME Corp', true, null, [[true, null]]],
    ]);
    const idOf = (name: string) => c.tree.find((x) => x.companyName === name)!.identity;
    // a " - Marketing Cloud" child joins its parent's company and VDP: one create_vdp for both accounts' opps
    expect(idOf('Globex')).toMatchObject({ state: 'resolved', by: 'name', deterministic: true, accounts: [{ id: 'acc_globex' }, { id: 'acc_globex_mc' }] });
    expect(c.notInVdp.find((r) => r.key === 'account:acc_globex')!.step.apply!.fields.find((f) => f.field === 'salesforce_opportunity_ids')!.suggested).toEqual(['006XXoppglobexdAAA', '006XXoppglobmcdAAA']);
    // a subsidiary brand under a parent VDP has: kept separate, by the judgment (a suggestion, never autopilot's)
    expect(idOf('Nexus Care')).toMatchObject({ state: 'resolved', by: 'judgment', deterministic: false, pick: { kind: 'create', name: 'Nexus Care' } });
    // two VDP companies with one name: Needs you, its best guess pre-selected, nothing under it pushable
    expect(idOf('Cyberdyne Systems')).toMatchObject({ state: 'needs_you', pick: { kind: 'match', name: 'Cyberdyne Systems' } });
    expect(c.notInVdp.find((r) => r.key === 'account:acc_cyberdyne')!.step.disabled).toBe('Needs you: confirm the VDP company first (Change…)');
    // your mapping (Change…): Soylent Foods is VDP's Soylent Corporation
    expect(idOf('Soylent Corporation')).toMatchObject({ state: 'resolved', by: 'you', override: { at: expect.any(String) } });
    expect(idOf('Initech')).toMatchObject({ state: 'resolved', by: 'rules', deterministic: true, pick: { kind: 'create', name: 'Initech' } });
    const acme = c.tree.find((x) => x.companyName === 'ACME Corp')!.vdps[0]!;
    expect(acme.sections.map((s) => s.kind)).toEqual(['opportunities', 'people', 'use_cases', 'assets', 'header']);
    // Generate sits under its use case's inputs
    const uc = acme.sections.find((s) => s.kind === 'use_cases')!.items[0]!;
    expect(uc.children.map((x) => x.step?.kind)).toEqual(['ai_fields']);
    // the AE from the Specialist Forecast (placeholder), Data Cloud first
    expect(acme.sections.find((s) => s.kind === 'people')!.items[0]!.title).toBe('AE: Data Cloud AE Placeholder, Agentforce AE Placeholder');
    // D-69: vdp-app #11 shipped update_vdp_header.entitlement_leveraged: an input you choose, pushable
    expect(acme.sections.find((s) => s.kind === 'header')!.items[0]!.step).toMatchObject({ kind: 'entitlement', disabled: null });
    // a 50% DC account: its VDP is past, not in the tree; no Copy or handoff anywhere
    expect(c.vdps.find((v) => v.companyName === 'Umbrella Health')).toMatchObject({ scope: 'past' });
    expect(c.tree.some((x) => x.companyName === 'Umbrella Health')).toBe(false);
    expect(JSON.stringify(c.tree)).not.toMatch(/copyText|"kind":"handoff"/);
  });

  it('a node ticks its pushable descendants; disabled and unfilled rows are skipped', async () => {
    const rows = await rowsOf();
    const initech = rows.find((r) => r.kind === 'company' && r.key === 'account:acc_initech:create_company')!;
    const t = toggleRow(new Set(), initech, rows, NONE);
    expect([...t].sort()).toEqual(['account:acc_initech:create_company', 'account:acc_initech:create_vdp', 'account:acc_initech:new_vdp:owners:ta'].sort());
    // the AE (no Specialist Forecast) and the use case need typing; the Generate needs the use case
    expect(whyNot(byKey(rows, 'account:acc_initech:new_vdp:owners:ae'), rows, NONE)).toBe('Fill it in first');
    expect(whyNot(byKey(rows, 'account:acc_initech:new_vdp:create_use_case:generate'), rows, NONE)).toMatch(/^Fill in “Add a use case” first/);
    expect(tickState(initech, t, rows, NONE)).toBe('all');
    // an input with no value is never ticked by "Tick all" until it is filled in
    const all = pushableKeys(rows, NONE);
    expect(all).not.toContain('acme-corp-1:entitlement');
    expect(whyNot(byKey(rows, 'acme-corp-1:entitlement'), rows, NONE)).toBe('Fill it in first');
    expect(pushableKeys(rows, { 'acme-corp-1:entitlement': { entitlement_leveraged: 'Flex' } })).toContain('acme-corp-1:entitlement');
  });

  it('a child of a VDP that does not exist yet ticks it; unticking the unborn VDP unticks what is under it', async () => {
    const rows = await rowsOf();
    const ta = byKey(rows, 'account:acc_globex:new_vdp:owners:ta');
    const t = toggleRow(new Set(), ta, rows, NONE);
    expect([...t].sort()).toEqual(['account:acc_globex:create_vdp', 'account:acc_globex:new_vdp:owners:ta']);
    const vdp = byKey(rows, 'account:acc_globex:create_vdp');
    const t2 = toggleRow(new Set([...t, 'account:acc_globex:new_vdp:owners:ae', 'asset:00000000-0000-4000-8000-000000005003']), vdp, rows, NONE);
    expect(t2.size).toBe(0);
  });

  it('a running push shows its progress; one the worker never picked up stops holding the page after 30 minutes', () => {
    const run = { id: 'p1', at: '2026-11-12T10:00:00.000Z', dryRun: false, state: 'queued' as const, finishedAt: null, nodes: [{ key: 'k1', title: 'x', companyName: 'c', op: 'create_vdp', requires: [], draftId: null, state: 'applied' as const, detail: null, externalId: null, slug: null, at: null }, { key: 'k2', title: 'y', companyName: 'c', op: 'set_vdp_owners', requires: ['k1'], draftId: null, state: 'queued' as const, detail: null, externalId: null, slug: null, at: null }] };
    expect(pushProgress(run, [], Date.parse('2026-11-12T10:05:00.000Z'))).toBe('Pushing to VDP: 1 of 2 done');
    expect(pushProgress(run, [], Date.parse('2026-11-12T10:31:00.000Z'))).toBeNull();
    expect(pushProgress({ ...run, state: 'done' }, [], Date.parse('2026-11-12T10:05:00.000Z'))).toBeNull();
  });

  it('typed values make an input row pushable; the push order and request follow the dependency order', async () => {
    const rows = await rowsOf();
    const uc = byKey(rows, 'account:acc_initech:new_vdp:create_use_case');
    const values = { 'account:acc_initech:new_vdp:create_use_case': { title: 'Pilot use case', division: 'IT', persona: 'Architect', details_input: 'Placeholder.' } };
    expect(canPush(uc, rows, NONE)).toBe(false);
    expect(canPush(uc, rows, values)).toBe(true);
    const gen = byKey(rows, 'account:acc_initech:new_vdp:create_use_case:generate');
    const t = toggleRow(new Set(), gen, rows, values);
    expect(pushOrder(t, rows, values).map((x) => [x.row.key, x.required])).toEqual([
      ['account:acc_initech:create_company', false],
      ['account:acc_initech:create_vdp', false],
      ['account:acc_initech:new_vdp:create_use_case', false],
      ['account:acc_initech:new_vdp:create_use_case:generate', false],
    ]);
    const req = pushRequest(t, rows, values);
    expect(req.find((x) => x.itemKey === 'account:acc_initech:new_vdp:create_use_case')).toMatchObject({ values: values['account:acc_initech:new_vdp:create_use_case'], useSuggestion: true });
  });
});

describe('D-63: Push N to VDP, chained and in order', () => {
  it('dry run: the ticked item and what it needs first, each its own Outbox item, recorded with placeholders; nothing sent', async () => {
    const r = await ds.pushVdpChanges({ body: { items: [{ itemKey: 'account:acc_globex:new_vdp:owners:ta' }] } } as never);
    expect(r.dryRun).toBe(true);
    expect(r.results.map((x) => [x.itemKey, x.state, x.required])).toEqual([
      ['account:acc_globex:create_vdp', 'dry_run', true],
      ['account:acc_globex:new_vdp:owners:ta', 'dry_run', false],
    ]);
    const ta = ds.store.get('drafts', r.results[1]!.draftId!)!;
    expect(ta.attempts.at(-1)).toMatchObject({ dryRun: true });
    expect(payloadOf(ta)).toMatchObject({ tool: 'set_vdp_owners', vdp_id: '(new VDP id)', pending: ['vdp_id'], waits_for: ['account:acc_globex:create_vdp'], args: { vdp_id: '(new VDP id)', technical_architects: [expect.stringContaining('@')] } });
    expect(ds.store.get('drafts', r.results[0]!.draftId!)!.status).toBe('ready');
    expect((await cov()).push).toMatchObject({ id: r.pushId, state: 'done', dryRun: true });
    // a key that is not open any more is refused, not guessed
    const bad = await ds.pushVdpChanges({ body: { items: [{ itemKey: 'acme:nothing' }] } } as never);
    expect(bad.results[0]).toMatchObject({ state: 'failed', draftId: null });
  });

  it('live: company → VDP → people → use case → Generate, each new id passed down; the placeholder items are withdrawn', async () => {
    const t = new SimulatedOutboxTransport(() => ds.now());
    ds.outbox.useTransport(t);
    // a dry run first: its placeholder items are re-staged with the real ids by the live push
    await ds.pushVdpChanges({ body: { items: [{ itemKey: 'account:acc_initech:new_vdp:owners:ta' }] } } as never);
    await live();
    const uc = { title: 'Pilot use case', priority: '3 - High', division: 'IT', persona: 'Architect', details_input: 'Placeholder details.' };
    const r = await ds.pushVdpChanges({ body: { items: [{ itemKey: 'account:acc_initech:new_vdp:create_use_case:generate' }, { itemKey: 'account:acc_initech:new_vdp:owners:ta' }, { itemKey: 'account:acc_initech:new_vdp:create_use_case', values: uc }] } } as never);
    expect(r.dryRun).toBe(false);
    expect(r.results.map((x) => [x.itemKey, x.state])).toEqual([
      ['account:acc_initech:create_company', 'applied'],
      ['account:acc_initech:create_vdp', 'applied'],
      ['account:acc_initech:new_vdp:owners:ta', 'applied'],
      ['account:acc_initech:new_vdp:create_use_case', 'applied'],
      ['account:acc_initech:new_vdp:create_use_case:generate', 'applied'],
    ]);
    const call = (tool: string) => t.calls.filter((c) => c.tool === tool);
    expect(t.calls.filter((c) => !/^(get_|list_)/.test(c.tool)).map((c) => c.tool)).toEqual(['create_company', 'create_vdp', 'set_vdp_owners', 'create_use_case', 'generate_use_case']);
    const company = JSON.parse((await t.callTool({ server: 'vdp-app-fir', tool: 'list_companies', args: { q: 'Initech' } })).text).companies[0];
    expect(call('create_vdp')[0]!.args).toMatchObject({ company_id: company.id, salesforce_opportunity_ids: ['006XXoppinitechAAA'] });
    const vdpId = (ds.store.get('drafts', r.results[1]!.draftId!)!).externalId;
    expect(call('set_vdp_owners')[0]!.args).toMatchObject({ vdp_id: vdpId });
    expect(call('create_use_case')[0]!.args).toMatchObject({ vdp_id: vdpId, title: 'Pilot use case' });
    const ucId = ds.store.get('drafts', r.results[3]!.draftId!)!.externalId;
    expect(call('generate_use_case')[0]!.args).toEqual({ vdp_id: vdpId, use_case_id: ucId });
    // the earlier placeholder items were replaced (withdrawn, with why), never sent
    const withdrawn = ds.store.all('drafts').filter((d) => d.status === 'discarded' && /Replaced: staged again with the new id/.test(d.rejectedReason ?? ''));
    expect(withdrawn.length).toBeGreaterThanOrEqual(2);
    // every item was its own Outbox item, approved by the push, read back
    for (const x of r.results) expect(['sent', 'verified']).toContain(ds.store.get('drafts', x.draftId!)!.status);
  });

  it('a failure stops its branch ("Not pushed: <parent> failed"); other branches go on', async () => {
    const t = new SimulatedOutboxTransport(() => ds.now());
    t.failNextWith = 'company_exists_placeholder';
    ds.outbox.useTransport(t);
    await live();
    const r = await ds.pushVdpChanges({ body: { items: [{ itemKey: 'account:acc_initech:new_vdp:owners:ta' }, { itemKey: 'account:acc_globex:new_vdp:owners:ta' }] } } as never);
    const st = Object.fromEntries(r.results.map((x) => [x.itemKey, [x.state, x.error]]));
    expect(st['account:acc_initech:create_company']![0]).toBe('failed');
    expect(st['account:acc_initech:create_vdp']).toEqual(['skipped', 'Not pushed: Create Initech in VDP failed']);
    expect(st['account:acc_initech:new_vdp:owners:ta']![0]).toBe('skipped');
    expect(st['account:acc_globex:create_vdp']![0]).toBe('applied');
    expect(st['account:acc_globex:new_vdp:owners:ta']![0]).toBe('applied');
    expect(t.calls.filter((c) => c.tool === 'create_vdp')).toHaveLength(1);
  });

  it('a re-push never creates a second VDP: an applied create passes its id down; pushing it again is refused', async () => {
    const t = new SimulatedOutboxTransport(() => ds.now());
    ds.outbox.useTransport(t);
    await live();
    const first = await ds.pushVdpChanges({ body: { items: [{ itemKey: 'account:acc_globex:create_vdp' }] } } as never);
    expect(first.results.map((x) => x.state)).toEqual(['applied']);
    // the frozen clock applied it at the read's own instant, so the item still reads open: the runner looks again right
    // before the create, finds the applied one, and passes its id on instead of creating a second VDP
    const again = await ds.pushVdpChanges({ body: { items: [{ itemKey: 'account:acc_globex:create_vdp' }] } } as never);
    expect(again.results[0]).toMatchObject({ state: 'applied' });
    expect((await cov()).push!.nodes[0]).toMatchObject({ state: 'applied', detail: 'Already in VDP: not created again' });
    // once VDP's read is older than the apply, the item waits for that read: a push is refused outright
    ds.clock.freeze(new Date(ds.now().getTime() + 60_000));
    expect((await ds.pushVdpChanges({ body: { items: [{ itemKey: 'account:acc_initech:create_company' }] } } as never)).results[0]!.state).toBe('applied');
    const later = await ds.pushVdpChanges({ body: { items: [{ itemKey: 'account:acc_initech:create_company' }] } } as never);
    expect(later.results[0]).toMatchObject({ state: 'failed', error: 'Applied already: the next VDP read confirms it' });
    expect(t.calls.filter((c) => c.tool === 'create_company')).toHaveLength(1);
    const child = await ds.pushVdpChanges({ body: { items: [{ itemKey: 'account:acc_globex:new_vdp:owners:ae' }] } } as never);
    expect(child.results.map((x) => [x.itemKey, x.state])).toEqual([['account:acc_globex:new_vdp:owners:ae', 'applied']]);
    const vdpId = ds.store.get('drafts', first.results[0]!.draftId!)!.externalId;
    expect(t.calls.filter((c) => c.tool === 'create_vdp')).toHaveLength(1);
    expect(t.calls.find((c) => c.tool === 'set_vdp_owners')!.args).toMatchObject({ vdp_id: vdpId, account_executives: ['btl.ae@example.com'] });
  });

  it('D-69: the entitlement (vdp-app #11) is pushed like any input; a disabled item is refused with its reason', async () => {
    const r = await ds.pushVdpChanges({ body: { items: [{ itemKey: 'acme-corp-1:entitlement', values: { entitlement_leveraged: 'Flex' } }] } } as never);
    expect(r.results[0]).toMatchObject({ state: 'dry_run', error: null });
    const gone = await ds.pushVdpChanges({ body: { items: [{ itemKey: 'acme-corp-1:nothing-like-this' }] } } as never);
    expect(gone.results[0]).toMatchObject({ state: 'failed', error: 'Not open any more: the VDP view has the latest' });
  });
});

describe('withdrawn and stale staged changes', () => {
  const draft = (id: string, key: string, createdAt: string, status: Draft['status'] = 'ready') => ({ id, status, createdAt, destination: { kind: 'action', action: 'vdp.update_vdp_header', input: { itemKey: key, vdpSlug: 'acme', field: 'fiscal_year' }, target: { label: 'x', url: null }, changes: [], text: null } }) as unknown as Draft;
  const c = { lastReadAt: '2026-11-10T16:00:00.000Z', notInVdp: [], vdps: [{ steps: [{ apply: { key: 'acme:fiscal_period' } }], assetItems: [] }] } as unknown as VdpCoveragePayload;

  it('a staged change whose item is open nowhere after a newer read is withdrawn; an open one or a newer one stays', () => {
    expect(goneVdpDrafts(c, [draft('d1', 'acme:account_id', '2026-11-09T10:00:00.000Z'), draft('d2', 'acme:fiscal_period', '2026-11-09T10:00:00.000Z'), draft('d3', 'acme:account_id', '2026-11-10T16:30:00.000Z'), draft('d4', 'acme:account_id', '2026-11-09T10:00:00.000Z', 'verified')])).toEqual(['d1']);
    expect(goneVdpDrafts({ ...c, lastReadAt: null }, [draft('d1', 'acme:account_id', '2026-11-09T10:00:00.000Z')])).toEqual([]);
    // D-63: what comes under a Not-in-VDP row counts as open too
    const withChild = { ...c, notInVdp: [{ step: { apply: { key: 'account:a:create_vdp' } }, children: [{ apply: { key: 'account:a:new_vdp:owners:ta' } }], assetItems: [] }] } as unknown as VdpCoveragePayload;
    expect(goneVdpDrafts(withChild, [draft('d5', 'account:a:new_vdp:owners:ta', '2026-11-09T10:00:00.000Z')])).toEqual([]);
  });

  it('a staged change still waiting after 14 days is stale', () => {
    const now = Date.parse('2026-11-30T12:00:00.000Z');
    expect(isStaleVdpDraft({ createdAt: new Date(now - VDP_STALE_AFTER_MS).toISOString() }, now)).toBe(true);
    expect(isStaleVdpDraft({ createdAt: new Date(now - VDP_STALE_AFTER_MS + 60_000).toISOString() }, now)).toBe(false);
  });
});

describe('mock side of the parity (the db side: tests/db/vdp/autopilot-db.test.ts)', () => {
  it('autopilot is off for a new user; the page carries its line, every item its policy', async () => {
    const s = await ds.getSettings({} as never);
    expect(s.sending.channels.vdp).toEqual({ mode: 'send', autopilot: false, dailyCap: 40 });
    const c = await cov();
    expect(c.autopilot).toMatchObject({ on: false, paused: null, line: 'Autopilot: off', queued: 0 });
    for (const v of c.vdps) for (const st of v.steps) expect(['auto', 'suggest', 'you']).toContain(st.policy);
    expect((await ds.getHealth({} as never)).vdpAutopilot).toBeNull();
  });

  it('turning it on needs confirm; with dry run on, a run pauses and writes nothing', async () => {
    const s = await ds.getSettings({} as never);
    await expect(ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { channels: { vdp: { autopilot: true } } } } } as never)).rejects.toThrow(/needs confirm/);
    await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { channels: { vdp: { autopilot: true } } }, confirm: true } } as never);
    const drafts = ds.store.all('drafts').length;
    const r = await ds.runVdpAutopilot();
    expect(r).toMatchObject({ paused: 'dry_run', applied: 0 });
    expect(ds.store.all('drafts').length).toBe(drafts);
    expect((await cov()).autopilot).toMatchObject({ on: true, paused: 'dry_run' });
  });
});
