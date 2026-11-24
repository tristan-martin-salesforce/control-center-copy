/**
 * Specialist Forecast (lane A), the pure parts: the pinned read-only SOQL and its parsers, note age from History,
 * the threshold boundaries of the weekly queue and the Deal Role audit, missing-record detection, the ONE canvas of
 * UPDATE rows (and its dry-run payload), canvasHolds keeping anything from being staged twice, and the read-back that
 * flags a note that didn't land. Placeholder data only.
 */
import { describe, expect, it } from 'vitest';

import { EMPTY_FORECAST_PENDING, type Draft, type ForecastSyncState, type Opportunity, type SpecialistForecast } from '../../src/contract';
import { buildForecastView, LAND_GRACE_MS } from '../../src/engines/forecast/view';
import { forecastCanvasActionFor, packForecastRows, renderForecastWorkOrder } from '../../src/engines/forecast/canvas';
import { forecastThresholds, missingForecasts, needsRoleFix, notesVerdict } from '../../src/engines/forecast/queue';
import { notesDue, nextSfrQuarter, quarterPair, sfrQuarterBounds, sfrQuarterOfDay } from '../../src/engines/forecast/time';
import { canvasHolds } from '../../src/lib/canvas/payload';
import { canvasRowsOf } from '../../src/lib/canvas/preflight';
import { actionPayloadFor } from '../../src/lib/actions';
import { ORG62_SCAN_TOOLS } from '../../src/llm/mcp-config';
import { AE_PERSONA, personaOf, SE_PERSONA } from '../../src/personas';
import { ForecastSoqlError, parseNotesHistory, parseSfrRecords, sfInstantToIso, sfrNotesHistorySoql, sfrRecordsSoql } from '../../src/server/forecast/soql';
import { draftTargets, patchedPending, stagePlan } from '../../src/server/forecast/service';
import { placeholderDraft } from '../../src/server/forecast/draft';
import { actionDraftFor } from '../../src/server/vdp/coverage';

const TZ = 'America/Denver';
/** Thursday 2026-11-05 09:02 Denver. */
const NOW = Date.parse('2026-11-05T16:02:00Z');
const DAY = 86_400_000;
const OWNER = '005XX0000000OWNAAA';
const ae = personaOf({ persona: { version: 1, id: 'ae', level: null, rules: {}, customRules: [], thresholds: {}, features: {}, connectors: {} } });
const se = personaOf({});
const t = forecastThresholds(ae);
const sync: ForecastSyncState = { status: 'ok', lastAt: new Date(NOW).toISOString(), note: null, records: 0, nextAt: null };

let n = 0;
function rec(x: Partial<SpecialistForecast> = {}): SpecialistForecast {
  n += 1;
  const id = `aDdXX0000000TEST${String(n).padStart(2, '0')}`;
  return {
    id: `00000000-0000-4000-b000-${String(n).padStart(12, '0')}`,
    org62Id: id,
    name: `SF-${n}`,
    url: null,
    org62OpportunityId: null,
    opportunityId: null,
    accountId: null,
    opportunityName: `Placeholder opp ${n}`,
    accountName: 'Placeholder Co',
    oppStage: null,
    oppNextStep: null,
    oppCloseDate: null,
    notes: 'Compelling event: x · In quarter: yes · Next step: y · Risk: none',
    prevNotes: null,
    mgrNotes: null,
    dealRole: 'Lead',
    judgement: 'IN',
    forecastStatus: 'Pipeline',
    amount: 500_000,
    stage: '04 - Confirming Value With Power',
    closeDate: '2026-12-15',
    fiscalQuarter: 'FY27 Q4',
    ownerOrg62Id: OWNER,
    lastModifiedAt: new Date(NOW - DAY).toISOString(),
    notesUpdatedAt: new Date(NOW - 2 * DAY).toISOString(),
    syncedAt: new Date(NOW - 3_600_000).toISOString(),
    goneAt: null,
    pending: EMPTY_FORECAST_PENDING,
    ...x,
  };
}

