/**
 * Projections: the pure mappers (source items → domain records), placeholder data only.
 */
import { describe, expect, it } from 'vitest';

import { planWeek, type WeekEvent, type WeekInput } from '@/projections/activity';
import { assetsFromDrive, assetsFromEvents, mergeAssets, projectGeminiNote } from '@/projections/assets';
import { isGone, projectCalendarEvent, resolveCalendarItems } from '@/projections/calendar';
import { Matcher, nameCore, shortNames } from '@/projections/matching';
import { oppsInBook, projectOrg62 } from '@/projections/org62';
import { projectClaudeSession } from '@/projections/sessions';
import { excerptFields, org62Ref, sfDate } from '@/projections/util';
import { fiscalQuarterStart } from '@/projections/run';
import { DEFAULT_EVIDENCE_CONFIG } from '@/engines/activity/types';

import { ACCT_ACME, ACCT_GLOBEX, calItem, cancelItem, driveItem, geminiItem, ME, OPP_ACME, OPP_ACME_2, OPP_GLOBEX, org62Item, RULES, sessionItem, TZ } from './fixtures';

describe('util', () => {
  it('parses Org62 refs, excerpts and Salesforce datetimes', () => {
    expect(org62Ref('Opportunity:006XX0000000001AAA@2026-11-05T15:42:05.000+0000')).toEqual({ sobject: 'Opportunity', id: '006XX0000000001AAA', modstamp: '2026-11-05T15:42:05.000+0000' });
    expect(org62Ref('MissedOpp:006XX0000000001AAA')).toEqual({ sobject: 'MissedOpp', id: '006XX0000000001AAA', modstamp: null });
    expect(Object.fromEntries(excerptFields('stage=Discovery; close=2026-12-15; amount=250000; next=SE demo; team_role=Solution Engineer'))).toEqual({ stage: 'Discovery', close: '2026-12-15', amount: '250000', next: 'SE demo', team_role: 'Solution Engineer' });
    expect(excerptFields('type=; what=null').size).toBe(0);
    expect(sfDate('2026-11-05T15:42:05.000+0000')).toBe('2026-11-05T15:42:05.000Z');
  });
});

describe('calendar', () => {
  it('maps an accepted customer meeting: response, domains, attendees, local day', () => {
    const e = projectCalendarEvent(calItem('evt_1', { attendees: [{ email: ME.email, response: 'accepted' }, { email: 'dana@acme.example', response: 'accepted' }, { email: 'room-4@resource.calendar.google.com', response: 'accepted' }, { email: 'sam@corp.example', response: 'tentative' }] }), ME, RULES)!;
    expect(e).toMatchObject({ calendarId: 'primary', externalEventId: 'evt_1', title: 'ACME discovery', myResponse: 'accepted', iAmOrganizer: false, hasExternalAttendees: true, externalDomains: ['acme.example'], localDay: '2026-11-05', status: 'confirmed', attendance: 'unknown', isAllDay: false, eventType: 'default' });
    expect(e.attendeeDomains).toEqual(['acme.example', 'corp.example']); // the room is no person
    expect(e.otherAttendeeCount).toBe(2);
    expect(e.attendees.find((a) => a.isSelf)?.email).toBe(ME.email);
    expect(e.attendees.find((a) => a.email === 'sam@corp.example')).toMatchObject({ isExternal: false, responseStatus: 'tentative' });
  });

  it('keeps the facts that decide what pages show: unanswered, organizer, solo, all-day, ended attendance', () => {
    expect(projectCalendarEvent(calItem('e2', { myResponse: 'needsAction' }), ME, RULES)!.myResponse).toBe('needs_action');
    expect(projectCalendarEvent(calItem('e3', { organizer: ME.email, myResponse: '' as string, attendees: [{ email: ME.email }, { email: 'dana@acme.example' }] }), ME, RULES)!).toMatchObject({ iAmOrganizer: true, myResponse: 'accepted' });
    const solo = projectCalendarEvent(calItem('e4', { title: 'Focus time', attendees: [{ email: ME.email, response: 'accepted' }], attendance: 'n/a' }), ME, RULES)!;
    expect(solo).toMatchObject({ otherAttendeeCount: 0, attendance: 'not_applicable', eventType: 'focus_time' });
    const ooo = projectCalendarEvent(calItem('e5', { title: 'OOO', allDay: true, start: '2026-11-06T00:00:00.000Z', end: '2026-11-07T00:00:00.000Z' }), ME, RULES)!;
    expect(ooo).toMatchObject({ isAllDay: true, eventType: 'out_of_office', localDay: '2026-11-06' });
    expect(projectCalendarEvent(calItem('e6', { ended: true, attendance: 'attended' }), ME, RULES)!.attendance).toBe('attended');
    expect(projectCalendarEvent(calItem('e7', { ended: false, attendance: 'attended' }), ME, RULES)!.attendance).toBe('unknown');
    expect(projectCalendarEvent(calItem('abc_20261105T160000Z'), ME, RULES)!.recurringEventId).toBe('abc');
  });

  it('ignores agent echoes without the fetcher payload', () => {
    const echo = { ...calItem('e8'), dedupeKey: 'calendar:e8', meta: { connector: 'calendar' } };
    expect(projectCalendarEvent(echo, ME, RULES)).toBeNull();
  });

  it('weighs a cancellation marker against the event row by recency', () => {
    const ev = calItem('e9', { changedAt: '2026-11-05T10:00:00.000Z' });
    const cancelled = cancelItem('e9', '2026-11-05T16:00:00.000Z', '2026-11-05T11:00:00.000Z');
    const [r1] = [...resolveCalendarItems([ev, cancelled]).values()];
    expect(isGone(r1!)).toBe(true);
    const back = calItem('e9', { changedAt: '2026-11-05T12:00:00.000Z' });
    const [r2] = [...resolveCalendarItems([ev, cancelled, back]).values()];
    expect(isGone(r2!)).toBe(false);
    const deleted = { ...calItem('e9', { changedAt: '2026-11-05T13:00:00.000Z' }), deletedUpstreamAt: '2026-11-05T13:00:00.000Z' };
    expect(isGone([...resolveCalendarItems([deleted]).values()][0]!)).toBe(true);
  });
});

