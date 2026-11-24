/**
 * Which opp a meeting logs to (src/projections/matching.ts `oppFor`), and what a re-projection may change.
 *
 * The live case, as placeholders: the recurring internal "FY27 CUSTOMER_1 Account Team Call" was put on the only open
 * opp whose name shared a word with it, a $0 renewal the user is not on ("… Renewal 1745 Platform, 232 Call Center …"),
 * through the generic word "call"; a batch approved it and 3 h went to that opp in Org62. Now generic words never
 * count, a weak hit on someone else's opp never wins, and such a row waits for the user's Approve. Rows already
 * approved, synced, logged or verified keep their opp through the full re-projection (PROJECTIONS_VERSION 6).
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_EVIDENCE_CONFIG } from '@/engines/activity/types';
import { NOT_ON_TEAM_FLAG } from '@/engines/activity/classify';
import { ENGINE_STATUSES, planWeek, type FixedEntry, type WeekEvent, type WeekInput } from '@/projections/activity';
import { GENERIC_MATCH_WORDS, isGenericMatchWord, Matcher, type MatchOpp } from '@/projections/matching';
import { PROJECTIONS_VERSION } from '@/projections/run';

import { ME, RULES, TZ } from './fixtures';

const ACCT = '001XX0000000C01AAA';
const opp = (n: number) => `006XX00000000${String(n).padStart(2, '0')}C1AA`;
const RENEWAL = opp(99);
const TEAM = [opp(1), opp(2), opp(3)];
const OTHER_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'];

/** CUSTOMER_1: 3 opps on my team (each with my DC), a $0 renewal I'm not on, and 26 more opps I'm not on. */
function book(o: { teamOpps?: number } = {}) {
  const accounts = [{ id: 'a-c1', name: 'CUSTOMER_1 Corporation', org62AccountId: ACCT, aliases: [] }];
  const team = TEAM.slice(0, o.teamOpps ?? 3);
  const opps: MatchOpp[] = [
    { id: 'o-d360', accountId: 'a-c1', org62OpportunityId: TEAM[0]!, name: 'CUSTOMER_1 - Data 360 Expansion', isClosed: false, onMyTeam: team.includes(TEAM[0]!), myDc: team.includes(TEAM[0]!) },
    { id: 'o-pilot', accountId: 'a-c1', org62OpportunityId: TEAM[1]!, name: 'CUSTOMER_1 - Agentforce Service Pilot', isClosed: false, onMyTeam: team.includes(TEAM[1]!), myDc: team.includes(TEAM[1]!) },
    { id: 'o-perso', accountId: 'a-c1', org62OpportunityId: TEAM[2]!, name: 'CUSTOMER_1 - Marketing Cloud Personalization', isClosed: false, onMyTeam: team.includes(TEAM[2]!), myDc: team.includes(TEAM[2]!) },
    { id: 'o-renewal', accountId: 'a-c1', org62OpportunityId: RENEWAL, name: 'CUSTOMER_1 Corporation Renewal 1745 Platform, 232 Call Center, 40 Agentforce', isClosed: false, onMyTeam: false, myDc: false },
    { id: 'o-pharmacy', accountId: 'a-c1', org62OpportunityId: opp(50), name: 'CUSTOMER_1 - Pharmacy Benefits Analytics', isClosed: false, onMyTeam: false, myDc: false },
    ...OTHER_WORDS.map((w, i) => ({ id: `o-${w}`, accountId: 'a-c1', org62OpportunityId: opp(10 + i), name: `CUSTOMER_1 - Initiative ${w[0]!.toUpperCase()}${w.slice(1)}`, isClosed: false, onMyTeam: false, myDc: false })),
  ];
  return { accounts, opps, m: new Matcher(accounts, opps, RULES) };
}

const TEAM_CALL = 'FY27 CUSTOMER_1 Account Team Call';

