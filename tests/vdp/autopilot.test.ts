/**
 * D-60, VDP autopilot (pure parts and the shared runner, with fakes; never the real VDP):
 *   policy        what autopilot applies (known values only) vs what it suggests vs what stays yours
 *   the cap       at most N writes a local day; the rest waits ("paused: today's cap")
 *   dry run       nothing staged or sent; paused: dry_run
 *   stale cookie  pauses (reauth), told once
 *   duplicates    create_company only when list_companies found nothing; a duplicate create_company reports returns
 *   assets        only the strongest grade, https links on a trusted site (SEC-6); the rest held for your Apply
 *   owners        TA = me as the role's full list; the AE is never set
 *   generate      only once the use case's five inputs are in
 *   idempotency   never the same call twice; a failure is never retried
 *   read-back     a failure returns the item to you with the error
 *   defaults      off for new users
 * Placeholders only.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_AUTOPILOT_ASSET_HOSTS, DEFAULT_SENDING_SETTINGS, SendingSettings, type Account, type Opportunity } from '../../src/contract';
import { assetPolicy, decorateCoverage, EMPTY_LEDGER, ledgerOf, nextLedger, opHash, stepPolicy, STRONG_ASSET_AT, type AutopilotLedger, type AutopilotLedgerEntry } from '../../src/engines/vdp/autopilot';
import { industryIdFor, sameUseCaseTitle } from '../../src/engines/vdp/gaps';
import { divisionOfTitle, priorityFromOpps, seniorStakeholder, titleFromOpp } from '../../src/engines/vdp/suggest';
import type { VdpServerInfo, VdpServerTool, VdpSnapshot } from '../../src/lib/vdp/types';
import { SHIPPED_VDP_TOOLS } from '../../src/mock/vdp';
import { autopilotRefusal, confirmFromApproval, mergeSendingPatch, NotConfirmedError, OutboxDelivery, OutboxGateway, sendingConfirmNeeded, sendingOf } from '../../src/outbox';
import { confirmDelivery } from '../../src/outbox/confirm';
import { payloadHash } from '../../src/outbox/hash';
import { payloadFor } from '../../src/server/datasource/mock/render';
import { inputsComplete, vdpActionForItem, vdpCoverageAndQueue, type CoverageAutopilot } from '../../src/server/vdp/coverage';
import { runVdpAutopilot, type AutopilotApplyResult, type AutopilotPort } from '../../src/server/vdp/autopilot';
import type { CandidateRecord } from '../../src/server/vdp/detail';
import { autopilotDue } from '../../src/worker/vdp-autopilot-hook';
import { FakeMcp } from '../outbox/fake';
import { NOW, uc, vdp } from './gap-fixtures';

const READ = '2026-11-10T16:00:00.000Z';
const account = (id: string, name: string, org62: string, industry: string | null = null): Account => ({ id, name, industry, dcStatus: 'none', vdpStatus: 'none', hoursQtd: 0, team: [], org62Url: `https://org62.example.test/lightning/r/Account/${org62}/view`, notes: '' }) as unknown as Account;
const opportunity = (id: string, accountId: string, org62: string, o: Partial<Opportunity> = {}): Opportunity =>
  ({ id, accountId, name: `Opp ${id}`, stage: 'Qualify', isOpen: true, isMine: true, dcAssigned: true, myDc: { split: 100, role: null, org62DcId: null, lastSeenAt: null }, closeDate: '2026-12-15', owner: { name: 'Owner Placeholder' }, org62Url: `https://org62.example.test/lightning/r/Opportunity/${org62}/view`, ...o }) as unknown as Opportunity;

const accounts = [account('A1', 'Acme Placeholder', '001AAAAAAAAAAAA'), account('A2', 'Globex Placeholder', '001BBBBBBBBBBBB'), account('A3', 'Initech Placeholder', '001CCCCCCCCCCCC', 'Retail')];
const opps = [opportunity('O1', 'A1', '006AAAAAAAAAAAA'), opportunity('O2', 'A2', '006BBBBBBBBBBBB'), opportunity('O3', 'A3', '006CCCCCCCCCCCC')];
const me = { name: 'Me Placeholder', email: 'me@example.com' };
const PENDING: VdpServerTool[] = [
  { name: 'create_company', args: ['aliases', 'industry_category_id', 'name', 'website'] },
  { name: 'add_vdp_asset', args: ['asset_type', 'deliverable_type', 'description', 'title', 'url', 'vdp_id'] },
  { name: 'set_vdp_owners', args: ['account_executives', 'technical_architects', 'vdp_id'] },
  { name: 'generate_use_case', args: ['regenerate', 'use_case_id', 'vdp_id'] },
  { name: 'list_industries', args: [] },
];
const server = (o: Partial<VdpServerInfo> = {}): VdpServerInfo => ({
  tools: [...SHIPPED_VDP_TOOLS, ...PENDING],
  deliverableTypes: null,
  companies: [
    { query: 'Globex Placeholder', at: NOW, matches: [{ id: '00000000-0000-4000-8000-0000000000c2', name: 'Globex Placeholder', slug: 'globex' }] },
    { query: 'Initech Placeholder', at: NOW, matches: [] },
  ],
  industries: [
    { id: '00000000-0000-4000-8000-0000000000e1', name: 'Retail', slug: 'retail', parentId: null },
    { id: '00000000-0000-4000-8000-0000000000e2', name: 'Financial Services', slug: 'financial-services', parentId: null },
  ],
  readAt: NOW,
  ...o,
});
const cand = (id: string, o: Partial<CandidateRecord> = {}): CandidateRecord => ({ id, targetKey: 'A1', vdpSlug: 'acme', accountId: 'A1', companyName: 'Acme Placeholder', title: `Deck ${id}`, url: `https://docs.google.com/presentation/d/${id.padEnd(24, 'x')}/edit`, assetKey: id, kind: 'deck', why: 'its title names Acme', confidence: 0.9, origin: 'matcher', status: 'suggested', sources: [], firstSeenAt: NOW, statusAt: null, ...o });

const HOSTS = DEFAULT_AUTOPILOT_ASSET_HOSTS;
const ON = { on: true, dryRun: false, cap: 40, assetHosts: HOSTS };
const ap = (o: Partial<CoverageAutopilot> = {}): CoverageAutopilot => ({ settings: ON, ledger: EMPTY_LEDGER, auth: 'ok', today: '2026-11-10', dayOf: (iso) => iso.slice(0, 10), ...o });
const build = (vdps: VdpSnapshot[], o: { autopilot?: CoverageAutopilot; candidates?: CandidateRecord[]; server?: VdpServerInfo; aesByOpp?: Map<string, Array<{ email: string; name: string | null; type: string }>> } = {}) =>
  vdpCoverageAndQueue({
    records: vdps.map((s) => ({ snapshot: s, goneAt: null, lastSeenAt: READ })),
    accounts,
    opps,
    me,
    now: NOW,
    vdpBaseUrl: 'https://vdp.example.test',
    server: o.server ?? server(),
    autopilot: o.autopilot ?? ap(),
    // D-69: the Org62 chains are read and each account is its own top: a company to create is zero-ambiguity
    hierarchy: { readAt: NOW, nodes: Object.fromEntries(accounts.map((a) => [a.org62Url!.match(/001\w{12}/)![0], { id: a.org62Url!.match(/001\w{12}/)![0], name: a.name, parentId: null }])), read: [] },
    ...(o.aesByOpp ? { aesByOpp: o.aesByOpp } : {}),
    ...(o.candidates ? { assets: { candidates: o.candidates, perRunUsd: 0.5, dayLeftUsd: 1, running: 0 } } : {}),
  });

// Acme: linked to O1 by its opp id, its account id unset, no TA, no AE, one use case missing persona, one complete
// without AI fields; Globex: no VDP but VDP knows the company; Initech: no VDP, VDP has no such company.
const acme = vdp({
  salesforceAccountId: null,
  salesforceOpportunityIds: ['006AAAAAAAAAAAA'],
  fiscalYear: null,
  fiscalQuarter: null,
  aes: [],
  tas: [],
  useCases: [uc('u1', { persona: null }), uc('u2', { title: 'Second use case', hasAi: false, generatedFields: null })],
  stakeholders: [{ id: 's1', name: 'Dana Placeholder', title: 'VP of Marketing', role: 'Champion', notes: null }],
  dcNoteCached: false,
});

const stepsOf = (cov: ReturnType<typeof build>['coverage'], slug = 'acme') => cov.vdps.find((v) => v.vdpSlug === slug)!.steps;
const byKind = (cov: ReturnType<typeof build>['coverage'], kind: string) => stepsOf(cov).find((s) => s.kind === kind)!;

describe('policy: auto (known values) vs suggest (judgment) vs you (handoff)', () => {
  const { coverage: cov, queue } = build([acme]);

  it('autopilot takes the header fills from Org62, me as TA, Generate on a complete use case, the VDP and the company', () => {
    expect(byKind(cov, 'account_id')).toMatchObject({ policy: 'auto', autopilot: { state: 'queued' } });
    expect(byKind(cov, 'fiscal_period')).toMatchObject({ policy: 'auto' });
    expect(byKind(cov, 'ta')).toMatchObject({ policy: 'auto' });
    // D-63: no Specialist Forecast names the AE: a person types it
    expect(byKind(cov, 'ae')).toMatchObject({ policy: 'suggest' });
    expect(stepsOf(cov).find((s) => s.id === 'ai_fields:u2')).toMatchObject({ policy: 'auto' });
    expect(cov.notInVdp.find((r) => r.key === 'account:A2')!.step).toMatchObject({ kind: 'create_vdp', policy: 'auto' });
    expect(cov.notInVdp.find((r) => r.key === 'account:A3')!.step).toMatchObject({ kind: 'create_company', policy: 'auto' });
    // D-63: what sits under a company or VDP that does not exist yet waits for the read that shows it (only a push chains)
    expect(queue.map((q) => q.op)).toEqual(['create_company', 'create_vdp', 'update_vdp_header', 'update_vdp_header', 'set_vdp_owners', 'generate_use_case']);
    expect(queue.map((q) => q.key)).not.toContain('account:A3:create_vdp');
    expect(queue.some((q) => q.key.includes(':new_vdp:'))).toBe(false);
  });

  it('use-case inputs are suggestions you approve (drafted from what the app knows), never queued', () => {
    const s = byKind(cov, 'use_case_fields');
    expect(s.policy).toBe('suggest');
    expect(s.suggestion).toMatchObject({ values: { persona: 'VP of Marketing' }, by: 'rules' });
    expect(queue.some((q) => q.key === s.apply!.key)).toBe(false);
  });

  it('Find assets (no call) is not autopilot’s; a fiscal period from the clock (no close date) is only a suggestion', () => {
    expect(byKind(build([vdp({ assets: [] })]).coverage, 'find_assets')).toMatchObject({ policy: 'you', apply: null });
    expect(stepsOf(cov).some((s) => s.kind === 'dc_note')).toBe(false); // D-63: auto-generated, not checked
    const noClose = vdpCoverageAndQueue({ records: [{ snapshot: acme, goneAt: null, lastSeenAt: READ }], accounts, opps: [opportunity('O1', 'A1', '006AAAAAAAAAAAA', { closeDate: null })], me, now: NOW, server: server(), autopilot: ap() }).coverage;
    expect(noClose.vdps[0]!.steps.find((s) => s.kind === 'fiscal_period')!.policy).toBe('suggest');
  });

  it('autopilot is off by default: same policies, nothing queued, no autopilot state on the items', () => {
    const off = build([acme], { autopilot: ap({ settings: { on: false, dryRun: true, cap: 40, assetHosts: HOSTS } }) });
    expect(off.queue).toEqual([]);
    expect(off.coverage.autopilot).toMatchObject({ on: false, line: 'Autopilot: off', queued: 0 });
    expect(byKind(off.coverage, 'account_id')).toMatchObject({ policy: 'auto', autopilot: null });
  });

  it('stepPolicy never makes a use-case edit or a looks-wrong fix autopilot’s', () => {
    const fix = { kind: 'app' as const, op: 'update_vdp_header' as const, field: 'fiscal_quarter', current: 3, suggested: 4, options: [], values: {}, known: true };
    const base = { who: 'app' as const, kind: 'check' as const, gaps: [{ fix } as never], apply: { key: 'k', op: 'update_vdp_header' as const, fields: [], label: 'Fix it' } };
    expect(stepPolicy({ ...base, check: 'wrong' }, { inputsComplete: () => true }).policy).toBe('suggest');
    expect(stepPolicy({ ...base, check: 'missing', apply: { ...base.apply, op: 'update_use_case' } }, { inputsComplete: () => true }).policy).toBe('suggest');
  });
});

describe('the Outbox door: only autopilot ops, only filling empty fields, only while on', () => {
  const sending = sendingOf({ channels: { vdp: { mode: 'send', autopilot: true, dailyCap: 40 } } } as never);
  const dest = (action: string, before: unknown = null) => ({ kind: 'action' as const, action, target: { label: 'x', url: null }, input: { changes: [{ field: 'f', before, value: 'v' }] }, changes: [], text: null });

  it('D-63: refuses an opp removal, the entitlement, a sales segment, and an item still waiting for a parent’s id', () => {
    const one = (field: string, extra: Record<string, unknown> = {}) => ({ kind: 'action' as const, action: 'vdp.update_vdp_header', target: { label: 'x', url: null }, input: { changes: [{ field, before: null, value: ['006PLACEHOLDER0001'] }], ...extra }, changes: [], text: null });
    expect(autopilotRefusal(one('remove_opportunity_ids') as never, sending)).toBe('A person approves this one');
    expect(autopilotRefusal(one('entitlement_leveraged') as never, sending)).toBe('A person approves this one');
    expect(autopilotRefusal(one('add_opportunity_ids', { pending: { vdpId: 'account:a:create_vdp' } }) as never, sending)).toMatch(/waits for an earlier item/);
    expect(autopilotRefusal(one('add_opportunity_ids') as never, sending)).toBeNull();
  });

  it('refuses when off, a use-case edit, a delete-like op, or a value already in VDP', () => {
    expect(autopilotRefusal(dest('vdp.update_vdp_header') as never, sending)).toBeNull();
    expect(autopilotRefusal(dest('vdp.update_vdp_header') as never, sendingOf({}))).toMatch(/off/);
    expect(autopilotRefusal(dest('vdp.update_use_case') as never, sending)).toMatch(/never makes update_use_case/);
    expect(autopilotRefusal(dest('vdp.update_vdp_header', 3) as never, sending)).toMatch(/never changes a value/);
    expect(autopilotRefusal(dest('slack_canvas.create') as never, sending)).toMatch(/only applies VDP/);
  });

  it('SEC-6: refuses an asset link off the trusted sites right before the write (the second line)', () => {
    const asset = (url: string) => ({ kind: 'action' as const, action: 'vdp.add_vdp_asset', target: { label: 'x', url: null }, input: { field: 'url', before: null, value: url, changes: [{ field: 'url', before: null, value: url }, { field: 'title', before: null, value: 'Deck' }] }, changes: [], text: null });
    expect(autopilotRefusal(asset('https://docs.google.com/presentation/d/abc/edit') as never, sending)).toBeNull();
    expect(autopilotRefusal(asset('https://evil.example/deck.pdf') as never, sending)).toBe('Held for you: link is on evil.example, not a trusted site');
    expect(autopilotRefusal(asset('https://docs.google.com@evil.example/deck.pdf') as never, sending)).toMatch(/user name/);
    expect(autopilotRefusal(asset('https://evil.example/deck.pdf') as never, { ...sending, autopilotAssetHosts: ['evil.example'] })).toBeNull();
  });

  it('an autonomy-policy approval mints a proof only when the policy allows it, by autopilot', () => {
    const base = { draftId: 'd1', draftVersion: 2, mode: 'send' as const, payloadHash: 'h', approvedAt: NOW, approvalMethod: 'autonomy_policy', approvedContentHash: 'c', currentContentHash: 'c', confirmedPayloadHash: 'h', at: NOW };
    expect(() => confirmFromApproval(base)).toThrow(NotConfirmedError);
    expect(() => confirmFromApproval({ ...base, policyRefusal: 'VDP autopilot is off (Settings ▸ Sending)' })).toThrow(/off/);
    expect(confirmFromApproval({ ...base, policyRefusal: null })).toMatchObject({ by: 'autopilot', via: 'autonomy_policy' });
    expect(() => confirmFromApproval({ ...base, approvalMethod: 'chat_confirm', policyRefusal: null })).toThrow(/not an explicit user confirm/);
  });
});

describe('the cap, dry run and the stale cookie', () => {
  const today = (n: number): AutopilotLedgerEntry[] => Array.from({ length: n }, (_, i) => ({ key: `x${i}`, hash: 'h', at: '2026-11-10T09:00:00.000Z', state: 'applied', title: 't', vdpKey: 'acme', companyName: 'Acme', op: 'update_vdp_header', detail: null, draftId: null, url: null }));

  it('stops at the daily cap: only what is left today is queued, then paused: cap', () => {
    const near = build([acme], { autopilot: ap({ settings: { ...ON, cap: 3 }, ledger: { ...EMPTY_LEDGER, entries: today(1) } }) });
    expect(near.queue).toHaveLength(2);
    const full = build([acme], { autopilot: ap({ settings: { ...ON, cap: 3 }, ledger: { ...EMPTY_LEDGER, entries: today(3) } }) });
    expect(full.queue).toEqual([]);
    expect(full.coverage.autopilot).toMatchObject({ paused: 'cap', appliedToday: 3 });
    expect(full.coverage.autopilot.line).toBe("Autopilot: on · 3 applied today · paused: today's cap is reached");
    // yesterday's writes do not count
    const yesterday = build([acme], { autopilot: ap({ settings: { ...ON, cap: 3 }, ledger: { ...EMPTY_LEDGER, entries: today(3).map((e) => ({ ...e, at: '2026-11-09T09:00:00.000Z' })) } }) });
    expect(yesterday.queue).toHaveLength(3);
  });

  it('dry run: nothing queued; each auto item says paused', () => {
    const d = build([acme], { autopilot: ap({ settings: { ...ON, dryRun: true } }) });
    expect(d.queue).toEqual([]);
    expect(d.coverage.autopilot).toMatchObject({ on: true, paused: 'dry_run' });
    expect(byKind(d.coverage, 'account_id').autopilot).toMatchObject({ state: 'paused', detail: 'Paused: dry run is on' });
  });

  it('a stale cookie pauses it: "paused: re-auth VDP"', () => {
    const s = build([acme], { autopilot: ap({ auth: 'stale' }) });
    expect(s.queue).toEqual([]);
    expect(s.coverage.autopilot.line).toBe('Autopilot: on · 0 applied today · paused: re-auth VDP');
  });
});

/** The runner over an in-memory port (the DataSources wire the same runner to the Outbox). */
function port(o: { sending?: Record<string, unknown>; auth?: 'ok' | 'stale'; apply?: (key: string) => AutopilotApplyResult; ledger?: AutopilotLedger; vdps?: VdpSnapshot[] }) {
  let ledger = o.ledger ?? EMPTY_LEDGER;
  const applied: string[] = [];
  const notified: string[] = [];
  const p: AutopilotPort = {
    now: () => new Date('2026-11-10T17:00:00.000Z'),
    settings: async () => ({ sending: { ...DEFAULT_SENDING_SETTINGS, dryRun: false, channels: { ...DEFAULT_SENDING_SETTINGS.channels, vdp: { mode: 'send', autopilot: true, dailyCap: 40 } }, ...o.sending } as never, timezone: 'UTC' }),
    auth: async () => o.auth ?? 'ok',
    ledger: async () => ledger,
    saveLedger: async (next) => void (ledger = next),
    plan: async (a) => ({ ...build(o.vdps ?? [acme], { autopilot: a }), snapshots: o.vdps ?? [acme] }),
    apply: async (item) => {
      applied.push(item.key);
      return o.apply?.(item.key) ?? { draftId: `d-${applied.length}`, outcome: 'applied', detail: 'Verified in VDP ✓', url: 'https://vdp.example.test/vdp/acme' };
    },
    notifyPaused: async (why) => void notified.push(why),
  };
  return { p, applied, notified, ledger: () => ledger };
}

