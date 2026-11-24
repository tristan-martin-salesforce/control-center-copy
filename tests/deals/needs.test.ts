/**
 * Deals needs (src/engines/deals/needs.ts): the DC-gap rule counts real gaps only, and a set-aside gap comes back only
 * on a material change (src/lib/need-decisions.ts). Placeholders only.
 */
import { describe, expect, it } from 'vitest';

import type { AccountRow, NeedDecision, Opportunity } from '@/contract';
import { dcGapBaseline, dcGapOf, dealsNeeds, type GapOpp } from '@/engines/deals/needs';
import { resurfaced, stillHides } from '@/lib/need-decisions';
import { planNeedDecisions } from '@/server/deals/needs';

const TODAY = '2026-11-11';
const NOW = '2026-11-11T18:00:00.000Z';
const DC = { split: 100, role: 'AI + Data Architect', org62DcId: 'a0XXX0000000DC1AAA', lastSeenAt: null };

const acct = (o: Partial<AccountRow> = {}): AccountRow =>
  ({ id: 'acc_c1', name: 'CUSTOMER_1', industry: null, dcStatus: 'partial', vdpStatus: 'none', hoursQtd: 4.75, team: [], org62Url: null, notes: '', myDcs: [], openOpps: 4, openTasks: 0, pipelineAmount: 3_000_000, nextCloseDate: '2027-06-30', ...o }) as AccountRow;
const opp = (id: string, o: Partial<Opportunity> = {}): GapOpp => ({ id, accountId: 'acc_c1', name: `CUSTOMER_1 – ${id}`, amount: 250_000, isOpen: true, isMine: false, dcAssigned: false, myDc: null, hoursQtd: 0, ...o });

/** The live account: 30 open opps; 3 I'm on, each with my DC; a $0 renewal with 2 h of mine; 26 others, no hours. */
function liveAccount(): GapOpp[] {
  const mine = ['team1', 'team2', 'team3'].map((id) => opp(id, { isMine: true, dcAssigned: true, myDc: DC, hoursQtd: 0.92 }));
  const renewal = opp('renewal', { name: 'CUSTOMER_1 – Renewal 1745 Platform, 232 Call Center', amount: 0, hoursQtd: 2 });
  const others = Array.from({ length: 26 }, (_, i) => opp(`other${i}`));
  return [...mine, renewal, ...others];
}

const run = (opps: GapOpp[], decisions: NeedDecision[] = [], o: { now?: string; requested?: string[]; account?: Partial<AccountRow> } = {}) =>
  dealsNeeds({ accounts: [acct(o.account)], opps, missed: [], requestedOppIds: new Set(o.requested ?? []), decisions, today: TODAY, now: o.now ?? NOW });
const fixRows = (rows: ReturnType<typeof run>) => rows.filter((r) => r.section === 'fix');

