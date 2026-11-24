/**
 * Hours grounded in truth (2026-11-14): engaged time from my own actions (engaged.ts), no caps, internal meetings
 * logged (Org62 precedent), flights always Travel with 120 / 60 min buffers, and the re-derive's seam (rederive.ts).
 * Placeholder data only (ACME, Globex, example domains).
 */
import { describe, expect, it } from 'vitest';

import { TimeSettings, DEFAULT_TIME_SETTINGS } from '@/contract';
import { airportBuffers } from '@/engines/activity/onsite';
import { bucketOf, DEFAULT_ENGAGED_PARAMS, engagedMinutes, engagedStretches, type EngagedAction } from '@/engines/activity/engaged';
import { diffRows, durationUpdateCandidates, rowsAfter, type RederiveRow } from '@/engines/activity/rederive';
import { dismissSourceOf } from '@/engines/activity/internal';
import { humanHours, buildTimeBlocks } from '@/engines/activity/blocks';
import { placeAcross } from '@/engines/activity/placement';
import { proposeActivity } from '@/engines/activity/propose';
import type { ActivityConfig, EvidenceBundle } from '@/engines/activity/types';
import { planWeek, type FixedEntry, type WeekInput } from '@/projections/activity';
import { humanTurnsOf } from '@/projections/sessions';
import { emailDomains } from '@/projections/run';
import { CFG, MAPPINGS, OPP_ACME } from '../fixtures/org62/activity';

const EMPTY: EvidenceBundle = { calendar: [], claude: [], drive: [], slack: [], git: [] };
const MIN = 60_000;
/** Tue 2026-11-10 America/Denver (MST, UTC-7) wall clock → ms / ISO. */
const ms = (hm: string, day = '2026-11-10') => Date.parse(`${day}T${hm}:00-07:00`);
const iso = (hm: string, day = '2026-11-10') => new Date(ms(hm, day)).toISOString().replace('.000', '');
const NOW = '2026-11-12T18:00:00Z';
const INTERNAL: ActivityConfig = { ...CFG, internalActivity: true };
const act = (hm: string, kind: EngagedAction['kind'], p: Partial<EngagedAction> = {}): EngagedAction => ({ at: ms(hm), kind, evidenceId: `${kind}-${hm}`, accountKey: null, repoKey: 'Projects-tools', ...p });

describe('engaged time: own actions, stretches, a share of the agent run', () => {
  it('each action implies minutes around it; actions within 15 min are one stretch; a longer gap ends it', () => {
    const st = engagedStretches([act('10:00', 'prompt'), act('10:10', 'prompt'), act('10:24', 'prompt'), act('10:45', 'prompt')]);
    // 09:56–10:25 (the gaps 10 and 14 min count), then 21 min later a new stretch 10:41–10:46
    expect(st.map((s) => [new Date(s.start).toISOString(), new Date(s.end).toISOString()])).toEqual([
      [new Date(ms('09:56')).toISOString(), new Date(ms('10:25')).toISOString()],
      [new Date(ms('10:41')).toISOString(), new Date(ms('10:46')).toISOString()],
    ]);
    expect(engagedMinutes(st)).toBe(29 + 5);
  });

  it("Claude's run counts only in part: a quarter of it after the stretch's last prompt, at most 15 min", () => {
    const short = engagedStretches([act('10:00', 'prompt', { runEndsAt: ms('10:21') })]);
    expect(engagedMinutes(short)).toBe(5 + 5); // 10:01 → 10:21 = 20 min of run, a quarter of it
    const long = engagedStretches([act('10:00', 'prompt', { runEndsAt: ms('13:00') })]);
    expect(engagedMinutes(long)).toBe(5 + 15);
    expect(long[0]!.agentMin).toBe(15);
    // never into the next stretch
    const next = engagedStretches([act('10:00', 'prompt', { runEndsAt: ms('13:00') }), act('10:22', 'slack', { accountKey: 'acme' })]);
    expect(next[0]!.end).toBeLessThanOrEqual(next[1]!.start);
    // inside a stretch the time between prompts counts in full (you were there: you prompted again)
    expect(engagedMinutes(engagedStretches([act('10:00', 'prompt', { runEndsAt: ms('10:12') }), act('10:13', 'prompt')]))).toBe(4 + 13 + 1);
  });

  it('a Slack message that names no account rides with the work around it; one that names an account claims its share', () => {
    const st = engagedStretches([act('10:00', 'prompt'), act('10:03', 'slack', { repoKey: null }), act('10:10', 'slack', { repoKey: null, accountKey: 'acme' }), act('10:14', 'prompt')]);
    expect(st).toHaveLength(1);
    const pieces = st[0]!.pieces.map((p) => [p.bucket, new Date(p.start).toISOString().slice(11, 16), new Date(p.end).toISOString().slice(11, 16)]);
    // cut at the midpoints between actions of different buckets: 10:05 (10:00 | 10:10) and 10:12 (10:10 | 10:14)
    expect(pieces).toEqual([
      ['repo:Projects-tools', '16:56', '17:05'],
      ['acct:acme', '17:05', '17:12'],
      ['repo:Projects-tools', '17:12', '17:15'],
    ]);
    expect(st[0]!.pieces[0]!.evidenceIds).toContain('slack-10:03');
    // Slack alone, no account: internal coordination
    expect(bucketOf({ kind: 'slack', accountKey: null, repoKey: null })).toBe('comms:unmapped');
    expect(bucketOf({ kind: 'drive', accountKey: null, repoKey: null })).toBe('docs:unmapped');
  });

  it('documents its parameters (the calibration on the live week)', () => {
    expect(DEFAULT_ENGAGED_PARAMS).toMatchObject({ gapMin: 15, agentShare: 0.25, agentMaxMin: 15, leadMin: { prompt: 4, slack: 2 }, tailMin: { prompt: 1, slack: 1 } });
  });
});