describe('org62 book', () => {
  const items = () => [
    // Q1 (team): role only in the excerpt; an older snapshot carries the amount the newest one dropped
    org62Item(`Opportunity:${OPP_ACME}@2026-11-01T10:00:00.000+0000`, { title: 'ACME - Data 360 Expansion', meta: { Id: OPP_ACME, Amount: 250000, CloseDate: '2027-01-31', StageName: 'Discovery' }, body: 'stage=Discovery; close=2027-01-31; amount=250000; team_role=Solution Engineer', accountHints: [ACCT_ACME, 'ACME Corporation'], oppHints: [OPP_ACME] }),
    org62Item(`Opportunity:${OPP_ACME}@2026-11-05T10:00:00.000+0000`, { title: 'ACME - Data 360 Expansion', meta: { Id: OPP_ACME, StageName: 'Validation', CloseDate: '2026-12-15', IsClosed: false }, body: 'stage=Validation; close=2026-12-15; next=SE demo before 12/1', accountHints: [ACCT_ACME, 'ACME Corporation'], oppHints: [OPP_ACME] }),
    // Q2 (my accounts): another ACME opp, not mine
    org62Item(`Opportunity:${OPP_ACME_2}@2026-11-04T10:00:00.000+0000`, { title: 'ACME - Service Renewal', meta: { Id: OPP_ACME_2, StageName: 'Closed Won', IsClosed: true, IsWon: true, Amount: 90000 }, accountHints: [ACCT_ACME, 'ACME Corporation'], oppHints: [OPP_ACME_2] }),
    // an opp on an account outside my book
    org62Item('Opportunity:006XX0000000009AAA@2026-11-04T10:00:00.000+0000', { title: 'Initech - Pilot', meta: { StageName: 'Qualify' }, accountHints: ['001XX0000000009AAA', 'Initech'], oppHints: ['006XX0000000009AAA'] }),
    // my DC on a Globex opp no opp row was read for
    org62Item('Deal_Contribution__c:a0XPLACEHOLDER01@2026-11-03T10:00:00.000+0000', { title: `DC on Globex - Agent Rollout`, meta: { Opportunity__c: OPP_GLOBEX, Opportunity_Role__c: 'AI + Data Architect', Split_Percentage__c: 100, IsClosed: false }, body: 'role=AI + Data Architect; split=100; opp_stage=Proposal; close=2026-12-20', accountHints: [ACCT_GLOBEX, 'Globex Inc.'], oppHints: [OPP_GLOBEX] }),
    // my events: one with a start in the excerpt, one without any start (not projectable)
    org62Item('Event:00UPLACEHOLDER01@2026-11-05T18:00:00.000+0000', { title: 'ACME - POV readout', meta: { Id: '00UPLACEHOLDER01', SE_Task_Type__c: 'Customer Presentation', Duration__c: 1, WhatId: OPP_ACME }, body: 'type=Customer Presentation; rt=Solutions Event; start=2026-11-05T16:00:00.000+0000; hrs=1; what=ACME - Data 360 Expansion', oppHints: [OPP_ACME] }),
    org62Item('Event:00UPLACEHOLDER02@2026-11-05T18:00:00.000+0000', { title: 'Globex prep', meta: { SE_Task_Type__c: 'Solution Creation' }, body: 'type=Solution Creation; what=Globex - Agent Rollout' }),
  ];

  it('builds my book: team and DC opps, their accounts, merged newest-first fields', () => {
    const book = projectOrg62(items());
    expect(book.accounts.map((a) => [a.org62AccountId, a.name, a.via.sort()])).toEqual([
      [ACCT_ACME, 'ACME Corporation', ['opp_team', 'org62_event']],
      [ACCT_GLOBEX, 'Globex Inc.', ['dc']],
    ]);
    const acme = book.opps.find((o) => o.org62OpportunityId === OPP_ACME)!;
    expect(acme).toMatchObject({ name: 'ACME - Data 360 Expansion', stage: 'Validation', closeDate: '2026-12-15', amount: 250000, onMyTeam: true, myTeamRole: 'Solution Engineer', nextStep: 'SE demo before 12/1', isClosed: false, myDc: false, org62AccountId: ACCT_ACME });
    expect(book.opps.find((o) => o.org62OpportunityId === OPP_ACME_2)).toMatchObject({ onMyTeam: false, isClosed: true, isWon: true });
    expect(book.opps.find((o) => o.org62OpportunityId === OPP_GLOBEX)).toMatchObject({ name: 'Globex - Agent Rollout', myDc: true, stage: 'Proposal', closeDate: '2026-12-20', org62AccountId: ACCT_GLOBEX });
    expect(oppsInBook(book).map((o) => o.org62OpportunityId).sort()).toEqual([OPP_ACME, OPP_GLOBEX, OPP_ACME_2].sort());
    expect(book.dcs).toHaveLength(1);
  });

  it('projects my Events with a start; counts the ones the skill recorded without one', () => {
    const book = projectOrg62(items());
    expect(book.events).toEqual([
      expect.objectContaining({ org62EventId: '00UPLACEHOLDER01', subject: 'ACME - POV readout', startsAt: '2026-11-05T16:00:00.000Z', endsAt: '2026-11-05T17:00:00.000Z', durationField: 1, seTaskTypeName: 'Customer Presentation', recordTypeName: 'Solutions Event', whatOrg62Id: OPP_ACME, whatName: 'ACME - Data 360 Expansion' }),
    ]);
    expect(book.eventsWithoutStart).toBe(1);
  });

  it('the missed-opp sweep fills in opps on my accounts the windowed scans have not reached', () => {
    const sweep = org62Item('MissedOpp:006XX0000000005AAA', { title: 'Initech - Data Cloud Phase 2', meta: { Id: '006XX0000000005AAA', StageName: 'Proposal', Amount: 120000, CloseDate: '2027-01-15', IsWon: false, tier: 'check' }, body: 'tier=check; signal=d360; evidence=some; hours=0.5; close=2027-01-15; won=false', accountHints: ['001XX0000000009AAA', 'Initech'], oppHints: ['006XX0000000005AAA'] });
    const book = projectOrg62([...items(), sweep]);
    expect(book.accounts.find((a) => a.org62AccountId === '001XX0000000009AAA')).toMatchObject({ name: 'Initech', via: ['sweep'] });
    expect(oppsInBook(book).find((o) => o.org62OpportunityId === '006XX0000000005AAA')).toMatchObject({ onMyTeam: false, amount: 120000, stage: 'Proposal', isClosed: false });
  });

  it('ignores rows deleted upstream', () => {
    const all = items().map((s) => (s.externalId.startsWith('Deal_') ? { ...s, deletedUpstreamAt: '2026-11-06T00:00:00.000Z' } : s));
    expect(projectOrg62(all).accounts.map((a) => a.org62AccountId)).toEqual([ACCT_ACME]);
  });
});