describe('the DC-gap rule: real gaps only', () => {
  it('the live case: 3 team opps with my DC, a $0 non-team renewal with 2 h, 26 others: no gap, whatever dcStatus says', () => {
    // The rule (one, pinned here): an opp with amount 0 or none counts only when I'm on its team, so my 2 h on the $0
    // renewal is no DC to claim; the team opps have my DC; the other 26 have no evidence. `dcStatus: 'partial'` and
    // `openOpps: 4` on the account row never make a gap on their own.
    expect(fixRows(run(liveAccount()))).toEqual([]);
  });

  it('counts an open opp with no DC and no request when I am on the team, logged ≥ 1 h, or the sweep says Claim', () => {
    expect(dcGapOf(opp('t', { isMine: true }), undefined, false)).toMatchObject({ reasons: ['team'] });
    expect(dcGapOf(opp('h', { hoursQtd: 2 }), undefined, false)).toMatchObject({ reasons: ['hours'], hoursQtd: 2 });
    expect(dcGapOf(opp('s'), { evidence: ['D360 product line'] }, false)).toMatchObject({ reasons: ['sweep'], evidence: ['D360 product line'] });
    // below the hours floor, no team, no sweep: no evidence
    expect(dcGapOf(opp('x', { hoursQtd: 0.75 }), undefined, false)).toBeNull();
    // my DC (read, or Org62 says so without a split yet), a request in flight, closed: handled
    expect(dcGapOf(opp('d', { isMine: true, myDc: DC, dcAssigned: true }), undefined, false)).toBeNull();
    expect(dcGapOf(opp('a', { isMine: true, dcAssigned: true }), undefined, false)).toBeNull();
    expect(dcGapOf(opp('r', { isMine: true }), undefined, true)).toBeNull();
    expect(dcGapOf(opp('c', { isMine: true, isOpen: false }), undefined, false)).toBeNull();
    // amount 0 or none: only on my team
    expect(dcGapOf(opp('z', { amount: 0, hoursQtd: 5 }), { evidence: [] }, false)).toBeNull();
    expect(dcGapOf(opp('n', { amount: null, hoursQtd: 5 }), undefined, false)).toBeNull();
    expect(dcGapOf(opp('zt', { amount: 0, isMine: true }), undefined, false)).toMatchObject({ reasons: ['team'] });
  });

  it('names the opp when there is one, the count and reasons when there are more', () => {
    const one = fixRows(run([...liveAccount(), opp('hrs', { name: 'CUSTOMER_1 – Data 360 Expansion', hoursQtd: 2 })]));
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ title: 'CUSTOMER_1: no DC on CUSTOMER_1 – Data 360 Expansion', why: '1 opp with your hours and no DC: CUSTOMER_1 – Data 360 Expansion · 2h QTD', claimOppId: 'hrs', verb: { label: 'Claim DC', href: '/deals/acc_c1?claim=hrs' } });
    expect(one[0]!.opps.map((g) => g.oppId)).toEqual(['hrs']);
    const two = fixRows(run([opp('t1', { isMine: true }), opp('h1', { hoursQtd: 1.5 })]));
    expect(two[0]).toMatchObject({ title: 'CUSTOMER_1: no DC on 2 opps', why: "2 opps without your DC (1 you're on, 1 with your hours) · 1.5h QTD", claimOppId: 't1' });
    // a request in flight on one of them: exactly the other one is left
    expect(fixRows(run([opp('t1', { isMine: true }), opp('h1', { hoursQtd: 1.5 })], [], { requested: ['t1'] }))[0]!.opps.map((g) => g.oppId)).toEqual(['h1']);
  });
});

