/**
 * opp_engagement rollup, the DC suggestion rule and Org62 discovery (src/engines/attribution engagement.ts, dc.ts,
 * discover.ts), pure: the multi-opp split, every edge case lane 06 named (a burst spanning two accounts, internal-only
 * meetings, a covered AE's opp I never touched, reassigned opps, closed-lost opps), rejects coming back only on a
 * material change, dcProducts, and the fixed SELECTs with a recorded Org62 answer.
 */
import { describe, expect, it } from 'vitest';

import { creditOf, rollupEngagement, totalsByOpp, type EngagementTouch } from '@/engines/attribution/engagement';
import { oppRundown } from '@/engines/attribution/rundown';
import { oppsSoql, parseDiscovered, parseUsers, teamSoql, userLookupSoql, viaOf } from '@/engines/attribution/discover';
import { coverageOf, coverageReason, coverageWhy } from '@/engines/attribution/coverage';
import { DEFAULT_TIME_SETTINGS, TimeSettings } from '@/contract';
import { planDcSuggestions, sellsDcProduct, sharesOf, decideDc, type DcCandidateOpp, type DcRuleInput } from '@/engines/attribution/dc';
import { lastCallsByAccount, resurfaced, returnedFindings } from '@/engines/attribution/resurface';
import type { ActivityEntry, MissedOpp, NeedDecision } from '@/contract';

const open = new Map([
  ['acc-a', ['opp-a1', 'opp-a2']],
  ['acc-b', ['opp-b1']],
]);
const t = (x: Partial<EngagementTouch>): EngagementTouch => ({ kind: 'meeting', at: '2026-11-17T17:00:00.000Z', day: '2026-11-17', ...x });

describe('opp_engagement rollup (Hours are human hours)', () => {
  it('credits 1.0 to the logged opp, the score to alternates ≥ 0.5, spreads account-only touches; hours only on the logged opp', () => {
    expect(creditOf(t({ oppId: 'opp-a1' }), open)).toEqual([{ oppId: 'opp-a1', w: 1 }]);
    expect(creditOf(t({ candidates: [{ oppId: 'opp-a1', score: 0.8 }, { oppId: 'opp-a2', score: 0.4 }] }), open)).toEqual([{ oppId: 'opp-a1', w: 0.8 }]);
    expect(creditOf(t({ accountId: 'acc-a' }), open)).toEqual([{ oppId: 'opp-a1', w: 0.5 }, { oppId: 'opp-a2', w: 0.5 }]);
    const rows = rollupEngagement([t({ oppId: 'opp-a1', hours: 2, external: true }), t({ kind: 'logged', candidates: [{ oppId: 'opp-a1', score: 0.9 }, { oppId: 'opp-a2', score: 0.6 }], hours: 3 })], open);
    const a1 = rows.find((r) => r.oppId === 'opp-a1')!;
    const a2 = rows.find((r) => r.oppId === 'opp-a2')!;
    expect(a1.hoursLogged).toBe(2); // the alternate's 3 h never land on an opp the row is not logged to
    expect(a2.hoursLogged).toBe(0);
    expect(a1.externalMeetings).toBe(1);
    expect(a1.credit).toBe(1.9);
    expect(a1.weekStart).toBe('2026-11-16');
  });

  it('a Slack burst spanning two accounts credits both accounts’ opps at their scores, neither in full', () => {
    const rows = rollupEngagement([t({ kind: 'slack', count: 12, candidates: [{ oppId: 'opp-a1', score: 0.7 }, { oppId: 'opp-b1', score: 0.6 }] })], open);
    expect(rows.map((r) => [r.oppId, r.credit, r.slackLines])).toEqual([
      ['opp-a1', 0.7, 8.4],
      ['opp-b1', 0.6, 7.2],
    ]);
  });

  it('an internal-only meeting (no customer, no account, no opp) credits nothing', () => {
    expect(rollupEngagement([t({ external: false })], open)).toEqual([]);
  });

  it('totals by opp from a week on, and the evidence links (newest first)', () => {
    const rows = rollupEngagement([t({ oppId: 'opp-b1', ref: { label: 'Demo', url: 'https://x.example/1' } }), t({ oppId: 'opp-b1', day: '2026-11-03', at: '2026-11-03T17:00:00.000Z', ref: { label: 'Kickoff', url: null } })], open);
    const tot = totalsByOpp(rows, '2026-11-02').get('opp-b1')!;
    expect(tot.meetings).toBe(2);
    expect(tot.refs.map((r) => r.label)).toEqual(['Demo', 'Kickoff']);
    expect(totalsByOpp(rows, '2026-11-16').get('opp-b1')!.meetings).toBe(1);
  });
});

