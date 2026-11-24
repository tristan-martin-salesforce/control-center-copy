import { describe, expect, it } from 'vitest';
import { buildFindings, deriveAccountScopes, type FindingsInput } from '@/engines/deals/findings';
import { classifyLineItems, passesThreshold } from '@/engines/deals/classify';
import { distinctiveTokens, narrowEvidence } from '@/engines/deals/evidence';
import type { EvidenceSignal } from '@/engines/deals/types';
import * as soql from '@/engines/deals/soql';
import { A_ACME, A_GLOBEX, A_INITECH, A_UNKNOWN, CORE, CORE2, LIGHT, ME, OTHER_SE, TODAY, WINDOW, dc, line, opp } from '../fixtures/org62/deals';

const T = { minAmount: 10_000, windowStart: WINDOW.start, windowEnd: WINDOW.end };

describe('classifier: line items and products', () => {
  it('D360 line items count (Data 360, Data Cloud, Data Services, Profiles, Marketing Data Bundle, Private Connect)', () => {
    for (const p of ['Data 360 Credits', 'Data Cloud Unified Profiles', 'Data Services Credits', 'Profiles', 'Marketing Data Bundle', 'Salesforce Private Connect']) {
      const c = classifyLineItems({ name: 'Plain opp' }, [line('o', p, 5000)]);
      expect(c.signal, p).toBe('d360_line');
      expect(c.d360LineAmount).toBe(5000);
    }
  });

  it('excludes $0 Provisioning and Foundations entitlements', () => {
    const c = classifyLineItems({ name: 'Plain opp' }, [line('o', 'Data Cloud Provisioning', 0), line('o', 'Data 360 Foundations', 0)]);
    expect(c.signal).toBe('none');
    expect(c.hasD360Line).toBe(false);
    expect(c.excludedEntitlements).toEqual(['Data 360 Foundations', 'Data Cloud Provisioning']);
  });

  it('a priced Foundations line is NOT excluded; user-permission "profiles" are not D360', () => {
    expect(classifyLineItems({ name: 'x' }, [line('o', 'Data 360 Foundations', 25_000)]).signal).toBe('d360_line');
    expect(classifyLineItems({ name: 'x' }, [line('o', 'Admin User Profiles', 100)]).signal).toBe('none');
  });

  it('Flex Credits only is its own category, with the amount', () => {
    const c = classifyLineItems({ name: 'Plain opp' }, [line('o', 'Flex Credits', 250_000), line('o', 'Premier Success', 10_000)]);
    expect(c).toMatchObject({ signal: 'flex_only', flexLineAmount: 250_000, d360LineAmount: 0, hasD360Line: false });
  });

  it('a D360 line wins over Flex on the same opp; a D360 name token beats Flex-only', () => {
    expect(classifyLineItems({ name: 'x' }, [line('o', 'Flex Credits', 1), line('o', 'Data Cloud', 9)])).toMatchObject({ signal: 'd360_line', d360LineAmount: 9, flexLineAmount: 1 });
    expect(classifyLineItems({ name: 'ACME - D360 Flex Credits' }, [line('o', 'Flex Credits', 100)]).signal).toBe('name_token');
  });

  it('name tokens', () => {
    for (const n of ['ACME - D360 Expansion', 'ACME Data 360 Phase 2', 'ACME Data-360', 'Globex Data Cloud UPSIDE', 'x #D360-HL', 'Private Connect Modeling'])
      expect(classifyLineItems({ name: n }, []).signal, n).toBe('name_token');
    expect(classifyLineItems({ name: 'ACME Agentforce Service' }, []).signal).toBe('none');
  });

  it('threshold: strictly above $10k; open, or closed-won in the quarter; dead/lost never', () => {
    const o = (p: object) => opp({ id: '006PLACEHOLDER0010', name: 'n', accountId: A_ACME, ...p });
    expect(passesThreshold(o({ amount: 10_000 }), T)).toBe(false);
    expect(passesThreshold(o({ amount: 10_001 }), T)).toBe(true);
    expect(passesThreshold(o({ isClosed: true, isWon: true, closeDate: '2026-11-03', stageName: 'Closed Won' }), T)).toBe(true);
    expect(passesThreshold(o({ isClosed: true, isWon: true, closeDate: '2026-08-03', stageName: 'Closed Won' }), T)).toBe(false);
    expect(passesThreshold(o({ isClosed: true, isWon: false, stageName: 'Closed Lost' }), T)).toBe(false);
    expect(passesThreshold(o({ stageName: 'Dead - Duplicate' }), T)).toBe(false);
  });
});