describe('Not needed: per opp, until something material changes', () => {
  const decided = (o: GapOpp, d: Partial<NeedDecision> = {}): NeedDecision => ({ rule: 'dc_gap', subjectId: o.id, kind: 'not_needed', until: null, reason: 'Not my deal', label: o.name, baseline: dcGapBaseline(o), decidedAt: '2026-11-10T12:00:00.000Z', ...d });
  const gap = opp('hrs', { hoursQtd: 2 });

  it('leaves the gap list once set aside, and the account with it', () => {
    expect(fixRows(run([gap]))).toHaveLength(1);
    expect(fixRows(run([gap], [decided(gap)]))).toEqual([]);
    // Undo (the decision gone) brings it back
    expect(fixRows(run([gap], []))).toHaveLength(1);
  });

  it('comes back when I log 2 h more after the decision, or join the opp team; not for less', () => {
    const d = decided(gap); // baseline: 2 h, not on the team
    expect(fixRows(run([{ ...gap, hoursQtd: 3.75 }], [d]))).toEqual([]);
    expect(fixRows(run([{ ...gap, hoursQtd: 4 }], [d]))[0]!.opps.map((g) => g.oppId)).toEqual(['hrs']);
    expect(fixRows(run([{ ...gap, isMine: true }], [d]))[0]!.opps.map((g) => g.oppId)).toEqual(['hrs']);
    expect(resurfaced('dc_gap', { onTeam: false, hoursQtd: 2 }, { onTeam: false, hoursQtd: 3.99 })).toBe(false);
    expect(resurfaced('dc_gap', { onTeam: true, hoursQtd: 2 }, { onTeam: true, hoursQtd: 2 })).toBe(false);
  });

  it('D-103 (d): comes back once on a call on its account after Not needed, says why, and a second Not needed hides it again', () => {
    const withCalls = (decisions: NeedDecision[], call?: string) =>
      dealsNeeds({ accounts: [acct()], opps: [gap], missed: [], requestedOppIds: new Set(), decisions, today: TODAY, now: NOW, timezone: 'UTC', calls: new Map(call ? [['acc_c1', call]] : []) });
    // the stored baseline: the account's last call then, and when (the server reads it; the client never sends one)
    const [d] = planNeedDecisions({ rule: 'dc_gap', subjectIds: ['hrs'], kind: 'not_needed', reason: 'Not my deal' }, new Date('2026-11-10T12:00:00.000Z'), [gap], 'UTC', new Map([['acc_c1', '2026-11-09T17:00:00.000Z']]));
    expect(d!.baseline).toMatchObject({ onTeam: false, hoursQtd: 2, lastCallAt: '2026-11-09T17:00:00.000Z', at: '2026-11-10T12:00:00.000Z' });
    expect(fixRows(withCalls([d!], '2026-11-09T17:00:00.000Z'))).toEqual([]); // the call it already saw
    const back = fixRows(withCalls([d!], '2026-11-11T16:00:00.000Z'));
    expect(back[0]!.opps[0]!.evidence[0]).toBe('You met CUSTOMER_1 on Nov 11, after you set this aside');
    const [again] = planNeedDecisions({ rule: 'dc_gap', subjectIds: ['hrs'], kind: 'not_needed', reason: 'Not my deal' }, new Date(NOW), [gap], 'UTC', new Map([['acc_c1', '2026-11-11T16:00:00.000Z']]));
    expect(fixRows(withCalls([again!], '2026-11-11T16:00:00.000Z'))).toEqual([]);
    // an old baseline (no lastCallAt): a call after its decision time counts; one before it does not
    expect(fixRows(withCalls([decided(gap)], '2026-11-09T17:00:00.000Z'))).toEqual([]);
    expect(fixRows(withCalls([decided(gap)], '2026-11-11T16:00:00.000Z'))).toHaveLength(1);
  });

  it('a snooze hides until its date; Think ahead comes back on a new close date', () => {
    const s = decided(gap, { kind: 'snooze', until: '2026-11-18T16:00:00.000Z', reason: null });
    expect(fixRows(run([gap], [s]))).toEqual([]);
    expect(fixRows(run([gap], [s], { now: '2026-11-18T16:00:01.000Z' }))).toHaveLength(1);
    const ahead = (closes: string) => run([], [{ rule: 'deals_ahead', subjectId: 'acc_c1', kind: 'not_needed', until: null, reason: 'Already handled', label: null, baseline: { nextCloseDate: '2026-11-20' }, decidedAt: NOW }], { account: { nextCloseDate: closes } }).filter((r) => r.section === 'ahead');
    expect(ahead('2026-11-20')).toEqual([]);
    expect(ahead('2026-11-25')).toHaveLength(1);
    // a Home row's Not needed comes back when a new subject appears, not for one that left
    expect(stillHides({ rule: 'home:missed_dc', kind: 'not_needed', until: null, baseline: { subjects: 'm1,m2' } }, NOW, { subjects: 'm1' })).toBe(true);
    expect(stillHides({ rule: 'home:missed_dc', kind: 'not_needed', until: null, baseline: { subjects: 'm1,m2' } }, NOW, { subjects: 'm1,m3' })).toBe(false);
  });
});