const opp = (x: Partial<DcCandidateOpp> & { id: string }): DcCandidateOpp => ({ accountId: 'acc-a', name: `ACME ${x.id} Data 360`, isOpen: true, isMine: false, myDc: false, amount: 200_000, products: [], ...x });
const totals = (m: Record<string, Partial<{ hoursLogged: number; externalMeetings: number; credit: number; meetings: number; slackLines: number }>>) =>
  new Map(Object.entries(m).map(([k, v]) => [k, { hoursLogged: 0, meetings: 0, externalMeetings: 0, slackLines: 0, mailThreads: 0, docsTouched: 0, sessions: 0, notes: 0, credit: 0, lastTouchAt: '2026-11-17T17:00:00.000Z', refs: [{ label: 'ACME demo', url: 'https://cal.example/1', at: '2026-11-17T17:00:00.000Z' }], ...v }]));
let n = 0;
const base = (x: Partial<DcRuleInput>): DcRuleInput => ({ opps: [], totals: new Map(), coveredAes: [], dcProducts: ['Data 360'], minAmount: 10_000, dcSplit: 'full', quarter: 'FY27 Q4', existing: [], newId: () => `dcs-${++n}`, ...x });

describe('the DC suggestion rule', () => {
  it('suggests where I did the work: team, ≥ 1 h, ≥ 2 customer meetings or credit ≥ 3; pre-ticks with evidence', () => {
    const plan = planDcSuggestions(base({ opps: [opp({ id: 'team', isMine: true }), opp({ id: 'hours' }), opp({ id: 'meet' }), opp({ id: 'none' })], totals: totals({ hours: { hoursLogged: 1.5, credit: 2 }, meet: { externalMeetings: 2, credit: 2 } }) }));
    const by = new Map(plan.upserts.map((u) => [u.oppId, u]));
    expect([...by.keys()].sort()).toEqual(['hours', 'meet', 'team']);
    expect(by.get('hours')!.reasons[0]!.text).toMatch(/1.5 h logged/);
    expect(by.get('hours')!.evidence[0]!.url).toBe('https://cal.example/1');
    expect(plan.upserts.every((u) => u.state === 'new' && u.splitPercent === 100)).toBe(true);
  });

  it('several opps of one engagement: one group, evidence shares adding to 100, split 100% (or the share with dcSplit evidence)', () => {
    const input = base({ opps: [opp({ id: 'x1' }), opp({ id: 'x2' }), opp({ id: 'x3', accountId: 'acc-b' })], totals: totals({ x1: { credit: 6, hoursLogged: 2 }, x2: { credit: 3, externalMeetings: 2 }, x3: { credit: 4 } }) });
    const plan = planDcSuggestions(input);
    const g = plan.upserts.filter((u) => u.groupKey === 'FY27 Q4|acc-a');
    expect(g.map((u) => [u.oppId, u.sharePercent])).toEqual([
      ['x1', 67],
      ['x2', 33],
    ]);
    expect(g.every((u) => u.reasons.some((r) => r.code === 'alternate'))).toBe(true);
    expect(plan.upserts.find((u) => u.oppId === 'x3')!.sharePercent).toBe(100);
    const ev = planDcSuggestions({ ...input, dcSplit: 'evidence', existing: [] });
    expect(ev.upserts.filter((u) => u.groupKey === 'FY27 Q4|acc-a').map((u) => u.splitPercent)).toEqual([67, 33]);
    expect(sharesOf([1 / 3, 1 / 3, 1 / 3])).toEqual([34, 33, 33]);
  });

  it('another architect’s DC on the opp: no default split, not pre-ticked (a split question)', () => {
    const plan = planDcSuggestions(base({ opps: [opp({ id: 'o', isMine: true, otherArchitectDc: true })] }));
    expect(plan.upserts[0]!.splitPercent).toBeNull();
    expect(plan.upserts[0]!.preTicked).toBe(false);
    expect(plan.upserts[0]!.reasons.map((r) => r.code)).toContain('split_question');
  });

  it('a covered (ae) AE’s opp I never touched is suggested, unticked (AT-09 as amended by D-103); one I touched too', () => {
    const ae = { name: 'Dana AE' };
    const plan = planDcSuggestions(base({ opps: [opp({ id: 'never', owner: { name: 'Dana AE' } }), opp({ id: 'touched', owner: { name: 'Dana AE' } })], totals: totals({ touched: { credit: 0.6 } }), coveredAes: [ae] }));
    expect(plan.upserts.map((u) => u.oppId).sort()).toEqual(['never', 'touched']);
    const never = plan.upserts.find((u) => u.oppId === 'never')!;
    expect(never.coveredAe).toBe('Dana AE');
    expect(never.preTicked).toBe(false);
    expect(never.splitPercent).toBe(100);
    expect(never.reasons.find((r) => r.code === 'covered_ae')!.text).toBe("Dana AE's deal (AE you cover)");
  });

  it('a reassigned opp: suggested only for its covered AE, it goes stale when the AE changes (kept, not deleted)', () => {
    const first = planDcSuggestions(base({ opps: [opp({ id: 'r', owner: { name: 'Dana AE' } })], totals: totals({ r: { credit: 1 } }), coveredAes: [{ name: 'Dana AE' }] }));
    const row = first.upserts[0]!;
    const after = planDcSuggestions(base({ opps: [opp({ id: 'r', owner: { name: 'Someone Else' }, accountId: 'acc-moved' })], totals: totals({ r: { credit: 1 } }), coveredAes: [{ name: 'Dana AE' }], existing: [row] }));
    expect(after.upserts).toEqual([{ ...row, state: 'stale', preTicked: false }]);
  });

  it('a reassigned opp that still qualifies is regrouped under its new account', () => {
    const first = planDcSuggestions(base({ opps: [opp({ id: 'm', isMine: true })] }));
    const after = planDcSuggestions(base({ opps: [opp({ id: 'm', isMine: true, accountId: 'acc-new' })], existing: first.upserts }));
    expect(after.upserts[0]!.id).toBe(first.upserts[0]!.id);
    expect(after.upserts[0]!.groupKey).toBe('FY27 Q4|acc-new');
  });

  it('closed-lost (and won) opps stop being suggested; the suggestion is kept as closed (history)', () => {
    const first = planDcSuggestions(base({ opps: [opp({ id: 'c', isMine: true })] }));
    const after = planDcSuggestions(base({ opps: [opp({ id: 'c', isMine: true, isOpen: false, isWon: false })], existing: first.upserts }));
    expect(after.upserts).toEqual([{ ...first.upserts[0]!, state: 'closed', preTicked: false }]);
    // a closed opp never gets a fresh suggestion
    expect(planDcSuggestions(base({ opps: [opp({ id: 'c2', isMine: true, isOpen: false })] })).upserts).toEqual([]);
  });

  it('a rejected suggestion comes back only on a material change (2 h more, or I join the team)', () => {
    const first = planDcSuggestions(base({ opps: [opp({ id: 'j' })], totals: totals({ j: { hoursLogged: 1 } }) }));
    const rejected = decideDc(first.upserts[0]!, 'reject', { hours: 1, onTeam: false });
    expect(rejected.state).toBe('rejected');
    expect(planDcSuggestions(base({ opps: [opp({ id: 'j' })], totals: totals({ j: { hoursLogged: 2.5 } }), existing: [rejected] })).upserts).toEqual([]);
    expect(planDcSuggestions(base({ opps: [opp({ id: 'j' })], totals: totals({ j: { hoursLogged: 3 } }), existing: [rejected] })).upserts[0]!.state).toBe('new');
    expect(planDcSuggestions(base({ opps: [opp({ id: 'j', isMine: true })], totals: totals({ j: { hoursLogged: 1 } }), existing: [rejected] })).upserts[0]!.state).toBe('new');
  });

  describe('one dismissal memory (D-103 (d), AT-13): back once on a call on its account after the dismissal', () => {
    const AT = '2026-11-20T18:00:00.000Z';
    const callOn = (start: string, x: Partial<ActivityEntry> = {}) =>
      ({ status: 'proposed', internal: false, sources: [{ kind: 'calendar', label: 'Calendar · ACME sync' }], fromOrg62: false, meetingType: 'CF', oppId: null, accountName: 'ACME', start, end: start.replace('T17', 'T18'), ...x }) as ActivityEntry;
    const accts = [{ id: 'acc-a', name: 'ACME' }];
    const calls = (rows: ActivityEntry[], now = '2026-11-25T00:00:00.000Z') => lastCallsByAccount(rows, accts, [{ id: 'j', accountId: 'acc-a' }], now);
    const rejectedJ = () => decideDc(planDcSuggestions(base({ opps: [opp({ id: 'j' })], totals: totals({ j: { hoursLogged: 1 } }) })).upserts[0]!, 'reject', { hours: 1, onTeam: false, lastCallAt: '2026-11-18T17:00:00.000Z', at: AT });
    const plan = (existing: ReturnType<typeof rejectedJ>[], c: Map<string, string>) => planDcSuggestions(base({ opps: [opp({ id: 'j', accountName: 'ACME' })], totals: totals({ j: { hoursLogged: 1 } }), existing, calls: c, timezone: 'America/Denver' }));

    it('stays hidden until a call after the Reject, then comes back once, saying why in plain words', () => {
      const r = rejectedJ();
      expect(r.baseline).toEqual({ hours: 1, onTeam: false, lastCallAt: '2026-11-18T17:00:00.000Z', at: AT });
      expect(plan([r], calls([callOn('2026-11-18T17:00:00.000Z')])).upserts).toEqual([]); // the call before the Reject
      const back = plan([r], calls([callOn('2026-11-24T17:00:00.000Z')])).upserts[0]!;
      expect(back.state).toBe('new');
      expect(back.reasons[0]).toEqual({ code: 'returned', text: 'You met ACME on Nov 24, after you set this aside' });
      // still says why on the next run, until decided again
      expect(plan([back], calls([callOn('2026-11-24T17:00:00.000Z')])).upserts[0]!.reasons[0]!.code).toBe('returned');
      // a second Reject moves the memory past that call: hidden again
      const again = decideDc(back, 'reject', { hours: 1, onTeam: false, lastCallAt: '2026-11-24T17:00:00.000Z', at: '2026-11-25T00:00:00.000Z' });
      expect(plan([again], calls([callOn('2026-11-24T17:00:00.000Z')])).upserts).toEqual([]);
    });

    it('Slack and mail never bring it back; an internal or future meeting is not a call; an Org62 Event is', () => {
      const r = rejectedJ();
      const slack = callOn('2026-11-24T17:00:00.000Z', { sources: [{ kind: 'slack', label: '#acme-ext' }] });
      const mail = callOn('2026-11-24T17:00:00.000Z', { sources: [{ kind: 'gmail', label: 'Gmail · Dana' }], meetingType: null });
      const internal = callOn('2026-11-24T17:00:00.000Z', { internal: true });
      const future = callOn('2026-11-26T17:00:00.000Z');
      expect(plan([r], calls([slack, mail, internal, future])).upserts).toEqual([]);
      expect(calls([callOn('2026-11-24T17:00:00.000Z', { sources: [], fromOrg62: true, oppId: 'j', accountName: null })]).get('acc-a')).toBe('2026-11-24T17:00:00.000Z');
    });

    it('an old baseline (hours and team only) loads: no call before its decision time counts, hours and team still do', () => {
      const old = { ...rejectedJ(), baseline: { hours: 1, onTeam: false }, decidedAt: AT };
      expect(plan([old], calls([callOn('2026-11-19T17:00:00.000Z')])).upserts).toEqual([]);
      expect(plan([old], calls([callOn('2026-11-24T17:00:00.000Z')])).upserts[0]!.state).toBe('new');
      // no time at all: calls never bring it back
      expect(plan([{ ...old, decidedAt: null }], calls([callOn('2026-11-24T17:00:00.000Z')])).upserts).toEqual([]);
      expect(resurfaced({ hours: 1, onTeam: false }, { hours: 3, onTeam: false, lastCallAt: null })?.why).toBe('hours');
      expect(resurfaced({ hours: 1, onTeam: false }, { hours: 1, onTeam: true, lastCallAt: null })?.why).toBe('team');
    });

    it('a dismissed missed-opp finding comes back once on a call (B-118), and stays dismissed without one', () => {
      const m = { id: 'mo-1', verdict: 'claim', oppId: 'j', oppName: 'ACME j', accountName: 'ACME', amount: 1, stage: 'Open', closeDate: null, evidence: ['Your account, no DC'], otherDcs: [], status: 'dismissed', dismissReason: 'not_mine', claimedWorkItemId: null, dcRequestId: null, foundAt: AT } as MissedOpp;
      const d: NeedDecision = { rule: 'missed_opp', subjectId: 'mo-1', kind: 'not_needed', until: null, reason: 'not_mine', label: 'ACME j', baseline: { hours: 0, onTeam: false, lastCallAt: null, at: AT }, decidedAt: AT };
      const world = (c: Map<string, string>) => ({ opps: [{ id: 'j', accountId: 'acc-a', isMine: false, hoursQtd: 0 }], accounts: accts, calls: c, timezone: 'America/Denver' });
      expect(returnedFindings([m], [d], world(calls([])))[0]!.status).toBe('dismissed');
      expect(returnedFindings([m], [d], world(calls([callOn('2026-11-24T17:00:00.000Z', { sources: [{ kind: 'slack', label: '#acme' }] })])))[0]!.status).toBe('dismissed');
      const back = returnedFindings([m], [d], world(calls([callOn('2026-11-24T17:00:00.000Z')])))[0]!;
      expect([back.status, back.evidence[0]]).toEqual(['new', 'You met ACME on Nov 24, after you set this aside']);
      // dismissed before D-103 (no decision): stays dismissed
      expect(returnedFindings([m], [], world(calls([callOn('2026-11-24T17:00:00.000Z')])))[0]!.status).toBe('dismissed');
      // dismissed again after the call: hidden again
      const again = { ...d, baseline: { ...d.baseline, lastCallAt: '2026-11-24T17:00:00.000Z', at: '2026-11-25T00:00:00.000Z' }, decidedAt: '2026-11-25T00:00:00.000Z' };
      expect(returnedFindings([m], [again], world(calls([callOn('2026-11-24T17:00:00.000Z')])))[0]!.status).toBe('dismissed');
    });
  });

  it('a DC of mine or a live request resolves it; small deals and products that do not count are left out', () => {
    const first = planDcSuggestions(base({ opps: [opp({ id: 'd', isMine: true })] }));
    expect(planDcSuggestions(base({ opps: [opp({ id: 'd', isMine: true, myDc: true })], existing: first.upserts })).upserts[0]!.state).toBe('resolved');
    expect(planDcSuggestions(base({ opps: [opp({ id: 'q', isMine: true, requested: true })] })).upserts).toEqual([]);
    expect(planDcSuggestions(base({ opps: [opp({ id: 's', isMine: true, amount: 5_000 })] })).upserts).toEqual([]);
    expect(planDcSuggestions(base({ opps: [opp({ id: 'p', isMine: true, name: 'ACME Field Service' })] })).upserts).toEqual([]);
    expect(planDcSuggestions(base({ opps: [opp({ id: 'p', isMine: true, name: 'ACME Field Service' })], dcProducts: [] })).upserts).toHaveLength(1);
    expect(sellsDcProduct({ name: 'X', products: ['Data Cloud Credits'] }, ['data cloud'])).toBe(true);
    expect(sellsDcProduct({ name: 'Agentforce for Service' }, ['Data 360'])).toBe(false);
  });

  it('accepting keeps the request id and the split, and the baseline for later', () => {
    const row = planDcSuggestions(base({ opps: [opp({ id: 'k', isMine: true })] })).upserts[0]!;
    const acc = decideDc(row, 'edit', { hours: 4, onTeam: true }, 'req-1', 60);
    expect([acc.state, acc.dcRequestId, acc.splitPercent, acc.baseline]).toEqual(['edited', 'req-1', 60, { hours: 4, onTeam: true }]);
  });
});