function opp(x: Partial<Opportunity> & { id: string }): Opportunity {
  return { accountId: 'acc_1', name: `Opp ${x.id}`, stage: 'Discovery', amount: 200_000, closeDate: '2026-12-01', isOpen: true, isMine: true, dcAssigned: false, vdpLinked: false, hoursQtd: 0, nextStep: null, nextStepRead: true, products: ['Data 360'], owner: null, org62Url: null, myDc: null, forecastCategory: null, isWon: false, updatedAt: new Date(NOW).toISOString(), ...x };
}

const view = (records: SpecialistForecast[], drafts: Draft[] = [], opps: Opportunity[] = [], now = NOW) =>
  buildForecastView({ now: new Date(now).toISOString(), timezone: TZ, persona: ae, mode: 'live', records, opps, accounts: [], drafts, sync });

// ---------------------------------------------------------------------------

describe('the fixed SOQL (pinned, read-only)', () => {
  it('reads my records for this and next quarter, 25 per page, keyset on Id', () => {
    expect(sfrRecordsSoql(OWNER, ['FY27 Q4', 'FY28 Q1'])).toBe(
      "SELECT Id, Name, Opportunity__c, Opportunity__r.Name, Opportunity__r.AccountId, Opportunity__r.Account.Name, Opportunity__r.StageName, Opportunity__r.NextStep, Opportunity__r.CloseDate, ForecastNotes__c, MgrForecastNotes__c, Deal_Role__c, Management_Forecast_Judgement__c, ForecastStatus__c, ForecastAmount__c, ForecastStage__c, ForecastCloseDate__c, FiscalQuarter__c, OwnerId, LastModifiedDate FROM SpecialistForecast__c WHERE OwnerId = '005XX0000000OWNAAA' AND FiscalQuarter__c IN ('FY27 Q4', 'FY28 Q1') ORDER BY Id LIMIT 25",
    );
    expect(sfrRecordsSoql(OWNER, ['FY27 Q4', 'FY28 Q1'], 'aDdXX0000000TEST25')).toContain("AND Id > 'aDdXX0000000TEST25' ORDER BY Id LIMIT 25");
  });

  it('takes note age from SpecialistForecast__History (the newest ForecastNotes__c change)', () => {
    expect(sfrNotesHistorySoql(OWNER, ['FY27 Q4', 'FY28 Q1'])).toBe(
      "SELECT ParentId, MAX(CreatedDate) lastAt FROM SpecialistForecast__History WHERE Field = 'ForecastNotes__c' AND ParentId IN (SELECT Id FROM SpecialistForecast__c WHERE OwnerId = '005XX0000000OWNAAA' AND FiscalQuarter__c IN ('FY27 Q4', 'FY28 Q1')) GROUP BY ParentId LIMIT 2000",
    );
  });

  it('is SELECT only and takes only validated ids and quarter labels', () => {
    for (const q of [sfrRecordsSoql(OWNER, ['FY27 Q4']), sfrNotesHistorySoql(OWNER, ['FY27 Q4'])]) {
      expect(q).toMatch(/^SELECT /);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/);
    }
    expect(() => sfrRecordsSoql("005XX' OR Name != '", ['FY27 Q4'])).toThrow(ForecastSoqlError);
    expect(() => sfrRecordsSoql(OWNER, ["FY27 Q4') OR (Id != '"])).toThrow(ForecastSoqlError);
    expect(() => sfrRecordsSoql(OWNER, ['FY27 Q4'], "x' OR Id != '")).toThrow(ForecastSoqlError);
    expect(() => sfrNotesHistorySoql(OWNER, [])).toThrow(ForecastSoqlError);
  });

  it('runs through the scanners’ Org62 read allowlist (soqlQuery only)', () => {
    expect([...ORG62_SCAN_TOOLS]).toEqual(['soqlQuery']);
  });

  it('parses a records page (relationships, dates, amounts) and redacts credential-like text', () => {
    const raw = `Here you go: ${JSON.stringify({
      totalSize: 2,
      done: true,
      records: [
        {
          Id: 'aDdXX0000000TST01A',
          Name: 'SF-1',
          Opportunity__c: '006XX0000000OPP01A',
          Opportunity__r: { Name: 'Placeholder opp', AccountId: '001XX0000000ACC01A', Account: { Name: 'Placeholder Co' }, StageName: 'Negotiation', NextStep: 'Send the order form', CloseDate: '2026-12-15' },
          ForecastNotes__c: 'Next step: share key sk-ant-api03-PLACEHOLDERxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
          MgrForecastNotes__c: null,
          Deal_Role__c: 'None',
          Management_Forecast_Judgement__c: 'UP+',
          ForecastStatus__c: 'Commit',
          ForecastAmount__c: 250000,
          ForecastStage__c: '05 - Negotiating $$ & Mutual Plan',
          ForecastCloseDate__c: '2026-12-15',
          FiscalQuarter__c: 'FY27 Q4',
          OwnerId: OWNER,
          LastModifiedDate: '2026-11-10T17:55:27.000+0000',
        },
        { Id: 'not an id', Name: 'junk' },
      ],
    })}`;
    const [r, ...rest] = parseSfrRecords(raw);
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ org62Id: 'aDdXX0000000TST01A', org62OpportunityId: '006XX0000000OPP01A', org62AccountId: '001XX0000000ACC01A', accountName: 'Placeholder Co', oppNextStep: 'Send the order form', dealRole: 'None', amount: 250000, fiscalQuarter: 'FY27 Q4', lastModifiedAt: '2026-11-10T17:55:27.000Z' });
    expect(r!.notes).not.toContain('sk-ant-api03');
  });

  it('parses the history aggregate (Org62 instants with +0000)', () => {
    const m = parseNotesHistory(JSON.stringify({ records: [{ ParentId: 'aDdXX0000000TEST01', lastAt: '2026-11-04T18:40:10.000+0000' }, { ParentId: 'bad', lastAt: '2026-11-04T18:40:10.000+0000' }] }));
    expect([...m]).toEqual([['aDdXX0000000TEST01', '2026-11-04T18:40:10.000Z']]);
    expect(sfInstantToIso('2026-11-04T18:40:10.000-0700')).toBe('2026-11-05T01:40:10.000Z');
  });
});

