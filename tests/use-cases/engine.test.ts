/**
 * The use-case engine (src/engines/use-cases), pure, over the synthetic sample dataset (sample-data/tables, the CAST
 * storylines) and hand-made cases:
 *   precision   no candidate from an internal-only meeting (SE team sync, 1:1s, an impromptu internal call)
 *   recall      the storylines that name use cases: Saltmere claim status (1, 12), Elderglen order status (2),
 *               Ferrowpay fraud agent, Harrowgate predictive maintenance (5)
 *   attribution the note's meeting is the explicit link; an account with several open opps asks (the rundown's top 3)
 *   dedupe      same opp + same use case (VDP's rule, the problem key, pg_trgm similarity) attaches evidence; a
 *               different number or a different problem stays apart; an existing Org62 / VDP use case is matched
 *   model       the confirm request and the strict parser (malformed answers are "no")
 *   decisions   accept / edit / reject, the learning each makes, the stage plan, the canvas row, the landing
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { needsYouCount } from '../../src/engines/activity/needs-count';
import type { World } from '../../src/engines/attribution/types';
import { applyConfirm, confirmRequest, parseConfirm } from '../../src/engines/use-cases/confirm';
import { candidateRowKey, canvasCreateOf, decideCandidate, landingOf, pendingCandidateCreates, stagePlanOf, withoutCandidateDuplicates } from '../../src/engines/use-cases/stage';
import { dedupeKeyOf, problemKey, sameUseCase, trigramSimilarity } from '../../src/engines/use-cases/similar';
import { extractMentions } from '../../src/engines/use-cases/extract';
import { findMatch, planCandidates } from '../../src/engines/use-cases/plan';
import { mentionsOf } from '../../src/engines/use-cases/mentions';
import { productsIn, productVocabulary } from '../../src/engines/use-cases/vocab';
import type { UcCandidateRow, UcExisting, UcSource } from '../../src/engines/use-cases/types';
import type { UseCaseQuestion } from '../../src/contract';
import { markSuggested } from '../../src/lib/canvas/prefill';
import { candidatesPayload } from '../../src/engines/use-cases/view';

const T = (name: string) => JSON.parse(readFileSync(path.resolve(__dirname, '../../sample-data/tables', `${name}.json`), 'utf8')) as Array<Record<string, any>>;

const items = T('source_items');
const notes = T('meeting_notes');
const events = T('calendar_events');
const opps = T('opportunities');
const accounts = T('accounts');
const eventById = new Map(events.map((e) => [e.id, e] as const));
const noteEvent = new Map(notes.map((n) => [n.source_item_id, eventById.get(n.calendar_event_id)] as const));

/** A Gemini note as the db loader builds it (external participants, the meeting's opp as the explicit link). */
function noteSource(si: Record<string, any>): UcSource {
  const ext = (si.meta?.participants ?? []).filter((p: any) => p.isExternal).map((p: any) => p.email);
  const ev = noteEvent.get(si.id);
  return {
    kind: 'gemini_note',
    key: si.id,
    sourceItemIds: [si.id],
    title: String(si.title).replace(/\s+-\s+Notes by Gemini$/i, ''),
    text: si.body ?? '',
    at: si.occurred_at,
    url: si.url ?? null,
    externalEmails: ext,
    externalDomains: [...new Set(ext.map((e: string) => e.split('@')[1]))] as string[],
    explicit: ev?.opportunity_id || ev?.account_id ? { oppIds: ev.opportunity_id ? [ev.opportunity_id] : [], accountIds: ev.account_id ? [ev.account_id] : [], via: 'The meeting' } : null,
  };
}