describe('engaged time in the plan: counted once against meetings, never overnight, no caps', () => {
  it('a meeting and solo work at the same moment count once (the meeting)', () => {
    const p = proposeActivity({
      now: NOW,
      cfg: INTERNAL,
      mappings: MAPPINGS,
      evidence: {
        ...EMPTY,
        calendar: [{ id: 'sync', summary: 'Team meeting', startsAt: iso('10:00'), endsAt: iso('11:00'), selfResponse: 'accepted', attendeeDomains: ['corp.example'] }],
        claude: [{ sessionId: 's1', repoKey: 'Projects-acme-demo', promptTimes: [iso('10:20'), iso('10:30'), iso('10:40'), iso('11:05')] }],
      },
    });
    const counted = p.blocks.filter((b) => b.countsAsHumanHours).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (let i = 1; i < counted.length; i++) expect(counted[i]!.startsAt >= counted[i - 1]!.endsAt).toBe(true);
    // the meeting's hour (the 10:20–10:40 prompts are its), then 11:01–11:06 for the 11:05 prompt
    expect(humanHours(p.blocks)).toBeCloseTo(1 + 5 / 60, 5);
    expect(p.entries.find((e) => e.dedupeKey.startsWith('cal|sync'))).toMatchObject({ internal: true, seTaskType: 'Admin', status: 'proposed' });
  });

  it('a stretch past midnight is two days of time', () => {
    const blocks = buildTimeBlocks({ ...EMPTY, claude: [{ sessionId: 's1', repoKey: 'Projects-acme-demo', promptTimes: [iso('23:50'), iso('00:04', '2026-11-11')] }] }, MAPPINGS, CFG);
    expect(blocks.filter((b) => b.countsAsHumanHours).map((b) => b.localDay)).toEqual(['2026-11-10', '2026-11-11']);
  });

  it('a long day of prompts keeps every hour (no daily cap): 14 h of engaged work is 14 h', () => {
    const prompts = Array.from({ length: 14 * 6 }, (_, i) => new Date(ms('08:00') + i * 10 * MIN).toISOString());
    const p = proposeActivity({ now: NOW, cfg: CFG, mappings: MAPPINGS, evidence: { ...EMPTY, claude: [{ sessionId: 's1', repoKey: 'Projects-acme-demo', promptTimes: prompts }] } });
    const rows = p.entries.filter((e) => e.origin === 'evidence');
    expect(rows.reduce((s, e) => s + e.durationHours, 0)).toBe(14);
    expect(rows.every((e) => e.whatOrg62Id === OPP_ACME)).toBe(true);
  });

  it('a day row split around meetings keeps its source: "Dismiss all from <repo>" covers its parts', () => {
    expect(dismissSourceOf('wb|2026-11-10|repo:Projects-tools#2', 'Projects-tools: internal asset build')).toEqual({ key: 'repo:Projects-tools', kind: 'repo', label: 'Projects-tools' });
    expect(dismissSourceOf('wb|2026-11-10|docs:unmapped#3', 'x')).toMatchObject({ key: 'docs:unmapped' });
  });

  it('a solo-work row goes around meetings: one row where one gap holds it, else as few parts as the gaps allow', () => {
    const day = '2026-11-10';
    const busy = [{ start: ms('09:00'), end: ms('12:00') }, { start: ms('13:00'), end: ms('17:00') }];
    expect(placeAcross(day, 1, ms('08:00'), busy, 'America/Denver')).toEqual({ pieces: [{ start: ms('08:00'), end: ms('09:00') }], unplaced: 0 });
    const split = placeAcross(day, 8, ms('08:00'), busy, 'America/Denver');
    // the largest gaps first: 17:00–24:00 (7 h) and then 08:00–09:00
    expect(split.pieces).toEqual([
      { start: ms('08:00'), end: ms('09:00') },
      { start: ms('17:00'), end: ms('00:00', '2026-11-11') },
    ]);
    expect(placeAcross(day, 30, ms('08:00'), busy, 'America/Denver').unplaced).toBeGreaterThan(0);
  });

  it('solo work never counts again what a row of yours already holds (yieldTo)', () => {
    const ev = { ...EMPTY, claude: [{ sessionId: 's1', repoKey: 'Projects-acme-demo', promptTimes: Array.from({ length: 7 }, (_, i) => new Date(ms('18:00') + i * 10 * MIN).toISOString()) }] };
    const free = proposeActivity({ now: NOW, cfg: CFG, mappings: MAPPINGS, evidence: ev });
    const held = proposeActivity({ now: NOW, cfg: CFG, mappings: MAPPINGS, evidence: ev, yieldTo: [{ startsAt: iso('18:00'), endsAt: iso('18:30') }] });
    expect(humanHours(free.blocks) - humanHours(held.blocks)).toBeCloseTo(0.5, 5);
  });
});