describe('claude sessions', () => {
  it('maps the fetcher status to db status, contract override and waiting reason', () => {
    expect(projectClaudeSession(sessionItem('s1', { status: 'busy' }))).toMatchObject({ status: 'running', stateOverride: null, waitingReason: null });
    expect(projectClaudeSession(sessionItem('s2', { status: 'waiting', waitingFor: 'plan approval' }))).toMatchObject({ status: 'waiting_on_me', waitingReason: 'plan_approval', waitingText: 'plan approval', waitingSince: '2026-11-05T15:30:00.000Z' });
    expect(projectClaudeSession(sessionItem('s3', { status: 'done' }))).toMatchObject({ status: 'completed', stateOverride: 'done', endedAt: '2026-11-05T15:30:00.000Z' });
    expect(projectClaudeSession(sessionItem('s4', { status: 'done', ccTag: 'wi_1' }))).toMatchObject({ status: 'completed', stateOverride: null, ccTag: 'wi_1' });
    expect(projectClaudeSession(sessionItem('s5', { status: 'idle' }))).toMatchObject({ status: 'idle', stateOverride: 'done' });
    expect(projectClaudeSession(sessionItem('s6', { status: 'errored' }))).toMatchObject({ status: 'errored' });
    const s = projectClaudeSession(sessionItem('s7'))!;
    expect(s).toMatchObject({ sessionExternalId: 's7', hostSessionId: 'local_s7', cwd: '/Users/example/Projects/client-demos/acme-demo', gitBranch: 'main', promptCount: 4, filesChangedCount: 3, costUsd: 1.2345678 });
    expect(s.summary).toBe('Built the demo flow and pushed it.'); // the recap, not the first prompt
  });
});