const geminiSources = items.filter((r) => r.source === 'gemini_notes').map(noteSource);
const world: World = {
  accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
  opps: opps.map((o) => ({ id: o.id, accountId: o.account_id, name: o.name, isOpen: !o.is_closed, isMine: !!o.on_my_team, myDc: false, closeDate: o.close_date ?? null, stage: o.stage_name ?? null })),
  people: [],
  today: '2026-11-18',
  internalDomains: ['example.com'],
};
const oppByOrg62 = new Map(opps.map((o) => [String(o.org62_opportunity_id).slice(0, 15), o] as const));
const existing: UcExisting[] = T('org62_use_cases').map((r) => ({ kind: 'org62', id: r.org62_use_case_id, title: r.name, oppId: oppByOrg62.get(String(r.org62_opportunity_id).slice(0, 15))?.id ?? null, accountId: oppByOrg62.get(String(r.org62_opportunity_id).slice(0, 15))?.account_id ?? null, org62UseCaseId: r.org62_use_case_id }));
const titleOf = (s: string) => geminiSources.find((x) => x.title.startsWith(s));

describe('the extractor over the sample notes', () => {
  it('precision: an internal-only meeting is never a use case', () => {
    const internal = geminiSources.filter((s) => !s.externalEmails.length);
    expect(internal.length).toBeGreaterThanOrEqual(4);
    expect(internal.map((s) => s.title).join('|')).toMatch(/SE team sync.*1:1 with Hana|1:1 with Hana.*SE team sync/);
    for (const s of internal) expect(extractMentions(s), s.title).toEqual([]);
    // the same words with no customer present: still nothing
    expect(extractMentions({ ...titleOf('Elderglen Outdoors renewal sync - 2026/11/12')!, externalEmails: [], externalDomains: [] })).toEqual([]);
  });

  it('recall: the storylines that name use cases are found, sure, with the sentence as evidence', () => {
    const { sure } = mentionsOf(geminiSources);
    const all = [...sure.values()].flat();
    const find = (re: RegExp) => all.find((m) => re.test(m.title));
    expect(find(/^Claim status$/i)?.cue).toBe('agreed to prove'); // Saltmere: "agreed to prove claim status first"
    expect(find(/^Order status$/i)?.statement).toMatch(/working demo of order status/); // Elderglen (storyline 2)
    expect(find(/fraud agent/i)?.products).toContain('Agentforce'); // Ferrowpay: the POC scope for the fraud agent
    expect(find(/predictive maintenance agent/i)?.track).toBe('agentforce'); // Harrowgate (storyline 5)
    // a question about a use case, a step or a slide is not one (sure)
    expect(all.some((m) => /behavioral health|one-page|sign/i.test(m.title))).toBe(false);
  });

  it('marks the unsure ones for the model: "asked for …" without a capability', () => {
    const { unsure } = mentionsOf(geminiSources);
    const u = [...unsure.values()].flat().map((m) => m.title);
    expect(u.some((t) => /follow-up question support/i.test(t))).toBe(true); // Oakhallow pilot retro
  });

  it('reads products from Settings ▸ Time dcProducts and VDP’s vocabulary', () => {
    const v = productVocabulary(['Data 360', 'Private Connect']);
    expect(productsIn('They want a unified profile on Data Cloud and a service agent', v).map((p) => p.name)).toEqual(['Data 360', 'Agentforce']);
    expect(productsIn('route traffic over Private Connect', v).map((p) => p.name)).toEqual(['Private Connect']);
  });
});