describe('oppFor: generic words never pick an opp', () => {
  it('lists the generic words (fiscal years and quarters too); distinctive words are not generic', () => {
    for (const w of ['call', 'calls', 'team', 'account', 'sync', 'meeting', 'weekly', 'monthly', 'review', 'update', 'check', 'platform', 'renewal', 'center', 'data', 'the', 'and', 'for', 'with']) expect(GENERIC_MATCH_WORDS.has(w)).toBe(true);
    for (const w of ['FY27', 'fy2027', 'Q4', 'q1', 'Call']) expect(isGenericMatchWord(w)).toBe(true);
    for (const w of ['pharmacy', 'personalization', 'q5', 'fy', 'quarterback']) expect(isGenericMatchWord(w)).toBe(false);
  });

  it('the live case: the team call never lands on the $0 renewal I am not on; with 3 opps of mine it is the account', () => {
    const { m } = book();
    expect(m.resolve(TEAM_CALL)).toMatchObject({ accountId: 'a-c1', oppId: null });
    expect(m.oppFor('a-c1', TEAM_CALL)).toBeNull();
    // the account-level default (no text) is the account too: never the only opp that happens to share a word
    const a = m.mappings({ internalDomains: RULES.internal, partnerDomains: RULES.partner, ignoreDomains: RULES.ignore }).accounts.find((x) => x.key === 'a-c1')!;
    expect(a).toMatchObject({ whatId: ACCT, whatType: 'Account' });
  });

  it('with one opp of mine on the account, the team call gets that opp', () => {
    const { m } = book({ teamOpps: 1 });
    expect(m.oppFor('a-c1', TEAM_CALL)).toBe('o-d360');
    expect(m.oppFor('a-c1', 'CUSTOMER_1 weekly sync')).toBe('o-d360');
  });

  it('a distinctive word still picks my opp; a strong (two-word) name picks one I am not on; a weak one never does', () => {
    const { m } = book();
    expect(m.oppFor('a-c1', 'CUSTOMER_1 personalization workshop')).toBe('o-perso');
    expect(m.oppFor('a-c1', 'CUSTOMER_1 pilot readout')).toBe('o-pilot');
    // someone else's opp, named strongly: two distinctive words
    expect(m.oppFor('a-c1', 'CUSTOMER_1 pharmacy benefits deep dive')).toBe('o-pharmacy');
    // one distinctive word on an opp I'm not on is a guess: my single opp, else the account
    expect(m.oppFor('a-c1', 'CUSTOMER_1 pharmacy question')).toBeNull();
    expect(book({ teamOpps: 1 }).m.oppFor('a-c1', 'CUSTOMER_1 pharmacy question')).toBe('o-d360');
    // one of my opps named too: someone else's opp is no longer the one distinctive hit, so it never wins; with 3 opps
    // of mine that is the account
    expect(m.oppFor('a-c1', 'CUSTOMER_1 pharmacy benefits and personalization')).toBeNull();
    expect(m.oppFor('a-c1', 'CUSTOMER_1 personalization and pilot')).toBeNull(); // two of mine, one word each: ambiguous
    // "call center" are generic: the renewal is never named by them
    expect(m.oppFor('a-c1', 'CUSTOMER_1 call center review call')).toBeNull();
  });

  it('two hits are ambiguous; an only open opp I am not on is no fallback', () => {
    const accounts = [{ id: 'a-x', name: 'Placeholdco', org62AccountId: '001XX0000000X01AAA', aliases: [] }];
    const two: MatchOpp[] = [
      { id: 'o-east', accountId: 'a-x', org62OpportunityId: '006XX0000000X01AAA', name: 'Placeholdco - Claims Portal East', isClosed: false, onMyTeam: true, myDc: false },
      { id: 'o-west', accountId: 'a-x', org62OpportunityId: '006XX0000000X02AAA', name: 'Placeholdco - Claims Portal West', isClosed: false, onMyTeam: true, myDc: false },
    ];
    const m = new Matcher(accounts, two, RULES);
    expect(m.oppFor('a-x', 'Placeholdco claims portal sync')).toBeNull(); // two shared words on both: ambiguous
    expect(m.oppFor('a-x', 'Placeholdco claims portal east cutover')).toBe('o-east'); // a distinctive word decides
    const lone = new Matcher(accounts, [{ ...two[0]!, onMyTeam: false }], RULES);
    expect(lone.oppFor('a-x', 'Placeholdco sync')).toBeNull();
  });
});