describe('the runner', () => {
  it('applies the queue in order, each once; a second run makes no call twice', async () => {
    const t = port({});
    const r = await runVdpAutopilot(t.p);
    expect(r).toMatchObject({ applied: 6, failed: 0, paused: null });
    expect(t.applied[0]).toBe('account:A3:create_company');
    const again = await runVdpAutopilot(t.p);
    expect(again.applied).toBe(0);
    expect(t.applied).toHaveLength(6);
  });

  it('off: nothing runs', async () => {
    const t = port({ sending: { channels: { vdp: { mode: 'send', autopilot: false, dailyCap: 40 } } } });
    expect(await runVdpAutopilot(t.p)).toMatchObject({ skipped: 'off' });
    expect(t.applied).toEqual([]);
  });

  it('dry run: nothing is staged or sent, paused dry_run', async () => {
    const t = port({ sending: { dryRun: true } });
    expect(await runVdpAutopilot(t.p)).toMatchObject({ paused: 'dry_run', applied: 0 });
    expect(t.applied).toEqual([]);
  });

  it('a stale cookie pauses it and tells the user once', async () => {
    const t = port({ auth: 'stale' });
    expect(await runVdpAutopilot(t.p)).toMatchObject({ paused: 'reauth', applied: 0 });
    await runVdpAutopilot(t.p);
    expect(t.notified).toEqual(['reauth']);
    expect(t.applied).toEqual([]);
    expect(t.ledger().paused).toBe('reauth');
  });

  it('a failure (or a read-back that did not confirm) returns the item to you, with the error, and is never retried', async () => {
    const t = port({ apply: (key) => (key === 'acme:account_id' ? { draftId: 'd-x', outcome: 'failed', detail: 'Read-back: the VDP is not in VDP', url: null } : { draftId: 'd', outcome: 'applied', detail: null, url: null }) });
    const r = await runVdpAutopilot(t.p);
    expect(r.failed).toBe(1);
    const cov = build([acme], { autopilot: ap({ ledger: t.ledger() }) }).coverage;
    expect(byKind(cov, 'account_id').autopilot).toMatchObject({ state: 'failed', detail: 'Read-back: the VDP is not in VDP' });
    expect(build([acme], { autopilot: ap({ ledger: t.ledger() }) }).queue.some((q) => q.key === 'acme:account_id')).toBe(false);
    expect(cov.autopilot.recent[0]).toMatchObject({ state: expect.any(String) });
  });

  it('a call already made (same key and values) is skipped; new values make a new call', () => {
    const { queue } = build([acme]);
    const item = queue.find((q) => q.key === 'acme:account_id')!;
    const ledger = nextLedger(EMPTY_LEDGER, [{ ...item, at: '2026-11-09T10:00:00.000Z', state: 'applied', detail: null, draftId: 'd', url: null }], { now: '2026-11-09T10:00:00.000Z', paused: null });
    expect(build([acme], { autopilot: ap({ ledger }) }).queue.some((q) => q.key === item.key)).toBe(false);
    expect(build([acme], { autopilot: ap({ ledger: { ...ledger, entries: ledger.entries.map((e) => ({ ...e, hash: 'other' })) } }) }).queue.some((q) => q.key === item.key)).toBe(true);
    expect(ledgerOf({ entries: [{ nope: 1 }], paused: 'weird' })).toEqual(EMPTY_LEDGER);
  });
});

