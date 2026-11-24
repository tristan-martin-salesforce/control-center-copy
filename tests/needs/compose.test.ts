/** composeNeeds: order, dedupe, no cap, a throwing provider, the persona gate, and closed rows never counted (NQ-02..04). */
import { describe, expect, it, vi } from 'vitest';
import { NeedsPayload, type NeedRow } from '@/contract';
import { composeNeeds } from '@/engines/needs/compose';
import { NEED_PROVIDERS } from '@/engines/needs/registry';
import { planNeedDecision } from '@/engines/needs/decide';
import type { NeedProvider } from '@/engines/needs/types';
import { ctxOf, draft, outbox, triage, triageItem, workItem } from './fixtures';

const row = (id: string, over: Partial<NeedRow> = {}): NeedRow =>
  ({ id: `triage_guess:${id}`, kind: 'triage_guess', title: id, why: '', who: null, account: null, opp: null, verbs: [{ id: 'accept', label: 'Accept', kbd: 'a', primary: true, call: { route: 'acceptTriage', params: { id }, body: {} }, href: null, undoable: true, feature: null }], groupKey: 'this_week', urgency: 0.5, since: '2026-11-10T00:00:00.000Z', source: null, estimateMin: null, confidence: null, subject: null, also: [], ...over }) as NeedRow;
const fixed = (kind: NeedRow['kind'], rows: NeedRow[], feature?: NeedProvider['feature']): NeedProvider => ({ kind, feature, run: () => rows });

describe('composeNeeds', () => {
  it('orders by urgency, then oldest first, then id; never caps', () => {
    const many = Array.from({ length: 250 }, (_, i) => row(`n${String(i).padStart(3, '0')}`, { urgency: 0.1 }));
    const q = composeNeeds(ctxOf(), [fixed('triage_guess', [row('late', { urgency: 0.2, since: '2026-11-17T00:00:00.000Z' }), row('early', { urgency: 0.2, since: '2026-11-01T00:00:00.000Z' }), row('hot', { urgency: 0.9 }), ...many])]);
    expect(q.rows.slice(0, 3).map((r) => r.title)).toEqual(['hot', 'early', 'late']);
    expect(q.total).toBe(253);
    expect(q.rows).toHaveLength(253);
    NeedsPayload.parse(q);
  });

  it('the same work item from two providers keeps one row with both verbs', () => {
    const t = triage([triageItem('w1', 'asks_promises')]);
    const ob = outbox([draft('d1', 'pending_approval', { workItemId: 'w1' })]);
    const q = composeNeeds(ctxOf({ triage: t, outbox: ob }));
    const rows = q.rows.filter((r) => r.subject === 'item:w1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verbs.map((v) => v.id)).toEqual(expect.arrayContaining(['accept', 'dismiss', 'review', 'reject']));
    expect(rows[0]!.verbs.filter((v) => v.primary)).toHaveLength(1);
    expect(rows[0]!.also).toHaveLength(1);
    expect(q.total).toBe(1);
  });

  it('a repeated id keeps its first row', () => {
    const q = composeNeeds(ctxOf(), [fixed('triage_guess', [row('x', { title: 'first', urgency: 0.6 }), row('x', { title: 'second', urgency: 0.3 })])]);
    expect(q.rows.map((r) => r.title)).toEqual(['first']);
  });

  it('a provider that throws gives zero rows, one onError, and the rest still render (NQ-02)', () => {
    const onError = vi.fn();
    const boom: NeedProvider = { kind: 'vdp_change', run: () => { throw new Error('bad payload'); } };
    const q = composeNeeds(ctxOf(), [boom, fixed('triage_guess', [row('ok')])], { onError });
    expect(q.rows.map((r) => r.title)).toEqual(['ok']);
    expect(q.partial).toEqual(['vdp_change']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe('vdp_change');
  });

  it('the persona gate: a kind it lacks gives nothing; a row whose primary verb it disables is never shown (NQ-03)', () => {
    const gated = row('claim', { verbs: [{ ...row('c').verbs[0]!, id: 'claim', feature: 'dealContributions' }] });
    const mixed = row('mixed', { verbs: [row('m').verbs[0]!, { ...row('m').verbs[0]!, id: 'claim', primary: false, feature: 'dealContributions' }] });
    const ae = ctxOf({ features: new Set(['activityLogging', 'specialistForecast']) });
    const q = composeNeeds(ae, [fixed('dc_suggestion', [row('dc', { kind: 'dc_suggestion', id: 'dc_suggestion:dc' })], 'dealContributions'), fixed('triage_guess', [gated, mixed])]);
    expect(q.rows.map((r) => r.title)).toEqual(['mixed']);
    expect(q.rows[0]!.verbs.map((v) => v.id)).toEqual(['accept']);
    expect(q.byKind.dc_suggestion).toBe(0);
  });

  it('counts never include closed rows (NQ-04): closed for you, sent drafts, decided suggestions', () => {
    const q = composeNeeds(
      ctxOf({
        triage: triage([triageItem('c1', 'closed_for_you'), triageItem('g1', 'asks_promises')]),
        outbox: outbox([draft('s1', 'sent'), draft('s2', 'scheduled')]),
        dc: { enabled: true, suggestions: [{ id: 'x', state: 'accepted' }] } as never,
        items: { items: [workItem('r', { reopened: { reason: 'x', at: '2026-11-01T00:00:00.000Z' }, state: 'done' })] } as never,
      }),
    );
    expect(q.rows.map((r) => r.id)).toEqual(['triage_guess:g1']);
    expect(q.total).toBe(1);
    expect(Object.values(q.byKind).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('byKind has every kind', () => {
    expect(Object.keys(composeNeeds(ctxOf(), NEED_PROVIDERS).byKind).sort()).toHaveLength(11);
  });
});

describe('planNeedDecision', () => {
  const r = row('p', {
    verbs: [
      { id: 'answer', label: 'Answer', kbd: 'a', primary: true, call: { route: 'acceptTriage', params: { id: 'p' }, body: { choiceId: 'c1' } }, href: null, choices: [{ id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }], undoable: true, feature: null },
      { id: 'dismiss', label: 'Not mine', kbd: 'n', primary: false, call: { route: 'dismissTriage', params: { id: 'p' }, body: { reason: 'not_mine' } }, href: null, undoable: true, feature: null },
      { id: 'open', label: 'Open', kbd: null, primary: false, call: null, href: '/triage', undoable: false, feature: null },
    ],
  });
  it('dispatches the verb’s route with its payload (answer takes the picked choice; a reason overrides)', () => {
    expect(planNeedDecision(r, { verb: 'answer', choiceId: 'c2' })).toMatchObject({ ok: true, plan: { route: 'acceptTriage', input: { params: { id: 'p' }, body: { choiceId: 'c2' } } } });
    expect(planNeedDecision(r, { verb: 'dismiss', reason: 'later on' })).toMatchObject({ ok: true, plan: { input: { body: { reason: 'later on' } } } });
  });
  it('refuses a verb the row lacks, a choice it did not offer, and a navigation', () => {
    expect(planNeedDecision(r, { verb: 'allow' })).toMatchObject({ ok: false, code: 'validation' });
    expect(planNeedDecision(r, { verb: 'answer', choiceId: 'zz' })).toMatchObject({ ok: false });
    expect(planNeedDecision(r, { verb: 'open' })).toMatchObject({ ok: false });
  });
});