describe('the rundown of opps when unsure', () => {
  it('lists the candidates and every open opp on their accounts, with my last 4 weeks on each', () => {
    const rd = oppRundown(
      { candidates: [{ kind: 'account', oppId: null, accountId: 'acc-a', confidence: 0.8, why: [] }], top: null, needsAsk: true },
      { opps: [opp({ id: 'opp-a1' }), opp({ id: 'opp-a2', isMine: true }), opp({ id: 'other', accountId: 'acc-z' })], totals4w: totals({ 'opp-a2': { meetings: 3, hoursLogged: 2 } }), coveredAes: [] },
    );
    expect(rd.map((o) => o.oppId)).toEqual(['opp-a2', 'opp-a1']);
    expect(rd[0]!.meetings4w).toBe(3);
  });
});

/** What a soqlQuery call answers (recorded shape, placeholder ids and names). */
const RECORDED_TEAM = JSON.stringify({
  totalSize: 2,
  done: true,
  records: [
    { attributes: { type: 'OpportunityTeamMember' }, OpportunityId: '006SMPL00000099AAA', UserId: '005SMPL00000001AAA', TeamMemberRole: 'Solutions Engineer', Opportunity: { Name: 'Quartzline - Data 360 Pilot', AccountId: '001SMPL00000099AAA', Account: { Name: 'Quartzline Labs' }, StageName: 'Discovery', CloseDate: '2027-01-30', Amount: 300000, IsClosed: false, IsWon: false, OwnerId: '005SMPL00000050AAA', Owner: { Name: 'Dana AE' } } },
    { attributes: { type: 'OpportunityTeamMember' }, OpportunityId: '006SMPL00000098AAA', UserId: '005SMPL00000050AAA', TeamMemberRole: 'Account Executive', Opportunity: { Name: 'Brightwater - Agentforce', AccountId: '001SMPL00000098AAA', Account: { Name: 'Brightwater' }, StageName: 'Qualify', CloseDate: '2027-02-15', Amount: 120000, IsClosed: false, IsWon: false, OwnerId: '005SMPL00000050AAA', Owner: { Name: 'Dana AE' } } },
  ],
});