describe('assets and notes', () => {
  it('one asset per Drive file, newest revision wins; invite attachments add the meeting', () => {
    const drive = assetsFromDrive([driveItem('F1', '2026-11-04T10:00:00.000Z', { title: 'ACME POV v1', byMe: false }), driveItem('F1', '2026-11-05T10:00:00.000Z', { title: 'ACME POV deck' })]);
    expect(drive).toEqual([expect.objectContaining({ externalId: 'F1', title: 'ACME POV deck', kind: 'deck', lastModifiedByMe: true, lastModifiedAt: '2026-11-05T10:00:00.000Z' })]);
    const ev = projectCalendarEvent(calItem('e1', { attachments: [{ title: 'ACME POV deck', fileId: 'F1', mimeType: 'application/vnd.google-apps.presentation' }, { title: 'Notes by Gemini', fileId: 'G1' }, { title: 'Agenda', fileId: 'F2', mimeType: 'application/vnd.google-apps.document' }] }), ME, RULES)!;
    const merged = mergeAssets(drive, assetsFromEvents([ev]));
    expect(merged.map((a) => [a.externalId, a.kind, a.eventExternalId])).toEqual([
      ['F1', 'deck', 'e1'],
      ['F2', 'doc', 'e1'],
    ]);
  });

  it('Gemini notes tie to their event and count next steps', () => {
    expect(projectGeminiNote(geminiItem('G1', 'evt_1', 2, 3))).toMatchObject({ docExternalId: 'G1', eventExternalId: 'evt_1', nextStepCount: 5, myNextStepCount: 2 });
  });
});