describe('planWeek: a meeting on an opp I am not on waits for the user; re-projection keeps the opps of my rows', () => {
  const from = '2026-11-02T07:00:00.000Z';
  const to = '2026-11-09T07:00:00.000Z';
  const { m, opps } = book();
  const byOrg62 = new Map(opps.map((o) => [o.org62OpportunityId, o]));
  const ev = (id: string, p: Partial<WeekEvent> = {}): WeekEvent => ({
    rowId: `row-${id}`,
    calendarId: 'primary',
    externalEventId: id,
    title: TEAM_CALL,
    startsAt: '2026-11-02T17:00:00.000Z',
    endsAt: '2026-11-02T18:00:00.000Z',
    isAllDay: false,
    eventType: 'default',
    cancelled: false,
    myResponse: 'accepted',
    iAmOrganizer: false,
    attendance: 'attended',
    attendeeDomains: [],
    recurring: true,
    hasNotes: false,
    url: null,
    accountId: 'a-c1',
    oppOrg62Id: null,
    ...p,
  });
  const input = (p: Partial<WeekInput>): WeekInput => ({
    now: '2026-11-06T18:00:00.000Z',
    from,
    to,
    cfg: { timezone: TZ, ownerId: ME.org62UserId!, recordTypeId: '', lightningHost: '', workday: { start: '07:30', end: '17:30' }, hoursTarget: 250, liveFrom: '1970-01-01', evidence: DEFAULT_EVIDENCE_CONFIG, quarters: [] },
    mappings: m.mappings({ internalDomains: RULES.internal, partnerDomains: RULES.partner, ignoreDomains: RULES.ignore }),
    events: [],
    sessions: [],
    drive: [],
    slack: [],
    org62: [],
    fixed: [],
    fixedBlocks: [],
    // the run's names: the matcher's opps, with whether each is mine (team or DC)
    names: (id) => {
      const o = byOrg62.get(id);
      return o ? { name: o.name, mine: o.onMyTeam || o.myDc } : null;
    },
    ...p,
  });
  const KEY = 'cal|primary|e1|2026-11-02T17:00:00.000Z';

  it('re-resolved, the team call logs to the account and is no longer on the renewal', () => {
    const p = planWeek(input({ events: [ev('e1')] }));
    const row = p.entries.find((e) => e.dedupeKey === KEY)!;
    expect(row.whatOrg62Id).toBe(ACCT);
    expect(row.whatKind).toBe('account');
    expect(row.flags.some((f) => /account fallback/.test(f))).toBe(true);
  });

  it('a stored pick on an opp I am not on holds the row (needs_input, flagged); my opp does not', () => {
    const held = planWeek(input({ events: [ev('e1', { oppOrg62Id: RENEWAL })] })).entries.find((e) => e.dedupeKey === KEY)!;
    expect(held).toMatchObject({ whatOrg62Id: RENEWAL, whatKind: 'opportunity', status: 'needs_input' });
    expect(held.flags).toContain(NOT_ON_TEAM_FLAG);
    const mine = planWeek(input({ events: [ev('e1', { oppOrg62Id: TEAM[2]! })] })).entries.find((e) => e.dedupeKey === KEY)!;
    expect(mine).toMatchObject({ whatOrg62Id: TEAM[2], status: 'proposed' });
    expect(mine.flags).not.toContain(NOT_ON_TEAM_FLAG);
  });

  it('PROJECTIONS_VERSION 10 (6 and on): rows I approved, synced or verified keep their opp; a logged Event keeps the WhatId Org62 has', () => {
    expect(PROJECTIONS_VERSION).toBe(10);
    // the projections rewrite only rows in engine statuses (and never one with locked fields): these are the user's
    for (const s of ['approved', 'synced_to_canvas', 'verified', 'verify_failed', 'dismissed']) expect(ENGINE_STATUSES.has(s)).toBe(false);
    const fixedRow = (id: string, status: string, startsAt: string, endsAt: string): FixedEntry => ({ rowId: `mine-${id}`, dedupeKey: `cal|primary|${id}|${startsAt}`, subject: TEAM_CALL, startsAt, endsAt, durationHours: 1, seTaskType: 'Account Planning', whatOrg62Id: RENEWAL, meetingType: null, status, operation: 'create', targetOrg62EventId: null });
    const verified = fixedRow('e1', 'verified', '2026-11-02T17:00:00.000Z', '2026-11-02T18:00:00.000Z');
    const synced = fixedRow('e2', 'synced_to_canvas', '2026-11-03T17:00:00.000Z', '2026-11-03T18:00:00.000Z');
    const approved = fixedRow('e3', 'approved', '2026-11-04T17:00:00.000Z', '2026-11-04T18:00:00.000Z');
    const org62 = [
      { rowId: 'r62-1', org62EventId: '00UXX0000000C01', recordTypeName: 'Solutions Event', subject: TEAM_CALL, startsAt: verified.startsAt, endsAt: verified.endsAt, durationField: 1, seTaskTypeName: 'Account Planning', meetingTypeName: null, whatOrg62Id: RENEWAL, ownerId: ME.org62UserId, whatName: null },
      // logged in Org62 with no app row of mine: Org62's WhatId stands
      { rowId: 'r62-2', org62EventId: '00UXX0000000C02', recordTypeName: 'Solutions Event', subject: TEAM_CALL, startsAt: '2026-11-05T17:00:00.000Z', endsAt: '2026-11-05T18:00:00.000Z', durationField: 1, seTaskTypeName: 'Account Planning', meetingTypeName: null, whatOrg62Id: RENEWAL, ownerId: ME.org62UserId, whatName: null },
    ];
    const events = [ev('e1'), ev('e2', { startsAt: synced.startsAt, endsAt: synced.endsAt }), ev('e3', { startsAt: approved.startsAt, endsAt: approved.endsAt }), ev('e4', { startsAt: '2026-11-05T17:00:00.000Z', endsAt: '2026-11-05T18:00:00.000Z' })];
    const p = planWeek(input({ events, org62, fixed: [verified, synced, approved] }));
    // read-back only moves a status, never a field (and a verified row is already where it goes)
    for (const mv of p.moves) expect(Object.keys(mv).sort()).toEqual(['issues', 'org62EventRowId', 'rowId', 'status']);
    // the user's rows are not replaced: their keys come back only as excluded twins, which the window never writes over
    for (const f of [verified, synced, approved]) expect(p.entries.filter((e) => e.dedupeKey === f.dedupeKey && e.status !== 'excluded')).toEqual([]);
    // the Org62 Event behind the verified row is that row (claimed): no second, re-resolved copy of it
    expect(p.entries.some((e) => e.dedupeKey === 'org62|00UXX0000000C01')).toBe(false);
    const logged = p.entries.find((e) => e.dedupeKey === 'org62|00UXX0000000C02')!;
    expect(logged).toMatchObject({ status: 'logged', whatOrg62Id: RENEWAL });
  });
});