describe('evidence narrowing to Claim / Check', () => {
  const o = opp({ id: '006PLACEHOLDER0001', name: 'ACME - Pega Headless Data360 Expansion', accountId: A_ACME });
  const sibs = [
    { id: o.id, name: o.name },
    { id: 's1', name: 'ACME - Data 360 Renewal' },
    { id: 's2', name: 'ACME - Data 360 Headless Care Gaps' },
    { id: 's3', name: 'ACME - Data 360 Headless Phase 2' },
    { id: 's4', name: 'ACME - Agentforce Service' },
  ];
  const sig = (p: Partial<EvidenceSignal> & Pick<EvidenceSignal, 'id' | 'kind' | 'text'>): EvidenceSignal => ({ accountId: A_ACME, ...p });
  const run = (signals: EvidenceSignal[]) => narrowEvidence(o, signals, { siblings: sibs });

  it('generic words and tokens shared by account-mates do not identify an opp', () => {
    const t = distinctiveTokens(o, { siblings: sibs });
    expect(t).toEqual(['pega']); // data360/expansion are stopwords, "acme" is the account, "headless" is on 3 of 5 account-mates
  });

  it('Org62 hours >= 1 on the opp is Claim; under 1 h is Check', () => {
    expect(run([sig({ id: 'e1', kind: 'org62_event', text: 'ACME working session', oppId: o.id, hours: 1.5 })])).toMatchObject({ strength: 'strong', verdict: 'claim', myOrg62Hours: 1.5, evidenceIds: ['e1'] });
    expect(run([sig({ id: 'e2', kind: 'org62_event', text: 'ACME working session', oppId: o.id, hours: 0.5 })])).toMatchObject({ strength: 'some', verdict: 'check' });
  });

  it('an owned deliverable that names the initiative is Claim', () => {
    const r = run([sig({ id: 'd1', kind: 'drive', text: 'ACME Pega POV deck', owned: true })]);
    expect(r).toMatchObject({ verdict: 'claim', strength: 'strong' });
    expect(r.reasons[0]!.text).toMatch(/matches 'pega'/);
  });

  it('one weak signal is Check; two independent kinds of weak signal are Claim', () => {
    const slack = sig({ id: 's', kind: 'slack', text: 'Pega thread', verdict: 'some' });
    const cal = sig({ id: 'c', kind: 'calendar', text: 'Pega architecture sync', owned: true });
    expect(run([slack])).toMatchObject({ verdict: 'check', strength: 'some' });
    expect(run([slack, cal])).toMatchObject({ verdict: 'claim', strength: 'strong' });
    expect(run([slack, { ...slack, id: 's2' }])).toMatchObject({ verdict: 'check' }); // same kind twice is still one kind
  });

  it('no evidence is Skip', () => {
    expect(run([])).toMatchObject({ verdict: 'skip', strength: 'none', summary: 'no evidence tied to this opp' });
  });

  it('noise: account-level calendar hits are false matches and are ignored', () => {
    const r = run([sig({ id: 'c', kind: 'calendar', text: 'ACME account team call', owned: true })]);
    expect(r.verdict).toBe('skip');
    expect(r.ignored).toEqual([{ evidenceId: 'c', why: 'account-level only, not this opp' }]);
  });

  it('noise: unaccepted and recurring-internal calendar matches are ignored', () => {
    const r = run([
      sig({ id: 'c1', kind: 'calendar', text: 'Pega sync', owned: false }),
      sig({ id: 'c2', kind: 'calendar', text: 'Pega weekly team meeting', owned: true, recurring: true, internalOnly: true }),
    ]);
    expect(r.verdict).toBe('skip');
    expect(r.ignored.map((x) => x.evidenceId)).toEqual(['c1', 'c2']);
  });

  it('noise: multi-account Claude sessions need a distinguishing token and never reach strong alone', () => {
    const none = run([sig({ id: 'm1', kind: 'claude_session', text: 'quarterly review prep', accountCount: 4, hours: 3, accountId: undefined })]);
    expect(none.verdict).toBe('skip');
    expect(none.ignored).toHaveLength(1);
    const tok = run([sig({ id: 'm2', kind: 'claude_session', text: 'Pega rollup', accountCount: 3, hours: 3 })]);
    expect(tok).toMatchObject({ verdict: 'check', strength: 'some' });
    const single = run([sig({ id: 'm3', kind: 'claude_session', text: 'Pega build', accountCount: 1, hours: 2 })]);
    expect(single).toMatchObject({ verdict: 'claim' });
  });

  it('evidence linked to a different opp is not counted here', () => {
    const r = run([sig({ id: 'x', kind: 'org62_event', text: 'ACME Pega', oppId: 's1', hours: 5 })]);
    expect(r.verdict).toBe('skip');
    expect(r.ignored[0]!.why).toBe('linked to a different opp');
  });

  it('unowned Drive files and verdict-less Slack threads are ignored; ambiguous tokens cap at Check', () => {
    const ace = opp({ id: 'a', name: 'ACME - ACE Rollout', accountId: A_ACME });
    const a = narrowEvidence(ace, [{ id: 'd', kind: 'drive', text: 'ACE demo deck', owned: true, accountId: A_ACME }], { siblings: [{ id: 'a', name: ace.name }, ...sibs.slice(1)] });
    expect(a.verdict).toBe('check'); // "ace" is in AMBIGUOUS_TOKENS (two products share the acronym)
    expect(run([sig({ id: 'u', kind: 'drive', text: 'Pega deck', owned: false }), sig({ id: 'v', kind: 'slack', text: 'Pega' })]).ignored).toHaveLength(2);
  });
});

