/**
 * D-64: internal-only activity, "Dismiss all from …" rules and declined meetings, through the engine, the week
 * projection (planWeek), the Time derivations and the mock DataSource. Placeholders only (no customer names or ids).
 *
 *   classification   repo / Drive work no account or opp matched, and meetings with no customer, account or opp that
 *                    name internal work, are internal: what_kind none, no WhatId, CF / CR off, the precedent's type,
 *                    proposed; a mapped repo keeps its opp; the AE (no internalActivity) is unchanged
 *   Time             internal rows never count in Needs you; they sit in a quiet group (Log / Dismiss); the opp picker's
 *                    "Internal (no opportunity)" completes a held row; a batch logs an approved one with Related To empty
 *   rules            "Dismiss all from <source>": the rows now, every re-projection, Undo and Remove
 *   declined         never a row: on first read, after accepting (mine go; handed-off ones are flagged), per instance
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { routes, Seed, type ActivityEntry, type LogCanvas, type RouteKey, type RouteOutput, type TimeWeek } from '@/contract';
import { autoApprove } from '@/engines/activity/propose';
import { DEFAULT_EVIDENCE_CONFIG, type ActivityConfig } from '@/engines/activity/types';
import { DECLINED_HELD_FLAG, DECLINED_LOGGED_FLAG, dismissRuleFlag, dismissSourceOf, INTERNAL_TASK_TYPES, internalMeetingType, personalBlockOf, internalWorkType } from '@/engines/activity/internal';
import { newEntry } from '@/engines/activity/entry';
import { SE_TASK_TYPES } from '@/engines/activity/taxonomy';
import { eventRow, renderWorkOrder } from '@/engines/activity/slackbot';
import { loggingProfile } from '@/engines/activity/persona';
import { internalPatch, isInternalEntry, restoredStatus } from '@/lib/time-internal';
import { personaOf } from '@/personas';
import { planWeek, type FixedEntry, type WeekEvent, type WeekInput, type WeekSession } from '@/projections/activity';
import { Matcher, type MatchOpp } from '@/projections/matching';
import { MockDataSource } from '@/server/datasource/mock';
import { toLogCount } from '@/engines/activity/to-log-count';
import { TO_LOG_NEED_STATUSES, toLogRange } from '@/engines/activity/to-log-rows';
import { NOT_IN_ORG62_FLAG } from '@/engines/activity/org62-check';
import { fixLane } from '@/components/time/fix-derive';
import { timeBadges } from '@/components/time/badges';
import { lanesOf } from '@/components/time/lanes-derive';
import { unsettledIds } from '@/components/time/history-derive';
import { scaleSeed } from '@/mock/scale';
import { timeReadyProvider } from '@/engines/needs/providers/time';
import { patchedEntry } from '@/server/time/dismiss';
import { isLoggable, q4Range, q4Steps, quarterRowsOf } from '@/components/time/derive';
import { fixPatch, internalGroup, logPath, missingOf, needsYou, weekSuggested } from '@/components/time/path-derive';

import { ME, RULES, TZ } from '../projections/fixtures';

// ---------------------------------------------------------------------------------------------------------------
// fixtures: one account with one opp of mine; a week in America/Denver (UTC-7)
// ---------------------------------------------------------------------------------------------------------------

const ACCT = '001XX0000000I01AAA';
const OPP = '006XX0000000I01AAA';
const accounts = [{ id: 'a-acct1', name: 'ACCOUNT_1 Corporation', org62AccountId: ACCT, aliases: [] }];
const opps: MatchOpp[] = [{ id: 'o-acct1', accountId: 'a-acct1', org62OpportunityId: OPP, name: 'ACCOUNT_1 - Expansion', isClosed: false, onMyTeam: true, myDc: true }];
const matcher = new Matcher(accounts, opps, RULES);
const FROM = '2026-11-02T07:00:00.000Z';
const TO = '2026-11-09T07:00:00.000Z';
const NOW = '2026-11-07T18:00:00.000Z';

const cfg = (o: Partial<ActivityConfig> = {}): ActivityConfig => ({
  timezone: TZ,
  ownerId: ME.org62UserId!,
  recordTypeId: '',
  lightningHost: '',
  workday: { start: '07:30', end: '17:30' },
  hoursTarget: 250,
  liveFrom: '1970-01-01',
  evidence: DEFAULT_EVIDENCE_CONFIG,
  quarters: [],
  internalActivity: true,
  ...o,
});

const ev = (id: string, p: Partial<WeekEvent> = {}): WeekEvent => ({
  rowId: `row-${id}`,
  calendarId: 'primary',
  externalEventId: id,
  title: 'Internal sync',
  startsAt: '2026-11-02T17:00:00.000Z',
  endsAt: '2026-11-02T18:00:00.000Z',
  isAllDay: false,
  eventType: 'default',
  cancelled: false,
  myResponse: 'accepted',
  iAmOrganizer: false,
  attendance: 'attended',
  attendeeDomains: ['corp.example'],
  recurring: false,
  hasNotes: false,
  url: null,
  accountId: null,
  oppOrg62Id: null,
  ...p,
});

const session = (id: string, repoKey: string, day: string): WeekSession => ({
  rowId: `s-${id}`,
  title: `${repoKey} session`,
  repoKey,
  startedAt: `${day}T22:00:00.000Z`,
  lastActivityAt: `${day}T23:35:00.000Z`,
  lastHumanPromptAt: `${day}T23:30:00.000Z`,
});

const input = (p: Partial<WeekInput> = {}, o: Partial<ActivityConfig> = {}, repos: Record<string, string> = {}): WeekInput => ({
  now: NOW,
  from: FROM,
  to: TO,
  cfg: cfg(o),
  mappings: matcher.mappings({ internalDomains: RULES.internal, partnerDomains: RULES.partner, ignoreDomains: RULES.ignore }, { repos }),
  events: [],
  sessions: [],
  drive: [],
  slack: [],
  org62: [],
  fixed: [],
  fixedBlocks: [],
  names: (id) => (id === OPP ? { name: 'ACCOUNT_1 - Expansion', mine: true } : id === ACCT ? { name: 'ACCOUNT_1 Corporation' } : null),
  ...p,
});

const key = (e: Pick<WeekEvent, 'calendarId' | 'externalEventId' | 'startsAt'>) => `cal|${e.calendarId}|${e.externalEventId}|${e.startsAt}`;
const fixed = (rowId: string, dedupeKey: string, status: string, p: Partial<FixedEntry> = {}): FixedEntry => ({
  rowId,
  dedupeKey,
  subject: 'Row',
  startsAt: dedupeKey.split('|')[3] ?? '2026-11-03T17:00:00.000Z',
  endsAt: new Date(Date.parse(dedupeKey.split('|')[3] ?? '2026-11-03T17:00:00.000Z') + 3_600_000).toISOString(),
  durationHours: 1,
  seTaskType: 'Account Planning',
  whatOrg62Id: OPP,
  meetingType: null,
  status,
  operation: 'create',
  targetOrg62EventId: null,
  flags: [],
  ...p,
});

// ---------------------------------------------------------------------------------------------------------------

describe('classification and the precedent type mapping', () => {
  it('maps the precedent: building demos / assets / tools / skills → Asset Creation, learning → Personal Development; internal meetings → Admin unless they name training, V2MOM, travel or a build', () => {
    expect(internalWorkType('headless demo portal').type).toBe('Asset Creation');
    expect(internalWorkType('estimator skill').type).toBe('Asset Creation');
    expect(internalWorkType('scanner stress harness').type).toBe('Asset Creation');
    expect(internalWorkType('Data Cloud certification prep').type).toBe('Personal Development');
    expect(internalWorkType('trailhead superbadge').type).toBe('Personal Development');
    expect(internalWorkType('SKO enablement deck').type).toBe('Sales Enablement');
    expect(internalMeetingType('Data Cloud certification study group')?.type).toBe('Personal Development');
    expect(internalMeetingType('Peer cert: agent design')?.type).toBe('Personal Development');
    expect(internalMeetingType('New hire on-boarding')?.type).toBe('Personal Development');
    expect(internalMeetingType('Demo build session')?.type).toBe('Asset Creation');
    expect(internalMeetingType('FY28 V2MOM working session')?.type).toBe('V2MOM Initiatives');
    expect(internalMeetingType('Travel to the team offsite')?.type).toBe('Travel');
    // 2026-11-14 (Org62 precedent: 248 no-WhatId Solutions Events, 27 SEs): 1:1s, syncs, team meetings, wraps, all hands,
    // office hours and enablement sessions are logged as Admin; a 1:1 about an asset is still the 1:1
    for (const t of ['1:1 with PERSON_1', 'SE team meeting', 'Weekly sync', 'All hands', 'Keynote live stream', 'Office hours', 'Agentic selling enablement', 'Team wrap', 'PERSON_1 / PERSON_2 catch up on demo assets'])
      expect(internalMeetingType(t)).toMatchObject({ type: 'Admin' });
    // personal time and holds of my own are no meeting at all
    const m = { internalDomains: ['corp.example'], ignoreDomains: [], partnerDomains: [] };
    expect(personalBlockOf({ summary: 'Lunch', attendeeDomains: [] }, m)).toMatch(/personal time/);
    expect(personalBlockOf({ summary: 'Dentist appointment', attendeeDomains: ['corp.example'] }, m)).toMatch(/personal time/);
    expect(personalBlockOf({ summary: 'BLOCK send docs to PERSON_1', organizerSelf: true, attendeeDomains: [] }, m)).toMatch(/hold of your own/);
    expect(personalBlockOf({ summary: 'Focus time', organizerSelf: true, attendeeDomains: [] }, m)).toMatch(/hold of your own/);
    expect(personalBlockOf({ summary: 'BLOCK review with ACCOUNT_1', organizerSelf: true, attendeeDomains: ['customer.example'] }, m)).toBeNull(); // a customer on it: a meeting
    expect(personalBlockOf({ summary: 'Lunch and learn with ACCOUNT_1', attendeeDomains: ['customer.example'] }, m)).toBeNull();
    expect(personalBlockOf({ summary: 'Dry run for ACCOUNT_1', organizerSelf: true, attendeeDomains: [] }, m)).toBeNull();
    // the internal types are real SE Task Types, and the type pickers offer the persona's taxonomy (not a stale list)
    for (const t of INTERNAL_TASK_TYPES) expect(SE_TASK_TYPES).toContain(t);
    expect(loggingProfile(personaOf({})).taskTypes).toEqual([...SE_TASK_TYPES]);
    expect(SE_TASK_TYPES).toEqual(expect.arrayContaining(['Solution Creation', 'Consumption Estimation', 'Dry Run', 'Customer Discovery', 'Customer Presentation', 'Workshop', 'Asset Creation', 'Personal Development', 'Sales Enablement', 'Travel', 'Marketing Support']));
    for (const stale of ['Demo', 'Discovery', 'Solution Design', 'Internal Prep']) expect(SE_TASK_TYPES).not.toContain(stale);
  });

  it('repo and Drive work no account matched is internal (Asset Creation, proposed, no WhatId, CF / CR off); a mapped repo keeps its opp', () => {
    const p = planWeek(
      input({ sessions: [session('a', 'demo-kit', '2026-11-03'), session('b', 'acct1-poc', '2026-11-04')], drive: [{ fileId: 'F1', title: 'Demo script template', at: '2026-11-05T20:00:00.000Z' }] }, {}, { 'acct1-poc': 'a-acct1' }),
    );
    const repo = p.entries.find((e) => e.dedupeKey === 'wb|2026-11-03|repo:demo-kit')!;
    expect(repo).toMatchObject({ internal: true, seTaskType: 'Asset Creation', status: 'proposed', whatKind: 'none', whatOrg62Id: null, customerFacing: false, customerRelated: false, meetingType: null });
    expect(repo.subject).toBe('demo-kit: internal asset build');
    expect(repo.flags.some((f) => /NEEDS WhatId/.test(f))).toBe(false);
    const docs = p.entries.find((e) => e.dedupeKey === 'wb|2026-11-05|docs:unmapped')!;
    expect(docs).toMatchObject({ internal: true, seTaskType: 'Asset Creation', status: 'proposed', whatOrg62Id: null, customerRelated: false });
    // the matcher stays: a repo that maps to an account keeps its opp
    const mapped = p.entries.find((e) => e.dedupeKey === 'wb|2026-11-04|acct:a-acct1')!;
    expect(mapped).toMatchObject({ whatOrg62Id: OPP, whatKind: 'opportunity' });
    expect(mapped.internal).toBeFalsy();
  });

  it('Slack alone in a channel no account names is internal coordination (Admin, no WhatId), D-64 as amended 2026-11-14', () => {
    const slack = ['22:00', '22:05', '22:09', '22:14', '22:18'].map((t, i) => ({ id: `m${i}`, channelId: 'C0PLACE01', at: `2026-11-03T${t}:00.000Z`, url: null, externalId: `C0PLACE01:${i}`, channelName: 'placeholder' }));
    const row = planWeek(input({ slack })).entries.find((e) => e.dedupeKey === 'wb|2026-11-03|comms:unmapped')!;
    // 21:58–22:19 of engaged time: 2 min before the first message, 1 after the last
    expect(row).toMatchObject({ internal: true, seTaskType: 'Admin', status: 'proposed', whatOrg62Id: null, customerRelated: false, durationHours: 0.25 });
    expect(row.subject).toBe('Slack: internal coordination');
  });

  it('a meeting with no customer, account or opp that names internal work is internal; a customer, an account or an opp makes it the customer\'s', () => {
    const cert = ev('cert', { title: 'Data Cloud certification study group' });
    const ext = ev('ext', { title: 'Certification study with a partner', attendeeDomains: ['customer.example'], startsAt: '2026-11-03T17:00:00.000Z', endsAt: '2026-11-03T18:00:00.000Z' });
    const acct = ev('acct', { title: 'ACCOUNT_1 demo build', accountId: 'a-acct1', startsAt: '2026-11-04T17:00:00.000Z', endsAt: '2026-11-04T18:00:00.000Z' });
    const oneOnOne = ev('one', { title: '1:1 with PERSON_1', startsAt: '2026-11-05T17:00:00.000Z', endsAt: '2026-11-05T17:30:00.000Z' });
    const p = planWeek(input({ events: [cert, ext, acct, oneOnOne] }));
    const row = (e: WeekEvent) => p.entries.find((x) => x.dedupeKey === key(e))!;
    expect(row(cert)).toMatchObject({ internal: true, seTaskType: 'Personal Development', status: 'proposed', whatOrg62Id: null, customerFacing: false, customerRelated: false });
    expect(row(ext).internal).toBeFalsy();
    expect(row(ext).customerFacing).toBe(true);
    expect(row(acct).internal).toBeFalsy();
    expect(row(acct).whatOrg62Id).toBe(OPP);
    // internal cadence is logged as internal Admin (2026-11-14), never excluded
    expect(row(oneOnOne)).toMatchObject({ internal: true, seTaskType: 'Admin', status: 'proposed', excludedReason: null, whatOrg62Id: null, customerRelated: false });
  });

  it('the AE persona (no internalActivity) is unchanged: unmapped work still asks for an opp, an internal meeting is not logged', () => {
    const p = planWeek(input({ sessions: [session('a', 'demo-kit', '2026-11-03')], events: [ev('cert', { title: 'Data Cloud certification study group' })] }, { internalActivity: false }));
    const repo = p.entries.find((e) => e.dedupeKey === 'wb|2026-11-03|repo:demo-kit')!;
    expect(repo.internal).toBeFalsy();
    expect(repo.status).toBe('needs_input');
    expect(repo.flags.some((f) => /NEEDS WhatId/.test(f))).toBe(true);
    expect(p.entries.find((e) => e.dedupeKey.startsWith('cal|primary|cert|'))).toMatchObject({ status: 'excluded' });
    expect(loggingProfile(personaOf({ persona: { id: 'ae' } }))).toMatchObject({ internalActivity: false, taskTypes: [] });
  });

  it('hands-off approval never approves an internal row (it waits for your Log); an Org62 Event with Related To empty and an internal type reads as internal', () => {
    const row = newEntry({ dedupeKey: 'wb|2026-11-03|repo:demo-kit', origin: 'evidence', subject: 'demo-kit: internal asset build', startsAt: '2026-11-03T22:00:00.000Z', endsAt: '2026-11-03T23:00:00.000Z', durationHours: 1, seTaskType: 'Asset Creation', internal: true });
    expect(autoApprove([row], NOW)[0]!.status).toBe('proposed');
    const p = planWeek(input({ org62: [{ rowId: 'r1', org62EventId: '00UXX0000000I01AAA', recordTypeName: 'Solutions Event', subject: 'Estimator skill', startsAt: '2026-11-04T16:00:00.000Z', endsAt: '2026-11-04T18:00:00.000Z', durationField: 2, seTaskTypeName: 'Asset Creation', meetingTypeName: null, whatOrg62Id: null, ownerId: ME.org62UserId, whatName: null }] }));
    expect(p.entries.find((e) => e.dedupeKey === 'org62|00UXX0000000I01AAA')).toMatchObject({ status: 'logged', internal: true, meetingType: null, customerRelated: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('declined meetings never show up in Time', () => {
  it('first read: a declined invite has no row, also one I organize (a declined instance of my own series)', () => {
    const decl = ev('decl', { title: 'ACCOUNT_1 sync', accountId: 'a-acct1', myResponse: 'declined', attendance: 'missed', attendeeDomains: ['customer.example'] });
    const own = ev('own', { title: 'ACCOUNT_1 planning', accountId: 'a-acct1', myResponse: 'declined', iAmOrganizer: true, startsAt: '2026-11-03T17:00:00.000Z', endsAt: '2026-11-03T18:00:00.000Z' });
    const p = planWeek(input({ events: [decl, own] }));
    expect(p.entries.filter((e) => e.dedupeKey === key(decl) || e.dedupeKey === key(own))).toEqual([]);
    expect(p.declined).toEqual([]);
  });

  it('declined after accepting: my row goes (approved too); a handed-off or logged row is flagged, never deleted; one in a canvas item waits flagged', () => {
    const at = (d: string) => ({ startsAt: `2026-11-0${d}T17:00:00.000Z`, endsAt: `2026-11-0${d}T18:00:00.000Z` });
    const events = ['3', '4', '5', '6'].map((d) => ev(`e${d}`, { title: 'ACCOUNT_1 sync', accountId: 'a-acct1', myResponse: 'declined', ...at(d) }));
    const rows = [fixed('mine-approved', key(events[0]!), 'approved'), fixed('mine-logged', key(events[1]!), 'logged'), fixed('mine-held', key(events[2]!), 'approved'), fixed('mine-edited', key(events[3]!), 'needs_input')];
    const p = planWeek(input({ events, fixed: rows, held: new Set(['mine-held']) }));
    expect(p.declined).toEqual(
      expect.arrayContaining([
        { rowId: 'mine-approved', action: 'remove' },
        { rowId: 'mine-logged', action: 'flag', flag: DECLINED_LOGGED_FLAG },
        { rowId: 'mine-held', action: 'flag', flag: DECLINED_HELD_FLAG },
        { rowId: 'mine-edited', action: 'remove' },
      ]),
    );
    expect(p.declined).toHaveLength(4);
    // a flag is added once
    const again = planWeek(input({ events, fixed: [fixed('mine-logged', key(events[1]!), 'logged', { flags: [DECLINED_LOGGED_FLAG] })] }));
    expect(again.declined).toEqual([]);
    // the projection's own rows simply have no proposal (applyActivityWindow drops them)
    expect(p.entries.filter((e) => events.some((x) => e.dedupeKey === key(x)))).toEqual([]);
  });

  it('recurring: only the instance I declined has no row; an accepted meeting it overlapped logs in full', () => {
    const wk = (d: string, p: Partial<WeekEvent> = {}) => ev(`weekly_202611${d}T170000Z`, { title: 'ACCOUNT_1 weekly', accountId: 'a-acct1', recurring: true, startsAt: `2026-11-${d}T17:00:00.000Z`, endsAt: `2026-11-${d}T18:00:00.000Z`, ...p });
    const kept = wk('03');
    const declined = wk('04', { myResponse: 'declined', attendance: 'missed' });
    const other = ev('other', { title: 'ACCOUNT_1 architecture review', accountId: 'a-acct1', startsAt: '2026-11-04T17:30:00.000Z', endsAt: '2026-11-04T18:30:00.000Z', attendeeDomains: ['customer.example'] });
    for (const overlaps of ['log_all_accepted', 'count_once'] as const) {
      const p = planWeek(input({ events: [kept, declined, other] }, { overlaps }));
      expect(p.entries.find((e) => e.dedupeKey === key(kept))!.status).toMatch(/^(proposed|needs_input)$/);
      expect(p.entries.find((e) => e.dedupeKey === key(declined))).toBeUndefined();
      const o = p.entries.find((e) => e.dedupeKey === key(other))!;
      expect(o.status).toMatch(/^(proposed|needs_input)$/);
      expect(o.flags.some((f) => /overlaps|double-booked|counted once/.test(f))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('"Dismiss all from <source>" in the projection', () => {
  it('the source of a row: a repo, unmapped Drive docs, a recurring series; nothing else', () => {
    expect(dismissSourceOf('wb|2026-11-03|repo:demo-kit', 'x')).toEqual({ key: 'repo:demo-kit', kind: 'repo', label: 'demo-kit' });
    expect(dismissSourceOf('wb|2026-11-03|docs:unmapped', 'x')).toEqual({ key: 'docs:unmapped', kind: 'docs', label: 'unmapped Drive docs' });
    expect(dismissSourceOf('cal|primary|weekly_20261103T170000Z|2026-11-03T17:00:00.000Z', 'ACCOUNT_1 weekly')).toEqual({ key: 'series:primary|weekly', kind: 'series', label: "'ACCOUNT_1 weekly'" });
    expect(dismissSourceOf('cal|primary|oneoff|2026-11-03T17:00:00.000Z', 'x')).toBeNull();
    expect(dismissSourceOf('wb|2026-11-03|acct:a-acct1', 'x')).toBeNull();
    expect(dismissSourceOf('org62|00UXX', 'x')).toBeNull();
  });

  it('a rule writes every new row of its source dismissed (with the rule), and a series it covers never takes time from another meeting', () => {
    const wk = (d: string) => ev(`weekly_202611${d}T170000Z`, { title: 'Asset sync', recurring: true, startsAt: `2026-11-${d}T17:00:00.000Z`, endsAt: `2026-11-${d}T18:00:00.000Z`, attendeeDomains: ['customer.example'] });
    const other = ev('other', { title: 'ACCOUNT_1 review', accountId: 'a-acct1', startsAt: '2026-11-03T17:15:00.000Z', endsAt: '2026-11-03T18:15:00.000Z', attendeeDomains: ['customer.example'] });
    const rules = [{ key: 'repo:demo-kit', label: 'demo-kit' }, { key: 'series:primary|weekly', label: "'Asset sync'" }];
    const p = planWeek(input({ sessions: [session('a', 'demo-kit', '2026-11-03')], events: [wk('03'), wk('04'), other], dismissRules: rules }, { overlaps: 'count_once' }));
    const repo = p.entries.find((e) => e.dedupeKey === 'wb|2026-11-03|repo:demo-kit')!;
    expect(repo.status).toBe('dismissed');
    expect(repo.flags).toContain(dismissRuleFlag('demo-kit'));
    for (const d of ['03', '04']) expect(p.entries.find((e) => e.dedupeKey === key(wk(d)))!.status).toBe('dismissed');
    // count once: the dismissed series never makes the review lose its slot
    const o = p.entries.find((e) => e.dedupeKey === key(other))!;
    expect(o.status).not.toBe('excluded');
  });

  it('a row I dismissed stays mine (never rewritten); a row a rule set aside whose rule is gone (Undo, Remove) logs again', () => {
    const s = session('a', 'demo-kit', '2026-11-03');
    const mine = fixed('mine', 'wb|2026-11-03|repo:demo-kit', 'dismissed', { seTaskType: 'Asset Creation', whatOrg62Id: null, startsAt: '2026-11-03T22:00:00.000Z', endsAt: '2026-11-03T22:15:00.000Z' });
    const byRule = { ...mine, flags: [dismissRuleFlag('demo-kit')] };
    expect(planWeek(input({ sessions: [s], fixed: [mine] })).revives).toEqual([]);
    expect(planWeek(input({ sessions: [s], fixed: [byRule], dismissRules: [{ key: 'repo:demo-kit', label: 'demo-kit' }] })).revives).toEqual([]);
    expect(planWeek(input({ sessions: [s], fixed: [byRule] })).revives).toEqual([expect.objectContaining({ rowId: 'mine', status: 'proposed', kind: 'rule' })]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

const entry = (o: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: 'r1',
  version: 1,
  date: '2026-11-03',
  start: '2026-11-03T22:00:00.000Z',
  end: '2026-11-03T23:30:00.000Z',
  durationH: 1.5,
  taskType: 'Asset Creation',
  oppId: null,
  oppName: null,
  accountName: null,
  meetingType: null,
  description: 'demo-kit: internal asset build',
  status: 'proposed',
  confidence: 'guess',
  sources: [],
  userLockedFields: [],
  issues: [],
  updatedAt: '2026-11-03T23:30:00.000Z',
  fromOrg62: false,
  excludedReason: null,
  loggedAt: null,
  verifiedAt: null,
  internal: true,
  dismissSource: { key: 'repo:demo-kit', kind: 'repo', label: 'demo-kit' },
  logNote: null,
  logNoteBasis: null,
  why: null,
  suggestion: null,
  ...o,
});
const week = { quarter: { label: 'Q4 FY27', loggedH: 0, targetH: 250, due: null }, logCanvases: [] as LogCanvas[] } as unknown as TimeWeek;

describe('Time: internal rows never ask for an opp; the picker\'s Internal completes a row', () => {
  it('Needs you (and its count) excludes internal rows; they sit in the quiet Internal group until you Log them', () => {
    const internal = entry();
    const held = entry({ id: 'r2', taskType: 'Solution Creation', meetingType: 'CR', internal: false, status: 'needs_input', issues: ['NEEDS WhatId: which account/opp was this for?'] });
    expect(missingOf(internal)).toBeNull();
    expect(missingOf(held)).toBe('opp');
    const n = needsYou([internal, held]);
    expect(n.ids).toEqual(['r2']);
    expect(internalGroup([internal, held]).ids).toEqual(['r1']);
    const path = logPath({ rows: [internal, held], week, nowIso: NOW });
    expect(path.needs.ids).toEqual(['r2']);
    expect(path.internal.ids).toEqual(['r1']);
    // a proposed internal row is never Ready to log (a batch never approves it for you); approved, it is
    expect(path.readyIds).not.toContain('r1');
    expect(q4Steps({ rows: [internal], week, nowIso: NOW }).find((s) => s.id === 'approve')).toBeUndefined();
    expect(isLoggable(entry({ status: 'approved' }), Date.parse(NOW))).toBe(true);
    expect(isLoggable(internal, Date.parse(NOW))).toBe(false);
    expect(logPath({ rows: [entry({ status: 'approved' })], week, nowIso: NOW }).readyIds).toEqual(['r1']);
    // Suggested says where they are
    expect(weekSuggested([internal, held], path).parts.map((x) => x.id)).toEqual(['needs', 'internal']);
  });

  it('fixPatch: "Internal (no opportunity)" completes a held no-opp row (approved), and a proposed one; the opp pick still approves only held rows', () => {
    const held = entry({ id: 'r2', taskType: 'Solution Creation', meetingType: 'CR', internal: false, status: 'needs_input', issues: ['NEEDS WhatId: which account/opp was this for?'] });
    expect(fixPatch(held, { internal: true })).toEqual({ internal: true, status: 'approved' });
    expect(fixPatch(entry({ internal: false, oppId: 'o1', taskType: 'Solution Creation', meetingType: 'CR' }), { internal: true })).toEqual({ internal: true, status: 'approved' });
    expect(fixPatch(entry({ status: 'approved' }), { internal: true })).toEqual({ internal: true });
    expect(fixPatch(held, { oppId: 'o1' })).toEqual({ oppId: 'o1', status: 'approved' });
  });

  it('the edit: internal sets no opp, no account, no CF / CR and an internal type (the row\'s words); an opp takes it back to customer work', () => {
    const cust = entry({ internal: false, taskType: 'Solution Creation', meetingType: 'CR', accountName: 'ACCOUNT_1', status: 'needs_input', issues: ['NEEDS WhatId: which account/opp was this for?', 'GUESS: hours estimated from evidence'], dismissSource: null, description: 'Certification prep notes' });
    const ip = internalPatch(cust, { internal: true })!;
    expect(ip.fields).toMatchObject({ internal: true, oppId: null, accountName: null, meetingType: null, taskType: 'Personal Development' });
    expect(ip.fields.issues).toEqual(['GUESS: hours estimated from evidence']);
    const { next, newLocks } = patchedEntry(cust, { internal: true, status: 'approved' }, null);
    expect(next).toMatchObject({ internal: true, status: 'approved', taskType: 'Personal Development' });
    expect(newLocks.sort()).toEqual(['meetingType', 'oppId', 'taskType']);
    expect(isInternalEntry(next)).toBe(true);
    // back to customer work: an opportunity, and the customer type of the same work
    const back = patchedEntry(entry(), { oppId: 'o1' }, { name: 'OPP_1', accountName: 'ACCOUNT_1' }).next;
    expect(back).toMatchObject({ internal: false, oppId: 'o1', oppName: 'OPP_1', accountName: 'ACCOUNT_1', taskType: 'Solution Creation', meetingType: 'CR' });
    expect(restoredStatus(entry(), NOW)).toBe('proposed');
    expect(restoredStatus(entry({ internal: false, taskType: 'Solution Creation' }), NOW)).toBe('needs_input');
  });

  it('the work order: an internal row has an empty WhatId, its task type, and a rule that says to leave Related To empty', () => {
    const row = eventRow({ id: 'act-1', subject: 'demo-kit: internal asset build', start: '2026-11-03T22:00:00.000Z', end: '2026-11-03T23:30:00.000Z', durationH: 1.5, taskType: 'Asset Creation', whatOrg62Id: '', origin: 'evidence' });
    const md = renderWorkOrder({ ownerName: 'PERSON_ME', ownerOrg62Id: '005XX0000000OWNAAA', recordTypeId: '012XX0000000RTYAAA', generatedAt: NOW, events: [row], updates: [], sourceLabel: 'Command Center' });
    expect(md).toContain('|Asset Creation|1.5||');
    expect(md).toContain('A row whose WhatId is empty is internal work with no opportunity: create it with WhatId (Related To) left empty');
    // a work order with no internal row is exactly the one Slackbot has always run
    const plain = renderWorkOrder({ ownerName: 'PERSON_ME', ownerOrg62Id: '005XX0000000OWNAAA', recordTypeId: '012XX0000000RTYAAA', generatedAt: NOW, events: [{ ...row, whatId: OPP }], updates: [], sourceLabel: 'Command Center' });
    expect(plain).not.toContain('internal work');
    expect(plain).toContain('2. Work through everything');
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('the mock DataSource', () => {
  const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
  const fast = { enrichMs: 1e8, stepMs: 5, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 };
  const made: MockDataSource[] = [];
  const fresh = () => {
    const ds = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
    made.push(ds);
    return ds;
  };
  afterEach(() => {
    for (const d of made.splice(0)) d.dispose();
  });
  async function call<K extends RouteKey>(ds: MockDataSource, key: K, inp: unknown): Promise<RouteOutput<K>> {
    const def = routes[key] as { body?: { parse: (v: unknown) => unknown }; response: (typeof routes)[K]['response'] };
    const parsed = inp as Record<string, unknown>;
    const out = await (ds[key as keyof MockDataSource] as (i: unknown) => Promise<unknown>).call(ds, { ...(def.body ? { body: def.body.parse(parsed.body ?? {}) } : {}), ...(parsed.params ? { params: parsed.params } : {}), ...(parsed.query ? { query: parsed.query } : {}) });
    const r = def.response.safeParse(out);
    if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
    return r.data as RouteOutput<K>;
  }

  it('the seed shows an Internal group (a repo block, a docs block, an internal meeting) and a declined meeting that is nowhere on Time', async () => {
    const ds = fresh();
    const log = await call(ds, 'getActivityLog', { query: {} });
    const internal = log.entries.filter((e) => e.internal).map((e) => e.id).sort();
    expect(internal).toEqual(['ac_mon_cert', 'ac_tue_repo', 'ac_wed_docs']);
    expect(log.entries.find((e) => e.id === 'ac_tue_repo')!.dismissSource).toMatchObject({ kind: 'repo' });
    expect(log.entries.find((e) => e.id === 'ac_mon_cert')!.dismissSource).toMatchObject({ kind: 'series' });
    expect(needsYou(log.entries).ids.some((id) => internal.includes(id))).toBe(false);
    const declined = ds.store.get('events', 'ev_tue_declined')!;
    const tw = await call(ds, 'getTime', { query: { week: declined.start.slice(0, 10) } });
    expect(tw.timeline.find((l) => l.id === 'meetings')!.blocks.map((b) => b.id)).not.toContain('ev_tue_declined');
    expect(tw.entries.some((e) => e.sources.some((s) => s.externalId === 'ev_tue_declined'))).toBe(false);
  });

  it('the picker\'s Internal on a held row: internal, no opp or account, approved; it logs with an empty WhatId; the other sidebar counts do not change, the To log count drops by the fixed row', async () => {
    const ds = fresh();
    const counts = (await call(ds, 'getToday', {})).navCounts;
    const held = ds.store.get('activity', 'ac_wed_hooli')!;
    expect(held.status).toBe('needs_input');
    const r = await call(ds, 'patchActivity', { params: { id: held.id }, body: { ifVersion: held.version, patch: fixPatch(held, { internal: true }) } });
    expect(r.entity).toMatchObject({ internal: true, oppId: null, accountName: null, meetingType: null, status: 'approved' });
    expect(INTERNAL_TASK_TYPES as readonly string[]).toContain(r.entity.taskType);
    expect(r.entity.userLockedFields).toEqual(expect.arrayContaining(['oppId', 'taskType']));
    // making one internal changes none of the other numbers; To log's one count (C10) loses the row it fixed
    expect((await call(ds, 'getToday', {})).navCounts).toEqual({ ...counts, toLog: counts.toLog - 1 });
    // a proposed internal row waits for its Log; the approved one goes on the canvas, Related To empty
    const b = await call(ds, 'stageLogBatch', { body: {} });
    const md = ds.store.get('drafts', b.entity.draftIds[0]!)!.destination as unknown as { input: { markdown: string; eventIds: string[] } };
    expect(md.input.eventIds).toContain(held.id);
    expect(md.input.eventIds).not.toContain('ac_tue_repo');
    const line = md.input.markdown.split('\n').find((l) => l.includes('Hooli onsite'))!;
    expect(line).toContain(`|${r.entity.taskType}|4||`);
    expect(md.input.markdown).toContain('A row whose WhatId is empty is internal work');
  });

  it('an internal row switched to an opportunity is customer work again (its type follows)', async () => {
    const ds = fresh();
    const row = ds.store.get('activity', 'ac_tue_repo')!;
    const opp = ds.store.all('opps')[0]!;
    const r = await call(ds, 'patchActivity', { params: { id: row.id }, body: { ifVersion: row.version, patch: { oppId: opp.id } } });
    expect(r.entity).toMatchObject({ internal: false, oppId: opp.id, taskType: 'Solution Creation', meetingType: 'CR' });
    const back = await call(ds, 'patchActivity', { params: { id: row.id }, body: { ifVersion: r.entity.version, patch: { internal: true } } });
    expect(back.entity).toMatchObject({ internal: true, oppId: null, taskType: 'Asset Creation' });
  });

  it('Dismiss all from a repo: the rule and its rows in one change (Undo restores both); Remove brings the rows back', async () => {
    const ds = fresh();
    const r = await call(ds, 'dismissFromSource', { body: { entryId: 'ac_tue_repo' } });
    expect(r.entity.rule).toMatchObject({ key: 'repo:demo-kit', kind: 'repo', label: 'demo-kit', rows: 1 });
    expect(r.entity.dismissedIds).toEqual(['ac_tue_repo']);
    expect(ds.store.get('activity', 'ac_tue_repo')).toMatchObject({ status: 'dismissed', excludedReason: 'dismiss_rule' });
    expect((await call(ds, 'listTimeDismissRules', {})).rules.map((x) => x.key)).toEqual(['repo:demo-kit']);
    // Undo: one click restores the row and forgets the rule
    await call(ds, 'undoAudit', { params: { id: r.auditId! }, body: {} });
    expect(ds.store.get('activity', 'ac_tue_repo')).toMatchObject({ status: 'proposed', excludedReason: null });
    expect((await call(ds, 'listTimeDismissRules', {})).rules).toEqual([]);
    // again, then Remove from Settings ▸ Time
    await call(ds, 'dismissFromSource', { body: { entryId: 'ac_tue_repo' } });
    const rm = await call(ds, 'removeTimeDismissRule', { body: { key: 'repo:demo-kit' } });
    expect(rm.entity.rules).toEqual([]);
    expect(ds.store.get('activity', 'ac_tue_repo')).toMatchObject({ status: 'proposed', excludedReason: null });
    expect(ds.store.get('activity', 'ac_tue_repo')!.issues.some((i) => /Dismissed by your rule/.test(i))).toBe(false);
    // a row with no source (a one-off customer meeting) has no "Dismiss all from …"
    await expect(call(ds, 'dismissFromSource', { body: { entryId: 'ac_mon_acme' } })).rejects.toThrow(/no source/);
  });

  it('per-row Dismiss: Dismissed by you', async () => {
    const ds = fresh();
    const row = ds.store.get('activity', 'ac_wed_docs')!;
    const r = await call(ds, 'patchActivity', { params: { id: row.id }, body: { ifVersion: row.version, patch: { status: 'dismissed' } } });
    expect(r.entity).toMatchObject({ status: 'dismissed', excludedReason: 'dismissed' });
    const log = await call(ds, 'getActivityLog', { query: {} });
    expect(internalGroup(log.entries).ids).not.toContain('ac_wed_docs');
  });
});

// C10: the sidebar's Activity badge is To log's one count: the server's `navCounts.toLog` (src/server/views/today.ts,
// src/engines/activity/to-log-count.ts) equals `lanesOf(...).badge` (the To log tab) over the same rows and batches.
// (Here, not in a file of its own: a new test file importing path-derive would widen overlap-flags' fan-out, ENG-5.)
const c10Seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const c10Fast = { enrichMs: 1e8, stepMs: 5, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 };
const c10Made: MockDataSource[] = [];
afterEach(() => {
  for (const d of c10Made.splice(0)) d.dispose();
});

describe('To log count (C10): the sidebar says what the tab says', () => {
  it('navCounts.toLog equals lanesOf(...).badge over the rows To log reads, and the sidebar shows it', async () => {
    const ds = new MockDataSource({ seed: structuredClone(c10Seed), delays: c10Fast, autoplay: false, clockMode: 'seed' });
    c10Made.push(ds);
    const week = await ds.getTime({ query: {} } as never);
    const log = await ds.getActivityLog({ query: q4Range(week) } as never);
    const rows = log.entries;
    const canvases = week.logCanvases;
    const taskTypeRequired = loggingProfile(personaOf(ds.store.settings())).taskTypeRequired;
    const lanes = lanesOf({ path: { needs: needsYou(rows, { canvases, taskTypeRequired }), readyIds: [], internal: internalGroup(rows, canvases) }, rows, canvases });
    const today = await ds.getToday({} as never);
    expect(lanes.badge).toBeGreaterThan(0);
    expect(today.navCounts.toLog).toBe(lanes.badge);
    expect(toLogCount({ rows, canvases, taskTypeRequired }).badge).toBe(lanes.badge);
    // nothing else waits in this seed's other tabs → the sidebar's number is the tab's
    const b = timeBadges(today.navCounts);
    expect(b.log).toBe(lanes.badge);
  });

  it('an older payload without toLog keeps the approvals count', () => {
    expect(timeBadges({ adminWaiting: 2, vdpOpen: 0, adminBySurface: { log: 2, forecast: 0, vdp: 0 } }).log).toBe(2);
    expect(timeBadges({ adminWaiting: 1, vdpOpen: 0, adminBySurface: { log: 1, forecast: 0, vdp: 0 }, toLog: 38 }).log).toBe(38);
  });
});

// F1 (2026-11-23 lanes review, R2-1): one row set, one rule. Home's queue row, the sidebar's navCounts.toLog, the To
// log tab badge (`lanesOf(...).badge`, over the rows useQuarterRows reads) and lane 1 + Sending failures are one
// number, on rows across two quarters (last quarter's before the 3-week lookback), internal rows, a row Org62 lacks
// after its batch ran and a batch in flight. (Here, not in a file of its own: ENG-5.)
describe('To log row set (F1): the queue row, the sidebar and the tab count the same rows', () => {
  it('provider title = navCounts.toLog = lanesOf(...).badge = lane 1 + Sending failures, Q3 rows included', async () => {
    const seed = structuredClone(c10Seed);
    const moveTo = (e: (typeof seed.activity)[number], day: string) => {
      const hm = (iso: string) => iso.slice(10);
      Object.assign(e, { date: day, start: `${day}${hm(e.start)}`, end: `${day}${hm(e.end)}` });
    };
    // two fix rows of last quarter (Q3 FY27), before the quarter-so-far and 3-week lookback base range
    moveTo(seed.activity.find((e) => e.id === 'ac_wed_roadmap')!, '2026-09-15');
    moveTo(seed.activity.find((e) => e.id === 'ac_mon_claude_model')!, '2026-09-16');
    // an internal row held for a fix in Q3 (never a need, D-64) and a row Org62 lacks after its batch ran (D-65)
    const internal = { ...structuredClone(seed.activity.find((e) => e.id === 'ac_tue_repo')!), id: 'ac_f1_internal', status: 'needs_input' as const, durationH: 0 };
    moveTo(internal, '2026-09-01');
    const notFound = { ...structuredClone(seed.activity.find((e) => e.id === 'ac_tue_sow')!), id: 'ac_f1_nf', status: 'synced_to_canvas' as const, issues: [NOT_IN_ORG62_FLAG], canvasDraftId: 'dr_f1_gone' };
    moveTo(notFound, '2026-09-10');
    seed.activity.push(internal, notFound);
    const ds = new MockDataSource({ seed, delays: c10Fast, autoplay: false, clockMode: 'seed' });
    c10Made.push(ds);
    await ds.stageLogBatch({ body: routes.stageLogBatch.body.parse({}) } as never); // a batch in flight (waiting for your Apply)

    // the client: useQuarterRows' two reads (the rows that can need you, then the one range)
    const week = await ds.getTime({ query: {} } as never);
    const taskTypeRequired = loggingProfile(personaOf(ds.store.settings())).taskTypeRequired;
    const base = q4Range(week);
    const needy = await ds.getActivityLog({ query: { to: base.to, status: TO_LOG_NEED_STATUSES } } as never);
    const range = toLogRange({ rows: needy.entries, canvases: week.logCanvases, taskTypeRequired, base });
    expect(range.from).toBe('2026-08-01');
    expect(range.from < base.from).toBe(true);
    const { rows } = quarterRowsOf({ log: await ds.getActivityLog({ query: range } as never), week });
    const canvases = week.logCanvases;
    expect(canvases?.some((c) => c.state === 'pending')).toBe(true);
    const lanes = lanesOf({ path: { needs: needsYou(rows, { canvases, taskTypeRequired }), readyIds: [], internal: internalGroup(rows, canvases) }, rows, canvases });

    const today = await ds.getToday({} as never);
    const queue = (await ds.listNeeds({} as never)).rows.find((r) => r.kind === 'time_ready_to_log')!;
    const queueN = Number(/^(\d+) to fix in Activity/.exec(queue.title)?.[1]);
    expect(lanes.badge).toBe(lanes.fix.rows + lanes.sending.failed);
    expect(rows.some((e) => e.id === 'ac_f1_nf')).toBe(true);
    expect(lanes.fix.ids).toEqual(expect.arrayContaining(['ac_wed_roadmap', 'ac_mon_claude_model']));
    expect(lanes.fix.ids).not.toContain('ac_f1_internal');
    expect(today.navCounts.toLog).toBe(lanes.badge);
    expect(queueN).toBe(lanes.badge);
    expect(queue.why).toContain(`${lanes.fix.rows} rows need a fix`);
    expect(queue.why).toContain(`${lanes.sending.notFound} not found in Org62`);
    // the base range alone would have left the Q3 rows on no page
    const old = await ds.getActivityLog({ query: base } as never);
    expect(toLogCount({ rows: old.entries, canvases, taskTypeRequired }).badge).toBeLessThan(lanes.badge);
    // lane 1 names their quarter, due first within its band (C11: the Accept band, then Review)
    const groups = fixLane({ needs: needsYou(rows, { canvases, taskTypeRequired }), internal: internalGroup(rows, canvases), taskTypeRequired, today: '2026-11-05' }).groups;
    const q3 = groups.find((g) => /^Q3 FY27 · /.test(g.label))!;
    expect(groups.find((g) => g.band === q3.band && g.kind !== 'internal')).toBe(q3);
    const byDay = fixLane({ needs: needsYou(rows, { canvases, taskTypeRequired }), internal: internalGroup(rows, canvases), by: 'day', taskTypeRequired, today: '2026-11-05' }).groups;
    expect(byDay.find((g) => g.ids.includes('ac_wed_roadmap'))!.label).toMatch(/^Q3 · /);
  });
});

// R3-8 (2026-11-23 wave-2 review): the queue row's parts below its number are lane 2 and lane 3 as Activity counts them
// (lanesOf over logPath's readyIds and the open batches), at scale 7 where the old formula said "1 ready · 1 batch".
describe('Home queue row (R3-8): its parts are the To log lanes at scale 7', () => {
  it('fix, not found, ready and in Sending equal lanesOf(...) over the same rows and batches', async () => {
    const ds = new MockDataSource({ seed: scaleSeed(structuredClone(c10Seed), 7), delays: c10Fast, autoplay: false, clockMode: 'seed' });
    c10Made.push(ds);
    const week = await ds.getTime({ query: {} } as never);
    const taskTypeRequired = loggingProfile(personaOf(ds.store.settings())).taskTypeRequired;
    const base = q4Range(week);
    const needy = await ds.getActivityLog({ query: { to: base.to, status: TO_LOG_NEED_STATUSES } } as never);
    const range = toLogRange({ rows: needy.entries, canvases: week.logCanvases, taskTypeRequired, base });
    const { rows } = quarterRowsOf({ log: await ds.getActivityLog({ query: range } as never), week });
    const canvases = week.logCanvases;
    const path = logPath({ rows, week, nowIso: ds.clock.now().toISOString(), taskTypeRequired, approveComplete: true });
    const lanes = lanesOf({ path, rows, canvases, unsettled: unsettledIds(rows) });
    expect(lanes.ready.rows).toBeGreaterThan(1);
    expect(lanes.sending.batches).toBeGreaterThan(1);
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : w === 'batch' ? 'es' : 's'}`;
    const want = [
      lanes.fix.rows ? `${plural(lanes.fix.rows, 'row')} need a fix` : null,
      lanes.sending.notFound ? `${lanes.sending.notFound} not found in Org62` : null,
      lanes.ready.rows ? `${lanes.ready.rows} ready` : null,
      lanes.sending.batches ? `${plural(lanes.sending.batches, 'batch')} in Sending` : null,
      lanes.sending.failedBatches ? `${plural(lanes.sending.failedBatches, 'batch')} failed` : null,
    ].filter(Boolean);
    // GET /needs: the number and lanes 1 and 2 as Activity says them
    const queue = (await ds.listNeeds({} as never)).rows.find((r) => r.kind === 'time_ready_to_log')!;
    expect(Number(/^(\d+) to fix in Activity/.exec(queue.title)?.[1])).toBe(lanes.badge);
    expect(queue.why.startsWith(want.slice(0, 3).join(' · '))).toBe(true);
    // the provider over lane 3's batches (GET /time `logCanvases`): every part, lane 3 included. (The gather in
    // src/server/datasource/db/needs.ts builds `canvases` from the Outbox's open admin items only, so an applied
    // batch not finished yet is missing there until it also reads `outbox.admin.applied`: a follow-up, R3-8.)
    const { gatherNeeds } = await import('@/server/datasource/mock/needs');
    const { ctx } = await gatherNeeds(ds, ds.clock.now());
    const [row] = timeReadyProvider.run({ ...ctx, canvases: canvases ?? [] });
    expect(row!.title).toBe(queue.title);
    expect(row!.why).toBe(want.join(' · '));
  });
});