describe('matching', () => {
  const accounts = [
    { id: 'a-acme', name: 'ACME Corporation', org62AccountId: ACCT_ACME, aliases: [] },
    { id: 'a-globex', name: 'Globex Inc.', org62AccountId: ACCT_GLOBEX, aliases: [{ kind: 'domain', value: 'globex.example' }] },
    { id: 'a-target', name: 'Target', org62AccountId: '001XX0000000007AAA', aliases: [] },
  ];
  const opps = [
    { id: 'o-acme-d360', accountId: 'a-acme', org62OpportunityId: OPP_ACME, name: 'ACME - Data 360 Expansion', isClosed: false, onMyTeam: true, myDc: false },
    { id: 'o-acme-agent', accountId: 'a-acme', org62OpportunityId: OPP_ACME_2, name: 'ACME - Agentforce Contact Center', isClosed: false, onMyTeam: true, myDc: false },
    { id: 'o-globex', accountId: 'a-globex', org62OpportunityId: OPP_GLOBEX, name: 'Globex - Agent Rollout', isClosed: false, onMyTeam: false, myDc: true },
  ];

  it('names without legal suffixes; generic single words need more', () => {
    expect(nameCore('ACME Corporation (Parent)')).toEqual(['acme']);
    expect(nameCore('The Home Depot, Inc.')).toEqual(['home', 'depot']);
    expect(nameCore('Target')).toEqual([]);
  });

  it('title → account and, when one stands out, the opp', () => {
    const m = new Matcher(accounts, opps, RULES);
    expect(m.resolve('ACME <> Salesforce: contact center deep dive')).toMatchObject({ accountId: 'a-acme', oppId: 'o-acme-agent', via: 'title' });
    expect(m.resolve('ACME weekly sync')).toMatchObject({ accountId: 'a-acme', oppId: null }); // two open opps of mine: account only
    expect(m.resolve('Globex architecture review')).toMatchObject({ accountId: 'a-globex', oppId: 'o-globex' });
    expect(m.resolve('hit the target date')).toBeNull();
    expect(m.resolve('client-demos acme-demo main')).toMatchObject({ accountId: 'a-acme' });
  });

  it('ACC-1: short names people use for Org62 legal names', () => {
    expect(shortNames('Globex Health - Commercial 2.0')).toEqual([['globex'], ['ghc']]);
    expect(shortNames('Initech42Health')).toEqual([['initech42']]);
    expect(shortNames('Blue Shield of Placeholdia').map((x) => x.join(' '))).toEqual(['bsp']); // "blue" alone is a common word
    expect(shortNames('Health Care Example Corporation').map((x) => x.join(' '))).toEqual(['hcec']); // "health" is generic
    expect(shortNames('Horizon Blue Cross Blue Shield of New Placeholdia')).toEqual([]); // common first word, acronym too long
    expect(shortNames('ACME Corporation')).toEqual([]); // the name itself is already one word
  });

  it('ACC-1: accounts that claim the same name: my open opps decide, an opp word decides a tie, else nothing', () => {
    const accts = [
      { id: 'a-pc', name: 'Placeholdco Health - Commercial', org62AccountId: '001XX0000000011AAA', aliases: [] },
      { id: 'a-pr', name: 'Placeholdco Health - Retail', org62AccountId: '001XX0000000012AAA', aliases: [] },
      { id: 'a-dup1', name: 'Duplico, Inc.', org62AccountId: '001XX0000000013AAA', aliases: [] },
      { id: 'a-dup2', name: 'Duplico, Inc.', org62AccountId: '001XX0000000014AAA', aliases: [] },
    ];
    const op = [
      { id: 'o-pc', accountId: 'a-pc', org62OpportunityId: '006XX0000000011AAA', name: 'Placeholdco - Clinical Insights', isClosed: false, onMyTeam: true, myDc: false },
      { id: 'o-pr', accountId: 'a-pr', org62OpportunityId: '006XX0000000012AAA', name: 'Placeholdco - Pharmacy Rollout', isClosed: false, onMyTeam: true, myDc: false },
      { id: 'o-dup2', accountId: 'a-dup2', org62OpportunityId: '006XX0000000013AAA', name: 'Duplico - Onboarding', isClosed: false, onMyTeam: true, myDc: false },
    ];
    const m = new Matcher(accts, op, RULES);
    expect(m.resolve('Duplico pipeline workshop')).toMatchObject({ accountId: 'a-dup2' }); // the row with my open opp
    expect(m.resolve('Open a VOC for the Placeholdco issue')).toBeNull(); // a real tie: nothing, never a guess
    expect(m.resolve('Placeholdco clinical demo follow-up')).toMatchObject({ accountId: 'a-pc' }); // an opp word decides
  });

  it('domains: aliases, and ones learned from meetings whose title named the account', () => {
    const m = new Matcher(accounts, opps, RULES);
    expect(m.resolve('Kickoff', ['globex.example'])).toMatchObject({ accountId: 'a-globex', via: 'domain' });
    expect(m.resolve('Kickoff', ['acme.example'])).toBeNull();
    m.learnDomains([{ title: 'ACME discovery', domains: ['acme.example', 'corp.example'] }]);
    expect(m.resolve('Kickoff', ['acme.example'])).toMatchObject({ accountId: 'a-acme', via: 'domain' });
    expect(m.domainsOf('a-acme')).toEqual(['acme.example']);
  });
});