describe('companies, owners, Generate and assets', () => {
  it('create_company only when list_companies found nothing; a near match stays a suggestion; the industry only on an exact match', () => {
    const { coverage } = build([acme]);
    const create = coverage.notInVdp.find((r) => r.key === 'account:A3')!.step;
    expect(create.apply!.fields.map((f) => [f.field, f.suggested])).toEqual([
      ['name', 'Initech Placeholder'],
      ['industry_category_id', '00000000-0000-4000-8000-0000000000e1'],
    ]);
    const near = build([acme], { server: server({ companies: [{ query: 'Initech Placeholder', at: NOW, matches: [{ id: '00000000-0000-4000-8000-0000000000c9', name: 'Initech Holdings Group EU', slug: 'x' }] }] }) });
    expect(near.coverage.notInVdp.find((r) => r.key === 'account:A3')!.step).toMatchObject({ kind: 'create_company', policy: 'suggest' });
    expect(industryIdFor('retail', server().industries)).toBe('00000000-0000-4000-8000-0000000000e1');
    expect(industryIdFor('Retail', [...server().industries!, { id: 'other', name: 'Retail', slug: null, parentId: 'p' }])).toBeNull();
    expect(industryIdFor(null, server().industries)).toBeNull();
  });

  it('VD-05 create_company returns created:false: several matches fail the item (never shown as applied), one match is the company', async () => {
    const fake = new FakeMcp().on('create_company', () => ({ text: JSON.stringify({ created: false, company: null, matches: [{ id: 'm1', name: 'Initech Inc' }, { id: 'm2', name: 'Initech EU' }], message: '2 companies already match' }) }));
    const { coverage } = build([acme]);
    const dest = vdpActionForItem(coverage, [acme], { itemKey: 'account:A3:create_company', values: {} });
    const doc = { type: 'doc', content: [] } as never;
    const payload = payloadFor(dest, doc, 'send');
    const engine = new OutboxDelivery({ gateway: new OutboxGateway(fake), isDryRun: () => false });
    const proof = confirmDelivery({ draftId: 'd1', draftVersion: 1, mode: 'send', payloadHash: payloadHash(payload), confirmToken: 't', expectedToken: 't', at: NOW });
    const proof2 = (p: Record<string, unknown>) => confirmDelivery({ draftId: 'd2', draftVersion: 1, mode: 'send', payloadHash: payloadHash(p), confirmToken: 't', expectedToken: 't', at: NOW });
    const rec = await engine.deliver(engine.prepare({ draftId: 'd1', draftVersion: 1, destination: dest, mode: 'send', payload, dryRun: false, attemptNo: 1, confirmation: proof }), proof);
    expect(rec).toMatchObject({ state: 'failed', error: { code: 'invalid_request', retryable: false } });
    expect(rec.error!.message).toBe('The destination rejected the request');
    expect(fake.calls.map((c) => c.tool)).toEqual(['create_company']);
    // one match: VDP's own company; its id is used (the items under it take it) and the read-back finds it by id
    const one = new FakeMcp()
      .on('create_company', () => ({ text: JSON.stringify({ created: false, company: { id: 'm1', name: 'Initech Inc' }, matches: [{ id: 'm1', name: 'Initech Inc' }], message: 'A company named "Initech Inc" (m1) already exists' }) }))
      .on('list_companies', () => ({ text: JSON.stringify({ companies: [{ id: 'm1', name: 'Initech Inc' }] }) }));
    const engine1 = new OutboxDelivery({ gateway: new OutboxGateway(one), isDryRun: () => false });
    const rec1 = await engine1.deliver(engine1.prepare({ draftId: 'd2', draftVersion: 1, destination: dest, mode: 'send', payload, dryRun: false, attemptNo: 1, confirmation: proof2(payload) }), proof2(payload));
    expect(rec1).toMatchObject({ state: 'delivered', result: { externalId: 'm1', reused: true }, readback: 'confirmed' });
    expect(rec1.readbackDetail).toMatch(/already had this company: its id is used, nothing was created/);
  });

  it('owners (D-63): TA = me, the AE from the opp’s Specialist Forecast (auto); with none, an input you fill', () => {
    const { coverage } = build([acme]);
    const ta = byKind(coverage, 'ta');
    expect(ta.apply!.fields.map((f) => [f.field, f.suggested])).toEqual([['technical_architects', ['me@example.com']]]);
    const dest = vdpActionForItem(coverage, [acme], { itemKey: ta.apply!.key, values: {} });
    expect(payloadFor(dest, { type: 'doc', content: [] } as never, 'send').args).toEqual({ vdp_id: 'v1', technical_architects: ['me@example.com'] });
    expect(byKind(coverage, 'ae').apply!.fields.map((f) => [f.field, f.suggested])).toEqual([['account_executives', null]]);
    const withAe = build([acme], { aesByOpp: new Map([['O1', [{ email: 'Specialist.AE@example.com', name: 'Specialist AE', type: 'Data Cloud' }]]]) });
    const ae = byKind(withAe.coverage, 'ae');
    expect(ae).toMatchObject({ policy: 'auto', title: 'AE: Specialist AE' });
    expect(withAe.queue.map((q) => q.key)).toContain('acme:owners:ae');
    expect(payloadFor(vdpActionForItem(withAe.coverage, [acme], { itemKey: 'acme:owners:ae' }), { type: 'doc', content: [] } as never, 'send').args).toEqual({ vdp_id: 'v1', account_executives: ['specialist.ae@example.com'] });
  });

  it('Generate only once the use case’s five inputs are in: it sits under the inputs’ item and needs it first', () => {
    expect(inputsComplete(uc('u', { hasAi: false }))).toBe(true);
    expect(inputsComplete(uc('u', { persona: null }))).toBe(false);
    expect(inputsComplete(uc('u', { detailLoaded: false }))).toBe(false);
    const { coverage, queue } = build([vdp({ useCases: [uc('u9', { hasAi: false, generatedFields: null, persona: null })] })]);
    const gen = stepsOf(coverage).find((s) => s.kind === 'ai_fields')!;
    expect(gen).toMatchObject({ state: 'todo', policy: 'suggest', requires: ['acme:use_case:u9'], parentKey: 'acme:use_case:u9' });
    expect(queue.some((q) => q.op === 'generate_use_case')).toBe(false);
  });

  it('assets: only the strongest grade with an https link on a trusted site is autopilot’s; others are yours to confirm; non-http is flagged', () => {
    expect(assetPolicy({ status: 'suggested', confidence: STRONG_ASSET_AT, url: 'https://docs.google.com/presentation/d/abc/edit', kind: 'deck' }, true, HOSTS).policy).toBe('auto');
    expect(assetPolicy({ status: 'suggested', confidence: 0.8, url: 'https://docs.google.com/presentation/d/abc/edit', kind: 'deck' }, true, HOSTS)).toMatchObject({ policy: 'suggest', reason: /strongest/ });
    expect(assetPolicy({ status: 'suggested', confidence: 0.95, url: 'ftp://x.example.test/a', kind: 'deck' }, true, HOSTS).policy).toBe('you');
    expect(assetPolicy({ status: 'suggested', confidence: 0.95, url: 'https://acme-demo.lightning.force.com/a', kind: 'demo' }, true, HOSTS).policy).toBe('suggest');
    const { coverage, queue } = build([vdp()], { candidates: [cand('c1'), cand('c2', { confidence: 0.75 }), cand('c3', { url: 'ftp://files.example.test/deck.pdf' })] });
    const items = coverage.vdps[0]!.assetItems;
    expect(items.map((a) => [a.candidateId, a.policy])).toEqual([
      ['c1', 'auto'],
      ['c2', 'suggest'],
      ['c3', 'you'],
    ]);
    expect(items.find((a) => a.candidateId === 'c3')).toMatchObject({ apply: null, policyReason: /http\(s\)/ });
    expect(queue.filter((q) => q.op === 'add_vdp_asset').map((q) => q.key)).toEqual(['asset:c1']);
  });

  // SEC-6 (D-60 amended 2026-11-21): the link came from a search over untrusted text. Before, any http(s) link of the
  // strongest grade was autopilot's (this test used https://x.example.test/a); now only a trusted site's https link is,
  // and anything else is an ordinary item that waits for your Apply, never dropped.
  it('SEC-6: a strong link on an untrusted site is held for your Apply, with the host, never queued or dropped', () => {
    const strong = { status: 'suggested', confidence: 0.95, kind: 'pdf' };
    expect(assetPolicy({ ...strong, url: 'https://x.example.test/deck.pdf' }, true, HOSTS)).toEqual({ policy: 'suggest', reason: 'Held for you: link is on x.example.test, not a trusted site' });
    expect(assetPolicy({ ...strong, url: 'http://docs.google.com/a.pdf' }, true, HOSTS)).toMatchObject({ policy: 'suggest', reason: /not https/ });
    expect(assetPolicy({ ...strong, url: 'https://evil.example/deck.pdf' }, true, [...HOSTS, 'evil.example']).policy).toBe('auto');
    expect(assetPolicy({ ...strong, url: 'https://docs.google.com/presentation/d/abc/edit' }, true, []).policy).toBe('suggest');
    const hostile = cand('c4', { url: 'https://attacker.example/q3-deck.pdf', kind: 'pdf' });
    const { coverage, queue } = build([vdp()], { candidates: [cand('c1'), hostile] });
    const held = coverage.vdps[0]!.assetItems.find((a) => a.candidateId === 'c4')!;
    expect(held).toMatchObject({ policy: 'suggest', policyReason: 'Held for you: link is on attacker.example, not a trusted site', autopilot: null, state: 'todo' });
    expect(held.apply).not.toBeNull(); // still yours to Apply
    expect(queue.filter((q) => q.op === 'add_vdp_asset').map((q) => q.key)).toEqual(['asset:c1']);
    // the user trusts the site: the same link is autopilot's
    const trusted = build([vdp()], { candidates: [hostile], autopilot: ap({ settings: { ...ON, assetHosts: [...HOSTS, 'attacker.example'] } }) });
    expect(trusted.queue.filter((q) => q.op === 'add_vdp_asset').map((q) => q.key)).toEqual(['asset:c4']);
  });

  it('the item hash is the key and the values it would send', () => {
    const a = { key: 'k', op: 'update_vdp_header' as const, label: 'x', fields: [{ field: 'fiscal_year', label: '', current: null, suggested: 27, options: [], required: true, multiline: false, fixed: false }] };
    expect(opHash('k', a)).toBe(opHash('k', { ...a }));
    expect(opHash('k', a)).not.toBe(opHash('k', { ...a, fields: [{ ...a.fields[0]!, suggested: 28 }] }));
  });
});