describe('internal meetings are logged (Org62 precedent), personal blocks are not meetings', () => {
  const plan = (calendar: EvidenceBundle['calendar'], extra: Partial<EvidenceBundle> = {}) => proposeActivity({ now: NOW, cfg: INTERNAL, mappings: MAPPINGS, evidence: { ...EMPTY, calendar, ...extra } });
  const m = (id: string, summary: string, from: string, to: string, p: Partial<EvidenceBundle['calendar'][number]> = {}) => ({ id, summary, startsAt: iso(from), endsAt: iso(to), selfResponse: 'accepted' as const, attendeeDomains: ['corp.example'], ...p });

  it('1:1s and syncs → Admin, training → Personal Development, V2MOM → V2MOM Initiatives; all internal, none excluded', () => {
    const p = plan([m('one', 'PERSON_1 / PERSON_2 weekly sync', '09:00', '09:30'), m('train', 'Data Cloud certification course', '10:00', '12:00'), m('v2', 'FY28 V2MOM planning', '13:00', '13:30'), m('ah', 'All hands', '14:00', '15:00')]);
    const by = Object.fromEntries(p.entries.map((e) => [e.dedupeKey.split('|')[1], e]));
    expect([by.one, by.train, by.v2, by.ah].map((e) => [e!.seTaskType, e!.status, e!.internal, e!.whatOrg62Id])).toEqual([
      ['Admin', 'proposed', true, null],
      ['Personal Development', 'proposed', true, null],
      ['V2MOM Initiatives', 'proposed', true, null],
      ['Admin', 'proposed', true, null],
    ]);
    expect(p.entries.some((e) => e.excludedReason === 'neither_type')).toBe(false);
  });

  it('a title that names customer work with no account matched asks for its opp', () => {
    const p = plan([m('prep', 'Internal: CUSTOMER_X QBR prep', '09:00', '10:00')]);
    expect(p.entries[0]).toMatchObject({ status: 'needs_input', seTaskType: 'Dry Run' });
    expect(p.entries[0]!.internal).toBeFalsy();
    expect(p.entries[0]!.flags.some((f) => /^NEEDS WhatId: it names customer work/.test(f))).toBe(true);
  });

  it('declined, cancelled and personal blocks are never logged; work in a hold counts from my own actions', () => {
    const p = plan(
      [
        m('dec', 'Team meeting', '08:00', '09:00', { selfResponse: 'declined' }),
        m('can', 'Team meeting', '09:00', '10:00', { deleted: true }),
        m('lunch', 'Lunch', '12:00', '13:00'),
        m('hold', 'BLOCK finish the deck', '14:00', '16:00', { organizerSelf: true, attendeeDomains: [] }),
      ],
      { claude: [{ sessionId: 's1', repoKey: 'Projects-acme-demo', promptTimes: [iso('14:30'), iso('14:40')] }] },
    );
    expect(p.entries.filter((e) => e.origin === 'calendar')).toEqual([]);
    expect(p.rejected.filter((r) => r.reason === 'personal').map((r) => r.dedupeKey.split('|')[1]).sort()).toEqual(['hold', 'lunch']);
    // the hold claims nothing: the prompts inside it are 14:26–14:41 of solo work
    expect(humanHours(p.blocks)).toBeCloseTo(15 / 60, 5);
  });
});

