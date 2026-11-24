/**
 * D-66: the Org62 Description reads like a teammate's note. Through the note engine (template, hygiene, the use
 * case, the cheap model's request and answer), the week projection (planWeek: every row gets a note, the meeting
 * notes' summary wins where there is one), the work order (the note, then the CC# key at the END; the read-back still
 * finds the row) and the mock DataSource (the seed's notes, your edit locked, the canvas carries it). Placeholders
 * only (no customer names or ids).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { routes, Seed, type RouteKey, type RouteOutput } from '@/contract';
import { cleanNote, NOTE_MAX, noteSummaryKey, noteSummaryRequest, parseNoteSummary, pickUseCase, templateNote, topicOf, withCcKey, type NoteFacts } from '@/engines/activity/note';
import { DEFAULT_EVIDENCE_CONFIG, type ActivityConfig } from '@/engines/activity/types';
import { parseWorkOrder } from '@/engines/activity/canvas-parse';
import { eventRow, renderWorkOrder } from '@/engines/activity/slackbot';
import { planWeek, type WeekEvent, type WeekInput } from '@/projections/activity';
import { Matcher, type MatchOpp } from '@/projections/matching';
import { MockDataSource } from '@/server/datasource/mock';
import { patchedEntry } from '@/server/time/dismiss';

import { ME, RULES, TZ } from '../projections/fixtures';

const meeting = (p: Partial<NoteFacts> = {}): NoteFacts => ({ kind: 'meeting', subject: 'ACCOUNT_1 <> Salesforce | Data model review', taskType: 'Customer Discovery', customer: 'ACCOUNT_1', externalDomains: ['account1.example'], ...p });

describe('the template (deterministic, every row)', () => {
  it('a customer meeting: what was done, with whom (the team, never a person), the topic, the use case and the next step', () => {
    const n = templateNote(meeting({ useCase: 'Unified customer profile', nextStep: 'send the POC plan to their data team.' }));
    expect(n).toBe('Discovery session with the ACCOUNT_1 team on Data model review (use case: Unified customer profile). Next step: Send the POC plan to their data team.');
    expect(n.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(n.split(/(?<=\.)\s/)).toHaveLength(2); // two sentences
  });

  it('drops a topic that says nothing more than the lead, and names attendee domains when the customer is unknown', () => {
    expect(templateNote(meeting({ subject: 'ACCOUNT_1 | Discovery call' }))).toBe('Discovery session with the ACCOUNT_1 team.');
    expect(templateNote(meeting({ customer: null, subject: 'Intro call', taskType: 'Customer Presentation', externalDomains: ['partner.example', 'account1.example'] }))).toBe('Presentation with attendees from partner.example and account1.example.');
    expect(topicOf('Weekly sync - ACCOUNT_2 Phase 2 scoping 11/12', ['ACCOUNT_2'], 'Account planning')).toBe('Phase 2 scoping');
  });

  it('an internal prep meeting on an opp, off-calendar work (sessions, docs, Slack), onsite and travel', () => {
    expect(templateNote(meeting({ externalDomains: [], taskType: 'Account Planning', subject: 'ACCOUNT_1 Q4 plan' }))).toBe('Internal account planning for ACCOUNT_1 on Q4 plan.');
    const work = templateNote({ kind: 'work', subject: 'ACCOUNT_1: off-calendar build/prep', taskType: 'Solution Creation', customer: 'ACCOUNT_1', useCase: 'Service agent', sessions: ['POC data model'], docs: ['ACCOUNT_1 POC plan'], channels: ['acct1-ext'] });
    expect(work).toBe("Solution build for ACCOUNT_1 (use case: Service agent): Claude Code work on 'POC data model'; edited 'ACCOUNT_1 POC plan' in Drive; worked with the team in #acct1-ext.");
    expect(templateNote({ kind: 'onsite', subject: 'Onsite: ACCOUNT_3 (CITY_1)', taskType: 'Workshop', customer: 'ACCOUNT_3', city: 'CITY_1' })).toBe('Onsite day at ACCOUNT_3 in CITY_1: workshop with the ACCOUNT_3 team.');
    expect(templateNote({ kind: 'travel', subject: 'Flight to CITY_1', taskType: 'Travel', customer: 'ACCOUNT_3' })).toBe('Travel for the ACCOUNT_3 onsite: Flight to CITY_1.');
  });

  it('D-64 internal rows get one too, with no customer', () => {
    expect(templateNote({ kind: 'work', subject: 'demo-kit: internal asset build', taskType: 'Asset Creation', internal: true, repos: ['demo-kit'], sessions: ['Demo kit portal build'] })).toBe("Internal asset build in demo-kit: Claude Code work on 'Demo kit portal build'.");
    expect(templateNote({ kind: 'meeting', subject: 'Certification study group', taskType: 'Personal Development', internal: true })).toBe('Learning session: Certification study group (internal, no customer).');
  });

  it('at most 300 characters: a next step that does not fit is dropped, never the first sentence cut', () => {
    const long = templateNote(meeting({ sessions: [], useCase: 'U'.repeat(150), nextStep: 'x '.repeat(100) }));
    expect(long.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(long).not.toContain('Next step');
    const huge = templateNote({ kind: 'work', subject: 's', taskType: 'Solution Creation', customer: 'ACCOUNT_1', sessions: ['S'.repeat(200), 'T'.repeat(200)], docs: ['D'.repeat(200)] });
    expect(huge.length).toBeLessThanOrEqual(NOTE_MAX);
  });

  it('cleans what it writes: credentials redacted; emails, phone numbers and links removed; one line, no table pipes', () => {
    const n = cleanNote('Shared token xoxb-123456789012-abcdefghijkl with ops@account1.example (+1 303-555-0100)\nsee https://docs.example/x?key=1 | done');
    expect(n).not.toMatch(/xoxb-|@account1|303-555|https?:|\||\n/);
    expect(n).toContain('[redacted]');
  });
});

describe('the use case (VDP mirror)', () => {
  it('the only one; the one the row names; the one High-priority one; otherwise none (never a guess)', () => {
    expect(pickUseCase([{ title: 'Unified customer profile' }], 'anything')).toBe('Unified customer profile');
    const two = [
      { title: 'Unified customer profile', priority: '2 - Medium' },
      { title: 'Service agent deflection', priority: '2 - Medium' },
    ];
    expect(pickUseCase(two, 'ACCOUNT_1 | deflection workshop')).toBe('Service agent deflection');
    expect(pickUseCase(two, 'ACCOUNT_1 | weekly')).toBeNull();
    expect(pickUseCase([{ ...two[0]!, priority: '3 - High' }, two[1]!], 'ACCOUNT_1 | weekly')).toBe('Unified customer profile');
    expect(pickUseCase([{ title: null }, { title: '  ' }], 'x')).toBeNull();
  });
});

describe("the cheap model's note (meeting notes only)", () => {
  const notes = 'Summary: The ACCOUNT_1 data team walked through their profile sources. Next steps: SE to send the POC plan.';

  it('the request names the facts and the notes, redacted, and asks for roles, not names', () => {
    const r = noteSummaryRequest({ facts: meeting({ useCase: 'Unified customer profile' }), notes: `${notes} token xoxb-123456789012-abcdefghijkl` });
    expect(r.system).toMatch(/1 or 2 plain sentences/);
    expect(r.system).toMatch(/never a person’s name, email address or phone number/);
    expect(r.user).toContain('Use case: Unified customer profile');
    expect(r.user).toContain('Attendee domains: account1.example');
    expect(r.user).not.toContain('xoxb-');
  });

  it('a usable answer becomes the note (cleaned, at most 300); SKIP, a refusal or nothing: null (the template stays)', () => {
    expect(parseNoteSummary('"Discovery session with the ACCOUNT_1 data team on their profile sources. Next step: send the POC plan."')).toBe('Discovery session with the ACCOUNT_1 data team on their profile sources. Next step: send the POC plan.');
    expect(parseNoteSummary('SKIP')).toBeNull();
    expect(parseNoteSummary("I can't summarize these notes.")).toBeNull();
    expect(parseNoteSummary('')).toBeNull();
    expect(parseNoteSummary(null)).toBeNull();
    expect(parseNoteSummary(`Workshop with the team. ${'More detail here. '.repeat(30)}`)!.length).toBeLessThanOrEqual(NOTE_MAX);
  });

  it('the cache key: the same notes and facts never cost twice; new notes or a new use case make a new one', () => {
    const k = noteSummaryKey({ facts: meeting(), notes });
    expect(noteSummaryKey({ facts: meeting(), notes })).toBe(k);
    expect(noteSummaryKey({ facts: meeting(), notes: `${notes} More.` })).not.toBe(k);
    expect(noteSummaryKey({ facts: meeting({ useCase: 'X' }), notes })).not.toBe(k);
    expect(k).toMatch(/^activity-note@1:[0-9a-f]{8}$/);
  });
});

describe('the CC# key stays at the end, exact (what the read-back joins on)', () => {
  it('withCcKey: the note, then the key; never two keys', () => {
    expect(withCcKey('Workshop with the ACCOUNT_1 team.', 'r1')).toBe('Workshop with the ACCOUNT_1 team. · CC#r1');
    expect(withCcKey('Workshop. · CC#r1', 'r1')).toBe('Workshop. · CC#r1');
    expect(withCcKey('', 'r1')).toBe('CC#r1');
  });

  it('every ADD row of a work order ends its Description cell with its own exact CC#<uuid> token', () => {
    const ev = (id: string, note: string) => eventRow({ id, subject: 'ACCOUNT_1 | Discovery', start: '2026-11-04T16:00:00.000Z', end: '2026-11-04T17:00:00.000Z', durationH: 1, taskType: 'Customer Discovery', whatOrg62Id: '006XX0000000OPPAAA', origin: 'calendar', note });
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const md = renderWorkOrder({ ownerName: 'PERSON_ME', ownerOrg62Id: '005XX0000000OWNAAA', recordTypeId: '012XX0000000RTYAAA', generatedAt: '2026-11-10T20:00:00.000Z', events: [ev(ids[0]!, 'Discovery session with the ACCOUNT_1 team.'), ev(ids[1]!, 'Workshop.')], updates: [], sourceLabel: 'Command Center' });
    const cells = parseWorkOrder(md).adds.map((r) => (r.kind === 'event' ? r.description : null));
    expect(cells).toEqual([`Discovery session with the ACCOUNT_1 team. · CC#${ids[0]}`, `Workshop. · CC#${ids[1]}`]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// the week projection
// ---------------------------------------------------------------------------------------------------------------

const ACCT = '001XX0000000N01AAA';
const OPP = '006XX0000000N01AAA';
const accounts = [{ id: 'a-acct1', name: 'ACCOUNT_1 Corporation', org62AccountId: ACCT, aliases: [] }];
const opps: MatchOpp[] = [{ id: 'o-acct1', accountId: 'a-acct1', org62OpportunityId: OPP, name: 'ACCOUNT_1 - Expansion', isClosed: false, onMyTeam: true, myDc: true }];
const matcher = new Matcher(accounts, opps, RULES);
const cfg: ActivityConfig = { timezone: TZ, ownerId: ME.org62UserId!, recordTypeId: '', lightningHost: '', workday: { start: '07:30', end: '17:30' }, hoursTarget: 250, liveFrom: '1970-01-01', evidence: DEFAULT_EVIDENCE_CONFIG, quarters: [], internalActivity: true };
const ev = (id: string, p: Partial<WeekEvent> = {}): WeekEvent => ({
  rowId: `row-${id}`,
  calendarId: 'primary',
  externalEventId: id,
  title: 'ACCOUNT_1 <> Salesforce | Data model review',
  startsAt: '2026-11-03T17:00:00.000Z',
  endsAt: '2026-11-03T18:00:00.000Z',
  isAllDay: false,
  eventType: 'default',
  cancelled: false,
  myResponse: 'accepted',
  iAmOrganizer: false,
  attendance: 'attended',
  attendeeDomains: ['account1.example'],
  recurring: false,
  hasNotes: false,
  url: null,
  accountId: 'a-acct1',
  oppOrg62Id: OPP,
  ...p,
});
const input = (p: Partial<WeekInput> = {}): WeekInput => ({
  now: '2026-11-07T18:00:00.000Z',
  from: '2026-11-02T07:00:00.000Z',
  to: '2026-11-09T07:00:00.000Z',
  cfg,
  mappings: matcher.mappings({ internalDomains: RULES.internal, partnerDomains: RULES.partner, ignoreDomains: RULES.ignore }, { repos: {} }),
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
const keyOf = (e: WeekEvent) => `cal|${e.calendarId}|${e.externalEventId}|${e.startsAt}`;

describe('the week projection: every row carries its note', () => {
  it('a meeting: the template over its evidence, with the VDP use case and the notes’ next step (basis template)', () => {
    const m = ev('m1', { hasNotes: true });
    const p = planWeek(input({ events: [m], meetingNotes: (id) => (id === m.rowId ? { summary: null, nextStep: 'Send the POC plan' } : null), useCases: (opp) => (opp === OPP ? [{ title: 'Unified customer profile' }] : []) }));
    const row = p.entries.find((x) => x.dedupeKey === keyOf(m))!;
    expect(row.logNoteBasis).toBe('template');
    expect(row.logNote).toMatch(/^.+ with the ACCOUNT_1 team on Data model review \(use case: Unified customer profile\)\. Next step: Send the POC plan\.$/);
    expect(row.logNote!.length).toBeLessThanOrEqual(NOTE_MAX);
  });

  it("where the cheap model made one from the meeting notes, that note wins (basis summary); a meeting with none keeps the template", () => {
    const a = ev('a', { hasNotes: true });
    const b = ev('b', { startsAt: '2026-11-04T17:00:00.000Z', endsAt: '2026-11-04T18:00:00.000Z' });
    const summary = 'Discovery session with the ACCOUNT_1 data team on their profile sources. Next step: Send the POC plan.';
    const p = planWeek(input({ events: [a, b], meetingNotes: (id) => (id === a.rowId ? { summary, nextStep: null } : null) }));
    expect(p.entries.find((x) => x.dedupeKey === keyOf(a))).toMatchObject({ logNote: summary, logNoteBasis: 'summary' });
    expect(p.entries.find((x) => x.dedupeKey === keyOf(b))).toMatchObject({ logNoteBasis: 'template' });
  });

  it('off-calendar work names its sessions; D-64 internal rows get a note; Org62’s own rows have none', () => {
    const s = { rowId: 's-1', title: 'Demo kit portal build', repoKey: 'demo-kit', startedAt: '2026-11-03T22:00:00.000Z', lastActivityAt: '2026-11-03T23:35:00.000Z', lastHumanPromptAt: '2026-11-03T23:30:00.000Z' };
    const o62 = { rowId: 'o62-1', org62EventId: '00UXX0000000N01AAA', recordTypeName: 'Solutions Event', subject: 'ACCOUNT_1 - readout', startsAt: '2026-11-05T17:00:00.000Z', endsAt: '2026-11-05T18:00:00.000Z', durationField: 1, seTaskTypeName: 'Customer Presentation', meetingTypeName: null, whatOrg62Id: OPP, ownerId: ME.org62UserId, whatName: null };
    const p = planWeek(input({ sessions: [s], org62: [o62] }));
    const work = p.entries.find((x) => x.dedupeKey.startsWith('wb|'))!;
    expect(work).toMatchObject({ internal: true, logNoteBasis: 'template' });
    expect(work.logNote).toBe("Internal asset build in demo-kit: Claude Code work on 'Demo kit portal build'.");
    expect(p.entries.find((x) => x.dedupeKey.startsWith('org62|'))).toMatchObject({ logNote: null, logNoteBasis: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// your edit, and the canvas (the mock DataSource; the db shares patchedEntry)
// ---------------------------------------------------------------------------------------------------------------

describe('your edit is locked, and the canvas carries it (mock DataSource)', () => {
  const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
  const fast = { enrichMs: 1e8, stepMs: 5, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 };
  const made: MockDataSource[] = [];
  const fresh = (edit: (s: Seed) => void = () => {}) => {
    const copy = structuredClone(seed);
    edit(copy);
    const ds = new MockDataSource({ seed: copy, delays: fast, autoplay: false, clockMode: 'seed' });
    made.push(ds);
    return ds;
  };
  afterEach(() => {
    for (const d of made.splice(0)) d.dispose();
  });
  async function call<K extends RouteKey>(ds: MockDataSource, key: K, inp: Record<string, unknown>): Promise<RouteOutput<K>> {
    const def = routes[key] as { body?: { parse: (v: unknown) => unknown }; response: (typeof routes)[K]['response'] };
    const out = await (ds[key as keyof MockDataSource] as (i: unknown) => Promise<unknown>).call(ds, { ...(def.body ? { body: def.body.parse(inp.body ?? {}) } : {}), ...(inp.params ? { params: inp.params } : {}) });
    const r = def.response.safeParse(out);
    if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
    return r.data as RouteOutput<K>;
  }
  const canvasOf = (ds: MockDataSource, draftId: string) => (ds.store.get('drafts', draftId)!.destination as unknown as { input: { markdown: string } }).input.markdown;

  it('the seed: every row carries a note (placeholders only); one is the meeting notes’ summary', () => {
    const rows = seed.activity;
    expect(rows.every((r) => !!r.logNote && r.logNote.length <= NOTE_MAX)).toBe(true);
    expect(rows.filter((r) => r.logNoteBasis === 'summary').map((r) => r.id)).toEqual(['ac_mon_acme']);
    expect(rows.find((r) => r.id === 'ac_tue_repo')!.logNote).toMatch(/^Internal asset build/);
  });

  it('PATCH logNote: yours (locked, no app basis); the canvas logs it, then the CC# key; emptied: the key alone', async () => {
    const ds = fresh();
    const row = ds.store.get('activity', 'ac_tue_sow')!; // approved, ended
    expect(row.status).toBe('approved');
    const note = 'Priced the SOW with the Globex procurement team; agreed the phase 1 scope. Next step: Send v4 by Friday.';
    const r = await call(ds, 'patchActivity', { params: { id: row.id }, body: { ifVersion: row.version, patch: { logNote: `  ${note}\n` } } });
    expect(r.entity).toMatchObject({ logNote: note, logNoteBasis: null });
    expect(r.entity.userLockedFields).toContain('logNote');
    const b = await call(ds, 'stageLogBatch', { body: {} });
    const line = canvasOf(ds, b.entity.draftIds[0]!).split('\n').find((l) => l.includes('CC#ac_tue_sow'))!;
    expect(line).toMatch(new RegExp(`\\|${note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · CC#ac_tue_sow\\|$`));

    const emptied = patchedEntry(r.entity, { logNote: '' }, null).next;
    expect(eventRow({ id: emptied.id, subject: emptied.description, start: emptied.start, end: emptied.end, durationH: emptied.durationH, taskType: 'Proposal', whatOrg62Id: '006XX0000000OPPAAA', origin: 'evidence', note: emptied.logNote }).description).toBe('CC#ac_tue_sow');
  });

  it('a row with no note stored still logs a human note (made from its fields), never the old log key', async () => {
    const ds = fresh((s) => Object.assign(s.activity.find((r) => r.id === 'ac_tue_sow')!, { logNote: null, logNoteBasis: null }));
    const b = await call(ds, 'stageLogBatch', { body: {} });
    const line = canvasOf(ds, b.entity.draftIds[0]!).split('\n').find((l) => l.includes('CC#ac_tue_sow'))!;
    expect(line).toMatch(/\|Proposal for Globex\. · CC#ac_tue_sow\|$/);
    expect(line).not.toMatch(/evidence:|\| ?calendar \d{4}/);
  });
});
