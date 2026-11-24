/**
 * PROJECT on Postgres (the real path): source items as the scanner stores them → runProjections → the pages, read
 * through the db DataSource and validated against the contract. Mapping, idempotency (a second pass writes
 * nothing: no change sets, no audit rows), updates, upstream cancels and deletes, user locks, the Org62
 * read-back, and the capacity rule (only accepted meetings block time; agent time is never load).
 *
 * Database: control_center_projections_<CC_TEST_DB_SUFFIX> (db-setup.ts), placeholder data only.
 */
import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable } from '../../support/pg';

import { routes, type RouteDef, type RouteKey } from '../../../src/contract';
import type { Db, DbHandle } from '../../../src/db/client';
import { actors, withChangeSet } from '../../../src/db/changeset';
import { runProjections } from '../../../src/projections';
import { recomputeWeeks } from '../../../src/projections/run';
import { DbDataSource } from '../../../src/server/datasource/db';
import { DbScannerStore } from '../../../src/scanner/store-db';

import { buildLogBatch } from '../../../src/server/datasource/db/store/log-batch';
import { driftedLoggedRowStarts, hiddenOrg62RowStarts } from '../../../src/server/datasource/db/store/projections';
import { loggingProfile } from '../../../src/engines/activity/persona';
import { DECLINED_LOGGED_FLAG } from '../../../src/engines/activity/internal';
import { personaOf } from '../../../src/personas';
import { freshProjectionsDb, PROFILE } from './db-setup';
import { ACCT_ACME, ACCT_GLOBEX, calItem, cancelItem, driveItem, geminiItem, ME, OPP_ACME, OPP_ACME_2, OPP_GLOBEX, org62Item, sessionItem } from '../../projections/fixtures';
import type { SourceRow } from '../../../src/projections/types';
import { projectionStore } from '../../../src/server/datasource/db/store/projections.run';


// Fri 2026-11-06 09:00 America/Denver (MST, UTC-7)
const NOW = new Date('2026-11-06T16:00:00.000Z');
const at = (hhmm: string, day = '2026-11-06') => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + ((h + 7) * 60 + m) * 60_000).toISOString();
};

let handle: DbHandle;
let db: Db;
let userId: string;
let ds: DbDataSource;

async function insert(si: SourceRow) {
  const hash = createHash('sha1').update(JSON.stringify([si.title, si.meta, si.body])).digest('hex').slice(0, 16);
  await db.execute(sql`
    insert into source_items (owner_user_id, source, kind, external_id, external_parent_id, external_container_id, dedupe_key, content_hash,
                              occurred_at, title, url, body, from_me, meta)
    values (${userId}, ${si.source}, ${si.kind}, ${si.externalId}, ${si.externalParentId}, ${si.externalContainerId}, ${si.dedupeKey}, ${hash},
            ${si.occurredAt}::timestamptz, ${si.title}, ${si.url}, ${si.body}, ${si.fromMe}, ${JSON.stringify(si.meta)}::jsonb)
    on conflict (owner_user_id, dedupe_key) do update set
      content_hash = excluded.content_hash, title = excluded.title, body = excluded.body, meta = excluded.meta, occurred_at = excluded.occurred_at,
      content_changed_at = now(), revision = source_items.revision + 1`);
}