describe('fiscal quarters and the notes deadline', () => {
  it('writes quarters as FiscalQuarter__c does (FY27 Q4) and rolls over', () => {
    expect(sfrQuarterOfDay('2026-11-11')).toBe('FY27 Q4');
    expect(sfrQuarterOfDay('2027-01-31')).toBe('FY27 Q4');
    expect(sfrQuarterOfDay('2027-02-01')).toBe('FY28 Q1');
    expect(nextSfrQuarter('FY27 Q4')).toBe('FY28 Q1');
    expect(nextSfrQuarter('FY27 Q2')).toBe('FY27 Q3');
    expect(sfrQuarterBounds('FY27 Q4')).toEqual({ start: '2026-11-01', end: '2027-01-31' });
    expect(quarterPair(NOW, TZ)).toEqual({ current: 'FY27 Q4', next: 'FY28 Q1' });
  });

  it('finds the last and next Monday 09:00 local (DST-safe)', () => {
    const d = notesDue(NOW, TZ, 1, '09:00');
    expect(new Date(d.prevMs).toISOString()).toBe('2026-11-02T16:00:00.000Z'); // Mon 11/2 09:00 MST
    expect(new Date(d.nextMs).toISOString()).toBe('2026-11-09T16:00:00.000Z');
    // the Monday before the DST change (Nov 1) is 09:00 MDT
    const before = notesDue(Date.parse('2026-11-01T12:00:00Z'), TZ, 1, '09:00');
    expect(new Date(before.prevMs).toISOString()).toBe('2026-10-26T15:00:00.000Z');
    expect(new Date(before.nextMs).toISOString()).toBe('2026-11-02T16:00:00.000Z');
    // exactly at the deadline it is the previous one
    const at = notesDue(Date.parse('2026-11-09T16:00:00Z'), TZ, 1, '09:00');
    expect(new Date(at.prevMs).toISOString()).toBe('2026-11-09T16:00:00.000Z');
  });
});