describe('attribution and dedupe', () => {
  it('a note’s use case is on its meeting’s opp, with why', () => {
    const { sure } = mentionsOf(geminiSources);
    const plan = planCandidates({ sources: geminiSources, mentions: sure, world, totals4w: new Map(), existing: [], candidates: [], now: '2026-11-18T16:00:00.000Z', newId: (() => { let n = 0; return () => `c${++n}`; })() });
    const order = plan.creates.find((c) => c.title === 'Order status')!;
    const elderglen = opps.find((o) => /elderglen outdoors/i.test(o.name) && /renewal/i.test(o.name))!;
    expect(order.oppId).toBe(elderglen.id);
    expect(order.needsPick).toBe(false);
    expect(order.why.map((r) => r.code)).toContain('explicit');
    expect(order.evidence[0]).toMatchObject({ kind: 'gemini_note', quote: expect.stringMatching(/order status/) });
  });

  it('against what exists: the Elderglen "Order status" is the Org62 "Order Status Agent" (fuzzy), its evidence ledger', () => {
    expect(sameUseCase('Order status', 'Order Status Agent').same).toBe(true);
    const { sure } = mentionsOf(geminiSources);
    const plan = planCandidates({ sources: geminiSources, mentions: sure, world, totals4w: new Map(), existing, candidates: [], now: '2026-11-18T16:00:00.000Z', newId: (() => { let n = 0; return () => `c${++n}`; })() });
    const ledger = plan.creates.find((c) => c.matchedKind === 'org62' && /order status/i.test(c.title));
    expect(ledger?.status).toBe('landed');
    expect(ledger?.org62UseCaseId).toBeTruthy();
    expect(plan.creates.some((c) => c.status === 'suggested' && c.title === 'Order status')).toBe(false);
    expect(plan.counts.matchedExisting).toBeGreaterThan(0);
  });

  it('fuzzy rules: pg_trgm similarity, the problem key, numbers kept apart', () => {
    expect(trigramSimilarity('order status', 'order status agent')).toBeGreaterThan(0.5);
    expect(problemKey('Claims Status Lookups')).toBe(problemKey('claim status lookup'));
    expect(sameUseCase('Agent phase 1', 'Agent phase 2').same).toBe(false);
    expect(sameUseCase('Fraud agent', 'Customer 360 for Risk').same).toBe(false);
    const k = dedupeKeyOf({ oppId: 'o1', accountId: 'a1', product: 'Data Cloud', title: 'Unified member profile' });
    expect(k).toBe(dedupeKeyOf({ oppId: 'o1', accountId: 'a9', product: 'D360', title: 'unified member profiles' }));
  });

  it('a second mention of the same use case adds evidence to its candidate, never a second one', () => {
    const src = (key: string, at: string): UcSource => ({ kind: 'gemini_note', key, sourceItemIds: [key], title: 'Weekly sync', text: '## Summary\nThey want to build a claims triage agent.', at, url: null, externalEmails: ['a@cust.example'], externalDomains: ['cust.example'], explicit: { oppIds: [opps[0]!.id], via: 'The meeting' } });
    const a = src('s1', '2026-11-10T10:00:00.000Z');
    const b = { ...src('s2', '2026-11-12T10:00:00.000Z'), text: '## Summary\nRecap: the customer wants to build the claims triage agent first.' };
    const first = planCandidates({ sources: [a], mentions: mentionsOf([a]).sure, world, totals4w: new Map(), existing: [], candidates: [], now: a.at, newId: () => 'x1' });
    expect(first.creates).toHaveLength(1);
    const second = planCandidates({ sources: [b], mentions: mentionsOf([b]).sure, world, totals4w: new Map(), existing: [], candidates: first.creates, now: b.at, newId: () => 'x2' });
    expect(second.creates).toHaveLength(0);
    expect(second.updates[0]?.after.evidence.map((e) => e.sourceKey)).toEqual(['s1', 's2']);
  });

  it('unsure of the opp (an account with several open opps): the top 3 of the rundown, no guess', () => {
    const acct = accounts.find((a) => opps.filter((o) => o.account_id === a.id && !o.is_closed).length >= 2)!;
    const s: UcSource = { kind: 'slack_burst', key: 't1', sourceItemIds: ['m1'], title: '#shared', text: 'We want to build a returns agent on Agentforce.', at: '2026-11-17T10:00:00.000Z', url: null, externalEmails: [], externalDomains: [], customer: true, explicit: { accountIds: [acct.id], via: 'The channel' } };
    const plan = planCandidates({ sources: [s], mentions: mentionsOf([s]).sure, world, totals4w: new Map(), existing: [], candidates: [], now: s.at, newId: () => 'p1' });
    const c = plan.creates[0]!;
    expect(c.needsPick).toBe(true);
    expect(c.alternates.length).toBeGreaterThanOrEqual(2);
    expect(c.alternates.length).toBeLessThanOrEqual(3);
    expect(c.alternates.every((o) => o.accountId === acct.id)).toBe(true);
    expect(c.dedupeKey.startsWith(`a:${acct.id}|`)).toBe(true);
  });
});