describe('findings', () => {
  const base = (over: Partial<FindingsInput>): FindingsInput => ({
    me: ME,
    managerName: 'Test Manager',
    today: TODAY,
    window: WINDOW,
    opps: [],
    lineItems: [],
    dcs: [],
    scopes: [CORE, CORE2, LIGHT],
    signals: [],
    ...over,
  });
  const O1 = opp({ id: '006PLACEHOLDER0001', name: 'ACME - Pega Data 360 Headless', accountId: A_ACME, amount: 311_000 });
  const O2 = opp({ id: '006PLACEHOLDER0002', name: 'ACME - Agentforce Service', accountId: A_ACME, amount: 500_000 });

  it('candidate set: only accounts he has been part of, lacking his DC, over $10k, with a D360 or Flex signal', () => {
    const f = buildFindings(
      base({
        opps: [
          O1,
          O2, // no D360/Flex signal at all
          opp({ id: '006PLACEHOLDER0003', name: 'Elsewhere D360', accountId: A_UNKNOWN }), // not his account
          opp({ id: '006PLACEHOLDER0004', name: 'ACME D360 small', accountId: A_ACME, amount: 9_000 }),
          opp({ id: '006PLACEHOLDER0005', name: 'ACME D360 covered', accountId: A_ACME }),
        ],
        dcs: [dc({ id: 'DC5', oppId: '006PLACEHOLDER0005', userId: ME.userId, userName: 'Test User' })],
        lineItems: [line(O1.id, 'Data 360 Credits', 300_000)],
      }),
    );
    expect(f.map((x) => x.opportunityId)).toEqual([O1.id]);
    expect(f[0]).toMatchObject({ tier: 'core_account_no_dc', verdict: 'skip', hasD360Line: true, d360LineAmount: 300_000, myDcExists: false });
  });

  it('scopes derive from opp team, DCs, Org62 events (core) and calendar / siblings (light)', () => {
    const s = deriveAccountScopes({
      opps: [O1, opp({ id: '006PLACEHOLDER0006', name: 'G', accountId: A_GLOBEX }), opp({ id: '006PLACEHOLDER0007', name: 'I', accountId: A_INITECH })],
      oppTeamOppIds: [O1.id],
      myDcs: [dc({ id: 'x', oppId: '006PLACEHOLDER0006', userId: ME.userId })],
      org62EventOppIds: [],
      calendarAccountIds: [A_INITECH],
    });
    expect(Object.fromEntries(s.map((x) => [x.accountId, x.kind]))).toEqual({ [A_ACME]: 'core', [A_GLOBEX]: 'core', [A_INITECH]: 'light' });
  });

  it('Flex-only on a core account is its own tier; light-touch tiers on the other accounts', () => {
    const f = buildFindings(
      base({
        opps: [
          opp({ id: '006PLACEHOLDER0010', name: 'ACME Agentforce credits', accountId: A_ACME }),
          opp({ id: '006PLACEHOLDER0011', name: 'Initech D360 Growth', accountId: A_INITECH }),
          opp({ id: '006PLACEHOLDER0012', name: 'Initech Flex pre-commit', accountId: A_INITECH }),
          opp({ id: '006PLACEHOLDER0013', name: 'ACME D360 renewal', accountId: A_ACME, type: 'Renewal' }),
        ],
        lineItems: [line('006PLACEHOLDER0010', 'Flex Credits', 500_000), line('006PLACEHOLDER0012', 'Flex Credits', 400_000)],
      }),
    );
    expect(Object.fromEntries(f.map((x) => [x.opportunityId, x.tier]))).toEqual({
      '006PLACEHOLDER0010': 'core_account_flex_only',
      '006PLACEHOLDER0011': 'light_touch',
      '006PLACEHOLDER0012': 'light_touch_flex_only',
      '006PLACEHOLDER0013': 'renewal',
    });
  });

  it('closed-won this quarter with no DC is the top tier', () => {
    const won = opp({ id: '006PLACEHOLDER0020', name: 'ACME D360 NCE add-on', accountId: A_ACME, isClosed: true, isWon: true, stageName: 'Closed Won', closeDate: '2026-11-03', amount: 48_000, deadlineToUpdate: '2026-11-03' });
    const f = buildFindings(base({ opps: [won, O1], lineItems: [line(won.id, 'Data 360 Credits', 48_000), line(O1.id, 'Data 360', 1)] }));
    expect(f[0]).toMatchObject({ opportunityId: won.id, tier: 'won_no_dc', verdict: 'check' }); // core account, won, no evidence: confirm
  });

  it('strong evidence -> Claim with a DC task and a Slackbot "DC Comment Upload" prompt draft', () => {
    const f = buildFindings(
      base({
        opps: [O1],
        lineItems: [line(O1.id, 'Data 360', 300_000)],
        signals: [{ id: 'ev1', kind: 'org62_event', text: 'ACME Pega', oppId: O1.id, hours: 4 }],
      }),
    )[0]!;
    expect(f).toMatchObject({ tier: 'strong_evidence_no_dc', verdict: 'claim', evidenceStrength: 'strong', myOrg62Hours: 4, evidenceIds: ['ev1'] });
    const claim = f.actions.find((a) => a.kind === 'claim')!;
    expect(claim.kind === 'claim' && claim.task).toMatchObject({ opportunityId: O1.id, splitPercent: 100, role: 'AI + Data Architect' });
    const prompt = claim.kind === 'claim' ? claim.task.slackbotPromptDraft : '';
    expect(prompt).toMatch(/^Run the DC Comment Upload skill with the attached CSV from my ACME Health VDP\./);
    expect(prompt).toContain(`Opportunity: ${O1.id} (ACME - Pega Data 360 Headless, closes 2027-03-31).`);
    expect(prompt).toContain('wait for my "yes" before saving');
    const dismiss = f.actions.find((a) => a.kind === 'dismiss');
    expect(dismiss).toMatchObject({ requiresReason: true });
  });

  it('split awareness: another AI + Data Architect at 100% or 50% -> "split, not a second 100%"', () => {
    const mk = (split: number) =>
      buildFindings(
        base({
          opps: [O1],
          lineItems: [line(O1.id, 'Data 360', 1)],
          dcs: [dc({ id: 'o1', oppId: O1.id, userId: OTHER_SE, userName: 'Other SE', splitPercent: split })],
          signals: [{ id: 'ev1', kind: 'org62_event', text: '', oppId: O1.id, hours: 2 }],
        }),
      )[0]!;
    const at100 = mk(100);
    expect(at100).toMatchObject({ otherArchitectDcCount: 1, suggestedSplit: 50 });
    expect(at100.splitNote).toMatch(/Split, not a second 100%: Other SE 100%/);
    const at50 = mk(50);
    expect(at50.suggestedSplit).toBe(50);
    expect(at50.splitNote).toMatch(/Other SE 50%.*Only 50% is left/);
    const claim = at100.actions.find((a) => a.kind === 'claim');
    expect(claim && claim.kind === 'claim' && claim.task.splitPercent).toBe(50);
    expect(claim && claim.kind === 'claim' && claim.task.slackbotPromptDraft).toContain('Split: 50% (share with the existing holder)');
    // A DC from a different role is not a co-holder.
    const other = buildFindings(base({ opps: [O1], lineItems: [line(O1.id, 'Data 360', 1)], dcs: [dc({ id: 'o2', oppId: O1.id, role: 'Core SE' })] }))[0]!;
    expect(other.otherArchitectDcCount).toBe(0);
    expect(other.splitNote).toBeNull();
  });

  it('deadline lock: past the lock the DC needs a manager exception and a note is drafted', () => {
    const locked = opp({ id: '006PLACEHOLDER0030', name: 'ACME D360 late', accountId: A_ACME, deadlineToUpdate: '2026-11-03' });
    const open = opp({ id: '006PLACEHOLDER0031', name: 'ACME D360 early', accountId: A_ACME, deadlineToUpdate: '2027-02-03' });
    const f = buildFindings(
      base({
        opps: [locked, open],
        signals: [
          { id: 'a', kind: 'org62_event', text: '', oppId: locked.id, hours: 2 },
          { id: 'b', kind: 'org62_event', text: '', oppId: open.id, hours: 2 },
        ],
      }),
    );
    const L = f.find((x) => x.opportunityId === locked.id)!;
    const OK = f.find((x) => x.opportunityId === open.id)!;
    expect(L.lock).toMatchObject({ deadline: '2026-11-03', locked: true, managerExceptionNeeded: true });
    expect(L.lock.noteDraft).toMatch(/^Hi Test Manager, the Deal Contribution lock for "ACME D360 late" \(ACME Health\) passed on 2026-11-03\./);
    expect(L.actions.map((a) => a.kind)).toEqual(['claim', 'request_exception', 'dismiss']);
    expect(OK.lock).toMatchObject({ locked: false, managerExceptionNeeded: false, noteDraft: null });
    expect(OK.actions.map((a) => a.kind)).toEqual(['claim', 'dismiss']);
  });

  it('lock rules fill in when the opp has no Deadline_to_Update__c', () => {
    const o = opp({ id: '006PLACEHOLDER0032', name: 'ACME D360 x', accountId: A_ACME, deadlineToUpdate: null, closeDate: '2026-11-03', isClosed: true, isWon: true, stageName: 'Closed Won' });
    const [f] = buildFindings(base({ opps: [o], lineItems: [line(o.id, 'Data 360', 1)], lockRules: [{ closeFrom: '2026-11-01', closeTo: '2027-01-31', deadline: '2026-11-03' }] }));
    expect(f!.lock).toMatchObject({ deadline: '2026-11-03', locked: true });
  });

  it('DC hygiene: my DC on a dead or duplicate opp is stranded', () => {
    const dup = opp({ id: '006PLACEHOLDER0040', name: 'ACME +MC Next POC', accountId: A_ACME, stageName: 'Dead - Duplicate' });
    const lost = opp({ id: '006PLACEHOLDER0041', name: 'ACME Olive project', accountId: A_ACME, stageName: 'Dead - Lost' });
    const survivor = opp({ id: '006PLACEHOLDER0042', name: 'ACME MC Next Phase 2', accountId: A_ACME, amount: 800_000 });
    const f = buildFindings(
      base({
        opps: [dup, lost, survivor, O2],
        dcs: [dc({ id: 'DCD', oppId: dup.id, userId: ME.userId }), dc({ id: 'DCL', oppId: lost.id, userId: ME.userId })],
      }),
    );
    const sd = f.find((x) => x.opportunityId === dup.id)!;
    const sl = f.find((x) => x.opportunityId === lost.id)!;
    expect(sd).toMatchObject({ tier: 'stranded_dc', verdict: 'check', strandedDcId: 'DCD', myDcExists: true });
    const mv = sd.actions[0]!;
    expect(mv.kind === 'move_dc' && mv.candidateOppIds[0]).toBe(survivor.id); // shares "MC", "Next" with the dead opp
    expect(sl).toMatchObject({ tier: 'stranded_dc', verdict: 'skip', strandedDcId: 'DCL' });
    expect(sl.evidenceSummary).toMatch(/nothing to recover/);
    expect(f.filter((x) => x.tier === 'stranded_dc')).toHaveLength(2);
  });

  it('covered opps are hidden by default and shown on request', () => {
    const args = base({ opps: [O1], dcs: [dc({ id: 'm', oppId: O1.id, userId: ME.userId })] });
    expect(buildFindings(args)).toEqual([]);
    expect(buildFindings({ ...args, includeCovered: true })[0]).toMatchObject({ tier: 'already_covered', verdict: 'skip' });
  });
});