describe('the weekly notes queue (thresholds)', () => {
  const due = notesDue(NOW, TZ, t.dueWeekday, t.dueAt);
  const o = { nowMs: NOW, currentQuarter: 'FY27 Q4', prevDueMs: due.prevMs, nextDueMs: due.nextMs };

  it('reads the AE preset’s thresholds, and a user’s own values over them', () => {
    expect(t).toMatchObject({ minAmountUsd: 100_000, staleDays: 7, dealRoleMinAcvUsd: 1, dueWeekday: 1, dueAt: '09:00' });
    const mine = forecastThresholds(personaOf({ persona: { version: 1, id: 'ae', level: null, rules: {}, customRules: [], thresholds: { staleNotesMinAmountUsd: 250_000, staleNotesDays: '5', notesDueWeekday: 9 }, features: {}, connectors: {} } }));
    expect(mine).toMatchObject({ minAmountUsd: 250_000, staleDays: 5, dueWeekday: 1 });
    expect(AE_PERSONA.thresholds.map((x) => x.key)).toContain('forecastNoteTemplate');
  });

  it('takes the amount threshold inclusively', () => {
    expect(notesVerdict(rec({ amount: 100_000, notesUpdatedAt: new Date(due.nextMs - 7 * DAY).toISOString() }), t, o).state).toBe('due');
    expect(notesVerdict(rec({ amount: 99_999, notesUpdatedAt: new Date(due.nextMs - 7 * DAY).toISOString() }), t, o).state).toBe('not_required');
  });

  it('is due when the notes will be staleDays old at the next deadline, overdue when they already were at the last', () => {
    expect(notesVerdict(rec({ notesUpdatedAt: new Date(due.nextMs - 7 * DAY).toISOString() }), t, o).state).toBe('due');
    expect(notesVerdict(rec({ notesUpdatedAt: new Date(due.nextMs - 7 * DAY + 60_000).toISOString() }), t, o).state).toBe('fresh');
    expect(notesVerdict(rec({ notesUpdatedAt: new Date(due.prevMs - 7 * DAY).toISOString() }), t, o).state).toBe('overdue');
    expect(notesVerdict(rec({ notesUpdatedAt: new Date(due.prevMs - 7 * DAY + 60_000).toISOString() }), t, o).state).toBe('due');
  });

  it('takes the age from History, not LastModifiedDate (any field change bumps that)', () => {
    const v = notesVerdict(rec({ lastModifiedAt: new Date(NOW - 60_000).toISOString(), notesUpdatedAt: new Date(NOW - 13 * DAY).toISOString() }), t, o);
    expect(v).toMatchObject({ state: 'overdue', ageDays: 13 });
    expect(notesVerdict(rec({ notesUpdatedAt: null }), t, o)).toMatchObject({ state: 'due', ageDays: null });
  });

  it('needs no notes out of quarter, when closed or dead, or when gone', () => {
    const old = new Date(NOW - 30 * DAY).toISOString();
    expect(notesVerdict(rec({ fiscalQuarter: 'FY28 Q1', notesUpdatedAt: old }), t, o).state).toBe('not_required');
    expect(notesVerdict(rec({ forecastStatus: 'Closed Won', notesUpdatedAt: old }), t, o).state).toBe('not_required');
    expect(notesVerdict(rec({ stage: 'Dead - Lost', notesUpdatedAt: old }), t, o).state).toBe('not_required');
    expect(notesVerdict(rec({ goneAt: old, notesUpdatedAt: old }), t, o).state).toBe('not_required');
    // no FiscalQuarter__c: from the close date
    expect(notesVerdict(rec({ fiscalQuarter: null, closeDate: '2027-01-20', notesUpdatedAt: old }), t, o).state).toBe('overdue');
  });

  it('ranks biggest and furthest along first', () => {
    const stale = new Date(NOW - 20 * DAY).toISOString();
    const big = rec({ amount: 1_000_000, stage: '02 - Determining Problem, Impact, Ideal', notesUpdatedAt: stale });
    const along = rec({ amount: 600_000, stage: '06 - Finalizing Closure', forecastStatus: 'Commit', notesUpdatedAt: stale });
    const small = rec({ amount: 150_000, stage: '06 - Finalizing Closure', notesUpdatedAt: stale });
    const v = view([small, big, along]);
    expect(v.queue.notes).toEqual([along.id, big.id, small.id]);
    expect(v.rows.slice(0, 3).map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('flags Deal Role None on a deal with ACV of at least the minimum (Aware unless you pick another)', () => {
    expect(needsRoleFix(rec({ dealRole: 'None', amount: 1 }), t)).toBe(true);
    expect(needsRoleFix(rec({ dealRole: null, amount: 5 }), t)).toBe(true);
    expect(needsRoleFix(rec({ dealRole: 'None', amount: 0 }), t)).toBe(false);
    expect(needsRoleFix(rec({ dealRole: 'Aware', amount: 5 }), t)).toBe(false);
    expect(needsRoleFix(rec({ dealRole: 'None', amount: 5, forecastStatus: 'Closed Lost' }), t)).toBe(false);
    expect(needsRoleFix(rec({ dealRole: 'None', amount: 999 }), { ...t, dealRoleMinAcvUsd: 1000 })).toBe(false);
    expect(needsRoleFix(rec({ dealRole: 'None', amount: 1000 }), { ...t, dealRoleMinAcvUsd: 1000 })).toBe(true);
    const r = rec({ dealRole: 'None' });
    expect(view([r]).rows[0]!.roleFix).toEqual({ from: 'None', to: 'Aware', approved: false });
  });

  it('shows nothing when the feature is not active (SE)', () => {
    const v = buildForecastView({ now: new Date(NOW).toISOString(), timezone: TZ, persona: se, mode: 'live', records: [rec({ notesUpdatedAt: null })], opps: [], accounts: [], drafts: [], sync });
    expect(v).toMatchObject({ active: false, rows: [], counts: { due: 0, roles: 0, missing: 0 } });
    expect(SE_PERSONA.features.specialistForecast).toBeUndefined();
  });
});

describe('opps with no Specialist Forecast', () => {
  const window = { current: 'FY27 Q4', next: 'FY28 Q1' };
  it('finds open opps of mine closing this or next quarter with Data 360 or Flex work and no record', () => {
    const opps = [
      opp({ id: 'o_line', products: ['Data 360'] }),
      opp({ id: 'o_name', name: 'Placeholder · Data Cloud expansion', products: [] }),
      opp({ id: 'o_flex', products: ['Flex Credits'] }),
      opp({ id: 'o_af', products: ['Agentforce'] }),
      opp({ id: 'o_ent', products: ['Data Cloud Provisioning'] }),
      opp({ id: 'o_far', closeDate: '2027-06-01' }),
      opp({ id: 'o_past', closeDate: '2026-10-31' }),
      opp({ id: 'o_closed', isOpen: false }),
      opp({ id: 'o_theirs', isMine: false }),
      opp({ id: 'o_linked' }),
      opp({ id: 'o_by_org62', org62Url: 'https://org62.example.test/lightning/r/Opportunity/006XX0000OPP009/view' }),
      opp({ id: 'o_gone' }),
    ];
    const recs = [rec({ opportunityId: 'o_linked' }), rec({ org62OpportunityId: '006XX0000OPP009AAA' }), rec({ opportunityId: 'o_gone', goneAt: new Date(NOW).toISOString() })];
    const m = missingForecasts(opps, recs, window);
    expect(m.map((x) => [x.opp.id, x.signal])).toEqual([
      ['o_flex', 'flex_only'],
      ['o_gone', 'd360_line'],
      ['o_line', 'd360_line'],
      ['o_name', 'name_token'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The canvas, holds and read-back
// ---------------------------------------------------------------------------

const ROWS = [
  { recordId: 'r1', org62Id: 'aDdXX0000000TEST01', notes: 'Compelling event: go-live | Q4\nNext step: order form', dealRole: null },
  { recordId: 'r2', org62Id: 'aDdXX0000000TEST02', notes: null, dealRole: 'Aware' },
];
const BASE = { ownerName: 'Placeholder Me', ownerOrg62Id: OWNER, generatedAt: '2026-11-05T16:00:00.000Z', sourceLabel: 'Command Center · forecast notes' };

function canvasDraft(id: string, status: Draft['status'], rows = ROWS, at = '2026-11-05T16:00:00.000Z'): Draft {
  const dest = forecastCanvasActionFor({ title: 'Specialist Forecast · test', markdown: renderForecastWorkOrder({ ...BASE, rows }), rows });
  const d = actionDraftFor(dest, { id, now: at, rendered: () => ({ slackMrkdwn: '', emailHtml: '', plain: '' }) as never });
  return { ...d, status, ...(status === 'sent' ? { attempts: [{ id: 'att1', at, mode: 'send', dryRun: false, outcome: 'sent' }] } : {}) };
}

describe('one Slackbot canvas of UPDATE rows on SpecialistForecast__c', () => {
  it('renders only an UPDATE table (Id, ForecastNotes__c, Deal_Role__c), no ADD rows', () => {
    const md = renderForecastWorkOrder({ ...BASE, rows: ROWS });
    // WO-1: its own table, no Object column
    expect(md).toContain('## SPECIALIST FORECASTS TO UPDATE (2 rows · 1 forecast note · 1 deal role)');
    expect(md).toContain('|#|Record Id|ForecastNotes__c|Deal_Role__c|');
    expect(md).not.toMatch(/# ADD|TO CREATE|\|Event\|/);
    const rows = md.split('\n').filter((l) => /^\|\d+\|/.test(l));
    expect(rows).toEqual(['|1|aDdXX0000000TEST01|Compelling event: go-live / Q4 ⏎ Next step: order form|—|', '|2|aDdXX0000000TEST02|—|Aware|']);
    expect(canvasRowsOf(md).map((r) => [r.kind, r.ref])).toEqual([['update:SpecialistForecast__c', 'aDdXX0000000TEST01'], ['update:SpecialistForecast__c', 'aDdXX0000000TEST02']]);
    expect(md).toContain('Execute it in Org62 for Placeholder Me (User Id 005XX0000000OWNAAA)');
    expect(md).toContain('never create or delete a record');
  });

  it('is the slack_canvas.create action; the dry-run payload is slack_create_canvas with that markdown only', () => {
    const dest = forecastCanvasActionFor({ title: 'Specialist Forecast · test', markdown: renderForecastWorkOrder({ ...BASE, rows: ROWS }), rows: ROWS });
    expect(dest.action).toBe('slack_canvas.create');
    expect(dest.input).toMatchObject({ eventIds: [], updateIds: ['aDdXX0000000TEST01:ForecastNotes__c', 'aDdXX0000000TEST02:Deal_Role__c'], updates: 2 });
    const p = actionPayloadFor(dest);
    expect(p).toMatchObject({ tool: 'slack_create_canvas', args: { title: 'Specialist Forecast · test', content: dest.text } });
    expect(p.invalid).toBeUndefined();
    expect(Object.keys(p.args as object)).toEqual(['title', 'content']);
  });

  it('fills ONE canvas up to Slack’s byte limit and leaves only the rest for the next (in order)', () => {
    const long = 'x'.repeat(3000);
    const rows = Array.from({ length: 6 }, (_, i) => ({ recordId: `r${i}`, org62Id: `aDdXX0000000TEST${String(i).padStart(2, '0')}`, notes: long, dealRole: null }));
    // 18 KB of notes: one canvas at Slack's real limit (the old 12,000-character cap deferred half of them)
    expect(packForecastRows(BASE, rows).take).toHaveLength(6);
    const { take, deferred } = packForecastRows(BASE, rows, 12_000);
    expect(take.length).toBe(3);
    expect(deferred.map((r) => r.recordId)).toEqual(['r3', 'r4', 'r5']);
    expect(renderForecastWorkOrder({ ...BASE, rows: take }).length).toBeLessThanOrEqual(12_000);
  });

  it('canvasHolds holds its updates while it waits for Apply (and lets them go when rejected)', () => {
    expect([...canvasHolds([canvasDraft('d1', 'ready')]).updates]).toEqual(['aDdXX0000000TEST01:ForecastNotes__c', 'aDdXX0000000TEST02:Deal_Role__c']);
    expect(canvasHolds([canvasDraft('d1', 'ready')]).rows.size).toBe(0);
    expect(canvasHolds([canvasDraft('d1', 'rejected')]).updates.size).toBe(0);
  });
});

describe('staging, holds and the read-back', () => {
  const approvedNote = (r: SpecialistForecast, text: string, at = new Date(NOW - 3_600_000).toISOString()): SpecialistForecast => ({ ...r, pending: { ...r.pending, notes: { text, state: 'approved', origin: 'model', at, basedOnNotesAt: r.notesUpdatedAt, model: 'placeholder', costUsd: 0, sources: [] } } });
  const opts = { ownerName: 'Placeholder Me', ownerOrg62Id: OWNER, nowIso: new Date(NOW).toISOString(), sourceLabel: 'test' };

  it('stages approved notes and Deal Roles into one canvas; a second Review & apply stages nothing (canvasHolds)', () => {
    const a = approvedNote(rec({ notesUpdatedAt: null }), 'Compelling event: A · In quarter: yes · Next step: B · Risk: none');
    const b = { ...rec({ dealRole: 'None' }), pending: { ...EMPTY_FORECAST_PENDING, dealRole: { value: 'Aware' as const, state: 'approved' as const, at: new Date(NOW - 60_000).toISOString() } } };
    const plan = stagePlan(view([a, b]), opts);
    expect(plan).toMatchObject({ notes: 1, roles: 1, deferred: [] });
    const held = actionDraftFor(plan.destination!, { id: 'dz', now: opts.nowIso, rendered: () => ({}) as never });
    const again = stagePlan(view([a, b], [held]), opts);
    expect(again.destination).toBeNull();
    expect(again.waiting).toEqual({ updates: 2, draftIds: ['dz'] });
    const v = view([a, b], [held]);
    expect(v.rows.find((r) => r.id === a.id)!.notes.state).toBe('staged');
    expect(v.rows.find((r) => r.id === b.id)!.role.state).toBe('staged');
    expect(v.canvases).toEqual([{ draftId: 'dz', title: plan.title, status: 'ready', notes: 1, roles: 1, at: opts.nowIso, url: null, waiting: 0 }]);
    expect(v.withSlackbot).toEqual([]);
    // and a note held by a canvas can't be edited until that canvas is rejected
    expect(() => patchedPending(a, v.rows.find((r) => r.id === a.id)!, { notes: 'changed' }, opts.nowIso)).toThrow(/waiting for Apply/);
  });

  it('flags a note that didn’t land (a read after the canvas still shows the old note); it can be staged again', () => {
    const sentAt = new Date(NOW - 2 * 3_600_000).toISOString();
    const text = 'Compelling event: A · In quarter: yes · Next step: B · Risk: none';
    const base = rec({ notes: 'old note', notesUpdatedAt: new Date(NOW - 10 * DAY).toISOString(), syncedAt: new Date(NOW - 60_000).toISOString() });
    const r = approvedNote(base, text, new Date(NOW - 3 * 3_600_000).toISOString());
    const sent = canvasDraft('dsent', 'sent', [{ recordId: r.id, org62Id: r.org62Id, notes: text, dealRole: null }], sentAt);
    const row = view([r], [sent]).rows[0]!;
    expect(row.notes).toMatchObject({ state: 'not_landed', draftId: 'dsent' });
    expect(view([r], [sent]).counts.notLanded).toBe(1);
    expect(stagePlan(view([r], [sent]), opts).notes).toBe(1);
    // within the grace period it is still with Slackbot
    const early = { ...r, syncedAt: new Date(Date.parse(sentAt) + LAND_GRACE_MS - 60_000).toISOString() };
    expect(view([early], [sent]).rows[0]!.notes.state).toBe('handed_off');
    expect(stagePlan(view([early], [sent]), opts).destination).toBeNull();
    // with Slackbot: the applied canvas stays listed, with its link, until the sync sees the note land
    const linked = { ...sent, resultUrl: 'https://example.slack.com/docs/T0PLACE/F0FORECAST1' };
    expect(view([early], [linked]).withSlackbot).toEqual([{ draftId: 'dsent', title: expect.any(String), status: 'sent', notes: 1, roles: 0, at: sentAt, url: 'https://example.slack.com/docs/T0PLACE/F0FORECAST1', waiting: 1 }]);
    expect(view([r], [linked]).withSlackbot).toEqual([]); // not landed: it goes in the next canvas instead
    // landed: Org62 shows the text (whitespace aside), or a newer note than the canvas
    const landed = { ...r, notes: `${text}  `, notesUpdatedAt: new Date(Date.parse(sentAt) + 60_000).toISOString() };
    expect(view([landed], [sent]).rows[0]!.notes.state).toBe('landed');
    expect(view([landed], [sent]).withSlackbot).toEqual([]);
    // a Deal Role that didn't land
    const role = { ...rec({ dealRole: 'None', syncedAt: new Date(NOW).toISOString() }), pending: { ...EMPTY_FORECAST_PENDING, dealRole: { value: 'Aware' as const, state: 'approved' as const, at: new Date(NOW - 3 * 3_600_000).toISOString() } } };
    const sentRole = canvasDraft('drole', 'sent', [{ recordId: role.id, org62Id: role.org62Id, notes: null, dealRole: 'Aware' }], sentAt);
    expect(view([role], [sentRole]).rows[0]!.role.state).toBe('not_landed');
    expect(view([{ ...role, dealRole: 'Aware' }], [sentRole]).rows[0]!.role.state).toBe('landed');
  });

  it('a note written against older Org62 notes is obsolete; a landed note from an earlier week is over', () => {
    const r = approvedNote(rec({ notesUpdatedAt: new Date(NOW - 10 * DAY).toISOString() }), 'stale draft');
    const moved = { ...r, notesUpdatedAt: new Date(NOW - DAY).toISOString() };
    expect(view([moved]).rows[0]!.notes).toMatchObject({ state: 'none', text: null });
  });

  it('Draft all takes queued records with nothing current; one record can always be drafted again', () => {
    const a = rec({ notesUpdatedAt: null });
    const b = approvedNote(rec({ notesUpdatedAt: null }), 'mine');
    const fresh = rec();
    const v = view([a, b, fresh]);
    expect(draftTargets(v)).toEqual({ targets: [a.id], skipped: [{ id: b.id, why: 'has a draft already' }] });
    expect(draftTargets(v, [b.id, 'nope']).targets).toEqual([b.id]);
  });

  it('edits keep the draft’s origin honest (model → edited) and approving takes the text shown', () => {
    const r = { ...rec({ notesUpdatedAt: null }), pending: { ...EMPTY_FORECAST_PENDING, notes: { text: 'drafted', state: 'drafted' as const, origin: 'model' as const, at: new Date(NOW - 60_000).toISOString(), basedOnNotesAt: null, model: 'placeholder', costUsd: 0, sources: [] } } };
    const row = view([r]).rows[0]!;
    const p = patchedPending(r, row, { notes: 'my edit', notesState: 'approved' }, new Date(NOW).toISOString());
    expect(p.notes).toMatchObject({ text: 'my edit', state: 'approved', origin: 'edited' });
    expect(patchedPending(r, row, { discardNotes: true }, new Date(NOW).toISOString()).notes).toBeNull();
    const own = patchedPending(rec(), view([rec()]).rows[0]!, { notes: 'written' }, new Date(NOW).toISOString());
    expect(own.notes).toMatchObject({ origin: 'manual', state: 'drafted' });
  });

  it('caps audit: the draft reads every meeting since the notes changed (was the newest 12)', async () => {
    const { draftContext } = await import('../../src/server/forecast/draft');
    const meetingsSince = Array.from({ length: 15 }, (_, i) => ({ title: `ACME sync ${i}`, start: new Date(NOW - i * 3600_000).toISOString() }));
    const c = draftContext({ record: rec(), template: t.template, personaBlock: '', meetingsSince, names: ['ACME'], now: new Date(NOW), timezone: 'UTC' });
    expect(c.meetingsSince).toHaveLength(15);
  });

  it('the placeholder drafter writes the template from the record’s own fields', () => {
    const r = rec({ mgrNotes: 'Core AE: budget confirmed. More later.', oppNextStep: 'Send the order form', oppCloseDate: '2026-12-15', forecastStatus: 'Commit' });
    const d = placeholderDraft({ record: r, template: t.template, meetingsSince: [] }, 'FY27 Q4');
    expect(d.notes).toBe('Compelling event: Core AE: budget confirmed. · In quarter: yes, 04 - Confirming Value With Power (Commit) · Next step (owner, date): Send the order form, before 2026-12-15 · Risk: none new this week');
    expect(d.sources.map((s) => s.label)).toEqual(['Manager forecast notes', 'Opportunity next step']);
  });
});