describe('Org62 discovery (fixed SELECTs, a recorded answer)', () => {
  it('builds read-only SELECTs only, ≤ 200 ids per list, refusing ids that are not ids', () => {
    const q = teamSoql(['005SMPL00000001AAA', "x' OR 1=1"]);
    expect(q).toMatch(/^SELECT .* FROM OpportunityTeamMember WHERE UserId IN \('005SMPL00000001AAA'\) AND Opportunity.IsClosed = false ORDER BY Id LIMIT 200$/);
    const ids = Array.from({ length: 250 }, (_, i) => `001SMPL${String(i).padStart(8, '0')}AAA`);
    const qs = oppsSoql({ accountIds: ids, ownerIds: ['005SMPL00000050AAA'] });
    expect(qs).toHaveLength(3);
    for (const x of qs) expect(x).toMatch(/^SELECT .* FROM Opportunity WHERE IsClosed = false AND (AccountId|OwnerId) IN/);
    expect(userLookupSoql("O'Brien")).toContain("Name LIKE '%O\\'Brien%'");
    expect(() => userLookupSoql('a')).toThrow();
  });

  it('parses a recorded answer into opps with their team rows and provenance (me → discovered, a covered AE → covered_ae)', () => {
    const found = parseDiscovered(RECORDED_TEAM);
    const mine = found.get('006SMPL00000099')!;
    expect(mine).toMatchObject({ name: 'Quartzline - Data 360 Pilot', accountName: 'Quartzline Labs', amount: 300000, ownerName: 'Dana AE' });
    expect(viaOf(mine, '005SMPL00000001AAA', new Set(['005SMPL00000050']))).toBe('discovered');
    expect(viaOf(found.get('006SMPL00000098')!, '005SMPL00000001AAA', new Set(['005SMPL00000050']))).toBe('covered_ae');
    expect(parseUsers(JSON.stringify({ records: [{ Id: '005SMPL00000050AAA', Name: 'Dana AE', Email: 'dana.ae@example.com', Title: 'Account Executive' }, { Id: '001NOTAUSER0000' }] }))).toEqual([{ org62UserId: '005SMPL00000050AAA', name: 'Dana AE', email: 'dana.ae@example.com', title: 'Account Executive' }]);
    expect(() => parseDiscovered('not json')).toThrow(/could not read/);
  });
});