describe('the model pass (confirm)', () => {
  it('builds one request per source and parses strictly: unknown or malformed items are "no"', () => {
    const ms = [{ statement: 'Customer asked for follow-up question support' }, { statement: 'Marisol asked for the denied-claim scenario in the demo' }];
    const req = confirmRequest(ms, ['Agentforce']);
    expect(req.user).toContain('1. Customer asked');
    expect(req.user).toContain('Products: Agentforce');
    expect(parseConfirm('not json', 2)).toEqual([]);
    expect(parseConfirm('{"items":[{"i":9,"useCase":true,"title":"X Y Z"}]}', 2)).toEqual([]);
    const ok = parseConfirm('```json\n{"items":[{"i":1,"useCase":true,"title":"Follow-up questions","problem":"Handle follow-up questions","product":"Agentforce","outcome":""},{"i":2,"useCase":false,"title":""}]}\n```', 2);
    expect(ok.map((x) => [x.i, x.useCase])).toEqual([[1, true], [2, false]]);
    const base = { sourceKey: 's', title: 'Follow-up question support', problem: 'p', products: [], track: null, outcome: '', stageHint: null, cue: 'asked for', certainty: 'unsure' as const };
    const out = applyConfirm([{ ...base, statement: ms[0]!.statement }, { ...base, statement: ms[1]!.statement }], ok);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: 'Follow-up questions', products: ['Agentforce'], certainty: 'sure' });
  });
});

const row = (o: Partial<UcCandidateRow> = {}): UcCandidateRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  source: 'gemini_note',
  sourceKey: 's1',
  title: 'Order status',
  problem: 'Brendan wants a working demo of order status before signing.',
  products: [],
  outcome: '',
  track: 'agentforce',
  stageHint: 'Discovery',
  status: 'suggested',
  rejectReason: null,
  accountId: 'a1',
  oppId: 'o1',
  confidence: 0.9,
  why: [{ code: 'explicit', weight: 0.9, text: 'The meeting is on this opportunity' }],
  needsPick: false,
  alternates: [],
  basis: 'rules',
  dedupeKey: 'o:o1||order status',
  problemKey: 'order status',
  evidence: [{ sourceKey: 's1', sourceItemId: 'si1', kind: 'gemini_note', label: 'Elderglen renewal sync', url: null, at: '2026-11-12T22:00:00.000Z', quote: 'Brendan wants a working demo of order status before signing.' }],
  signal: { kind: 'gemini', text: 'Elderglen renewal sync Order status', domains: ['elderglen.example'] },
  matchedKind: null,
  useCaseId: null,
  org62UseCaseId: null,
  vdpUseCaseId: null,
  vdpSlug: null,
  vdpDraftId: null,
  createdAt: '2026-11-12T22:00:00.000Z',
  decidedAt: null,
  updatedAt: '2026-11-12T22:00:00.000Z',
  ...o,
});
const OPPS = [
  { id: 'o1', accountId: 'a1', isOpen: true },
  { id: 'o2', accountId: 'a1', isOpen: true },
  { id: 'o3', accountId: 'a1', isOpen: false },
];

describe('the candidates payload', () => {
  it('caps audit: lists every decision of the 30-day window (was the newest 50)', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row({ id: `uc${i}`, status: 'rejected', decidedAt: `2026-11-1${i % 9}T10:00:00.000Z`, dedupeKey: `k${i}` }));
    const ctx = { accountName: () => null, oppName: () => null, org62OppId: () => null, vdpFor: () => null, holds: { held: new Map(), sent: new Map() } };
    const p = candidatesPayload([...rows, row({ id: 'old', status: 'rejected', decidedAt: '2026-09-01T00:00:00.000Z' })], ctx, { enabled: true, now: '2026-11-20T00:00:00.000Z', generatedAt: null });
    expect(p.decided).toHaveLength(60);
  });
});