describe('planWeek (Time page)', () => {
  const from = '2026-11-02T07:00:00.000Z';
  const to = '2026-11-09T07:00:00.000Z';
  const accounts = [{ id: 'a-acme', name: 'ACME Corporation', org62AccountId: ACCT_ACME, aliases: [] }];
  const opps = [{ id: 'o-acme', accountId: 'a-acme', org62OpportunityId: OPP_ACME, name: 'ACME - Data 360 Expansion', isClosed: false, onMyTeam: true, myDc: false }];
  const m = new Matcher(accounts, opps, RULES);
  const ev = (id: string, p: Partial<WeekEvent> = {}): WeekEvent => ({
    rowId: `row-${id}`,
    calendarId: 'primary',
    externalEventId: id,
    title: 'ACME discovery',
    startsAt: '2026-11-04T16:00:00.000Z',
    endsAt: '2026-11-04T17:00:00.000Z',
    isAllDay: false,
    eventType: 'default',
    cancelled: false,
    myResponse: 'accepted',
    iAmOrganizer: false,
    attendance: 'attended',
    attendeeDomains: ['acme.example'],
    recurring: false,
    hasNotes: false,
    url: null,
    accountId: 'a-acme',
    oppOrg62Id: OPP_ACME,
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
    names: (id) => (id === OPP_ACME ? { name: 'ACME - Data 360 Expansion' } : null),
    ...p,
  });

  it('proposes accepted meetings with their calendar source; tentative invites are not proposed', () => {
    const p = planWeek(input({ events: [ev('e1'), ev('e2', { myResponse: 'tentative', startsAt: '2026-11-04T18:00:00.000Z', endsAt: '2026-11-04T19:00:00.000Z' })] }));
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]).toMatchObject({ dedupeKey: 'cal|primary|e1|2026-11-04T16:00:00.000Z', origin: 'calendar', status: 'proposed', seTaskType: 'Customer Discovery', meetingType: 'CF', customerFacing: true, whatOrg62Id: OPP_ACME, durationHours: 1 });
    expect(p.entries[0]!.sources).toEqual([expect.objectContaining({ kind: 'calendar', externalId: 'e1' })]);
    expect(p.blocks.filter((b) => b.source === 'calendar').map((b) => b.calendarEventId)).toEqual(['row-e1']);
  });

  it('SE activity already in Org62 shows as logged, once', () => {
    const org62 = [
      { rowId: 'r62-1', org62EventId: '00U1', recordTypeName: 'Solutions Event', subject: 'ACME discovery', startsAt: '2026-11-04T16:00:00.000Z', endsAt: '2026-11-04T17:00:00.000Z', durationField: 1, seTaskTypeName: 'Customer Discovery', meetingTypeName: null, whatOrg62Id: OPP_ACME, ownerId: ME.org62UserId, whatName: null },
      { rowId: 'r62-2', org62EventId: '00U2', recordTypeName: 'Solutions Event', subject: 'Globex build', startsAt: '2026-11-05T15:00:00.000Z', endsAt: '2026-11-05T17:00:00.000Z', durationField: 2, seTaskTypeName: 'Solution Creation', meetingTypeName: null, whatOrg62Id: null, ownerId: ME.org62UserId, whatName: null },
    ];
    const p = planWeek(input({ events: [ev('e1')], org62 }));
    expect(p.entries.map((e) => [e.dedupeKey, e.status, e.durationHours])).toEqual([
      ['org62|00U1', 'logged', 1],
      ['org62|00U2', 'logged', 2],
    ]);
    expect(p.entries[0]!.sources.map((s) => s.kind)).toEqual(['org62', 'calendar']); // the meeting it came from
    expect(p.entries[0]).toMatchObject({ whatName: 'ACME - Data 360 Expansion', meetingType: 'CF' });
  });

  it('logged rows are this quarter only; an older Org62 Event still means "already in Org62"', () => {
    const org62 = [{ rowId: 'r62-1', org62EventId: '00U1', recordTypeName: 'Solutions Event', subject: 'ACME discovery', startsAt: '2026-11-04T16:00:00.000Z', endsAt: '2026-11-04T17:00:00.000Z', durationField: 1, seTaskTypeName: 'Customer Discovery', meetingTypeName: null, whatOrg62Id: OPP_ACME, ownerId: ME.org62UserId, whatName: null }];
    const p = planWeek(input({ events: [ev('e1')], org62, loggedFrom: '2026-11-05T07:00:00.000Z' }));
    expect(p.entries).toEqual([]);
    expect(fiscalQuarterStart(new Date('2026-11-06T16:00:00Z'), TZ)).toBe('2026-11-01');
    expect(fiscalQuarterStart(new Date('2027-01-20T16:00:00Z'), TZ)).toBe('2026-11-01');
    expect(fiscalQuarterStart(new Date('2026-07-31T16:00:00Z'), TZ)).toBe('2026-05-01');
  });

  it('an Event edited in Org62 after it was verified: the row takes Org62\'s opp and stays verified (no revert)', () => {
    const OTHER = '006000000000OTHERX';
    const fixed = [{ rowId: 'mine-1', dedupeKey: 'cal|primary|e1|2026-11-04T16:00:00.000Z', subject: 'ACME discovery', startsAt: '2026-11-04T16:00:00.000Z', endsAt: '2026-11-04T17:00:00.000Z', durationHours: 1, seTaskType: 'Customer Discovery', whatOrg62Id: OPP_ACME, meetingType: null, status: 'verified', operation: 'create' as const, targetOrg62EventId: null }];
    const org62 = [{ rowId: 'r62-1', org62EventId: '00U1', recordTypeName: 'Solutions Event', subject: 'ACME discovery', startsAt: '2026-11-04T16:00:00.000Z', endsAt: '2026-11-04T17:00:00.000Z', durationField: 1, seTaskTypeName: 'Customer Discovery', meetingTypeName: null, whatOrg62Id: OTHER, ownerId: ME.org62UserId, whatName: null }];
    const p = planWeek(input({ events: [ev('e1')], org62, fixed }));
    expect(p.moves).toEqual([{ rowId: 'mine-1', status: 'verified', org62EventRowId: 'r62-1', issues: [], adopt: { whatOrg62Id: OTHER, seTaskType: 'Customer Discovery', meetingType: null, note: expect.stringContaining('Updated from Org62') } }]);
    // a row with an app edit still to push (operation update) keeps its own path: no adoption
    const pending = planWeek(input({ events: [ev('e1')], org62, fixed: [{ ...fixed[0]!, operation: 'update' as const }] }));
    expect(pending.moves.some((mv) => mv.adopt)).toBe(false);
    // the first verification of a row Slackbot logged (its CC# key on the Event) still flags a mismatch: Slackbot
    // entered something else (D-65: an approved row logged by hand, no CC#, takes Org62's values instead: TL-05)
    const first = planWeek(input({ events: [ev('e1')], org62: [{ ...org62[0]!, ccKey: 'mine-1' }], fixed: [{ ...fixed[0]!, status: 'approved' }] }));
    expect(first.moves).toEqual([expect.objectContaining({ status: 'verify_failed' })]);
    const byHand = planWeek(input({ events: [ev('e1')], org62, fixed: [{ ...fixed[0]!, status: 'approved' }] }));
    expect(byHand.moves).toEqual([expect.objectContaining({ status: 'verified', adopt: expect.objectContaining({ whatOrg62Id: OTHER }) })]);
  });

  it('read-back moves rows I approved; it never rewrites them', () => {
    const fixed = [{ rowId: 'mine-1', dedupeKey: 'cal|primary|e1|2026-11-04T16:00:00.000Z', subject: 'ACME discovery', startsAt: '2026-11-04T16:00:00.000Z', endsAt: '2026-11-04T17:00:00.000Z', durationHours: 1, seTaskType: 'Customer Discovery', whatOrg62Id: OPP_ACME, meetingType: null, status: 'approved', operation: 'create' as const, targetOrg62EventId: null }];
    const org62 = [{ rowId: 'r62-1', org62EventId: '00U1', recordTypeName: 'Solutions Event', subject: 'ACME discovery', startsAt: '2026-11-04T16:00:00.000Z', endsAt: '2026-11-04T17:00:00.000Z', durationField: 1, seTaskTypeName: 'Customer Discovery', meetingTypeName: null, whatOrg62Id: OPP_ACME, ownerId: ME.org62UserId, whatName: null }];
    const p = planWeek(input({ events: [ev('e1')], org62, fixed }));
    expect(p.moves).toEqual([{ rowId: 'mine-1', status: 'verified', org62EventRowId: 'r62-1', issues: [] }]);
    // the approved row represents both the meeting and the Org62 event: no second row, and the proposal is excluded by overlap
    expect(p.entries.filter((e) => e.status !== 'excluded')).toEqual([]);
  });

  /** The original D-18 (Settings ▸ Time ▸ Overlapping meetings: Count overlapping time once). */
  const once = (p: Partial<WeekInput>): WeekInput => {
    const i = input(p);
    return { ...i, cfg: { ...i.cfg, overlaps: 'count_once' } };
  };
  const twoMeetings = {
    events: [ev('e1'), ev('e3', { title: 'ACME exec briefing', startsAt: '2026-11-04T16:30:00.000Z', endsAt: '2026-11-04T17:30:00.000Z' })],
    sessions: [{ rowId: 'sess-1', title: 'Build ACME demo', repoKey: 'acme-demo', startedAt: '2026-11-04T13:00:00.000Z', lastActivityAt: '2026-11-04T20:00:00.000Z', lastHumanPromptAt: '2026-11-04T19:55:00.000Z' }],
  };
  const overlap = (a: { startsAt: string; endsAt: string }, b: { startsAt: string; endsAt: string }) => Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);

  it('every accepted meeting logs, also double-booked (D-18 amended); estimates never overlap them; agent time never counts', () => {
    const p = planWeek(input(twoMeetings));
    const counted = p.entries.filter((e) => e.status !== 'excluded');
    const meetings = counted.filter((e) => e.origin === 'calendar');
    expect(meetings.map((e) => [e.subject, e.status])).toEqual([
      ['ACME discovery', 'proposed'],
      ['ACME exec briefing', 'proposed'],
    ]);
    expect(meetings[0]!.flags).toContain("overlaps 'ACME exec briefing' 09:30–10:00 (both log)");
    expect(meetings[1]!.flags).toContain("overlaps 'ACME discovery' 09:30–10:00 (both log)");
    for (const a of counted) for (const b of counted) if (a !== b && (a.origin !== 'calendar' || b.origin !== 'calendar')) expect(overlap(a, b)).toBe(false);
    expect(p.entries.some((e) => e.excludedReason === 'overlap')).toBe(false);
    expect(p.blocks.filter((b) => b.source === 'claude_background').every((b) => !b.countsAsHumanHours)).toBe(true);
  });

  it('a meeting dismissed by the user never makes another lose (rule 3), in either mode', () => {
    const dismissed = { rowId: 'mine-x', dedupeKey: 'cal|primary|e1|2026-11-04T16:00:00.000Z', subject: 'ACME discovery', startsAt: '2026-11-04T16:00:00.000Z', endsAt: '2026-11-04T17:00:00.000Z', durationHours: 1, seTaskType: 'Customer Discovery', whatOrg62Id: OPP_ACME, meetingType: null, status: 'dismissed', operation: 'create' as const, targetOrg62EventId: null };
    for (const mk of [input, once]) {
      const p = planWeek(mk({ ...twoMeetings, fixed: [dismissed] }));
      const brief = p.entries.find((e) => e.subject === 'ACME exec briefing')!;
      expect(brief).toMatchObject({ status: 'proposed', excludedReason: null });
      expect(brief.flags.some((f) => /overlaps|double-booked/.test(f))).toBe(false);
    }
  });

  it('an Org62 Event of the same slot stands in for the meeting (a twin); one that only overlaps does not', () => {
    const o62 = (id: string, startsAt: string, endsAt: string, subject: string, whatOrg62Id = OPP_ACME) => ({ rowId: `r62-${id}`, org62EventId: id, recordTypeName: 'Solutions Event', subject, startsAt, endsAt, durationField: (Date.parse(endsAt) - Date.parse(startsAt)) / 3_600_000, seTaskTypeName: 'Solution Creation', meetingTypeName: null, whatOrg62Id, ownerId: ME.org62UserId, whatName: null });
    const twin = planWeek(input({ events: [ev('e1')], org62: [o62('00UT', '2026-11-04T16:00:00.000Z', '2026-11-04T17:00:00.000Z', 'Customer time block')] }));
    expect(twin.entries.map((e) => [e.dedupeKey, e.status])).toEqual([['org62|00UT', 'logged']]);
    // another customer's Event that only overlaps (D-65: the same Related To and half the slot would be a twin, TL-02)
    const other = planWeek(input({ events: [ev('e1')], org62: [o62('00UO', '2026-11-04T15:00:00.000Z', '2026-11-04T16:30:00.000Z', 'Globex build', OPP_GLOBEX)] }));
    expect(other.entries.map((e) => [e.dedupeKey, e.status])).toEqual([
      ['org62|00UO', 'logged'],
      ['cal|primary|e1|2026-11-04T16:00:00.000Z', 'proposed'],
    ]);
  });

  it('count once: counted rows never overlap; agent time never counts', () => {
    const p = planWeek(once(twoMeetings));
    const counted = p.entries.filter((e) => e.status !== 'excluded');
    for (const a of counted) for (const b of counted) if (a !== b) expect(Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt)).toBe(false);
    expect(p.entries.some((e) => e.status === 'excluded' && e.excludedReason === 'overlap')).toBe(true);
    const bg = p.blocks.filter((b) => b.source === 'claude_background');
    expect(bg.length).toBe(1);
    expect(bg[0]).toMatchObject({ countsAsHumanHours: false, attention: 'background', startsAt: '2026-11-04T16:00:00Z', endsAt: '2026-11-04T20:00:00Z' });
    const humanMs = p.blocks.filter((b) => b.countsAsHumanHours).reduce((s, b) => s + Date.parse(b.endsAt) - Date.parse(b.startsAt), 0);
    expect(humanMs / 3_600_000).toBeCloseTo(p.humanHours, 5);
    expect(p.leverageHours).toBeCloseTo(4, 5);
  });

  it('Slack bursts are evidence; an unmapped bucket is named by what it holds', () => {
    const at = (t: string) => `2026-11-04T${String(Number(t.slice(0, 2)) + 7).padStart(2, '0')}:${t.slice(3)}:00.000Z`;
    const slack = ['14:00', '14:05', '14:09', '14:30', '14:38'].map((t, i) => ({ id: `m${i}`, channelId: 'C0PLACE1', at: at(t), url: `https://example.slack.com/archives/C0PLACE1/p${i}`, externalId: `C0PLACE1:${i}` }));
    const p = planWeek(input({ slack }));
    expect(p.blocks.filter((b) => b.source === 'slack_burst').map((b) => b.label)).toEqual(['3 Slack messages', '2 Slack messages']);
    // AUDIT: each message is its own action and its own source, linked to it (engaged time, 2026-11-14)
    expect(p.entries.map((e) => [e.subject, e.status, e.sources.map((s) => [s.kind, s.url])])).toEqual([
      ['Unmapped Slack: off-calendar build/prep', 'needs_input', [0, 1, 2, 3, 4].map((i) => ['slack', `https://example.slack.com/archives/C0PLACE1/p${i}`])],
    ]);
    // 13:58–14:10 and 14:28–14:39 of engaged time (2 min before each message, 1 after; a 21 min gap ends a stretch)
    expect(p.entries[0]!.durationHours).toBe(0.5);
  });

  it('only this window: neighbours belong to their own pass', () => {
    const p = planWeek(input({ events: [ev('e1'), ev('e9', { startsAt: '2026-11-10T16:00:00.000Z', endsAt: '2026-11-10T17:00:00.000Z' })] }));
    expect(p.entries.map((e) => e.dedupeKey)).toEqual(['cal|primary|e1|2026-11-04T16:00:00.000Z']);
  });
});