describe('coverage as data (D-103 (a)): coverageOf, the DC rule, the split and the why', () => {
  const avery = { name: 'Avery Park', org62UserId: '005PLACEHOLDER0001' };
  const sfrOpp = { owner: { name: 'Someone Else' }, team: [], specialistForecastOwnerIds: ['005PLACEHOLDER0001AAA'] };

  it('matches as owner, team member or Specialist Forecast owner; precedence ae, then owner', () => {
    expect(coverageOf({ owner: { name: 'avery park' } }, [avery])).toMatchObject({ kind: 'ae', creditShare: 100, via: 'owner' });
    expect(coverageOf({ owner: { name: 'X' }, team: [{ org62UserId: '005PLACEHOLDER0001' }] }, [avery])).toMatchObject({ via: 'team' });
    expect(coverageOf(sfrOpp, [avery])).toMatchObject({ via: 'sfr', ae: avery });
    expect(coverageOf({ owner: { name: 'Avery Park' } }, [{ ...avery, kind: 'sme' }, { name: 'Avery Park', kind: 'ooo' }])).toMatchObject({ kind: 'ooo', creditShare: 50 });
    expect(coverageOf({ owner: { name: 'Nobody' } }, [avery])).toBeNull();
  });

  it('holds only inside its window (to inclusive); without asOf the window is not checked', () => {
    const ooo = { name: 'Avery Park', kind: 'ooo' as const, window: { from: '2026-11-03', to: '2026-11-14' } };
    const o = { owner: { name: 'Avery Park' } };
    expect(coverageOf(o, [ooo], '2026-11-02')).toBeNull();
    expect(coverageOf(o, [ooo], '2026-11-14')).toMatchObject({ kind: 'ooo', creditShare: 50 });
    expect(coverageOf(o, [ooo], '2026-11-15')).toBeNull();
    expect(coverageOf(o, [ooo])).not.toBeNull();
  });

  it('an sme or ooo match needs my work to be suggested, and its credit share is the default split', () => {
    const sme = { name: 'Avery Park', kind: 'sme' as const, note: 'SME on Data Cloud call' };
    const ooo = { name: 'Rio Lane', kind: 'ooo' as const, note: 'covering for Rio Lane OOO' };
    const none = planDcSuggestions(base({ opps: [opp({ id: 's', owner: { name: 'Avery Park' } })], coveredAes: [sme] }));
    expect(none.upserts).toEqual([]);
    const plan = planDcSuggestions(base({ opps: [opp({ id: 's', owner: { name: 'Avery Park' } }), opp({ id: 'o', accountId: 'acc-b', team: [{ name: 'Rio Lane' }] })], totals: totals({ s: { credit: 0.6 }, o: { credit: 0.8 } }), coveredAes: [sme, ooo] }));
    expect(plan.upserts.find((u) => u.oppId === 's')).toMatchObject({ splitPercent: 25, preTicked: false, coveredAe: 'Avery Park' });
    expect(plan.upserts.find((u) => u.oppId === 's')!.reasons.find((r) => r.code === 'covered_ae')!.text).toBe("assisting on Avery Park's deal (SME) · 25%");
    expect(coverageReason({ kind: 'sme', creditShare: 25, via: 'owner', ae: sme }, 'Hooli')).toBe("assisting on Hooli's deal (SME) · 25%");
    const o = plan.upserts.find((u) => u.oppId === 'o')!;
    expect(o.splitPercent).toBe(50);
    expect(o.reasons.find((r) => r.code === 'covered_ae')!.text).toBe('covering for Rio Lane (OOO) · 50%');
  });

  it('a suggestion held only by coverage goes stale when the window ends; an accepted one is never changed (J-8)', () => {
    const ooo = { name: 'Avery Park', kind: 'ae' as const, window: { from: '2026-11-03', to: '2026-11-14' } };
    const o = opp({ id: 'w', owner: { name: 'Avery Park' } });
    const first = planDcSuggestions(base({ opps: [o], coveredAes: [ooo], asOf: '2026-11-10' }));
    expect(first.upserts).toHaveLength(1);
    const later = planDcSuggestions(base({ opps: [o], coveredAes: [ooo], asOf: '2026-11-20', existing: first.upserts }));
    expect(later.upserts).toEqual([{ ...first.upserts[0]!, state: 'stale', preTicked: false }]);
    const accepted = decideDc(first.upserts[0]!, 'accept', { hours: 0, onTeam: false });
    expect(planDcSuggestions(base({ opps: [o], coveredAes: [], asOf: '2026-11-20', existing: [accepted] })).upserts).toEqual([]);
  });

  it('the rundown names the coverage row that matched', () => {
    const cov = coverageOf(sfrOpp, [{ ...avery, window: { from: '2026-11-03' } }], '2026-11-23')!;
    expect(coverageWhy(cov)).toBe('via Specialist Forecast owner: Avery Park, you cover them since 3 Nov');
    const r = oppRundown(null, { opps: [opp({ id: 'x', specialistForecastOwnerIds: ['005PLACEHOLDER0001'] })], totals4w: new Map(), coveredAes: [avery], accountIds: ['acc-a'], asOf: '2026-11-23' });
    expect(r[0]).toMatchObject({ coveredAe: 'Avery Park', coverage: 'via Specialist Forecast owner: Avery Park, you cover them', why: 'via Specialist Forecast owner: Avery Park, you cover them' });
  });

  it('old settings without kind, window or share load unchanged; new fields validate', () => {
    const old = TimeSettings.parse({ ...DEFAULT_TIME_SETTINGS, coveredAes: [{ name: 'Dana AE', enabled: true }] });
    expect(old.coveredAes).toEqual([{ name: 'Dana AE', enabled: true }]);
    const row = { name: 'Rio Lane', kind: 'ooo', window: { from: '2026-11-03', to: '2026-11-14' }, creditShare: 50, note: 'covering for Rio Lane OOO' };
    expect(TimeSettings.parse({ ...DEFAULT_TIME_SETTINGS, coveredAes: [row] }).coveredAes).toEqual([{ ...row, enabled: true }]);
    expect(() => TimeSettings.parse({ ...DEFAULT_TIME_SETTINGS, coveredAes: [{ ...row, creditShare: 40 }] })).toThrow();
    expect(() => TimeSettings.parse({ ...DEFAULT_TIME_SETTINGS, coveredAes: [{ ...row, window: { from: '2026-11-14', to: '2026-11-03' } }] })).toThrow();
  });
});