async function call<K extends RouteKey>(key: K, input: Record<string, unknown> = {}): Promise<any> {
  const def: RouteDef = routes[key];
  const inp: Record<string, unknown> = {};
  if (def.params) inp.params = def.params.parse(input.params ?? {});
  if (def.query) inp.query = def.query.parse(input.query ?? {});
  if (def.body) inp.body = def.body.parse(input.body);
  const out = await (ds[key] as unknown as (i: unknown) => Promise<unknown>).call(ds, inp);
  const r = def.response.safeParse(out);
  if (!r.success) throw new Error(`${key} failed contract validation: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
  return r.data;
}

const n = async (q: string) => (await db.execute<{ n: number }>(sql.raw(q))).rows[0]!.n;
const project = (o: { full?: boolean; now?: Date } = {}) => runProjections({ store: projectionStore(db), userId, now: o.now ?? NOW, full: o.full });
const audit = async () => ({ changeSets: await n('select count(*)::int as n from change_sets'), audit: await n('select count(*)::int as n from audit_events') });

const ACME_ATTENDEES = [{ email: ME.email, response: 'accepted' }, { email: 'dana@acme.example', response: 'accepted' }];
const ACCT_INITECH = '001XX0000000003AAA';
const OPP_INITECH = '006XX0000000007AAA';
const OPP_GLOBEX_2 = '006XX0000000008AAA';
/** The daily book read's run stamp ({{window.to}} of the missed_opps run). */
const BOOK_AT = '2026-11-06T13:00:00.000Z';
const today = (id: string, title: string, from: string, to: string, o: Parameters<typeof calItem>[1] = {}) => calItem(id, { title, start: at(from), end: at(to), ...o });

beforeAll(async () => {
  if (!pgAvailable) return;
  ({ handle, userId } = await freshProjectionsDb(NOW));
  db = handle.db;
  ds = new DbDataSource({ handle, userId, clock: { now: () => NOW } });

  // ---- calendar: today, yesterday, a cancelled one
  await insert(today('e_acme', 'ACME discovery', '10:00', '11:00', { attendees: ACME_ATTENDEES }));
  await insert(today('e_tent', 'Globex intro', '12:00', '13:00', { myResponse: 'tentative', attendees: [{ email: ME.email, response: 'tentative' }, { email: 'kim@globex.example', response: 'accepted' }] }));
  await insert(today('e_unans', 'Quarterly all hands', '13:00', '14:00', { myResponse: 'needsAction', attendees: [{ email: ME.email, response: 'needsAction' }, { email: 'ceo@corp.example', response: 'accepted' }] }));
  await insert(today('e_decl', 'Initech sync', '14:00', '15:00', { myResponse: 'declined', attendees: [{ email: ME.email, response: 'declined' }, { email: 'lee@initech.example', response: 'accepted' }] }));
  await insert(today('e_solo', 'Focus time', '15:00', '16:00', { attendees: [{ email: ME.email, response: 'accepted' }], organizer: ME.email, attendance: 'n/a' }));
  await insert(calItem('e_ooo', { title: 'OOO', allDay: true, start: '2026-11-06T00:00:00.000Z', end: '2026-11-07T00:00:00.000Z', attendees: [{ email: ME.email, response: 'accepted' }], organizer: ME.email, attendance: 'n/a' }));
  await insert(today('e_gone', 'ACME exec prep', '16:00', '16:30', { attendees: ACME_ATTENDEES }));
  await insert({ ...cancelItem('e_gone', at('16:00'), '2026-11-06T15:30:00.000Z'), externalContainerId: 'primary' });
  await insert(calItem('e_past', { title: 'ACME - POV readout', start: at('10:00', '2026-11-05'), end: at('11:00', '2026-11-05'), attendees: ACME_ATTENDEES, ended: true, attendance: 'attended' }));

  // ---- Org62 (as the scan-org62 skill records it)
  await insert(org62Item(`Opportunity:${OPP_ACME}@2026-11-05T10:00:00.000+0000`, { title: 'ACME - Data 360 Expansion', meta: { Id: OPP_ACME, Amount: 250000, CloseDate: '2026-12-15', StageName: 'Validation', IsClosed: false }, body: 'stage=Validation; close=2026-12-15; amount=250000; next=SE demo; team_role=Solution Engineer', accountHints: [ACCT_ACME, 'ACME Corporation'], oppHints: [OPP_ACME] }));
  await insert(org62Item(`Opportunity:${OPP_ACME_2}@2026-11-04T10:00:00.000+0000`, { title: 'ACME - Service Renewal', meta: { Id: OPP_ACME_2, StageName: 'Closed Won', IsClosed: true, IsWon: true, Amount: 90000.333 }, accountHints: [ACCT_ACME, 'ACME Corporation'], oppHints: [OPP_ACME_2] })); // a fractional amount: the column keeps 2 decimals
  await insert(org62Item('Deal_Contribution__c:a0XXX000000001AAA@2026-11-03T10:00:00.000+0000', { title: 'DC on Globex - Agent Rollout', meta: { Opportunity__c: OPP_GLOBEX, Opportunity_Role__c: 'AI + Data Architect', Split_Percentage__c: 100, IsClosed: false }, body: 'role=AI + Data Architect; split=100; opp_stage=Proposal; close=2026-12-20', accountHints: [ACCT_GLOBEX, 'Globex Inc.'], oppHints: [OPP_GLOBEX] }));
  // the POV readout yesterday is in Org62; a Globex build block logged off-calendar on Wednesday
  await insert(org62Item('Event:00UXX000000001AAA@2026-11-05T19:00:00.000+0000', { title: 'ACME - POV readout', meta: { SE_Task_Type__c: 'Customer Presentation', Duration__c: 1, WhatId: OPP_ACME }, body: `type=Customer Presentation; rt=Solutions Event; start=${at('10:00', '2026-11-05')}; hrs=1; what=ACME - Data 360 Expansion`, oppHints: [OPP_ACME] }));
  await insert(org62Item('Event:00UXX000000002AAA@2026-11-04T23:00:00.000+0000', { title: 'Globex agent build', meta: { SE_Task_Type__c: 'Solution Creation', Duration__c: 2, WhatId: OPP_GLOBEX }, body: `type=Solution Creation; rt=Solutions Event; start=${at('13:00', '2026-11-04')}; hrs=2; what=Globex - Agent Rollout`, oppHints: [OPP_GLOBEX] }));
  // last quarter (Q3 FY27): its times only in the payload (Salesforce datetime form), logged in Org62 a day later
  await insert(org62Item('Event:00UXX000000005AAA@2026-10-15T21:00:00.000+0000', { title: 'ACME architecture workshop', meta: { Id: '00UXX000000005AAA', StartDateTime: '2026-10-14T16:00:00.000+0000', EndDateTime: '2026-10-14T17:30:00.000+0000', Duration__c: 1.5, SE_Task_Type__c: 'Workshop', Meeting_Type__c: 'Data Cloud Workshop', RecordTypeName: 'Solutions Event', WhatId: OPP_ACME, CreatedDate: '2026-10-15T20:00:00.000+0000' }, body: 'type=Workshop; meeting_type=Data Cloud Workshop; rt=Solutions Event; hrs=1.5; what=ACME - Data 360 Expansion', oppHints: [OPP_ACME] }));
  // an Initech opp whose team I am on (the daily book read later drops it)
  await insert(org62Item(`Opportunity:${OPP_INITECH}@2026-10-01T10:00:00.000+0000`, { title: 'Initech - Data Cloud Pilot', meta: { Id: OPP_INITECH, StageName: 'Discovery', Amount: 60000, CloseDate: '2027-03-31', IsClosed: false }, body: 'stage=Discovery; close=2027-03-31; amount=60000; team_role=Solution Engineer', accountHints: [ACCT_INITECH, 'Initech'], oppHints: [OPP_INITECH] }));
  // the sweep: a Globex opp with a D360 line, 3.5 h of my logged time and no DC from me
  await insert(org62Item(`MissedOpp:${OPP_GLOBEX_2}`, { title: 'Globex - Data Cloud Expansion', meta: { Id: OPP_GLOBEX_2, AccountId: ACCT_GLOBEX, AccountName: 'Globex Inc.', StageName: 'Proposal', Amount: 180000, CloseDate: '2026-12-31', IsClosed: false, IsWon: false, signal: 'd360', hours: 3.5, d360Amount: 120000, products: ['Data 360 Profiles'] }, body: 'tier=claim; signal=d360; evidence=strong; hours=3.5; d360_amount=120000; close=2026-12-31; won=false; other_architect_dc=none', accountHints: [ACCT_GLOBEX, 'Globex Inc.'], oppHints: [OPP_GLOBEX_2] }));

  // ---- Claude sessions, Drive, Gemini notes, Slack
  await insert(sessionItem('sess-run', { status: 'busy', title: 'ACME demo build', startedAt: at('08:00'), lastActivityAt: at('08:55'), lastHumanPromptAt: at('08:50') }));
  await insert(sessionItem('sess-done', { status: 'done', title: 'Globex agent prompt tuning', cwd: '/Users/example/Projects/globex-agent', startedAt: at('13:00', '2026-11-05'), lastActivityAt: at('15:00', '2026-11-05'), lastHumanPromptAt: at('14:40', '2026-11-05') }));
  await insert(sessionItem('sess-wait', { status: 'waiting', waitingFor: 'input needed', title: 'Initech sizing', cwd: '/Users/example/Projects/tools', startedAt: at('07:40'), lastActivityAt: at('08:30'), lastHumanPromptAt: at('07:40') }));
  await insert(driveItem('FILE_ACME_DECK', at('16:00', '2026-11-05'), { title: 'ACME POV deck' }));
  await insert(geminiItem('DOC_GEMINI_1', 'e_past'));
  // my Slack messages, on their own (engaged time, 2026-11-14: inside a Claude stretch they would ride with its work)
  for (const [i, t] of ['09:10', '09:14', '09:16'].entries()) {
    await insert({ ...sessionItem('x'), source: 'slack', kind: 'slack_message', externalId: `C0ACME0001:17000000${i}.0001`, dedupeKey: `slack:C0ACME0001:17000000${i}.0001`, occurredAt: at(t), fromMe: true, meta: {}, title: null, body: null });
  }
});

afterAll(async () => {
  await ds?.dispose();
  await handle?.close();
});

describe.skipIf(!pgAvailable)('projections on Postgres', () => {
  it('first pass: every page reads real records derived from the source items', async () => {
    const r = await project();
    expect(r.errors).toEqual([]);
    expect(r.written.calendar_events).toBe(7);
    expect(r.written.cancelled_events).toBe(1);

    // Today: today's meetings I attend (+ declined, cancelled), and tentative / unanswered invites carrying their
    // answer (shown, never blocking); never solo or all-day blocks
    const t = await call('getToday');
    expect(t.spine.events.map((e: any) => [e.title, e.attendance, e.myResponse ?? null]).sort()).toEqual([
      ['ACME discovery', 'upcoming', null],
      ['ACME exec prep', 'cancelled', null],
      ['Globex intro', 'upcoming', 'tentative'],
      ['Initech sync', 'declined', null],
      ['Quarterly all hands', 'upcoming', 'needs_action'],
    ]);
    expect(t.header.nextMeeting?.title).toBe('ACME discovery'); // a tentative invite is not "your next meeting"
    const acme = t.spine.events.find((e: any) => e.title === 'ACME discovery');
    expect(acme).toMatchObject({ isCustomerFacing: true, meetingUrl: 'https://meet.example/abc' });
    expect(acme.accountId).toBeTruthy();
    expect(acme.oppId).toBeTruthy(); // ACME has one open opp of mine
    // capacity: 09:00 → 17:30 is 510 min; only the accepted ACME hour blocks (the tentative and unanswered invites
    // show but don't); agents never count
    expect(t.header.capacity).toMatchObject({ freeMin: 450, youMinToday: 0, fits: true });
    expect(t.spine.slots.some((s: any) => s.kind === 'gap' && s.start <= at('12:00') && s.end >= at('14:00'))).toBe(true);

    // Deals: my book (team opps, DC opp, swept opp) with the account's other opps listed under it
    const d = await call('getDeals');
    const byName = Object.fromEntries(d.accounts.map((a: any) => [a.name, a]));
    expect(Object.keys(byName).sort()).toEqual(['ACME Corporation', 'Globex Inc.', 'Initech']);
    expect(byName['ACME Corporation']).toMatchObject({ openOpps: 1, pipelineAmount: 250000, nextCloseDate: '2026-12-15', dcStatus: 'none' });
    expect(byName['Globex Inc.']).toMatchObject({ openOpps: 2, dcStatus: 'partial' });
    expect(byName['ACME Corporation'].org62Url).toContain(ACCT_ACME);
    // the summary and pipeline by fiscal quarter over the projected opps: mine only (team or DC, not the swept or the
    // closed one), by stage (these rows carry no forecast category), and the DC-only opp's next step unknown, not missing
    expect(d.pipeline).toMatchObject({ basis: 'team_or_dc', categoryBasis: 'stage', currentQuarter: 'Q4 FY27', amountField: { field: 'Opportunity.Amount' } });
    expect(d.pipeline.rows.map((r: any) => [r.name, r.via, r.quarter, r.category, r.amount, r.attention])).toEqual([
      ['ACME - Data 360 Expansion', 'team', 'Q4 FY27', 'mid', 250000, []],
      ['Globex - Agent Rollout', 'dc', 'Q4 FY27', 'mid', null, []],
      ['Initech - Data Cloud Pilot', 'team', 'Q1 FY28', 'early', 60000, []],
    ]);
    expect(d.pipeline.summary.open).toEqual({ amount: 310000, count: 3 });
    expect(d.pipeline.notes).toEqual(expect.arrayContaining(['No forecast category was read on your opps, so they are grouped by stage.', '1 open opp has no amount read yet: counted, adding $0.', '1 opp this quarter has no next step read yet: not flagged for one.']));

    // Deals ▸ Missed: the deals engine over the sweep row (D360 line, 3.5 h logged, no DC from me) → Claim
    const mi = await call('getMissed');
    expect(mi.missed).toHaveLength(1);
    expect(mi.missed[0]).toMatchObject({ verdict: 'claim', oppName: 'Globex - Data Cloud Expansion', accountName: 'Globex Inc.', amount: 180000, status: 'new' });
    expect(mi.missed[0].evidence).toEqual(expect.arrayContaining(['D360 product line', 'Your account, no DC from you', 'Org62 event 3.5h (linked to this opp)']));
    expect(d.missedCount).toBe(1);

    // Agents: the sessions with their states
    const ag = await call('getAgents');
    expect(ag.runs.map((x: any) => [x.title, x.state]).sort()).toEqual([
      ['ACME demo build', 'running'],
      ['Globex agent prompt tuning', 'done'],
      ['Initech sizing', 'waiting_on_you'],
    ]);
    expect(ag.runs.find((x: any) => x.state === 'waiting_on_you').waiting.reason).toBe('input needed');
    expect(ag.runs[0].deepLink).toMatch(/^claude:\/\/code\/continue\?session=local_/);

    // Time: the week grid and the log (Org62 logged once, proposals, the upcoming meeting)
    const tw = await call('getTime', { query: {} });
    const lane = (id: string) => tw.timeline.find((l: any) => l.id === id).blocks;
    expect(lane('meetings').map((b: any) => b.label).sort()).toEqual(['ACME - POV readout', 'ACME discovery']);
    expect(lane('meetings').find((b: any) => b.label === 'ACME - POV readout').activityId).toBeTruthy();
    expect(lane('claude').length).toBeGreaterThanOrEqual(2);
    expect(lane('claude').every((b: any) => b.hatched)).toBe(true);
    expect(lane('focus').length).toBeGreaterThanOrEqual(1);
    expect(lane('drive').length).toBe(1);
    expect(lane('slack').length).toBe(1);
    const entries = tw.entries.map((e: any) => [e.description.split(' · ')[0], e.status, e.durationH]);
    expect(entries).toEqual(
      expect.arrayContaining([
        ['Globex agent build', 'logged', 2],
        ['ACME - POV readout', 'logged', 1],
        ['ACME discovery', 'upcoming', 1],
      ]),
    );
    expect(tw.entries.filter((e: any) => e.description.startsWith('ACME - POV readout'))).toHaveLength(1);
    expect(tw.totals.loggedH).toBe(3);
    const logged = tw.entries.find((e: any) => e.description === 'ACME - POV readout');
    expect(logged).toMatchObject({ taskType: 'Customer Presentation', meetingType: 'CF', oppName: 'ACME - Data 360 Expansion', accountName: 'ACME Corporation' });
    // the quarter total is this fiscal quarter's (Q4 FY27 from 1 Nov) logged rows only, not last quarter's 1.5 h
    expect(tw.quarter).toMatchObject({ label: 'Q4 FY27', loggedH: 3 });
    expect((await call('getToday')).header.nearestDeadline.progress.done).toBe(3);

    // a past week of last quarter: its Org62 Event (times from the payload only) is placed and logged
    const lastQ = await call('getTime', { query: { week: '2026-10-12' } });
    expect(lastQ.entries.map((e: any) => [e.description, e.status, e.durationH, e.start])).toEqual([['ACME architecture workshop', 'logged', 1.5, '2026-10-14T16:00:00.000Z']]);
    expect(lastQ.quarter.loggedH).toBe(3);
    expect(await n(`select count(*)::int as n from org62_events where org62_event_id = '00UXX000000005AAA' and meeting_type_name = 'Data Cloud Workshop' and org62_created_at = '2026-10-15T20:00:00Z'`)).toBe(1);
    // History: the day it was logged in Org62 (its CreatedDate), and its hours on the day it was worked
    const logDay = await call('getHistoryDay', { params: { day: '2026-10-15' } });
    expect(logDay.org62.map((o: any) => [o.label, o.workDay, o.durationH])).toEqual([['Logged in Org62', '2026-10-14', 1.5]]);
    const workDay = await call('getHistoryDay', { params: { day: '2026-10-14' } });
    expect(workDay.summary).toBeTruthy();

    // Assets and notes
    expect(await n(`select count(*)::int as n from assets where external_id = 'FILE_ACME_DECK' and account_id is not null`)).toBe(1);
    expect(await n(`select count(*)::int as n from meeting_notes where calendar_event_id is not null`)).toBe(1);
    const cal = await call('getCalendar', { query: { from: '2026-11-05T07:00:00.000Z', to: '2026-11-06T06:59:59.000Z' } });
    const past = cal.events.find((e: any) => e.title === 'ACME - POV readout');
    expect(past?.takeaways?.notesUrl).toContain('DOC_GEMINI_1');
  });

  it('is idempotent: a second pass (incremental or full) writes nothing', async () => {
    const before = await audit();
    const rows = await n('select (select count(*) from calendar_events) + (select count(*) from activity_entries) + (select count(*) from time_blocks) + (select count(*) from accounts) + (select count(*) from opportunities) + (select count(*) from claude_sessions) + (select count(*) from assets)::int as n');
    const inc = await project({ now: new Date(NOW.getTime() + 60_000) });
    expect(inc.skipped).toBe(true);
    const full = await project({ full: true });
    expect(full.errors).toEqual([]);
    expect(Object.values(full.written).reduce((s, x) => s + x, 0)).toBe(0);
    const after = await audit();
    // the full pass rewrites its own watermark only
    expect(after.changeSets - before.changeSets).toBeLessThanOrEqual(1);
    expect(after.audit - before.audit).toBeLessThanOrEqual(1);
    expect(await n('select (select count(*) from calendar_events) + (select count(*) from activity_entries) + (select count(*) from time_blocks) + (select count(*) from accounts) + (select count(*) from opportunities) + (select count(*) from claude_sessions) + (select count(*) from assets)::int as n')).toBe(rows);
  });

  it('ACC-1: a work item with no account gets the one its title names; a set or user-locked account is left alone', async () => {
    const item = async (title: string, locked: string[] = []) =>
      (
        await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'placeholder items' }, async (tx) =>
          (await tx.execute<{ id: string }>(sql`insert into work_items (owner_user_id, kind, origin, status, title, user_locked_fields)
            values (${userId}, 'ask', 'asked_of_me', 'open', ${title}, ${`{${locked.join(',')}}`}::text[]) returning id`)).rows[0]!.id,
        )
      ).result;
    const named = await item('Send the ACME pricing follow-up');
    const none = await item('Book travel for the offsite');
    const locked = await item('Prep the ACME workshop agenda', ['account_id']);
    const r = await project({ now: new Date(NOW.getTime() + 5 * 60_000) });
    expect(r.errors).toEqual([]);
    expect(r.written.work_item_accounts).toBe(1);
    const acct = async (id: string) => (await db.execute<{ a: string | null }>(sql`select a.org62_account_id as a from work_items w left join accounts a on a.id = w.account_id where w.id = ${id}::uuid`)).rows[0]!.a;
    expect(await acct(named)).toBe(ACCT_ACME);
    expect(await acct(none)).toBeNull();
    expect(await acct(locked)).toBeNull(); // the user cleared it: never filled
    // Idempotent: the next pass writes nothing more.
    const again = await project({ now: new Date(NOW.getTime() + 10 * 60_000) });
    expect(again.written.work_item_accounts ?? 0).toBe(0);
  });

  it('follows changes: a moved meeting moves its row and its proposal; an accepted invite starts blocking time', async () => {
    await insert(today('e_acme', 'ACME discovery', '10:30', '11:30', { attendees: ACME_ATTENDEES }));
    await insert(today('e_tent', 'Globex intro', '12:00', '13:00', { myResponse: 'accepted', attendees: [{ email: ME.email, response: 'accepted' }, { email: 'kim@globex.example', response: 'accepted' }] }));
    const r = await project({ now: new Date(NOW.getTime() + 2 * 60_000) });
    expect(r.errors).toEqual([]);
    const t = await call('getToday');
    expect(t.spine.events.find((e: any) => e.title === 'ACME discovery').start).toBe(at('10:30'));
    expect(t.spine.events.map((e: any) => e.title)).toContain('Globex intro');
    expect(t.header.capacity.freeMin).toBe(390);
    const keys = (await db.execute<{ k: string }>(sql`select dedupe_key as k from activity_entries where dedupe_key like 'cal|primary|e_acme|%'`)).rows.map((x) => x.k);
    expect(keys).toEqual([`cal|primary|e_acme|${at('10:30')}`]);
  });

  it('upstream deletes hide the event; cancellations keep it as cancelled', async () => {
    await db.execute(sql`update source_items set deleted_upstream_at = now() where dedupe_key = 'cal:e_tent'`);
    await project({ now: new Date(NOW.getTime() + 3 * 60_000) });
    const t = await call('getToday');
    expect(t.spine.events.map((e: any) => e.title)).not.toContain('Globex intro');
    expect(await n(`select count(*)::int as n from calendar_events where external_event_id = 'e_tent' and deleted_upstream_at is not null`)).toBe(1);
    expect(t.header.capacity.freeMin).toBe(450); // only the moved ACME hour blocks (10:30–11:30)
  });

  it('never clobbers what the user owns: mapping locks, edited and approved log rows', async () => {
    // the user unmapped the meeting (mapping_locked) and edited the proposal's description (a locked field)
    await withChangeSet({ db, userId, actor: actors.user('test'), reason: 'user edits' }, async (tx) => {
      await tx.execute(sql`update calendar_events set account_id = null, opportunity_id = null, mapping_locked = true where external_event_id = 'e_acme'`);
      await tx.execute(sql`update activity_entries set description = 'my words', user_locked_fields = array['description'] where dedupe_key like 'cal|primary|e_acme|%'`);
    });
    await insert(today('e_acme', 'ACME discovery (updated)', '10:30', '11:30', { attendees: ACME_ATTENDEES }));
    await project({ now: new Date(NOW.getTime() + 4 * 60_000) });
    const [ev] = (await db.execute<{ account_id: string | null; title: string }>(sql`select account_id, title from calendar_events where external_event_id = 'e_acme'`)).rows;
    expect(ev).toEqual({ account_id: null, title: 'ACME discovery (updated)' });
    const rows = (await db.execute<{ description: string }>(sql`select description from activity_entries where dedupe_key like 'cal|primary|e_acme|%'`)).rows;
    expect(rows).toEqual([{ description: 'my words' }]);
  });

  it('Org62 read-back moves an approved row to verified, and never rewrites it', async () => {
    // a past meeting I approved, then logged by Slackbot in Org62 with the same subject and start
    await insert(calItem('e_wed', { title: 'Globex architecture review', start: at('09:00', '2026-11-04'), end: at('10:00', '2026-11-04'), attendees: [{ email: ME.email, response: 'accepted' }, { email: 'kim@globex.example', response: 'accepted' }], ended: true, attendance: 'attended' }));
    await project({ now: new Date(NOW.getTime() + 5 * 60_000) });
    const [p] = (await db.execute<{ id: string; status: string; se: string | null }>(sql`
      select a.id, a.status, t.name as se from activity_entries a left join se_task_types t on t.id = a.se_task_type_id where a.dedupe_key like 'cal|primary|e_wed|%'`)).rows;
    expect(p?.status).toBe('proposed');
    await withChangeSet({ db, userId, actor: actors.user('test'), reason: 'approve' }, (tx) => tx.execute(sql`update activity_entries set status = 'approved', approved_at = now(), approval_method = 'click' where id = ${p!.id}`));
    await insert(org62Item('Event:00UXX000000003AAA@2026-11-06T16:00:00.000+0000', { title: 'Globex architecture review', meta: { SE_Task_Type__c: p!.se, Duration__c: 1, WhatId: OPP_GLOBEX, Meeting_Type__c: p!.se === 'Workshop' ? 'Data Cloud Workshop' : null }, body: `type=${p!.se}; rt=Solutions Event; start=${at('09:00', '2026-11-04')}; hrs=1; what=Globex - Agent Rollout`, oppHints: [OPP_GLOBEX] }));
    const r = await project({ now: new Date(NOW.getTime() + 6 * 60_000) });
    expect(r.errors).toEqual([]);
    const [after] = (await db.execute<{ status: string; org62: string | null }>(sql`select status, org62_event_row_id as org62 from activity_entries where id = ${p!.id}`)).rows;
    expect(after!.status).toBe('verified');
    expect(after!.org62).toBeTruthy();
    expect(await n(`select count(*)::int as n from activity_entries where dedupe_key = 'org62|00UXX000000003AAA'`)).toBe(0); // represented once
    // counted rows still never overlap (the database's exclusion constraint held through every pass)
    expect(await n(`select count(*)::int as n from activity_entries a join activity_entries b on a.id < b.id and a.owner_user_id = b.owner_user_id
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
      where a.status not in ('excluded','dismissed','dropped') and b.status not in ('excluded','dismissed','dropped')`)).toBe(0);
  });

  it('a logged row left on another opp than its Org62 Event (no pass saw the edit) is re-checked on the next Org62 pass and follows Org62', async () => {
    const [row] = (await db.execute<{ id: string }>(sql`select id from activity_entries where dedupe_key like 'cal|primary|e_wed|%'`)).rows;
    // the stale state an older pass left: the Event says Globex, the app's row still says ACME
    await withChangeSet({ db, userId, actor: actors.user('test'), reason: 'stale' }, (tx) => tx.execute(sql`update activity_entries set what_org62_id = ${OPP_ACME} where id = ${row!.id}`));
    const [st] = (await db.execute<{ s: Date }>(sql`select starts_at as s from activity_entries where id = ${row!.id}`)).rows;
    expect(await driftedLoggedRowStarts(db, userId)).toEqual([new Date(st!.s).toISOString()]);
    // the next Org62 pass (here it touches another week's Event) gives the drifted row's week a pass
    await db.execute(sql`update source_items set content_changed_at = now(), revision = revision + 1 where dedupe_key = 'org62:Event:00UXX000000005AAA@2026-10-15T21:00:00.000+0000'`);
    const r = await project({ now: new Date(NOW.getTime() + 6 * 60_000 + 30_000) });
    expect(r.errors).toEqual([]);
    const [after] = (await db.execute<{ what: string | null; status: string }>(sql`select what_org62_id as what, status from activity_entries where id = ${row!.id}`)).rows;
    expect(after).toEqual({ what: OPP_GLOBEX, status: 'verified' });
    expect(await driftedLoggedRowStarts(db, userId)).toEqual([]);
  });

  it('TL-04b a row on a live Org62 Event an older rule hid as overlap gets a pass on the next Org62 pass and shows again', async () => {
    // the October workshop is a logged row tied to its Org62 Event (no later test reads that week)
    const linked = sql`org62_event_row_id = (select id from org62_events where org62_event_id = '00UXX000000005AAA')`;
    const [row] = (await db.execute<{ id: string; s: Date }>(sql`select id, starts_at as s from activity_entries where ${linked}`)).rows;
    // the stale state an older pass left (before D-65): hidden as overlap
    await withChangeSet({ db, userId, actor: actors.user('test'), reason: 'stale' }, (tx) => tx.execute(sql`update activity_entries set status = 'excluded', excluded_reason = 'overlap' where id = ${row!.id}`));
    expect(await hiddenOrg62RowStarts(db, userId)).toEqual([new Date(row!.s).toISOString()]);
    // the next pass (any Org62 change elsewhere, or the 15-minute week refresh) gives the hidden row's week a pass
    await db.execute(sql`update source_items set content_changed_at = now(), revision = revision + 1 where dedupe_key = 'org62:Event:00UXX000000001AAA@2026-11-05T19:00:00.000+0000'`);
    const r = await project({ now: new Date(NOW.getTime() + 6 * 60_000 + 45_000) });
    expect(r.errors).toEqual([]);
    const after = (await db.execute<{ status: string }>(sql`select status::text as status from activity_entries where ${linked}`)).rows;
    expect(after.length).toBe(1);
    expect(after[0]!.status).toMatch(/^(logged|verified)$/);
    expect(await hiddenOrg62RowStarts(db, userId)).toEqual([]);
  });

  it('the daily book read is the source of truth for my book: an opp it no longer lists is marked, never deleted', async () => {
    expect(await n(`select count(*)::int as n from opportunities where org62_opportunity_id = '${OPP_INITECH}' and on_my_team`)).toBe(1);
    // the book read (unwindowed): only ACME's opp is still an open opp of mine
    await insert({ ...org62Item(`Book:${OPP_ACME}`, { title: 'ACME - Data 360 Expansion', meta: { Id: OPP_ACME, AccountId: ACCT_ACME, AccountName: 'ACME Corporation', StageName: 'Validation', Amount: 250000, CloseDate: '2026-12-15', TeamMemberRole: 'Solution Engineer', IsClosed: false, bookAt: BOOK_AT }, body: `book_at=${BOOK_AT}; stage=Validation; close=2026-12-15; amount=250000; team_role=Solution Engineer`, accountHints: [ACCT_ACME, 'ACME Corporation'], oppHints: [OPP_ACME] }), occurredAt: '2026-11-05T10:00:00.000Z' });
    await insert({ ...org62Item('BookRun:run-1', { title: 'Book read', meta: { bookAt: BOOK_AT, rows: 1, dcs: 0, complete: true }, body: `book_at=${BOOK_AT}; rows=1; dcs=0; complete=true` }), occurredAt: BOOK_AT });
    const r = await project({ now: new Date(NOW.getTime() + 7 * 60_000) });
    expect(r.errors).toEqual([]);
    expect(r.book).toMatchObject({ authoritative: true, seen: 1, expected: 1, openTeamOpps: 1, left: 1 });
    const [ini] = (await db.execute<{ mine: boolean; left: string | null }>(sql`
      select o.on_my_team as mine, coalesce(to_char(o.left_book_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), s.value->>'leftBookAt') as left from opportunities o
        left join user_settings s on s.owner_user_id = o.owner_user_id and s.key = 'cc.ext/opportunities/' || o.id
       where o.org62_opportunity_id = ${OPP_INITECH}`)).rows;
    expect(ini).toEqual({ mine: false, left: BOOK_AT });
    expect(await n(`select count(*)::int as n from opportunity_team_members m join opportunities o on o.id = m.opportunity_id where o.org62_opportunity_id = '${OPP_INITECH}' and m.removed_at is not null`)).toBe(1);
    const acme = (await call('getAccount', { params: { accountId: (await db.execute<{ id: string }>(sql`select id from accounts where org62_account_id = ${ACCT_ACME}`)).rows[0]!.id } })).opps;
    expect(acme.find((o: any) => o.name === 'ACME - Data 360 Expansion')).toMatchObject({ isMine: true, isOpen: true });
    // the read lists every DC of mine on open opps: ACME's opp has none, and 2.5 h of my logged Events → Claim
    const mi = await call('getMissed');
    expect(mi.missed.map((m: any) => [m.oppName, m.verdict]).sort()).toEqual([
      ['ACME - Data 360 Expansion', 'claim'],
      ['Globex - Data Cloud Expansion', 'claim'],
    ]);
    expect(mi.missed.find((m: any) => m.oppName.startsWith('ACME')).evidence).toEqual(expect.arrayContaining(['D360 in the opportunity name', 'On your opp team (Solution Engineer), no DC from you']));
    // idempotent: the same read again writes nothing
    const again = await project({ now: new Date(NOW.getTime() + 8 * 60_000), full: true });
    expect(again.errors).toEqual([]);
    expect(Object.values(again.written).reduce((s, x) => s + x, 0)).toBe(0);
  });

  it('a claimed finding resolves itself once my DC shows up in Org62 (status is otherwise the user\'s)', async () => {
    await withChangeSet({ db, userId, actor: actors.user('test'), reason: 'claim' }, (tx) => tx.execute(sql`update missed_opp_findings set status = 'actioned'`));
    await insert(org62Item('Deal_Contribution__c:a0XXX000000009AAA@2026-11-06T15:00:00.000+0000', { title: 'DC on Globex - Data Cloud Expansion', meta: { Opportunity__c: OPP_GLOBEX_2, Opportunity_Role__c: 'AI + Data Architect', Split_Percentage__c: 100 }, body: 'role=AI + Data Architect; split=100', accountHints: [ACCT_GLOBEX, 'Globex Inc.'], oppHints: [OPP_GLOBEX_2] }));
    const r = await project({ now: new Date(NOW.getTime() + 9 * 60_000) });
    expect(r.errors).toEqual([]);
    const mi = await call('getMissed');
    expect(mi.missed.map((m: any) => [m.oppName, m.status]).sort()).toEqual([
      ['ACME - Data 360 Expansion', 'claimed'],
      ['Globex - Data Cloud Expansion', 'resolved'],
    ]);
  });

  it('a row whose opp you change logs to that opp: the WhatId follows, a later pass keeps it, clearing it clears it', async () => {
    const t0 = NOW.getTime() + 9 * 60_000;
    await insert(calItem('e_pick', { title: 'Globex roadmap sync', start: at('15:30', '2026-11-04'), end: at('16:30', '2026-11-04'), attendees: [{ email: ME.email, response: 'accepted' }, { email: 'kim@globex.example', response: 'accepted' }], ended: true, attendance: 'attended' }));
    expect((await project({ now: new Date(t0 + 20_000) })).errors).toEqual([]);
    const what = async () =>
      (await db.execute<{ id: string; version: number; what_kind: string; what_org62_id: string | null; what_name: string | null; opportunity_id: string | null }>(sql`
        select id, version, what_kind::text, what_org62_id, what_name, opportunity_id from activity_entries where dedupe_key like 'cal|primary|e_pick|%'`)).rows[0]!;
    const engine = await what();
    expect(engine.what_org62_id).not.toBe(OPP_ACME); // the engine's pick (Globex), not the opp we move it to
    const acme = (await db.execute<{ id: string; name: string }>(sql`select id, name from opportunities where org62_opportunity_id = ${OPP_ACME}`)).rows[0]!;

    const r = await call('patchActivity', { params: { id: engine.id }, body: { ifVersion: engine.version, patch: { oppId: acme.id, taskType: 'Discovery', status: 'approved' } } });
    expect(r.entity).toMatchObject({ oppId: acme.id, oppName: acme.name });
    expect(await what()).toMatchObject({ what_kind: 'opportunity', what_org62_id: OPP_ACME, what_name: acme.name, opportunity_id: acme.id });
    // the projection never rewrites a row you edited (src/projections/run.ts ownedRow, applyActivityWindow)
    expect((await project({ now: new Date(t0 + 40_000), full: true })).errors).toEqual([]);
    expect(await what()).toMatchObject({ what_kind: 'opportunity', what_org62_id: OPP_ACME, opportunity_id: acme.id });
    const batch = (at: Date) => buildLogBatch(db, userId, { now: at, timezone: PROFILE.timezone, approveComplete: false, recordTypeId: '012XX0000000MOCKAA', held: { rows: new Map(), updates: new Set() } });
    const line = (await batch(new Date(t0 + 40_000))).canvases.flatMap((c) => c.markdown.split('\n')).find((l) => l.includes('Globex roadmap sync'));
    expect(line).toContain(`|${OPP_ACME}|`);

    // cleared: no WhatId (the engine's account fallback is not put back on a row you own); the batch says why it skips it
    const cur = await what();
    await call('patchActivity', { params: { id: cur.id }, body: { ifVersion: cur.version, patch: { oppId: null } } });
    expect((await project({ now: new Date(t0 + 50_000), full: true })).errors).toEqual([]);
    expect(await what()).toMatchObject({ what_kind: 'none', what_org62_id: null, what_name: null, opportunity_id: null });
    expect((await batch(new Date(t0 + 50_000))).skipped.find((s) => s.id === cur.id)?.why).toMatch(/WhatId/);

    // D-55: the same rows as a Specialist AE's batch: Sales Events, no SE task type asked for or written
    const ae = await buildLogBatch(db, userId, { now: new Date(t0 + 50_000), timezone: PROFILE.timezone, approveComplete: true, recordTypeId: '012XX0000000MOCKAA', held: { rows: new Map(), updates: new Set() }, logging: loggingProfile(personaOf({ persona: { id: 'ae' } })) });
    expect(ae.skipped.every((x) => !/task type/.test(x.why))).toBe(true);
    for (const c of ae.canvases) {
      expect(c.markdown).toContain('(Sales Events)');
      expect(c.markdown).not.toContain('(Solutions Event)');
    }
  });

  it('D-18 amended: overlapping accepted meetings both log in the database; a setting change recomputes; your own dismissal stays', async () => {
    const t0 = NOW.getTime() + 12 * 60_000;
    const DAY = '2026-11-03';
    // Settings ▸ Time ▸ Overlapping meetings, saved through the contract, then the recompute the save starts (awaited here)
    const setOverlaps = async (v: 'log_all_accepted' | 'count_once', at: number) => {
      const cur = (await call('getSettings')).time;
      const r = await call('patchSettings', { params: { section: 'time' }, body: { ifVersion: cur.version, value: { overlaps: v } } });
      expect(r.entity.time.overlaps).toBe(v);
      expect((await recomputeWeeks({ store: projectionStore(db), userId, days: [DAY], now: new Date(at) })).errors).toEqual([]);
    };
    const rows = async () =>
      Object.fromEntries(
        (await db.execute<{ k: string; status: string; reason: string | null; flags: string[] }>(sql`
          select split_part(dedupe_key, '|', 3) as k, status::text, excluded_reason::text as reason, flags from activity_entries where dedupe_key like 'cal|primary|e_dbl_%'`)).rows.map((r) => [r.k, r]),
      );
    await setOverlaps('count_once', t0);
    await insert(calItem('e_dbl_a', { title: 'ACME pricing review', start: at('09:00', DAY), end: at('10:00', DAY), attendees: ACME_ATTENDEES, ended: true, attendance: 'attended' }));
    await insert(calItem('e_dbl_b', { title: 'Globex architecture deep dive', start: at('09:30', DAY), end: at('10:30', DAY), attendees: [{ email: ME.email, response: 'accepted' }, { email: 'kim@globex.example', response: 'accepted' }], ended: true, attendance: 'attended' }));
    expect((await project({ now: new Date(t0 + 10_000) })).errors).toEqual([]);
    // count once: the earlier customer meeting keeps the slot; the other is excluded as an overlap
    let r = await rows();
    expect(r.e_dbl_a!.status).not.toMatch(/excluded|dismissed/);
    expect(r.e_dbl_b).toMatchObject({ status: 'excluded', reason: 'overlap' });
    // you edit the excluded row: an overlap the engine decided is still not your dismissal
    await withChangeSet({ db, userId, actor: actors.user('test'), reason: 'user edits' }, (tx) =>
      tx.execute(sql`update activity_entries set description = 'my words', user_locked_fields = array['description'] where dedupe_key like 'cal|primary|e_dbl_b|%'`),
    );

    // the default: both come back and both log (the exclusion constraint now leaves calendar rows to the engine)
    await setOverlaps('log_all_accepted', t0 + 20_000);
    r = await rows();
    for (const k of ['e_dbl_a', 'e_dbl_b']) expect(r[k]!.status).toMatch(/^(proposed|needs_input)$/);
    expect(r.e_dbl_a!.flags).toContain("overlaps 'Globex architecture deep dive' 09:30–10:00 (both log)");
    expect(r.e_dbl_b!.flags).toContain("overlaps 'ACME pricing review' 09:30–10:00 (both log)");
    expect(r.e_dbl_b!.flags.some((f) => /counted once/.test(f))).toBe(false);
    expect((await db.execute<{ d: string }>(sql`select description as d from activity_entries where dedupe_key like 'cal|primary|e_dbl_b|%'`)).rows).toEqual([{ d: 'my words' }]);
    // (an edited row stays yours, flags included: hand it back so the passes below keep it current)
    await withChangeSet({ db, userId, actor: actors.user('test'), reason: 'user edits' }, (tx) =>
      tx.execute(sql`update activity_entries set user_locked_fields = '{}' where dedupe_key like 'cal|primary|e_dbl_b|%'`),
    );

    // (h) you dismiss one: it stays dismissed through every recompute, and never makes the other lose
    const [a] = (await db.execute<{ id: string; version: number }>(sql`select id, version from activity_entries where dedupe_key like 'cal|primary|e_dbl_a|%'`)).rows;
    await call('patchActivity', { params: { id: a!.id }, body: { ifVersion: a!.version, patch: { status: 'dismissed' } } });
    for (const [mode, dt] of [['count_once', 30_000], ['log_all_accepted', 40_000]] as const) {
      await setOverlaps(mode, t0 + dt);
      r = await rows();
      expect(r.e_dbl_a).toMatchObject({ status: 'dismissed', reason: null });
      expect(r.e_dbl_b!.status).toMatch(/^(proposed|needs_input)$/);
      expect(r.e_dbl_b!.flags.some((f) => /overlaps|double-booked/.test(f))).toBe(false);
    }
    // estimates and every other non-calendar row still never overlap (the database's exclusion constraint)
    expect(await n(`select count(*)::int as n from activity_entries a join activity_entries b on a.id < b.id and a.owner_user_id = b.owner_user_id
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
      where a.origin <> 'calendar' and b.origin <> 'calendar' and a.status not in ('excluded','dismissed','dropped') and b.status not in ('excluded','dismissed','dropped')`)).toBe(0);
  });
});

/**
 * AUDIT Part A: every projected kind links back to its original when its source has one (tenet: Provenance on
 * everything). Evidence chips, item origins, activity rows, meetings, files and deals. A source recorded through the
 * scanner store gets its link at ingest; a row stored before (the fixtures above, url null) gets it at read time.
 */
describe.skipIf(!pgAvailable)('provenance links', () => {
  it('every evidence chip, item origin, activity row, meeting, file and deal links to its original', async () => {
    const store = new DbScannerStore({ db, userId, clock: () => NOW });
    const hash = (x: string) => createHash('sha1').update(x).digest('hex');
    const win = { from: '2026-11-05T00:00:00.000Z', to: NOW.toISOString() };
    // Org62 through the store: no permalink of its own, so the store derives the Lightning record page
    const o62 = await store.startRun({ scope: { connector: 'org62', scope: 'events' }, trigger: 'schedule', window: win });
    const [ev] = await store.recordSourceItems(o62.runId, [
      { connector: 'org62', kind: 'record_snapshot', externalId: 'Event:00UXX000000009AAA@2026-11-06T15:00:00.000+0000', dedupeKey: 'org62:Event:00UXX000000009AAA@2026-11-06T15:00:00.000+0000', contentHash: hash('ev9'), occurredAt: '2026-11-06T15:00:00.000Z', title: 'ACME follow-up call', excerpt: 'type=Customer Meeting', oppHints: [OPP_ACME] },
    ]);
    const fixtureOpp = (await db.execute<{ id: string }>(sql`select id from source_items where external_id like ${`Opportunity:${OPP_ACME}@%`} limit 1`)).rows[0]!.id;
    const item = await store.proposeItem(o62.runId, { kind: 'task', title: 'Send ACME the follow-up deck', evidence: [{ sourceItemId: ev!.sourceItemId, role: 'origin', reason: 'placeholder' }, { sourceItemId: fixtureOpp, role: 'context', reason: 'placeholder' }], confidence: 'sure' });
    // a Claude session through the store: the Desktop continue link
    const cl = await store.startRun({ scope: { connector: 'claude_sessions', scope: 'all' }, trigger: 'schedule', window: win });
    const [sess] = await store.recordSourceItems(cl.runId, [
      { connector: 'claude_sessions', kind: 'claude_session', externalId: 'sess-link', dedupeKey: 'claude:sess-link', contentHash: hash('sess'), occurredAt: at('09:30'), title: 'ACME deck build', excerpt: 'built the deck', payload: { sessionId: 'sess-link', hostSessionId: 'local_sess-link', status: 'done', startedAt: at('09:00'), lastActivityAt: at('09:30') } },
    ]);
    await store.linkEvidence(cl.runId, { workItemId: item.workItemId, sourceItemId: sess!.sourceItemId, role: 'progress', confidence: 'likely', reason: 'placeholder' });
    // a Slack message with its permalink, and a fixture Claude session (url null: derived at read time)
    const sl = await store.startRun({ scope: { connector: 'slack', scope: 'dm' }, trigger: 'schedule', window: win });
    const [msg] = await store.recordSourceItems(sl.runId, [
      { connector: 'slack', kind: 'message', externalId: 'C0ACME0001:1762444800.000100', dedupeKey: 'slack:C0ACME0001:1762444800.000100', contentHash: hash('m'), occurredAt: at('08:40'), author: { name: ME.name, isMe: true }, permalink: 'https://slack.example/archives/C0ACME0001/p1762444800000100', excerpt: 'sending the deck today', payload: { channelId: 'C0ACME0001', channelName: 'acme-ext', ts: '1762444800.000100' } },
    ]);
    await store.linkEvidence(sl.runId, { workItemId: item.workItemId, sourceItemId: msg!.sourceItemId, role: 'progress', confidence: 'likely', reason: 'placeholder' });
    const fixtureSess = (await db.execute<{ id: string }>(sql`select id from source_items where dedupe_key = 'claude:sess-done'`)).rows[0]!.id;
    await store.linkEvidence(sl.runId, { workItemId: item.workItemId, sourceItemId: fixtureSess, role: 'context', confidence: 'guess', reason: 'placeholder' });
    const stored = await db.execute<{ dedupe_key: string; url: string | null }>(sql`select dedupe_key, url from source_items where id in (${ev!.sourceItemId}::uuid, ${sess!.sourceItemId}::uuid)`);
    expect(Object.fromEntries(stored.rows.map((r) => [r.dedupe_key, r.url]))).toEqual({
      'org62:Event:00UXX000000009AAA@2026-11-06T15:00:00.000+0000': 'https://org62.lightning.force.com/lightning/r/Event/00UXX000000009AAA/view',
      'claude:sess-link': 'claude://code/continue?session=local_sess-link',
    });
    const r = await project({ now: new Date(NOW.getTime() + 10 * 60_000), full: true });
    expect(r.errors).toEqual([]);

    const missing: string[] = [];
    const need = (what: string, url: unknown, kind?: string) => {
      if (typeof url !== 'string' || !url) return void missing.push(what);
      if (kind === 'org62' && !url.startsWith('https://org62.lightning.force.com/lightning/r/')) missing.push(`${what} (not a Lightning record URL: ${url})`);
      if (kind === 'claude' && !url.startsWith('claude://code/continue?session=')) missing.push(`${what} (not a continue link: ${url})`);
      if ((kind === 'slack' || kind === 'calendar' || kind === 'drive' || kind === 'gemini') && !url.startsWith('https://')) missing.push(`${what} (not https: ${url})`);
    };
    // evidence chips + the item's origin
    const evList: any[] = (await call('getItemEvidence', { params: { id: item.workItemId } })).evidence;
    expect(evList.length).toBe(5);
    for (const e of evList) need(`evidence ${e.source.kind} ${e.source.label}`, e.source.url, e.source.kind);
    const detail = await call('getItem', { params: { id: item.workItemId } });
    expect(detail.item.sources[0]).toMatchObject({ kind: 'org62', label: 'ACME follow-up call' }); // the origin first
    for (const src of detail.item.sources) need(`item origin ${src.kind}`, src.url, src.kind);
    // activity rows (this week and the last quarter's Org62 read-back)
    const linkedKinds = new Set<string>();
    for (const week of [{}, { week: '2026-10-12' }]) {
      const t = await call('getTime', { query: week });
      for (const e of t.entries) for (const src of e.sources) if (src.url) linkedKinds.add(src.kind);
      for (const e of t.entries) for (const src of e.sources) {
        if (src.kind === 'manual') continue;
        // the fixture Slack messages above were stored without a permalink: nothing to link to
        if (src.kind === 'slack' && !src.url && (await db.execute(sql`select 1 from source_items where external_id = ${src.externalId ?? ''} and url is null`)).rows.length) continue;
        need(`activity ${e.description} · ${src.kind} ${src.label}`, src.url, src.kind);
      }
    }
    // a meeting → its event, an Org62 row → its Event, a Slack burst → its first message, a session → its continue link
    expect([...linkedKinds].sort()).toEqual(expect.arrayContaining(['calendar', 'claude', 'org62', 'slack']));
    // meetings
    const cal = await call('getCalendar', { query: { from: '2026-11-05T07:00:00.000Z', to: '2026-11-07T06:59:59.000Z' } });
    for (const e of cal.events) need(`meeting ${e.title}`, e.source?.url, 'calendar');
    // deals: accounts and their opps
    const d = await call('getDeals');
    expect(d.accounts.length).toBeGreaterThan(0);
    let files = 0;
    for (const a of d.accounts) {
      need(`account ${a.name}`, a.org62Url, 'org62');
      const page = await call('getAccount', { params: { accountId: a.id } });
      for (const o of page.opps) need(`opp ${o.name}`, o.org62Url, 'org62');
      for (const f of page.assets) {
        files++;
        need(`file ${f.title}`, f.url, 'drive');
      }
    }
    // files (Drive assets), also through search (⌘K opens them)
    const found = await call('search', { query: { q: 'ACME POV deck' } });
    const hits = found.hits.filter((h: any) => h.ref.type === 'asset');
    for (const h of hits) need(`file ${h.title}`, h.ref.href, 'drive');
    expect(files + hits.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});


describe.skipIf(!pgAvailable)('meeting details (hover card, meeting panel)', () => {
  it('a scanned invite reads its agenda from the source body, guests and answers from the attendees table, files from its meta', async () => {
    const base = today('e_details', 'ACME agenda review', '16:30', '17:00', {
      attendees: [{ email: ME.email, response: 'accepted' }, { email: 'dana@acme.example', response: 'accepted' }, { email: 'lee@acme.example', response: 'tentative' }],
      attachments: [
        { title: 'ACME review deck', fileId: 'FILE_DETAILS_DECK', mimeType: 'application/vnd.google-apps.presentation' },
        { title: 'Notes by Gemini', fileId: 'DOC_DETAILS_NOTES', mimeType: 'application/vnd.google-apps.document' },
      ],
    });
    // what store-db writes: the one-line excerpt, a blank line, then the (redacted) description; no conference data
    const description = '<p>Agenda:</p><ul><li>Scope &amp; timeline</li><li>Open <b>questions</b></li></ul><a href="https://docs.example.com/acme-review">Review doc</a><br>-::~:~::~:~::-<br>Join with Google Meet: https://meet.example/xyz';
    await insert({
      ...base,
      body: `ACME agenda review - Agenda: Scope & timeline Open questions\n\n${description}`,
      meta: { ...base.meta, meetingLink: undefined, location: 'Zoom https://acme.zoom.us/j/123456789', author: { name: 'Dana Placeholder', email: 'dana@acme.example' } },
    });
    // a control: conference data on the invite and no description
    await insert(today('e_plain', 'Initech check-in', '08:00', '08:30', { attendees: [{ email: ME.email, response: 'accepted' }, { email: 'pat@initech.example', response: 'accepted' }], organizer: 'pat@initech.example' }));
    const res = await project({ full: true });
    expect(res.errors).toEqual([]);

    const id = (await db.execute<{ id: string }>(sql`select id from calendar_events where external_event_id = 'e_details'`)).rows[0]!.id;
    const d = await call('getCalendarEvent', { params: { id } });
    const ev = d.event;
    expect(ev.agenda).toBe('Agenda:\n• Scope & timeline\n• Open questions\nReview doc (https://docs.example.com/acme-review)');
    expect(ev.agenda).not.toMatch(/<|&amp;/);
    // no conference data on the invite: the Zoom link in the location is the join link
    expect(ev.meetingUrl).toBe('https://acme.zoom.us/j/123456789');
    // no person record for the organizer: the invite's display name, not the bare address
    expect(ev.organizer).toEqual({ name: 'Dana Placeholder', personId: null, isMe: false, isExternal: true });
    expect(ev.attendees.map((a: any) => [a.name, a.response, !!a.organizer, !!a.isExternal])).toEqual([
      ['dana@acme.example', 'accepted', true, true],
      ['lee@acme.example', 'tentative', false, true],
    ]);
    expect(ev.attachments).toEqual([
      { title: 'ACME review deck', url: 'https://docs.google.com/presentation/d/FILE_DETAILS_DECK/edit', kind: 'deck' },
      { title: 'Notes by Gemini', url: 'https://docs.google.com/document/d/DOC_DETAILS_NOTES/edit', kind: 'doc' },
    ]);
    expect(d.readIn).toBeNull();
    // the list read carries the same details (the hover card and the panel agree with the spine)
    const cal = await call('getCalendar', { query: {} });
    expect(cal.events.find((e: any) => e.id === id)).toEqual(ev);
    // the agenda is message text: it stays in the source body (90-day retention), never copied into ext
    expect(await n(`select count(*)::int as n from user_settings where key like 'cc.ext/calendar_events/%' and value::text like '%Scope%'`)).toBe(0);

    // an invite with conference data keeps it, and one without a description has no agenda
    const plain = cal.events.find((e: any) => e.title === 'Initech check-in');
    expect(plain.meetingUrl).toBe('https://meet.example/abc');
    expect(plain.agenda).toBeNull();
    expect(plain.attachments).toEqual([]);
    expect(plain.attendees.map((a: any) => [a.response, !!a.organizer])).toEqual([['accepted', true]]);

    // a purged body (90 days) leaves the event without an agenda, nothing else changes
    await db.execute(sql`update source_items set body = null, body_purged_at = now() where dedupe_key = 'cal:e_details'`);
    const after = await call('getCalendarEvent', { params: { id } });
    expect(after.event.agenda).toBeNull();
    expect(after.event.attachments).toHaveLength(2);
  });

  it('an unknown meeting is not_found', async () => {
    await expect(ds.getCalendarEvent({ params: { id: '00000000-0000-4000-8000-00000000dead' } })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe.skipIf(!pgAvailable)('my DCs on Postgres (D-58): read from the scan, checked by every request, confirmed by the next scan', () => {
  const T0 = NOW.getTime() + 60 * 60_000;
  const oppRow = async (org62: string) => (await db.execute<{ id: string; on_my_team: boolean }>(sql`select id, on_my_team from opportunities where org62_opportunity_id = ${org62}`)).rows[0]!;
  const acctOf = async (org62Acct: string) => (await db.execute<{ id: string }>(sql`select id from accounts where org62_account_id = ${org62Acct}`)).rows[0]!.id;
  const held = { rows: new Map<string, string>(), updates: new Set<string>() };

  it('persists each DC of mine (Org62 id, opp, split, role, last seen) and keeps the DC apart from the team', async () => {
    expect((await project({ now: new Date(T0), full: true })).errors).toEqual([]);
    const rows = (
      await db.execute<{ org62_dc_id: string; opp: string | null; split_percent: number; role: string; is_mine: boolean; deleted_upstream_at: Date | null; last_seen_at: Date }>(sql`
        select dc.org62_dc_id, o.org62_opportunity_id as opp, dc.split_percent, dc.role, dc.is_mine, dc.deleted_upstream_at, dc.last_seen_at
          from deal_contributions dc left join opportunities o on o.id = dc.opportunity_id order by dc.org62_dc_id`)
    ).rows;
    expect(rows.map((r) => [r.org62_dc_id, r.opp, Number(r.split_percent), r.role, r.is_mine, r.deleted_upstream_at])).toEqual([
      ['a0XXX000000001AAA', OPP_GLOBEX, 100, 'AI + Data Architect', true, null],
      ['a0XXX000000009AAA', OPP_GLOBEX_2, 100, 'AI + Data Architect', true, null],
    ]);
    expect(rows.every((r) => !!r.last_seen_at)).toBe(true);
    // a DC alone is not "on my team": the opp says myDc (split, role); isMine is the team only
    expect((await oppRow(OPP_GLOBEX)).on_my_team).toBe(false);
    const globex = (await call('getAccount', { params: { accountId: await acctOf(ACCT_GLOBEX) } })).opps.find((o: any) => o.name === 'Globex - Agent Rollout');
    expect(globex).toMatchObject({ isMine: false, dcAssigned: true, myDc: { split: 100, role: 'AI + Data Architect', org62DcId: 'a0XXX000000001AAA' } });
    const acme = (await call('getAccount', { params: { accountId: await acctOf(ACCT_ACME) } })).opps.find((o: any) => o.name === 'ACME - Data 360 Expansion');
    expect(acme).toMatchObject({ isMine: true, dcAssigned: false, myDc: null });
    // the Deals row and the DC list say it too
    expect((await call('getDeals')).accounts.find((a: any) => a.name.startsWith('Globex')).myDcs).toEqual(expect.arrayContaining([{ oppId: globex.id, oppName: 'Globex - Agent Rollout', split: 100, role: 'AI + Data Architect' }]));
    expect((await call('listDcRequests')).myDcs.map((d: any) => [d.org62DcId, d.split, d.role]).sort()).toEqual([
      ['a0XXX000000001AAA', 100, 'AI + Data Architect'],
      ['a0XXX000000009AAA', 100, 'AI + Data Architect'],
    ]);
    // idempotent: the same read again writes nothing
    const again = await project({ now: new Date(T0 + 60_000), full: true });
    expect(again.written.deal_contributions).toBe(0);
  });

  it('the incident: holding 100%, a request for 100% is refused and 50% becomes a change row on that DC', async () => {
    await expect(ds.createDcRequest({ body: { opp: OPP_GLOBEX, split: 100, comment: 'Ran the agent build' } } as never)).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/You already hold a 100% DC on Globex - Agent Rollout \(AI \+ Data Architect\)/) });
    expect(await n('select count(*)::int as n from deal_contribution_requests')).toBe(0);
    const c = await call('createDcRequest', { body: { opp: OPP_GLOBEX, split: 50, comment: 'Shared it with the partner SE' } });
    expect(c.entity).toMatchObject({ kind: 'change', fromSplit: 100, splitPercent: 50, stage: 'waiting', dc: { split: 100, org62DcId: 'a0XXX000000001AAA' } });
    const stored = (await db.execute<{ kind: string; dc: string }>(sql`select kind, (select org62_dc_id from deal_contributions where id = deal_contribution_id) as dc from deal_contribution_requests`)).rows[0]!;
    expect(stored).toMatchObject({ kind: 'change', dc: 'a0XXX000000001AAA' });
    // nothing ready in the range: the change waits for a canvas with rows; Log DCs now makes one on purpose
    const quiet = await buildLogBatch(db, userId, { now: new Date(T0), timezone: PROFILE.timezone, approveComplete: false, recordTypeId: '012XX0000000MOCKAA', held, from: '2027-01-01' });
    expect(quiet.canvases).toEqual([]);
    const own = await buildLogBatch(db, userId, { now: new Date(T0), timezone: PROFILE.timezone, approveComplete: false, recordTypeId: '012XX0000000MOCKAA', held, dcOnly: true });
    expect(own.canvases).toHaveLength(1);
    // WO-1: the change is a row of DEAL CONTRIBUTIONS TO UPDATE (Record Id = the DC), never a second DC to create
    expect(own.canvases[0]!.markdown).toMatch(/## DEAL CONTRIBUTIONS TO UPDATE \(1 row · 1 DC change\)\n\n\*\*DEAL CONTRIBUTIONS TO UPDATE:\*\*/);
    expect(own.canvases[0]!.markdown).toContain('|1|a0XXX000000001AAA|Split_Percentage__c|50|100|Change your DC 100% → 50% on Globex - Agent Rollout · Shared it with the partner SE|');
    expect(own.canvases[0]!.markdown).not.toContain('## DEAL CONTRIBUTIONS TO CREATE');
    // withdraw it (it never went on a canvas), then Undo puts it back
    const w = await call('withdrawDcRequest', { params: { id: c.entity.id }, body: {} });
    expect(w.entity.stage).toBe('dismissed');
    await call('undoAudit', { params: { id: w.auditId }, body: {} });
    expect((await call('listDcRequests')).requests[0]).toMatchObject({ id: c.entity.id, stage: 'waiting' });
    // edit it: the split is re-checked against my DC (back to 100% is refused)
    await expect(ds.patchDcRequest({ params: { id: c.entity.id }, body: { split: 100 } } as never)).rejects.toMatchObject({ code: 'conflict' });
    expect((await call('patchDcRequest', { params: { id: c.entity.id }, body: { split: 60 } })).entity).toMatchObject({ kind: 'change', fromSplit: 100, splitPercent: 60 });
    await call('withdrawDcRequest', { params: { id: c.entity.id }, body: {} });
  });

  it('the next scan confirms a request once Org62 shows my DC on the opp (DC-03: at any split), and links it to that DC', async () => {
    const c = await call('createDcRequest', { body: { opp: OPP_ACME, split: 50, comment: 'Built the POV deck and demo' } });
    expect(c.entity).toMatchObject({ kind: 'add', stage: 'waiting', dc: null });
    // the DC was made by hand at another split: Org62 wins, the request is answered (never a second ADD row)
    await insert(org62Item('Deal_Contribution__c:a0XXX0000000010AAA@2026-11-06T17:00:00.000+0000', { title: 'DC on ACME - Data 360 Expansion', meta: { Opportunity__c: OPP_ACME, Opportunity_Role__c: 'AI + Data Architect', Split_Percentage__c: 100 }, body: 'role=AI + Data Architect; split=100', accountHints: [ACCT_ACME, 'ACME Corporation'], oppHints: [OPP_ACME] }));
    const r = await project({ now: new Date(T0 + 2 * 60_000) });
    expect(r.errors).toEqual([]);
    expect(r.written.deal_contributions).toBeGreaterThanOrEqual(2); // the DC, and the request it confirmed
    const done = (await call('listDcRequests')).requests.find((x: any) => x.id === c.entity.id);
    expect(done).toMatchObject({ status: 'verified', stage: 'confirmed', dc: { split: 100, org62DcId: 'a0XXX0000000010AAA' } });
    const link = (await db.execute<{ dc: string }>(sql`select (select org62_dc_id from deal_contributions where id = r.deal_contribution_id) as dc from deal_contribution_requests r where r.id = ${c.entity.id}`)).rows[0]!;
    expect(link.dc).toBe('a0XXX0000000010AAA');
  });

  it('my DC shows its split on the opp the account lists, even when the DC row points at another row for the same Org62 opp; the next pass re-links it', async () => {
    const visible = await oppRow(OPP_GLOBEX);
    // a second, archived row for the same Org62 opp (15-character id), and my DC linked to it instead
    const { result: dup } = await withChangeSet({ db, userId, actor: actors.system('test'), reason: 'a duplicate opp row' }, async (tx) => {
      const id = (
        await tx.execute<{ id: string }>(sql`
          insert into opportunities (id, owner_user_id, account_id, org62_opportunity_id, name, is_closed, on_my_team, archived_at)
          select gen_random_uuid(), owner_user_id, account_id, left(org62_opportunity_id, 15), name, is_closed, on_my_team, now() from opportunities where id = ${visible.id}
          returning id`)
      ).rows[0]!.id;
      await tx.execute(sql`update deal_contributions set opportunity_id = ${id} where org62_dc_id = 'a0XXX000000001AAA'`);
      return id;
    });
    expect(dup).toBeTruthy();
    const opp = async () => (await call('getAccount', { params: { accountId: await acctOf(ACCT_GLOBEX) } })).opps.find((o: any) => o.id === visible.id);
    // never "Assigned (the next Org62 scan reads its split)": dcAssigned and myDc agree
    expect(await opp()).toMatchObject({ dcAssigned: true, myDc: { split: 100, role: 'AI + Data Architect', org62DcId: 'a0XXX000000001AAA' } });
    expect((await call('getDeals')).needs.flatMap((n: any) => n.opps.map((g: any) => g.oppId))).not.toContain(visible.id);
    // the next full pass links the DC back to the row the app lists
    expect((await project({ now: new Date(T0 + 4 * 60_000), full: true })).errors).toEqual([]);
    expect((await db.execute<{ opp: string }>(sql`select opportunity_id as opp from deal_contributions where org62_dc_id = 'a0XXX000000001AAA'`)).rows[0]!.opp).toBe(visible.id);
    expect(await opp()).toMatchObject({ dcAssigned: true, myDc: { split: 100 } });
  });
});

/**
 * D-64 on Postgres: internal-only activity (the real projection path), the batch for an internal row, "Dismiss all
 * from <source>" through re-projection, Undo and Remove, and meetings declined after they were accepted.
 */
describe.skipIf(!pgAvailable)('D-64 on Postgres: internal rows, dismiss rules, declined meetings', () => {
  const T1 = NOW.getTime() + 30 * 60_000;
  const later = (min: number) => new Date(T1 + min * 60_000);
  const row = async (like: string) =>
    (
      await db.execute<{ id: string; version: number; status: string; what_kind: string; what_org62_id: string | null; customer_related: boolean; customer_facing: boolean; task: string | null; flags: string[] }>(sql`
        select a.id, a.version, a.status::text as status, a.what_kind::text as what_kind, a.what_org62_id, a.customer_related, a.customer_facing, t.name as task, a.flags
          from activity_entries a left join se_task_types t on t.id = a.se_task_type_id where a.dedupe_key like ${like}`)
    ).rows;
  // an evening session (18:00–20:00 Denver, nothing else on the calendar then) in a repo no account matches
  const repoDay = (day: string) => {
    const si = sessionItem(`sess-kit-${day}`, { title: 'Demo kit portal build', body: 'first prompt text\n\nBuilt the portal flow.', cwd: '/Users/example/Projects/demo-kit', startedAt: at('18:00', day), lastActivityAt: at('20:00', day), lastHumanPromptAt: at('19:50', day) });
    return { ...si, meta: { ...si.meta, repo: 'demo-kit' } };
  };

  it('a repo no account matches is internal: what_kind none, no WhatId, CF / CR off, Asset Creation, proposed; the read model says internal', async () => {
    await insert(repoDay('2026-11-03'));
    expect((await project({ now: later(1), full: true })).errors).toEqual([]);
    const [r] = await row('wb|2026-11-03|repo:demo-kit');
    expect(r).toMatchObject({ status: 'proposed', what_kind: 'none', what_org62_id: null, customer_related: false, customer_facing: false, task: 'Asset Creation' });
    expect(r!.flags.some((f) => /NEEDS WhatId/.test(f))).toBe(false);
    const e = (await call('getActivityLog', { query: {} })).entries.find((x: any) => x.id === r!.id);
    expect(e).toMatchObject({ internal: true, oppId: null, taskType: 'Asset Creation', dismissSource: { key: 'repo:demo-kit', kind: 'repo', label: 'demo-kit' } });
  });

  it('Log it: approved, the batch puts it on the canvas with an empty WhatId and its type; a proposed internal row is never taken', async () => {
    const [r] = await row('wb|2026-11-03|repo:demo-kit');
    const batch = () => buildLogBatch(db, userId, { now: later(2), timezone: PROFILE.timezone, approveComplete: true, recordTypeId: '012XX0000000MOCKAA', held: { rows: new Map(), updates: new Set() } });
    expect((await batch()).canvases.flatMap((c) => c.eventIds)).not.toContain(r!.id);
    await call('patchActivity', { params: { id: r!.id }, body: { ifVersion: r!.version, patch: { status: 'approved' } } });
    const b = await batch();
    const md = b.canvases.map((c) => c.markdown).join('\n');
    const line = md.split('\n').find((l) => l.includes('demo-kit: internal asset build'))!;
    expect(line).toMatch(/\|Asset Creation\|[\d.]+\|\|/);
    // WO-1: the old **Internal rows:** paragraph is now a sentence in the EVENTS TO CREATE rule (D-64: empty WhatId, never guessed)
    expect(md).toMatch(/\*\*EVENTS TO CREATE:\*\*[^\n]*A row whose WhatId is empty is internal work with no opportunity: create it with WhatId \(Related To\) left empty/);
    expect(b.skipped.find((s) => s.id === r!.id)).toBeUndefined();
  });

  it('the picker\'s Internal on a no-opp row clears every WhatId column and survives a full re-projection; an opp takes it back', async () => {
    await insert(calItem('e_d64_int', { title: 'Weekly vendor tooling sync', start: at('13:00', '2026-11-02'), end: at('13:30', '2026-11-02'), attendees: [{ email: ME.email, response: 'accepted' }, { email: 'lee@vendor.example', response: 'accepted' }], ended: true, attendance: 'attended' }));
    expect((await project({ now: later(3), full: true })).errors).toEqual([]);
    const [r] = await row('cal|primary|e_d64_int|%');
    expect(r!.status).toBe('needs_input'); // an external attendee, no account: it can't classify, so it asks
    const p = await call('patchActivity', { params: { id: r!.id }, body: { ifVersion: r!.version, patch: { internal: true, status: 'approved' } } });
    expect(p.entity).toMatchObject({ internal: true, oppId: null, status: 'approved', meetingType: null });
    expect((await project({ now: later(4), full: true })).errors).toEqual([]);
    const [after] = await row('cal|primary|e_d64_int|%');
    expect(after).toMatchObject({ status: 'approved', what_kind: 'none', what_org62_id: null, customer_related: false, customer_facing: false });
    const acme = (await db.execute<{ id: string }>(sql`select id from opportunities where org62_opportunity_id = ${OPP_ACME}`)).rows[0]!;
    const back = await call('patchActivity', { params: { id: after!.id }, body: { ifVersion: after!.version, patch: { oppId: acme.id } } });
    expect(back.entity).toMatchObject({ internal: false, oppId: acme.id });
    expect((await row('cal|primary|e_d64_int|%'))[0]).toMatchObject({ what_kind: 'opportunity', what_org62_id: OPP_ACME });
  });

  it('Dismiss all from the repo: its live rows now and every new one; Undo and Remove bring them back through the projection', async () => {
    await insert(repoDay('2026-11-02'));
    expect((await project({ now: later(5), full: true })).errors).toEqual([]);
    const [mon] = await row('wb|2026-11-02|repo:demo-kit');
    expect(mon!.status).toBe('proposed');
    const d = await call('dismissFromSource', { body: { entryId: mon!.id } });
    expect(d.entity.rule).toMatchObject({ key: 'repo:demo-kit', label: 'demo-kit', rows: 1 });
    expect(d.entity.dismissedIds).toEqual([mon!.id]); // the approved row (Log it) is yours: untouched
    expect((await row('wb|2026-11-03|repo:demo-kit'))[0]!.status).toBe('approved');
    // a new day of the repo, and a full re-projection: still set aside, and the new one too
    await insert(repoDay('2026-11-05'));
    expect((await project({ now: later(6), full: true })).errors).toEqual([]);
    for (const day of ['2026-11-02', '2026-11-05']) {
      const [x] = await row(`wb|${day}|repo:demo-kit`);
      expect(x!.status).toBe('dismissed');
      expect(x!.flags.some((f) => f.startsWith('Dismissed by your rule'))).toBe(true);
    }
    const log = (await call('getActivityLog', { query: {} })).entries.filter((x: any) => x.dismissSource?.key === 'repo:demo-kit' && x.status === 'dismissed');
    expect(log.map((x: any) => x.excludedReason)).toEqual(['dismiss_rule', 'dismiss_rule']);
    expect((await call('listTimeDismissRules')).rules).toEqual([expect.objectContaining({ key: 'repo:demo-kit', rows: 2 })]);
    // Undo: the rule goes, the row it set aside is back; the one a later pass set aside comes back on the next pass
    await call('undoAudit', { params: { id: d.auditId }, body: {} });
    expect((await call('listTimeDismissRules')).rules).toEqual([]);
    expect((await project({ now: later(7), full: true })).errors).toEqual([]);
    for (const day of ['2026-11-02', '2026-11-05']) expect((await row(`wb|${day}|repo:demo-kit`))[0]!.status).toBe('proposed');
    // again, then Remove (Settings ▸ Time): the rows come back right away, the weeks recomputed
    const [mon2] = await row('wb|2026-11-02|repo:demo-kit');
    await call('dismissFromSource', { body: { entryId: mon2!.id } });
    const rm = await call('removeTimeDismissRule', { body: { key: 'repo:demo-kit' } });
    expect(rm.entity.rules).toEqual([]);
    for (const day of ['2026-11-02', '2026-11-05']) {
      const [x] = await row(`wb|${day}|repo:demo-kit`);
      expect(x!.status).toBe('proposed');
      expect(x!.flags.some((f) => f.startsWith('Dismissed by your rule'))).toBe(false);
    }
  });

  it('declined after accepting: my approved row goes; a logged one is flagged and kept; per instance of a series', async () => {
    const acc = (id: string, from: string, to: string, day: string, response = 'accepted') =>
      calItem(id, { title: 'ACME roadmap review', start: at(from, day), end: at(to, day), myResponse: response, attendees: [{ email: ME.email, response }, { email: 'dana@acme.example', response: 'accepted' }], ended: true, attendance: response === 'declined' ? 'missed' : 'attended', changedAt: later(8).toISOString() });
    await insert(acc('e_d64_a', '08:00', '08:30', '2026-11-04'));
    await insert(acc('e_d64_b', '08:30', '09:00', '2026-11-04'));
    await insert(acc('e_d64w_20261102T150000Z', '08:00', '08:30', '2026-11-02'));
    await insert(acc('e_d64w_20261103T150000Z', '08:00', '08:30', '2026-11-03'));
    expect((await project({ now: later(9), full: true })).errors).toEqual([]);
    const [a] = await row('cal|primary|e_d64_a|%');
    const [b] = await row('cal|primary|e_d64_b|%');
    expect(a && b).toBeTruthy();
    await call('patchActivity', { params: { id: a!.id }, body: { ifVersion: a!.version, patch: { status: 'approved' } } });
    // b: approved, on a canvas Slackbot ran (handed off), and in Org62 since (the read-back finds its Event)
    await call('patchActivity', { params: { id: b!.id }, body: { ifVersion: b!.version, patch: { status: 'approved' } } });
    await withChangeSet({ db, userId, actor: actors.user('test'), reason: 'a delivered canvas' }, (tx) => tx.execute(sql`update activity_entries set status = 'synced_to_canvas', synced_to_canvas_at = now() where id = ${b!.id}::uuid`));
    await insert(org62Item('Event:00UXX000000064AAA@2026-11-05T19:00:00.000+0000', { title: 'ACME roadmap review', meta: { SE_Task_Type__c: b!.task, Duration__c: 0.5, WhatId: OPP_ACME }, body: `type=${b!.task}; rt=Solutions Event; start=${at('08:30', '2026-11-04')}; hrs=0.5; what=ACME - Data 360 Expansion`, oppHints: [OPP_ACME] }));
    expect((await project({ now: later(9.5), full: true })).errors).toEqual([]);
    expect((await row('cal|primary|e_d64_b|%'))[0]!.status).toMatch(/^(logged|verified|verify_failed)$/);
    // then I decline both, and one instance of the series
    const declines = [['e_d64_a', '2026-11-04', '08:00', '08:30'], ['e_d64_b', '2026-11-04', '08:30', '09:00'], ['e_d64w_20261103T150000Z', '2026-11-03', '08:00', '08:30']] as const;
    for (const [id, day, from, to] of declines) await insert(acc(id, from, to, day, 'declined'));
    expect((await project({ now: later(10), full: true })).errors).toEqual([]);
    expect(await row('cal|primary|e_d64_a|%')).toEqual([]);
    // handed off and in Org62: kept, flagged, never deleted from Org62
    const [kept] = await row('cal|primary|e_d64_b|%');
    expect(kept!.status).toMatch(/^(logged|verified|verify_failed)$/);
    expect(kept!.flags).toContain(DECLINED_LOGGED_FLAG);
    expect(await n(`select count(*)::int as n from org62_events where org62_event_id = '00UXX000000064AAA' and deleted_upstream_at is null`)).toBe(1);
    expect(await row('cal|primary|e_d64w_20261103T150000Z|%')).toEqual([]);
    expect((await row('cal|primary|e_d64w_20261102T150000Z|%'))[0]!.status).toMatch(/^(proposed|needs_input)$/);
  });
});

describe.skipIf(!pgAvailable)('D-66 on Postgres: the Org62 Description is a teammate’s note', () => {
  const T2 = NOW.getTime() + 60 * 60_000;
  const later = (min: number) => new Date(T2 + min * 60_000);
  const SUMMARY = 'Discovery session with the ACME data team on their profile sources. Next step: Send the POC plan.';
  const NOTES_BODY = 'The ACME data team walked through their profile sources and the consent model.\n\nSE to send the POC plan by Friday.';
  const rowOf = async () =>
    (await db.execute<{ id: string; version: number; status: string; locks: string[] }>(sql`select id, version, status::text as status, user_locked_fields as locks from activity_entries where dedupe_key like 'cal|primary|e_d65|%'`)).rows[0]!;
  const entryOf = async (id: string) => (await call('getActivityLog', { query: {} })).entries.find((x: any) => x.id === id);
  let calls = 0;
  const fake = async () => {
    calls += 1;
    return { ok: true, text: `"${SUMMARY}"`, costUsd: 0.0012, inputTokens: 900, outputTokens: 40 };
  };
  const ctx = (now: Date) =>
    ({ job: { id: null, payload: {} }, signal: new AbortController().signal, db, userId, clock: () => now, log: () => {}, heartbeat: async () => {}, enqueue: async () => ({ inserted: false }), services: {} }) as never;

  it('every row is projected with the template’s note: with whom (the team), the topic, the VDP use case', async () => {
    await db.execute(sql`
      insert into vdp_records (owner_user_id, vdp_slug, detail)
      values (${userId}, 'acme-d65', ${JSON.stringify({ useCases: [{ id: 'uc1', title: 'Unified customer profile', priority: '3 - High' }], salesforceOpportunityId: OPP_ACME, salesforceOpportunityIds: [OPP_ACME] })}::jsonb)`);
    await insert(calItem('e_d65', { title: 'ACME <> Salesforce | Data model review', start: at('09:00', '2026-11-04'), end: at('10:00', '2026-11-04'), attendees: ACME_ATTENDEES, ended: true, attendance: 'attended', changedAt: later(0).toISOString() }));
    expect((await project({ now: later(1), full: true })).errors).toEqual([]);
    const r = await rowOf();
    expect(r.status).toBe('proposed');
    const e = await entryOf(r.id);
    expect(e).toMatchObject({ logNoteBasis: 'template' });
    expect(e.logNote).toMatch(/ with the ACME .*team on Data model review \(use case: Unified customer profile\)\.$/);
    expect(e.logNote.length).toBeLessThanOrEqual(300);
  });

  it('activity.notes: where meeting notes exist, one cheap call under the hard cap; the row takes it (basis summary); the same notes never cost twice', async () => {
    const g = geminiItem('DOC_GEMINI_D65', 'e_d65', 1, 0);
    await insert({ ...g, occurredAt: at('10:00', '2026-11-04'), body: NOTES_BODY });
    expect((await project({ now: later(2) })).errors).toEqual([]);
    const { runActivityNotes } = await import('../../../src/jobs/handlers/activity-notes');

    // at the daily hard cap nothing is called; the template stays
    const day = '2026-11-06';
    await db.execute(sql`insert into llm_calls (owner_user_id, purpose, model, model_tier, request_hash, status, cost_usd, budget_day) values (${userId}, 'other', 'claude-haiku-5-5', 'haiku', 'd65-cap', 'ok', 500, ${day}::date)`);
    const capped = await runActivityNotes(ctx(later(3)), { model: fake as never });
    expect(capped).toMatchObject({ status: 'deferred_budget', deferred: 'daily_hard_cap', calls: 0 });
    expect(calls).toBe(0);
    await db.execute(sql`delete from llm_calls where request_hash = 'd65-cap'`);

    const res = await runActivityNotes(ctx(later(4)), { model: fake as never });
    expect(res).toMatchObject({ status: 'done', calls: 1, summarized: 1 });
    expect(calls).toBe(1);
    expect(await n(`select count(*)::int as n from llm_calls where skill_key = 'activity-note' and purpose = 'summarize' and budget = 'daily'`)).toBe(1);
    const r = await rowOf();
    expect(await entryOf(r.id)).toMatchObject({ logNote: SUMMARY, logNoteBasis: 'summary' });
    // cached for these notes and facts
    expect(await runActivityNotes(ctx(later(5)), { model: fake as never })).toMatchObject({ status: 'nothing_to_do' });
    expect(calls).toBe(1);
  });

  it('an approved row you have not edited still takes the newer note; your edit is locked and never rewritten', async () => {
    const r = await rowOf();
    await call('patchActivity', { params: { id: r.id }, body: { ifVersion: r.version, patch: { status: 'approved' } } });
    // newer notes (a re-summary): the approved row's note follows, nothing else of it changes
    await withChangeSet({ db, userId, actor: actors.user('test'), reason: 'newer summary' }, (tx) =>
      tx.execute(sql`update user_settings set value = jsonb_set(value, '{logSummary,note}', ${JSON.stringify('Workshop with the ACME data team on consent. Next step: Share the consent model.')}::jsonb)
                      where owner_user_id = ${userId} and key like 'cc.ext/meeting_notes/%' and value ? 'logSummary'`),
    );
    expect((await project({ now: later(6), full: true })).errors).toEqual([]);
    const approved = await entryOf(r.id);
    expect(approved).toMatchObject({ status: 'approved', logNote: 'Workshop with the ACME data team on consent. Next step: Share the consent model.', logNoteBasis: 'summary' });

    const mine = 'Data model review with the ACME data team; agreed the consent fields. Next step: Send the POC plan.';
    const p = await call('patchActivity', { params: { id: r.id }, body: { ifVersion: approved.version, patch: { logNote: mine } } });
    expect(p.entity).toMatchObject({ logNote: mine, logNoteBasis: null });
    expect(p.entity.userLockedFields).toContain('logNote');
    expect((await rowOf()).locks).toContain('log_note');
    expect((await project({ now: later(7), full: true })).errors).toEqual([]);
    expect(await entryOf(r.id)).toMatchObject({ logNote: mine, logNoteBasis: null });
    // the job never asks about a row whose note is yours
    const { runActivityNotes } = await import('../../../src/jobs/handlers/activity-notes');
    expect(await runActivityNotes(ctx(later(8)), { model: fake as never })).toMatchObject({ status: 'nothing_to_do', candidates: 0 });
  });

  it('the work order: the note, then the exact CC#<uuid> token at the end', async () => {
    const r = await rowOf();
    const b = await buildLogBatch(db, userId, { now: later(9), timezone: PROFILE.timezone, approveComplete: false, recordTypeId: '012XX0000000MOCKAA', held: { rows: new Map(), updates: new Set() } });
    const md = b.canvases.map((c) => c.markdown).join('\n');
    const line = md.split('\n').find((l) => l.includes(`CC#${r.id}`))!;
    expect(line).toMatch(new RegExp(`\\|Data model review with the ACME data team; agreed the consent fields\\. Next step: Send the POC plan\\. · CC#${r.id}\\|$`));
  });
});