describe('looks wrong: a few deterministic checks, each with why, fixes as suggestions', () => {
  const checks = (s: VdpSnapshot, o: Opportunity[] = opps) => vdpCoverageAndQueue({ records: [{ snapshot: s, goneAt: null, lastSeenAt: READ }], accounts, opps: o, me, now: NOW, server: server(), autopilot: ap() }).coverage.vdps[0]!;
  const clean = vdp({ salesforceOpportunityIds: ['006AAAAAAAAAAAA'] });

  it('nothing to check on a clean VDP', () => {
    expect(checks(clean).steps.filter((s) => s.check === 'wrong')).toEqual([]);
    expect(checks(clean).status).toMatchObject({ toCheck: 0 });
  });

  it('fiscal period vs the linked open opp’s close quarter: a suggested fix', () => {
    const r = checks(vdp({ salesforceOpportunityIds: ['006AAAAAAAAAAAA'], fiscalQuarter: 3 }));
    const s = r.steps.find((x) => x.id === 'check:wrong_fiscal_period')!;
    expect(s).toMatchObject({ kind: 'check', check: 'wrong', policy: 'suggest', apply: { key: 'acme:check:fiscal_period' } });
    expect(s.detail).toMatch(/Opp O1 closes FY27 Q4; the VDP says FY27 Q3/);
    expect(s.suggestion).toMatchObject({ values: { fiscal_quarter: '4' } });
    expect(r.status).toMatchObject({ toCheck: 1 });
  });

  it('the account id vs the linked opps’ account', () => {
    const r = checks(vdp({ salesforceOpportunityIds: ['006AAAAAAAAAAAA'], salesforceAccountId: '001BBBBBBBBBBBB' }));
    const s = r.steps.find((x) => x.id === 'check:wrong_account_id')!;
    expect(s).toMatchObject({ policy: 'suggest', apply: { fields: [{ field: 'salesforce_account_id', current: '001BBBBBBBBBBBB', suggested: '001AAAAAAAAAAAA' }] } });
  });

  it('D-63: a closed-lost opp linked: remove_opportunity_ids, a suggestion you approve (never autopilot’s)', () => {
    const lost = [opportunity('O1', 'A1', '006AAAAAAAAAAAA', { isOpen: false, stage: 'Closed Lost' }), opportunity('O7', 'A1', '006GGGGGGGGGGGG')];
    const r = checks(vdp({ salesforceOpportunityIds: ['006AAAAAAAAAAAA', '006GGGGGGGGGGGG'] }), lost);
    const s = r.steps.find((x) => x.kind === 'remove_opp')!;
    expect(s).toMatchObject({ policy: 'suggest', check: 'wrong', section: 'opportunities', apply: { key: 'acme:remove_opp:O1', op: 'update_vdp_header' } });
    expect(s.detail).toMatch(/closed lost/);
  });

  it('D-63: duplicate use cases and asset links are no longer checked (nothing to push for them)', () => {
    const r = checks(
      vdp({
        salesforceOpportunityIds: ['006AAAAAAAAAAAA'],
        useCases: [uc('u1', { title: 'Unified customer profile' }), uc('u2', { title: 'Unified Customer Profile!' })],
        assets: [
          { id: 'a1', title: 'Deck', url: 'https://docs.example.com/d/1', type: 'Deck', description: null },
          { id: 'a2', title: 'Deck copy', url: 'https://docs.example.com/d/1', type: 'Deck', description: null },
          { id: 'a3', title: 'Notes', url: 'file:///Users/someone/notes.txt', type: null, description: null },
        ],
      }),
    );
    expect(r.steps.filter((s) => s.check === 'wrong')).toEqual([]);
    expect(sameUseCaseTitle('Service agent for returns', 'Service agent for returns and refunds')).toBe(false);
    expect(sameUseCaseTitle('Data Cloud: unified profile', 'data cloud unified profile')).toBe(true);
  });
});