describe('travel: always Travel, 2 h before a flight and 1 h after (Settings ▸ Time)', () => {
  const flight = { id: 'f1', summary: 'Flight to Atlanta (UA 100)', startsAt: iso('10:00'), endsAt: iso('13:00'), selfResponse: 'accepted' as const, organizerSelf: true, attendeeDomains: [], location: 'Denver DEN' };

  it('a flight with no customer trip is internal Travel with no opp, not excluded', () => {
    const p = proposeActivity({ now: NOW, cfg: INTERNAL, mappings: MAPPINGS, evidence: { ...EMPTY, calendar: [flight] } });
    const t = p.entries.filter((e) => e.seTaskType === 'Travel');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ internal: true, whatOrg62Id: null, status: 'proposed', startsAt: iso('08:00'), endsAt: iso('14:00'), durationHours: 6, remote: false });
  });

  it('the buffers: the two sides win; a legacy symmetric value the user changed applies to both; the old default 60 reads as unset', () => {
    expect(airportBuffers(undefined)).toEqual({ beforeMin: 120, afterMin: 60 });
    expect(airportBuffers({ airportBufferMin: 60 })).toEqual({ beforeMin: 120, afterMin: 60 });
    expect(airportBuffers({ airportBufferMin: 90 })).toEqual({ beforeMin: 90, afterMin: 90 });
    expect(airportBuffers({ airportBufferMin: 90, airportBufferBeforeMin: 150, airportBufferAfterMin: 30 })).toEqual({ beforeMin: 150, afterMin: 30 });
    const p = proposeActivity({ now: NOW, cfg: { ...INTERNAL, onsite: { enabled: true, hours: { start: '08:00', end: '17:00' }, airportBufferBeforeMin: 30, airportBufferAfterMin: 0, dinnersCustomerFacing: true } }, mappings: MAPPINGS, evidence: { ...EMPTY, calendar: [flight] } });
    expect(p.entries.find((e) => e.seTaskType === 'Travel')).toMatchObject({ startsAt: iso('09:30'), endsAt: iso('13:00'), durationHours: 3.5 });
  });

  it('the settings contract keeps the old field readable and takes the two sides as optional', () => {
    expect(TimeSettings.parse(DEFAULT_TIME_SETTINGS)).not.toHaveProperty('airportBufferBeforeMin');
    expect(TimeSettings.parse({ ...DEFAULT_TIME_SETTINGS, airportBufferBeforeMin: 120, airportBufferAfterMin: 60 })).toMatchObject({ airportBufferMin: 60, airportBufferBeforeMin: 120, airportBufferAfterMin: 60 });
    expect(TimeSettings.safeParse({ ...DEFAULT_TIME_SETTINGS, airportBufferBeforeMin: -5 }).success).toBe(false);
  });
});

