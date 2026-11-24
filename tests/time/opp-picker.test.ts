/**
 * The Time row's opportunity picker (placeholders only): the ranking for a row (src/lib/opp-options.ts), the
 * type-to-filter order, the combobox keyboard (src/ui/combobox-model.ts), the Org62 search query, and the mock
 * DataSource's three routes (ranked list, placeholder search, a pick that adds the opp and undoes cleanly).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OppOptions, Org62OppSearch, type Account, type ActivityEntry, type CalendarEvent, type Opportunity, type Person } from '@/contract';
import { buildOppOptions, filterOppOptions, matchScore, tierOf } from '@/lib/opp-options';
import { MOCK_ORG62_OPPS, mockOrg62IdFor } from '@/mock/org62-opps';
import { buildOrg62OppById, buildOrg62OppSearch, Org62LookupError, org62OppHit, parseOrg62Rows } from '@/server/chat/org62';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';
import { comboKey, comboTriggerKey } from '@/ui/combobox-model';

const acct = (id: string, name: string): Account => ({ id, name, industry: null, dcStatus: 'none', vdpStatus: 'none', hoursQtd: 0, team: [], org62Url: null, notes: '' });
const opp = (id: string, accountId: string, name: string, o: Partial<Opportunity> = {}): Opportunity => ({
  id,
  accountId,
  name,
  stage: 'Discovery',
  amount: null,
  closeDate: null,
  isOpen: true,
  isMine: false,
  dcAssigned: false,
  vdpLinked: false,
  hoursQtd: 0,
  nextStep: null,
  nextStepRead: true,
  products: [],
  owner: null,
  org62Url: null,
  myDc: null,
  forecastCategory: null,
  isWon: false,
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...o,
});
const row = (id: string, o: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id,
  version: 1,
  date: '2026-11-10',
  start: '2026-11-10T16:00:00.000Z',
  end: '2026-11-10T17:00:00.000Z',
  durationH: 1,
  taskType: 'Demo',
  oppId: null,
  oppName: null,
  accountName: null,
  meetingType: 'CF',
  description: 'Row',
  status: 'proposed',
  confidence: 'likely',
  sources: [],
  userLockedFields: [],
  issues: [],
  updatedAt: '2026-11-10T17:00:00.000Z',
  fromOrg62: false,
  excludedReason: null,
  loggedAt: null,
  verifiedAt: null,
  internal: false,
  dismissSource: null,
  logNote: null,
  logNoteBasis: null,
  why: null,
  suggestion: null,
  ...o,
});
const event = (id: string, o: Partial<CalendarEvent>): CalendarEvent =>
  ({ id, title: 'Meeting', start: '2026-11-10T16:00:00.000Z', end: '2026-11-10T17:00:00.000Z', attendance: 'attended', isCustomerFacing: true, accountId: null, oppId: null, attendees: [], location: null, meetingUrl: null, prep: null, takeaways: null, source: { kind: 'calendar', label: 'Google Calendar', externalId: `g_${id}` }, ...o }) as CalendarEvent;

// ACME is the row's account; the meeting is on a Globex opp; an attendee works at Initech; Hooli was used lately
const accounts = [acct('a_acme', 'ACME Corp'), acct('a_globex', 'Globex'), acct('a_initech', 'Initech'), acct('a_hooli', 'Hooli'), acct('a_other', 'Other Co')];
const opps = [
  opp('o_zeta', 'a_other', 'Other · Zeta'),
  opp('o_alpha', 'a_other', 'Other · Alpha'),
  opp('o_acme_late', 'a_acme', 'ACME · Agentforce Service', { closeDate: '2027-01-30' }),
  opp('o_acme_soon', 'a_acme', 'ACME · Headless Phase 2', { closeDate: '2026-12-15', isMine: true }),
  opp('o_acme_won', 'a_acme', 'ACME · Renewal FY26', { isOpen: false, closeDate: '2026-09-30', stage: 'Closed Won' }),
  opp('o_acme_ancient', 'a_acme', 'ACME · Pilot FY23', { isOpen: false, closeDate: '2023-01-31', stage: 'Closed Won' }),
  opp('o_globex', 'a_globex', 'Globex · Data 360 Expansion'),
  opp('o_globex_2', 'a_globex', 'Globex · Renewal'),
  opp('o_initech', 'a_initech', 'Initech · D360 Pilot'),
  opp('o_hooli', 'a_hooli', 'Hooli · Nimbus Context Engine'),
];
const people: Person[] = [{ id: 'p_lee', name: 'Lee Placeholder', accountId: 'a_initech' }];
const events = [event('ev1', { oppId: 'o_globex', accountId: 'a_globex', attendees: [{ id: 'p_lee', name: 'Lee Placeholder' }] })];
const entry = row('r1', { accountName: 'ACME Corp', sources: [{ kind: 'calendar', label: 'Google Calendar', externalId: 'g_ev1' }] });
const activity = [
  entry,
  row('r_used', { date: '2026-11-06', oppId: 'o_hooli', status: 'approved' }),
  row('r_old', { date: '2026-09-01', oppId: 'o_alpha', status: 'logged' }), // older than 30 days: not "recent"
  row('r_engine', { date: '2026-11-09', oppId: 'o_zeta', status: 'proposed' }), // the engine's guess, not your use
];
const input = { entry, opps, accounts, events, people, assets: [], runs: [], workItems: [], activity, today: '2026-11-11' };

describe('opp options: ranked for the row', () => {
  it('the row\'s account first, then its evidence\'s opp, an account its evidence names, used lately, then A–Z', () => {
    const r = OppOptions.parse(buildOppOptions(input));
    expect(r.entryId).toBe('r1');
    expect(r.opps.map((o) => o.id)).toEqual([
      'o_acme_soon', // account, open, nearest close
      'o_acme_late',
      'o_acme_won', // account, closed this year: after the open ones
      'o_globex', // the meeting is on it
      'o_globex_2', // the meeting's account
      'o_initech', // an attendee's account
      'o_hooli', // used lately
      'o_alpha',
      'o_zeta',
    ]);
    const why = Object.fromEntries(r.opps.map((o) => [o.id, o.why]));
    expect(why).toMatchObject({ o_acme_soon: ['account'], o_globex: ['evidence'], o_globex_2: ['related'], o_initech: ['related'], o_hooli: ['recent'], o_alpha: [], o_zeta: [] });
    expect(r.opps.find((o) => o.id === 'o_hooli')).toMatchObject({ lastUsed: '2026-11-06', accountName: 'Hooli' });
    // an opp that closed years ago and the row has no tie to is left out
    expect(r.opps.some((o) => o.id === 'o_acme_ancient')).toBe(false);
  });

  it('tiers add up: on the account and from the meeting beats the account alone', () => {
    const ev = [event('ev1', { oppId: 'o_acme_late', accountId: 'a_acme' })];
    const r = buildOppOptions({ ...input, events: ev });
    expect(r.opps[0]!.id).toBe('o_acme_late');
    expect(r.opps[0]!.why).toEqual(['account', 'evidence']);
    expect(tierOf(['account', 'evidence'])).toBeGreaterThan(tierOf(['account', 'related', 'recent']));
    expect(tierOf(['evidence'])).toBeGreaterThan(tierOf(['related', 'recent']));
  });

  it('the row\'s current opp keeps its account tie (and stays listed even when closed long ago)', () => {
    const r = buildOppOptions({ ...input, entry: { ...entry, accountName: null, oppId: 'o_acme_ancient', sources: [] } });
    expect(r.opps.slice(0, 2).map((o) => o.id)).toEqual(['o_acme_soon', 'o_acme_late']);
    expect(r.opps.some((o) => o.id === 'o_acme_ancient')).toBe(true);
  });

  it('without a row: used lately, then the rest A–Z', () => {
    const r = buildOppOptions({ ...input, entry: null });
    expect(r.opps[0]!.id).toBe('o_hooli');
    expect(r.entryId).toBeNull();
  });
});

describe('opp options: type to filter, top match first', () => {
  const ranked = buildOppOptions(input).opps;
  it('nothing typed: the ranking, without closed opps the row has no tie to', () => {
    const list = filterOppOptions(ranked, '');
    expect(list[0]!.id).toBe('o_acme_soon');
    expect(list.some((o) => o.id === 'o_acme_won')).toBe(true); // tied: on the row's account
  });
  it('typed: every word must match the name or account; the row\'s tier still comes first', () => {
    expect(filterOppOptions(ranked, 'globex').map((o) => o.id)).toEqual(['o_globex', 'o_globex_2']);
    expect(filterOppOptions(ranked, 'acme phase').map((o) => o.id)).toEqual(['o_acme_soon']);
    expect(filterOppOptions(ranked, 'pilot').map((o) => o.id)).toEqual(['o_initech']);
    // "data" is in a Globex name and nowhere on ACME: the meeting's opp is the top match
    expect(filterOppOptions(ranked, 'data')[0]!.id).toBe('o_globex');
    expect(filterOppOptions(ranked, 'nothing like this')).toEqual([]);
  });
  it('a word start beats an inner hit', () => {
    expect(matchScore({ name: 'Globex · Renewal', accountName: 'Globex', stage: '' }, ['ren'])).toBeGreaterThan(matchScore({ name: 'Globex · Torrent', accountName: 'Globex', stage: '' }, ['ren']));
    expect(matchScore({ name: 'A', accountName: 'B', stage: 'C' }, ['zz'])).toBe(0);
  });
});

describe('combobox keyboard', () => {
  const none = [false, false, false];
  it('↓ / ↑ move and stop at the ends; disabled options are skipped', () => {
    expect(comboKey({ key: 'ArrowDown' }, 0, none)).toEqual({ kind: 'move', active: 1 });
    expect(comboKey({ key: 'ArrowDown' }, 2, none)).toEqual({ kind: 'move', active: 2 });
    expect(comboKey({ key: 'ArrowUp' }, 0, none)).toEqual({ kind: 'move', active: 0 });
    expect(comboKey({ key: 'ArrowDown' }, 0, [false, true, false])).toEqual({ kind: 'move', active: 2 });
    expect(comboKey({ key: 'ArrowUp' }, 2, [false, true, false])).toEqual({ kind: 'move', active: 0 });
    expect(comboKey({ key: 'ArrowDown' }, -1, [true, false])).toEqual({ kind: 'move', active: 1 });
    expect(comboKey({ key: 'PageDown' }, 0, Array(20).fill(false))).toEqual({ kind: 'move', active: 8 });
    expect(comboKey({ key: 'PageUp' }, 3, Array(20).fill(false))).toEqual({ kind: 'move', active: 0 });
  });
  it('Enter picks the active option (never a disabled one); Esc and Tab close; other keys type', () => {
    expect(comboKey({ key: 'Enter' }, 1, none)).toEqual({ kind: 'pick', index: 1 });
    expect(comboKey({ key: 'Enter' }, 1, [false, true])).toEqual({ kind: 'none' });
    expect(comboKey({ key: 'Enter' }, -1, none)).toEqual({ kind: 'none' });
    expect(comboKey({ key: 'Escape' }, 1, none)).toEqual({ kind: 'close', reason: 'escape' });
    expect(comboKey({ key: 'Tab' }, 1, none)).toEqual({ kind: 'close', reason: 'tab' });
    expect(comboKey({ key: 'a' }, 1, none)).toEqual({ kind: 'none' });
    expect(comboKey({ key: 'ArrowDown' }, -1, [])).toEqual({ kind: 'none' });
  });
  it('the closed trigger: ↓ opens, a letter opens with that letter typed, shortcuts and Space are left alone', () => {
    expect(comboTriggerKey({ key: 'ArrowDown' })).toEqual({ open: true, query: '' });
    expect(comboTriggerKey({ key: 'g' })).toEqual({ open: true, query: 'g' });
    expect(comboTriggerKey({ key: 'g', metaKey: true })).toEqual({ open: false });
    expect(comboTriggerKey({ key: ' ' })).toEqual({ open: false }); // Space and Enter click the button (opens)
    expect(comboTriggerKey({ key: 'Enter' })).toEqual({ open: false });
  });
});

describe('Org62 search for the picker (read-only SOQL from fixed fields)', () => {
  it('every word in the opp or its account name, open only, newest close first', () => {
    const q = buildOrg62OppSearch('stark data');
    expect(q).toBe(
      "SELECT Id, Name, AccountId, Account.Name, StageName, CloseDate, Amount, ForecastCategoryName, Type, IsClosed, IsWon, Owner.Name FROM Opportunity WHERE (Name LIKE '%stark%' OR Account.Name LIKE '%stark%') AND (Name LIKE '%data%' OR Account.Name LIKE '%data%') AND IsClosed = false ORDER BY CloseDate DESC NULLS LAST LIMIT 10",
    );
    expect(buildOrg62OppSearch("o'brien · x")).toContain("LIKE '%o\\'brien%'");
    expect(() => buildOrg62OppSearch('· ·')).toThrow(Org62LookupError);
    expect(buildOrg62OppSearch('ab cd ef gh ij')).not.toContain("'%ij%'"); // at most 4 words
    expect(() => buildOrg62OppSearch('a b c')).toThrow(Org62LookupError); // single letters are not words
  });
  it('re-reads one picked record by id, and only an Opportunity id', () => {
    expect(buildOrg62OppById('006XX0000MOCK03AAA')).toMatch(/FROM Opportunity WHERE Id = '006XX0000MOCK03AAA' LIMIT 1$/);
    expect(() => buildOrg62OppById("006XX' OR Name != '")).toThrow(Org62LookupError);
    expect(() => buildOrg62OppById('001XX0000MOCK03AAA')).toThrow(Org62LookupError);
  });
  it('a soqlQuery answer becomes picker hits', () => {
    const rows = parseOrg62Rows(JSON.stringify({ records: [MOCK_ORG62_OPPS[2]] }), 'opportunities');
    expect(rows.map(org62OppHit)).toEqual([
      { kind: 'opp', org62Id: '006XX0000MOCK03AAA', name: 'Stark Labs · Data 360 Foundations', accountName: 'Stark Labs', accountOrg62Id: '001XX0000MOCK03AAA', stage: 'Discovery', closeDate: '2027-04-30', amount: 240000, owner: 'Placeholder AE', isOpen: true, oppId: null, accountId: null },
    ]);
  });
});

describe('the picker routes on the mock', () => {
  let ds: MockDataSource;
  beforeAll(() => {
    ds = createMockDataSource({ autoplay: false });
  });
  afterAll(() => ds.dispose());

  it('GET /time/opps ranks the row\'s account first (a Hooli row that needs an opp: the Hooli opp on top)', async () => {
    const r = OppOptions.parse(await ds.getOppOptions({ query: { entryId: 'ac_wed_hooli' } }));
    expect(r.opps[0]).toMatchObject({ id: 'opp_hooli_nce', accountName: 'Hooli', why: expect.arrayContaining(['account']) });
    const r2 = OppOptions.parse(await ds.getOppOptions({ query: {} }));
    expect(r2.opps.length).toBe(r.opps.length);
  });

  it('Search Org62: placeholder records plus the app\'s own matches, marked', async () => {
    const s = Org62OppSearch.parse(await ds.searchOrg62Opps({ body: { q: 'globex' } }));
    expect(s.simulated).toBe(true);
    const voice = s.hits.find((h) => h.name === 'Globex · Service Cloud Voice')!;
    expect(voice).toMatchObject({ oppId: null, accountId: 'acc_globex' }); // the app has the account, not the opp
    const own = s.hits.find((h) => h.oppId === 'opp_globex_d360')!;
    expect(own.org62Id).toBe(mockOrg62IdFor('opp_globex_d360'));
    expect(Org62OppSearch.parse(await ds.searchOrg62Opps({ body: { q: 'zzz qqq' } })).hits).toEqual([]);
  });

  it('picking a record the app lacks adds the opp and its account, sets the row, and Undo takes it all back', async () => {
    const before = (await ds.getTime({ query: {} })).entries.find((e) => e.id === 'ac_wed_hooli')!;
    const accountsBefore = (await ds.getDeals({} as never)).accounts.length;
    const r = await ds.pickOrg62Opp({ params: { id: 'ac_wed_hooli' }, body: { ifVersion: before.version, org62Id: '006XX0000MOCK03AAA' } });
    expect(r.entity).toMatchObject({ oppName: 'Stark Labs · Data 360 Foundations', accountName: 'Stark Labs', userLockedFields: expect.arrayContaining(['oppId']) });
    expect(r.auditId).toBeTruthy();
    expect((await ds.getDeals({} as never)).accounts.map((a) => a.name)).toContain('Stark Labs');
    const opts = await ds.getOppOptions({ query: { entryId: 'ac_wed_hooli' } });
    expect(opts.opps[0]).toMatchObject({ id: r.entity.oppId, accountName: 'Stark Labs' });
    // the search now says it is in the app
    expect((await ds.searchOrg62Opps({ body: { q: 'stark data' } })).hits[0]).toMatchObject({ oppId: r.entity.oppId });
    // a logging batch writes the record's own Org62 id as the WhatId
    const batch = await ds.stageLogBatch({ body: { from: before.date, to: before.date, includeProposed: true } });
    expect(batch.entity.skipped.some((x) => x.id === 'ac_wed_hooli' && /WhatId/.test(x.why))).toBe(false);

    await ds.undoAudit({ params: { id: batch.auditId! }, body: {} });
    await ds.undoAudit({ params: { id: r.auditId! }, body: {} });
    const after = (await ds.getTime({ query: {} })).entries.find((e) => e.id === 'ac_wed_hooli')!;
    expect(after).toMatchObject({ oppId: null, oppName: before.oppName, userLockedFields: before.userLockedFields });
    expect((await ds.getDeals({} as never)).accounts.length).toBe(accountsBefore);
  });

  it('a hit the app has just sets the row; a logged row and an unknown id are refused', async () => {
    const cur = (await ds.getTime({ query: {} })).entries.find((e) => e.id === 'ac_wed_hooli')!;
    const r = await ds.pickOrg62Opp({ params: { id: cur.id }, body: { ifVersion: cur.version, org62Id: mockOrg62IdFor('opp_hooli_nce') } });
    expect(r.entity).toMatchObject({ oppId: 'opp_hooli_nce', oppName: 'Hooli · Nimbus Context Engine' });
    await expect(ds.pickOrg62Opp({ params: { id: 'ac_mon_prep' }, body: { org62Id: '006XX0000MOCK03AAA' } })).rejects.toMatchObject({ code: 'validation' });
    await expect(ds.pickOrg62Opp({ params: { id: cur.id }, body: { org62Id: '006XX0000NOPE99AAA' } })).rejects.toMatchObject({ code: 'not_found' });
  });
});