describe('decisions, staging, the canvas row, the landing', () => {
  it('accept on the shown opp: an accept learning; staged in both systems when the account has a VDP', () => {
    const d = decideCandidate(row(), { decision: 'accept' }, OPPS, '2026-11-18T16:00:00.000Z');
    expect(d.stage).toBe(true);
    expect(d.learning).toMatchObject({ outcome: 'accept', chosen: { oppId: 'o1' } });
    const p = stagePlanOf(d.next, { org62OppId: '006SMPL00000008AAA', oppOpen: true, vdpSlug: 'elderglen-outdoors-expansion', inOrg62: false, inVdp: false });
    expect(p).toMatchObject({ status: 'accepted', org62: true, vdp: { vdpSlug: 'elderglen-outdoors-expansion', title: 'Order status', track: 'agentforce' } });
    expect(stagePlanOf(d.next, { org62OppId: '006X', oppOpen: true, vdpSlug: null, inOrg62: false, inVdp: false }).status).toBe('staged_org62');
    expect(stagePlanOf(d.next, { org62OppId: null, oppOpen: true, vdpSlug: 'v', inOrg62: false, inVdp: false }).status).toBe('staged_vdp');
    expect(() => stagePlanOf(d.next, { org62OppId: null, oppOpen: true, vdpSlug: null, inOrg62: false, inVdp: false })).toThrow(/Nowhere/);
  });

  it('unsure: accept needs a pick; a pick of another opp is an edit learning (a correction)', () => {
    const r = row({ needsPick: true });
    expect(() => decideCandidate(r, { decision: 'accept' }, OPPS, 'now')).toThrow(/Pick the opportunity/);
    const d = decideCandidate(r, { decision: 'accept', oppId: 'o2' }, OPPS, 'now');
    expect(d.next).toMatchObject({ oppId: 'o2', needsPick: false });
    expect(d.learning).toMatchObject({ outcome: 'edit', chosen: { oppId: 'o2' }, shown: { oppId: 'o1' } });
    expect(() => decideCandidate(r, { decision: 'accept', oppId: 'o3' }, OPPS, 'now')).toThrow(/closed/);
  });

  it('reject: says why; wrong opp alone decays (a reject learning), wrong opp with the right one moves it (an edit)', () => {
    expect(() => decideCandidate(row(), { decision: 'reject' }, OPPS, 'now')).toThrow(/Say why/);
    const no = decideCandidate(row(), { decision: 'reject', reason: 'not_use_case' }, OPPS, 'now');
    expect(no.next).toMatchObject({ status: 'rejected', rejectReason: 'not_use_case' });
    expect(no.learning).toBeNull();
    const wrong = decideCandidate(row(), { decision: 'reject', reason: 'wrong_opp' }, OPPS, 'now');
    expect(wrong.learning).toMatchObject({ outcome: 'reject', shown: { oppId: 'o1' } });
    const moved = decideCandidate(row(), { decision: 'reject', reason: 'wrong_opp', oppId: 'o2' }, OPPS, 'now');
    expect(moved.next).toMatchObject({ status: 'edited', oppId: 'o2' });
    expect(moved.learning?.outcome).toBe('edit');
    expect(() => decideCandidate(row({ status: 'rejected' }), { decision: 'accept' }, OPPS, 'now')).toThrow(/rejected already/);
  });

  it('edit updates the words and re-keys it; nothing is staged', () => {
    const d = decideCandidate(row(), { decision: 'edit', title: 'Order status agent', outcome: 'Containment 40%' }, OPPS, 'now');
    expect(d.stage).toBe(false);
    expect(d.next).toMatchObject({ status: 'edited', title: 'Order status agent', outcome: 'Containment 40%' });
    expect(d.next.problemKey).toBe('agent order status');
  });

  it('the canvas row: Use_Case__c with CC-UC#cand-<id>; held by a waiting canvas, handed off by a sent one', () => {
    const r = row({ status: 'accepted', vdpSlug: 'elderglen-outdoors-expansion' });
    const opp = { org62Id: '006SMPL00000008AAA', name: 'Elderglen renewal', accountOrg62Id: '001SMPL00000008AAA', closeDate: '2026-11-30' };
    const c = canvasCreateOf(r, opp);
    expect(c).toMatchObject({ vdpUseCaseId: `cand-${r.id}`, name: 'Order status', opportunityId: opp.org62Id, product: 'Agentforce', stage: 'U03 - Scoping' });
    expect(c.notes).toMatch(new RegExp(`Source: VDP elderglen-outdoors-expansion .*CC-UC#cand-${r.id}$`));
    const none = { held: new Map(), sent: new Map() };
    expect(pendingCandidateCreates([r], none, () => opp)).toHaveLength(1);
    expect(pendingCandidateCreates([r], { held: new Map([[candidateRowKey(r.id), 'd1']]), sent: new Map() }, () => opp)).toHaveLength(0);
    expect(pendingCandidateCreates([{ ...r, status: 'staged_vdp' }], none, () => opp)).toHaveLength(0);
    // the plan's VDP → Org62 twin (VDP read the new use case before Org62 read the record) is left out
    const twin = { ...c, vdpUseCaseId: 'vdp-uc-new', name: 'Order Status' };
    expect(withoutCandidateDuplicates([twin], [r], () => opp.org62Id)).toEqual([]);
  });

  it('the landing: Org62 and VDP found it → landed; only one of two → still accepted with its id', () => {
    const r = row({ status: 'accepted', vdpSlug: 'v1' });
    const facts = { org62: [{ id: 'a1XSMPL00000099AAA', name: 'Order status', opportunityId: '006SMPL00000008AAA' }], vdp: [] as Array<{ id: string; title: string | null; vdpSlug: string }> };
    expect(landingOf(r, '006SMPL00000008AAA', facts)).toEqual({ org62UseCaseId: 'a1XSMPL00000099AAA' });
    expect(landingOf(r, '006SMPL00000008AAA', { ...facts, vdp: [{ id: 'u9', title: 'Order Status', vdpSlug: 'v1' }] })).toEqual({ org62UseCaseId: 'a1XSMPL00000099AAA', vdpUseCaseId: 'u9', status: 'landed' });
    expect(landingOf(row({ status: 'staged_org62' }), '006SMPL00000008AAA', facts)).toMatchObject({ status: 'landed' });
    expect(landingOf(row(), '006SMPL00000008AAA', facts)).toBeNull(); // not staged: nothing to land
  });

  it('the canvas question carries the suggested marker and the opp it was accepted on', () => {
    const q: UseCaseQuestion = { code: 'pick_opp' as const, text: 'Which opp?', opps: [{ org62Id: '006SMPL00000008AAA', name: 'Renewal' }, { org62Id: '006SMPL00000009AAA', name: 'Other' }] };
    const m = markSuggested(q, { title: 'Order Status', accountId: 'a1' }, [{ id: 'c1', title: 'Order status', accountId: 'a1', oppOrg62Id: '006SMPL00000008', from: 'Elderglen renewal sync' }]);
    expect(m?.suggested).toEqual({ candidateId: 'c1', org62Id: '006SMPL00000008AAA', why: 'Suggested by the app from Elderglen renewal sync: the opp you accepted it on' });
    expect(markSuggested(q, { title: 'Something else', accountId: 'a1' }, [{ id: 'c1', title: 'Order status', accountId: 'a1', oppOrg62Id: null, from: null }])).toBe(q);
    expect(markSuggested(null, { title: 'x', accountId: null }, [])).toBeNull();
  });

  it('findMatch: same opp, or same account when either is unsettled; a different account never', () => {
    const w = { opps: [{ id: 'o1', accountId: 'a1' }, { id: 'o2', accountId: 'a2' }] } as unknown as World;
    const ex: UcExisting[] = [{ kind: 'vdp', id: 'u1', title: 'Order status agent', oppId: 'o1', accountId: 'a1' }];
    expect(findMatch(w, { oppId: 'o1', accountId: 'a1', title: 'Order status', dedupeKey: 'k' }, ex, [])?.kind).toBe('vdp');
    expect(findMatch(w, { oppId: null, accountId: 'a1', title: 'order status', dedupeKey: 'k', needsPick: true }, ex, [])?.kind).toBe('vdp');
    expect(findMatch(w, { oppId: 'o2', accountId: 'a2', title: 'Order status', dedupeKey: 'k' }, ex, [])).toBeNull();
  });

  it('the count joins Needs you', () => {
    expect(needsYouCount({ rows: 1, useCases: 0, candidates: 2 }).total).toBe(3);
  });
});