describe('the re-derive (dry run first) and its update-candidate seam', () => {
  const row = (k: string, h: number, status: string, p: Partial<RederiveRow> = {}): RederiveRow & { owned?: boolean } => ({ dedupeKey: k, startsAt: '2026-11-10T17:00:00Z', durationHours: h, status, seTaskType: 'Asset Creation', whatOrg62Id: null, subject: k, ...p });
  const owned = (r: RederiveRow) => (r as { owned?: boolean }).owned === true;

  it('rows added, changed and removed; the user’s rows stand', () => {
    const existing = [{ ...row('wb|a', 0.25, 'proposed'), owned: true }, { ...row('wb|gone', 1, 'needs_input'), owned: true }, { ...row('wb|mine', 2, 'approved'), owned: false }];
    const want = [row('wb|a', 1.5, 'proposed'), row('wb|new', 0.5, 'proposed'), row('wb|mine', 3, 'proposed')];
    const d = diffRows(existing, want, owned);
    expect(d.added.map((r) => r.dedupeKey)).toEqual(['wb|new']);
    expect(d.changed.map((c) => [c.to.dedupeKey, c.fields])).toEqual([['wb|a', ['hours']]]);
    expect(d.removed.map((r) => r.dedupeKey)).toEqual(['wb|gone']);
    // after: the user's 2 h row as it is, the engine's rows as it wants them
    expect(rowsAfter(existing, want, owned).map((r) => [r.dedupeKey, r.durationHours])).toEqual([['wb|mine', 2], ['wb|a', 1.5], ['wb|new', 0.5]]);
  });

  it('a row in Org62 whose hours would change is an update candidate (never edited); approved ones are held; an edited Duration is yours', () => {
    const fixed = [
      { rowId: 'r1', dedupeKey: 'wb|2026-11-10|repo:x', status: 'verified', durationHours: 0.25, org62EventId: '00UXX0000000E01AAA' },
      { rowId: 'r2', dedupeKey: 'wb|2026-11-11|repo:x', status: 'approved', durationHours: 1, org62EventId: null },
      { rowId: 'r3', dedupeKey: 'wb|2026-11-12|repo:x', status: 'verified', durationHours: 1, org62EventId: '00UXX0000000E03AAA', lockedFields: ['duration_hours'] },
      { rowId: 'r4', dedupeKey: 'wb|2026-11-13|repo:x', status: 'verified', durationHours: 2, org62EventId: '00UXX0000000E04AAA' },
    ];
    const shadowed = [
      { dedupeKey: 'wb|2026-11-10|repo:x', baseKey: 'wb|2026-11-10|repo:x', durationHours: 2, reason: 'engaged', evidence: 'engaged 3 h (40 prompts)' },
      { dedupeKey: 'wb|2026-11-10|repo:x#2', baseKey: 'wb|2026-11-10|repo:x', durationHours: 1, reason: 'engaged', evidence: '' },
      { dedupeKey: 'wb|2026-11-11|repo:x', baseKey: 'wb|2026-11-11|repo:x', durationHours: 2, reason: 'engaged', evidence: '' },
      { dedupeKey: 'wb|2026-11-12|repo:x', baseKey: 'wb|2026-11-12|repo:x', durationHours: 4, reason: 'engaged', evidence: '' },
      { dedupeKey: 'wb|2026-11-13|repo:x', baseKey: 'wb|2026-11-13|repo:x', durationHours: 2, reason: 'engaged', evidence: '' },
    ];
    const { candidates, held } = durationUpdateCandidates(fixed, shadowed);
    expect(candidates).toEqual([{ activityEntryId: 'r1', org62EventId: '00UXX0000000E01AAA', field: 'Duration__c', from: 0.25, to: 3, reason: 're-derived: engaged 3 h (40 prompts)' }]);
    expect(held.map((h) => [h.activityEntryId, h.from, h.to])).toEqual([['r2', 1, 2]]);
  });

  it('planWeek: the user’s solo-work row stands for its day; the engine’s hours for it are shadowed, its continuations never written', () => {
    const tz = 'America/Denver';
    const prompts = Array.from({ length: 30 }, (_, i) => new Date(ms('08:00') + i * 10 * MIN).toISOString());
    const fixed: FixedEntry = {
      rowId: 'row-1',
      dedupeKey: 'wb|2026-11-10|acct:acme',
      subject: 'ACME: off-calendar build/prep',
      startsAt: iso('20:00'),
      endsAt: iso('20:15'),
      durationHours: 0.25,
      seTaskType: 'Solution Creation',
      whatOrg62Id: OPP_ACME,
      meetingType: null,
      status: 'verified',
      operation: 'create',
      targetOrg62EventId: null,
    };
    const input: WeekInput = {
      now: NOW,
      from: '2026-11-09T07:00:00.000Z',
      to: '2026-11-16T07:00:00.000Z',
      cfg: { ...CFG, timezone: tz },
      mappings: MAPPINGS,
      // a meeting 10:00–11:00 splits the day's 5 h of work into two parts
      events: [{ rowId: 'ev1', calendarId: 'primary', externalEventId: 'm1', title: 'ACME call', startsAt: iso('10:00'), endsAt: iso('11:00'), isAllDay: false, eventType: 'default', cancelled: false, myResponse: 'accepted', iAmOrganizer: false, attendance: 'attended', attendeeDomains: ['acme.example'], recurring: false, hasNotes: false, url: null, accountId: null, oppOrg62Id: null }],
      sessions: [{ rowId: 's1', title: 'ACME demo build', repoKey: 'Projects-acme-demo', startedAt: prompts[0]!, lastActivityAt: prompts[prompts.length - 1]!, lastHumanPromptAt: prompts[prompts.length - 1]!, turns: prompts.map((at) => ({ at, runEndsAt: at })) }],
      drive: [],
      slack: [],
      org62: [],
      fixed: [fixed],
      fixedBlocks: [],
      names: () => null,
    };
    const p = planWeek(input);
    expect(p.entries.filter((e) => e.dedupeKey.startsWith('wb|2026-11-10|acct:acme#'))).toEqual([]);
    expect(p.shadowed.length).toBeGreaterThanOrEqual(1);
    expect(p.shadowed.every((s) => s.baseKey === 'wb|2026-11-10|acct:acme')).toBe(true);
    // 07:56–12:51 of engaged time less the meeting's hour: 3 h 55 → 4 h
    const hours = p.shadowed.reduce((s, x) => s + x.durationHours, 0);
    expect(hours).toBe(4);
    const { candidates } = durationUpdateCandidates([{ rowId: 'row-1', dedupeKey: fixed.dedupeKey, status: 'verified', durationHours: 0.25, org62EventId: '00UXX0000000E09AAA' }], p.shadowed);
    expect(candidates).toEqual([expect.objectContaining({ activityEntryId: 'row-1', org62EventId: '00UXX0000000E09AAA', from: 0.25, to: hours })]);
  });
});

describe('the projections read what the scanner stores', () => {
  it('humanTurns: [promptAt, turnEndAt] pairs, malformed entries skipped, an end before its prompt clamped', () => {
    expect(humanTurnsOf({ humanTurns: [['2026-11-10T17:00:00Z', '2026-11-10T17:12:00Z'], ['bad'], ['2026-11-10T18:00:00Z', '2026-11-10T17:00:00Z'], 'x'] })).toEqual([
      { at: '2026-11-10T17:00:00Z', runEndsAt: '2026-11-10T17:12:00Z' },
      { at: '2026-11-10T18:00:00Z', runEndsAt: '2026-11-10T18:00:00Z' },
    ]);
    expect(humanTurnsOf({})).toEqual([]);
  });

  it('an email I sent: the recipients’ domains, never their addresses', () => {
    expect(emailDomains({ to: ['PERSON_1 <person1@acme.example>', 'person2@corp.example'], cc: 'x@Globex.Example' })).toEqual(['acme.example', 'corp.example', 'globex.example']);
  });
});