describe('suggestions are deterministic', () => {
  it('priority from the close quarter; persona and division from the one senior stakeholder; title from the opp', () => {
    expect(priorityFromOpps([{ name: 'O', isOpen: true, closeDate: '2026-12-01' }], NOW)).toMatchObject({ value: '3 - High' });
    expect(priorityFromOpps([{ name: 'O', isOpen: true, closeDate: '2027-03-01' }], NOW)).toMatchObject({ value: '2 - Medium' });
    expect(priorityFromOpps([{ name: 'O', isOpen: true, closeDate: '2027-09-01' }], NOW)).toMatchObject({ value: '1 - Low' });
    expect(priorityFromOpps([], NOW)).toBeNull();
    expect(seniorStakeholder([{ name: 'A', title: 'CIO' }, { name: 'B', title: 'Analyst' }])).toEqual({ name: 'A', title: 'CIO' });
    expect(seniorStakeholder([{ name: 'A', title: 'CIO' }, { name: 'B', title: 'VP of Sales' }])).toBeNull();
    expect(divisionOfTitle('VP of Marketing')).toBe('Marketing');
    expect(divisionOfTitle('CIO')).toBeNull();
    expect(titleFromOpp('Acme Placeholder - Data Cloud expansion', 'Acme Placeholder')).toBe('Data Cloud expansion');
  });
});