describe('SOQL builders (strings only, read-only, SystemModstamp windows)', () => {
  const W = { from: '2026-11-04T00:00:00Z', to: '2026-11-05T12:30:00.000Z' };
  it('opps on accounts', () => {
    const q = soql.oppsOnAccounts([A_GLOBEX, A_ACME], W);
    expect(q).toBe(
      "SELECT Id, Name, AccountId, Account.Name, Amount, StageName, CloseDate, IsClosed, IsWon, Type, Deadline_to_Update__c, SystemModstamp FROM Opportunity WHERE AccountId IN ('001PLACEHOLDER0001','001PLACEHOLDER0002') AND SystemModstamp >= 2026-11-04T00:00:00Z AND SystemModstamp < 2026-11-05T12:30:00Z ORDER BY SystemModstamp ASC",
    );
  });
  it('opp team, line items, DCs, events, users', () => {
    expect(soql.myOppTeam(ME.userId, { openOnly: true, from: W.from })).toContain("WHERE UserId = '005PLACEHOLDER0001' AND Opportunity.IsClosed = false AND SystemModstamp >= 2026-11-04T00:00:00Z");
    expect(soql.lineItems(['006PLACEHOLDER0001'], W)).toContain('FROM OpportunityLineItem WHERE OpportunityId IN');
    expect(soql.lineItems(['006PLACEHOLDER0001'])).toContain('Product2.Name');
    expect(soql.myDealContributions(ME.userId)).toContain("FROM Deal_Contribution__c WHERE SE_Name__c = '005PLACEHOLDER0001'");
    expect(soql.otherDealContributions(['006PLACEHOLDER0001'], ME.userId)).toContain("SE_Name__c != '005PLACEHOLDER0001' AND Opportunity_Role__c LIKE 'AI%Data Architect'");
    expect(soql.solutionsEvents(ME.userId, '2026-11-01', W)).toContain("FROM Event WHERE OwnerId = '005PLACEHOLDER0001' AND IsChild = false AND StartDateTime >= 2026-11-01T00:00:00Z AND SystemModstamp >=");
    expect(soql.users([ME.userId, OTHER_SE])).toBe('SELECT Id, Name, Email, Title, ManagerId, IsActive FROM User WHERE Id IN (\'005PLACEHOLDER0001\',\'005PLACEHOLDER0002\')');
  });
  it('rejects bad ids / datetimes and anything that is not a SELECT', () => {
    expect(() => soql.users(["x' OR Name != '"])).toThrow(/not a Salesforce id/);
    expect(() => soql.oppsOnAccounts([A_ACME], { from: '2026-11-04' })).toThrow(/bad datetime/);
    expect(() => soql.assertReadOnlySoql('DELETE FROM Event')).toThrow();
    expect(() => soql.assertReadOnlySoql('SELECT Id FROM Event WHERE x = 1 DELETE')).toThrow(/DML/);
    expect(() => soql.users([])).toThrow(/empty/);
  });
  it('buildScanQueries bundles the scanner windows; chunk splits long id lists', () => {
    const s = soql.buildScanQueries({ userId: ME.userId, startDay: '2026-11-01', window: W, accountIds: [A_ACME], oppIds: [] });
    expect(s.lineItems).toBeNull();
    expect(s.otherDcs).toBeNull();
    expect(s.oppsOnAccounts).toContain('AccountId IN');
    expect(Object.values(s).filter(Boolean).every((q) => q!.startsWith('SELECT'))).toBe(true);
    expect(soql.chunk(Array.from({ length: 320 }, (_, i) => i), 150).map((c) => c.length)).toEqual([150, 150, 20]);
  });
});

void A_INITECH;