describe('the setting', () => {
  it('defaults off for new users; turning it on needs confirm; the patch keeps it and its cap', () => {
    expect(DEFAULT_SENDING_SETTINGS.channels.vdp).toEqual({ mode: 'send', autopilot: false, dailyCap: 40 });
    expect(sendingOf(null).channels.vdp).toEqual({ mode: 'send', autopilot: false, dailyCap: 40 });
    expect(SendingSettings.parse({ version: 1, defaultMode: 'draft', dryRun: true, verifyReadback: true, undoWindowSec: 10 }).channels.vdp.autopilot).toBe(false);
    expect(sendingOf({ channels: { vdp: { mode: 'send', autopilot: 'yes' } } } as never).channels.vdp.autopilot).toBe(false);
    expect(sendingConfirmNeeded(DEFAULT_SENDING_SETTINGS, { channels: { vdp: { autopilot: true } } })).toMatch(/autopilot on needs confirm/);
    expect(sendingConfirmNeeded(DEFAULT_SENDING_SETTINGS, { channels: { vdp: { autopilot: false } } })).toBeNull();
    const on = mergeSendingPatch(DEFAULT_SENDING_SETTINGS, { channels: { vdp: { autopilot: true, dailyCap: 12 } } });
    expect(on.channels.vdp).toEqual({ mode: 'send', autopilot: true, dailyCap: 12 });
    expect(mergeSendingPatch(on, { channels: { slack: { mode: 'send' } } }).channels.vdp.autopilot).toBe(true);
    expect(mergeSendingPatch(on, { channels: { vdp: { dailyCap: 9999 } } }).channels.vdp.dailyCap).toBe(40);
  });

  it('the worker hook runs after each VDP read and every 30 minutes, only while on', () => {
    const now = new Date('2026-11-10T17:00:00.000Z');
    expect(autopilotDue({ on: false, lastReadAt: '2026-11-10T16:59:00.000Z', lastRunAt: null, now })).toBe(false);
    expect(autopilotDue({ on: true, lastReadAt: null, lastRunAt: null, now })).toBe(true);
    expect(autopilotDue({ on: true, lastReadAt: '2026-11-10T16:50:00.000Z', lastRunAt: '2026-11-10T16:40:00.000Z', now })).toBe(true);
    expect(autopilotDue({ on: true, lastReadAt: '2026-11-10T16:30:00.000Z', lastRunAt: '2026-11-10T16:40:00.000Z', now })).toBe(false);
    expect(autopilotDue({ on: true, lastReadAt: '2026-11-10T16:00:00.000Z', lastRunAt: '2026-11-10T16:20:00.000Z', now })).toBe(true);
  });

  it('decorateCoverage keeps the cov shape (pure)', () => {
    const d = decorateCoverage({ vdps: [], notInVdp: [] }, { settings: ON, ledger: EMPTY_LEDGER, auth: 'ok', policy: { inputsComplete: () => true }, today: '2026-11-10', dayOf: (s) => s.slice(0, 10) });
    expect(d).toMatchObject({ queue: [], state: { on: true, queued: 0, line: 'Autopilot: on · 0 applied today' } });
  });
});
