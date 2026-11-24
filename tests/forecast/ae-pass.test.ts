/**
 * The Specialist AE handoff pass (mock, placeholder seed only):
 *
 *   Stage → Apply   one verb per step: "Stage N notes" builds ONE canvas whose preview holds the one Apply
 *   check now       "I created it, check now" on an opp with no Specialist Forecast: checking… → found (the record
 *                   joins the queue and the Deal Role fixes) or not yet (with when the app reads again); the SOQL is
 *                   the pinned one-opp read; never for an SE without the feature
 *   Home            the AE's forecast duty rows come first in Log & fix, so the rows a capped section hides are the
 *                   Week ones "See all" opens; an SE who activates Specialist Forecast gets the rows; a note with
 *                   Slackbot is not listed as still to write
 *   logging         an AE's Sales Events need no task type: a complete proposed row is ready without one
 *   feedback        an AE's report never blames VDP (not active for them); an SE's still can
 *   page help       the AE's Deals note says where the forecast rows really are
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { ActivityEntry, ForecastPayload, ForecastRow, SpecialistForecast } from '@/contract';
import { buildForecastView, CHECK_FOUND_SHOW_MS, checkState, type ForecastCheckInput } from '@/engines/forecast/view';
import { guidePayload, guideSignals } from '@/guide/checklist';
import { itemGuideFor } from '@/guide/items';
import { appRoutes } from '@/server/chat/app-routes';
import { pageHelpFor } from '@/guide/pages';
import { personaOf } from '@/personas';
import { checkButton, checkLine, checkOutcomes, stageButton } from '@/components/time/forecast-derive';
import { q4Steps } from '@/components/time/derive';
import { sfrRecordsForOppSoql, sfrRecordsSoql } from '@/server/forecast/soql';
import { createMockDataSource, type MockDataSource } from '@/server/datasource/mock';

const AE = personaOf({ persona: { id: 'ae' } });
const SE = personaOf({ profile: { role: 'se_ic' } });
const OWNER = '005XX0000000OWNAAA';
const Q = ['FY27 Q4', 'FY28 Q1'];

let ds: MockDataSource | null = null;
afterEach(() => {
  ds?.dispose();
  ds = null;
});

async function mock(persona: Record<string, unknown> = { id: 'ae' }, delays: { stepMs?: number } = {}) {
  ds?.dispose();
  ds = createMockDataSource({ autoplay: false, delays: { enrichMs: 1e8, stepMs: delays.stepMs ?? 5, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 1e8 } });
  ds.clock.freeze(new Date(ds.loaded.seed.meta.asOf));
  ds.resetStore();
  const s = await ds.getSettings({} as never);
  await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s.persona.version, value: persona } } as never);
  return ds;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Stage → Apply: one verb per step', () => {
  const row = (over: Partial<Pick<ForecastRow, 'notes' | 'role' | 'roleFix'>>) =>
    ({ notes: { state: 'none', text: null }, role: { state: 'none', draftId: null }, roleFix: null, ...over }) as unknown as ForecastRow;

  it('"Stage N notes" names what it stages; nothing approved reads "Stage notes"', () => {
    expect(stageButton({ rows: [] }).label).toBe('Stage notes');
    const rows = [
      row({ notes: { state: 'approved', text: 'a' } as ForecastRow['notes'] }),
      row({ notes: { state: 'not_landed', text: 'b' } as ForecastRow['notes'] }),
      row({ notes: { state: 'drafted', text: 'c' } as ForecastRow['notes'] }),
      row({ role: { state: 'approved', draftId: null }, roleFix: { from: 'None', to: 'Aware', approved: true } }),
    ];
    expect(stageButton({ rows })).toEqual({ label: 'Stage 2 notes + 1 Deal Role', notes: 2, roles: 1 });
    expect(stageButton({ rows: rows.slice(0, 1) }).label).toBe('Stage 1 note');
    expect(stageButton({ rows: rows.slice(3) }).label).toBe('Stage 1 Deal Role');
    for (const r of rows) expect(stageButton({ rows: [r] }).label).not.toMatch(/apply/i);
  });

  it('the Getting started tip says Stage, then Apply in what opens', () => {
    const tip = itemGuideFor('batch', AE).find((s) => s.id === 'guide.batch.forecast.stage')!;
    expect(tip.selector).toBe('[data-testid="forecast-stage"]');
    expect(tip.text).toMatch(/^Stage N notes/);
    expect(tip.text).toMatch(/Apply it there/);
  });

  it('mock: approve → Stage → ONE canvas (an Outbox action with SpecialistForecast__c UPDATE rows) → its preview holds the one Apply', async () => {
    const m = await mock();
    const v0 = await m.getForecast({} as never);
    await m.draftForecastNotes({ body: { ids: [v0.queue.notes[0]!] } } as never);
    await m.patchForecast({ params: { id: v0.queue.notes[0]! }, body: { notesState: 'approved' } } as never);
    const v1 = await m.getForecast({} as never);
    expect(stageButton(v1).label).toBe('Stage 1 note');
    const st = await m.stageForecast({ body: {} } as never);
    expect(st.entity).toMatchObject({ notes: 1, roles: 0, draftId: expect.any(String) });
    const d = await m.getDraft({ params: { id: st.entity.draftId! } } as never);
    expect(d.destination).toMatchObject({ kind: 'action', action: 'slack_canvas.create' });
    const prev = await m.previewDraft({ params: { id: d.id }, body: { mode: 'send' } } as never);
    expect(prev.dryRun).toBe(true);
    const content = String((prev.payload as { args: { content: string } }).args.content);
    expect(content).toContain('## SPECIALIST FORECASTS TO UPDATE (1 row');
    expect(content.split('\n').filter((l) => /^\|\d+\|/.test(l))).toHaveLength(1);
    // staged, waiting for its Apply on Activity; a second Stage stages nothing
    expect((await m.getForecast({} as never)).canvases.map((c) => c.draftId)).toEqual([d.id]);
    expect((await m.stageForecast({ body: {} } as never)).entity.draftId).toBeNull();
  });
});

describe('"I created it, check now"', () => {
  const NOW = Date.parse('2026-11-11T17:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  it('the one-opp read is the pinned record read plus that opp, and refuses anything but an opp id', () => {
    const q = sfrRecordsForOppSoql(OWNER, Q, '006XX0000OPP009AAA');
    expect(q).toBe(sfrRecordsSoql(OWNER, Q).replace(` AND FiscalQuarter__c`, ` AND Opportunity__c = '006XX0000OPP009AAA' AND FiscalQuarter__c`));
    expect(() => sfrRecordsForOppSoql(OWNER, Q, "006' OR Name != '")).toThrow();
    expect(() => sfrRecordsForOppSoql(OWNER, Q, '001XX0000ACC001AAA')).toThrow();
  });

  it('checking while queued or running; not yet, dated by the later of the check and a full read; failed and skipped say why', () => {
    const c = (status: ForecastCheckInput['status'], x: Partial<ForecastCheckInput> = {}): ForecastCheckInput => ({ opportunityId: 'o1', status, askedAt: iso(NOW - 60_000), finishedAt: null, note: null, ...x });
    expect(checkState(c('queued'), { opportunityName: 'Opp', syncedAt: null })).toMatchObject({ status: 'checking', at: iso(NOW - 60_000) });
    expect(checkState(c('running'), { opportunityName: 'Opp', syncedAt: null }).status).toBe('checking');
    expect(checkState(c('succeeded', { finishedAt: iso(NOW - 30_000) }), { opportunityName: 'Opp', syncedAt: iso(NOW - 3_600_000) })).toMatchObject({ status: 'not_found', at: iso(NOW - 30_000) });
    expect(checkState(c('succeeded', { finishedAt: iso(NOW - 30_000) }), { opportunityName: 'Opp', syncedAt: iso(NOW) })).toMatchObject({ status: 'not_found', at: iso(NOW) });
    expect(checkState(c('failed', { note: 'The read did not finish (timeout)' }), { opportunityName: 'Opp', syncedAt: null })).toMatchObject({ status: 'failed', note: 'The read did not finish (timeout)' });
    expect(checkState(c('skipped', { note: 'This opportunity has no Org62 id in the app, so it cannot be looked up' }), { opportunityName: 'Opp', syncedAt: null }).status).toBe('skipped');
  });

  it('the row says checking…, then not yet with when the app reads again; its button checks again', () => {
    const base = { opportunityId: 'o1', opportunityName: 'Opp', note: null, recordId: null };
    expect(checkButton({ check: null })).toEqual({ label: 'I created it, check now', busy: false });
    expect(checkButton({ check: null }, true)).toEqual({ label: 'Checking…', busy: true });
    expect(checkButton({ check: { ...base, status: 'checking', at: iso(NOW) } })).toEqual({ label: 'Checking…', busy: true });
    expect(checkButton({ check: { ...base, status: 'not_found', at: iso(NOW) } })).toEqual({ label: 'Check again', busy: false });
    expect(checkLine(null)).toBeNull();
    expect(checkLine({ ...base, status: 'checking', at: iso(NOW) })).toMatch(/^Checking Org62/);
    expect(checkLine({ ...base, status: 'not_found', at: '2026-11-11T17:00:00.000Z' }, { nextAt: '2026-11-11T17:30:00.000Z', tz: 'UTC', now: '2026-11-11T17:05:00.000Z' })).toBe('Not in Org62 yet · read 17:00 · reads again 17:30');
    // a full read already past the check: no "reads again"
    expect(checkLine({ ...base, status: 'not_found', at: '2026-11-11T17:40:00.000Z' }, { nextAt: '2026-11-11T17:30:00.000Z', tz: 'UTC', now: '2026-11-11T17:45:00.000Z' })).toBe('Not in Org62 yet · read 17:40');
    expect(checkLine({ ...base, status: 'failed', at: iso(NOW), note: 'The read did not finish (timeout)' })).toBe('The read did not finish (timeout)');
  });

  it('a finished check is told once: found, not yet (with the next read), or did not finish', () => {
    const v = (missing: ForecastPayload['queue']['missing'], found: ForecastPayload['found'] = [], nextAt: string | null = null) => ({ queue: { notes: [], roles: [], missing }, found, sync: { status: 'ok', lastAt: null, note: null, records: 0, nextAt } }) as unknown as ForecastPayload;
    const miss = (status: 'checking' | 'not_found' | 'failed') => ({ opportunityId: 'o1', opportunityName: 'Opp', check: { opportunityId: 'o1', opportunityName: 'Opp', status, at: iso(NOW), note: status === 'failed' ? 'The read did not finish (timeout)' : null, recordId: null } }) as unknown as ForecastPayload['queue']['missing'][number];
    const first = checkOutcomes(null, v([miss('checking')]));
    expect(first.toasts).toEqual([]);
    expect(checkOutcomes(first.statuses, v([miss('checking')])).toasts).toEqual([]);
    expect(checkOutcomes(first.statuses, v([], [{ opportunityId: 'o1', opportunityName: 'Opp', status: 'found', at: iso(NOW), note: null, recordId: 'r1' }])).toasts).toMatchObject([{ tone: 'success', title: 'Found its Specialist Forecast' }]);
    expect(checkOutcomes(first.statuses, v([miss('not_found')], [], '2026-11-11T17:30:00.000Z'), 'UTC').toasts).toMatchObject([{ tone: 'info', title: 'Not in Org62 yet', body: expect.stringContaining('again at 17:30') }]);
    expect(checkOutcomes(first.statuses, v([miss('failed')])).toasts).toMatchObject([{ tone: 'error', body: 'The read did not finish (timeout)' }]);
    // a page load never toasts an old result
    expect(checkOutcomes(null, v([miss('not_found')])).toasts).toEqual([]);
  });

  it('mock: checking… → found: the record joins the notes queue and the Deal Role fixes, Found ✓ links it', async () => {
    const m = await mock({ id: 'ae' }, { stepMs: 20 });
    const v0 = await m.getForecast({} as never);
    expect(v0.queue.missing).toHaveLength(1);
    const opp = v0.queue.missing[0]!;
    expect(opp.check).toBeNull();
    const r = await m.checkMissingForecast({ params: { id: opp.opportunityId }, body: {} } as never);
    expect(r.entity).toMatchObject({ queued: true, check: { status: 'checking', opportunityId: opp.opportunityId } });
    // a second click while it runs starts nothing new
    expect((await m.checkMissingForecast({ params: { id: opp.opportunityId }, body: {} } as never)).entity.queued).toBe(false);
    expect((await m.getForecast({} as never)).queue.missing[0]!.check?.status).toBe('checking');
    await wait(80);
    const v1 = await m.getForecast({} as never);
    expect(v1.queue.missing).toEqual([]);
    expect(v1.found).toMatchObject([{ opportunityId: opp.opportunityId, status: 'found', recordId: expect.any(String) }]);
    const rec = v1.rows.find((x) => x.id === v1.found[0]!.recordId)!;
    expect(rec).toMatchObject({ opportunityId: opp.opportunityId, notesState: 'due', roleFix: { from: 'None', to: 'Aware' } });
    expect(v1.queue.notes).toContain(rec.id);
    expect(v1.queue.roles).toContain(rec.id);
    expect(v1.counts.missing).toBe(0);
    // Found ✓ again: says so, starts nothing
    expect((await m.checkMissingForecast({ params: { id: opp.opportunityId }, body: {} } as never)).entity).toMatchObject({ queued: false, check: { status: 'found' } });
    // an opp that is not missing one
    await expect(m.checkMissingForecast({ params: { id: 'opp_not_missing' }, body: {} } as never)).rejects.toThrow(/not missing a Specialist Forecast/);
  });

  it('Found ✓ shows for a while after the check, then leaves', () => {
    const rec = { id: 'r1', org62Id: 'aDdXX00000TST01AAA', opportunityId: 'o1', org62OpportunityId: null, goneAt: null, opportunityName: 'Opp', name: 'SF-1' } as unknown as SpecialistForecast;
    const input = (askedAt: string) =>
      buildForecastView({
        now: iso(NOW),
        timezone: 'UTC',
        persona: AE,
        mode: 'live',
        records: [{ ...rec, pending: { notes: null, dealRole: null, draftError: null }, amount: 0, stage: null, forecastStatus: null, fiscalQuarter: 'FY27 Q4', closeDate: null, notesUpdatedAt: null, notes: null, dealRole: 'Lead', syncedAt: iso(NOW) } as unknown as SpecialistForecast],
        opps: [],
        accounts: [],
        drafts: [],
        sync: { status: 'ok', lastAt: iso(NOW), note: null, records: 1, nextAt: null },
        checks: [{ opportunityId: 'o1', status: 'succeeded', askedAt, finishedAt: askedAt, note: null }],
      }).found;
    expect(input(iso(NOW - 60_000))).toMatchObject([{ status: 'found', recordId: 'r1' }]);
    expect(input(iso(NOW - CHECK_FOUND_SHOW_MS - 60_000))).toEqual([]);
  });

  it('an SE without the feature has no check (the route is gated like every forecast change)', async () => {
    const m = await mock({ id: 'se' });
    await expect(m.checkMissingForecast({ params: { id: 'opp_initech_pilot' }, body: {} } as never)).rejects.toThrow(/not active for your role/);
  });
});

describe('Home ▸ Log & fix for an AE', () => {
  it('the forecast duty rows come first, so the capped section hides only Week rows (where "See all" goes)', async () => {
    const m = await mock();
    const home = await m.getHome({ query: { wide: false } } as never);
    const fix = home.sections.find((s) => s.id === 'fix')!;
    const ids = fix.rows.map((r) => r.id);
    expect(ids.slice(0, 3)).toEqual(['gap:forecast_notes', 'gap:deal_role', 'gap:missing_sfr']);
    expect(fix.rows.every((r) => r.href === '/activity?view=forecast')).toBe(true);
    expect(fix.count).toBeGreaterThan(fix.rows.length);
    expect(fix.seeAllHref).toBe('/activity?view=week');
    const wide = (await m.getHome({ query: { wide: true } } as never)).sections.find((s) => s.id === 'fix')!;
    expect(wide.rows.slice(3).every((r) => r.href === '/activity?view=week')).toBe(true);
  });

  it('an SE who activates Specialist Forecast gets the rows in the Home payload too', async () => {
    const fixOf = async (persona: Record<string, unknown>) => (await (await mock(persona)).getHome({ query: { wide: true } } as never)).sections.find((s) => s.id === 'fix')!;
    const on = await fixOf({ id: 'se', features: { specialistForecast: true } });
    const off = await fixOf({ id: 'se' });
    // the three rows join the SE's own (after them: the SE's order is unchanged)
    expect(on.count).toBe(off.count + 3);
    expect(on.rows.map((r) => r.id)).toContain('gap:forecast_notes');
    expect(off.rows.map((r) => r.id)).not.toContain('gap:forecast_notes');
    expect(on.rows.filter((r) => off.rows.some((o) => o.id === r.id)).map((r) => r.id)).toEqual(off.rows.map((r) => r.id).slice(0, on.rows.filter((r) => off.rows.some((o) => o.id === r.id)).length));
  });

  it('a note in a canvas or with Slackbot is not listed as still to write', async () => {
    const m = await mock();
    const v0 = await m.getForecast({} as never);
    const [first, second] = v0.queue.notes;
    await m.draftForecastNotes({ body: { ids: [first!, second!] } } as never);
    await m.patchForecast({ params: { id: first! }, body: { notesState: 'approved' } } as never);
    await m.stageForecast({ body: {} } as never);
    const row = (await m.getHome({ query: { wide: true } } as never)).sections.find((s) => s.id === 'fix')!.rows.find((r) => r.id === 'gap:forecast_notes')!;
    const name = (id: string) => v0.rows.find((r) => r.id === id)!.accountName!.split(' ')[0]!;
    expect(row.why).toContain('1 waiting for Apply');
    expect(row.why).toContain('1 drafted');
    expect(row.why).not.toContain(name(first!));
    expect(row.verb.label).toBe('Review notes');
  });
});

describe('AE hours: Sales Events need no task type', () => {
  const entry = (x: Partial<ActivityEntry>): ActivityEntry => ({ id: 'a1', status: 'proposed', taskType: null, oppId: 'opp1', start: '2026-11-10T16:00:00.000Z', end: '2026-11-10T17:00:00.000Z', durationH: 1, issues: [], canvasDraftId: null, ...x }) as unknown as ActivityEntry;
  const week = { entries: [], canvas: { label: 'canvas' }, quarter: { label: 'Q4 FY27', loggedH: 0, targetH: 0, due: '2026-11-12T19:00:00.000Z' }, logCanvases: [] } as never;

  it('a complete proposed row is ready without a type, and no step asks for one', () => {
    const rows = [entry({})];
    const se = q4Steps({ rows, week, nowIso: '2026-11-11T17:00:00.000Z' });
    const ae = q4Steps({ rows, week, nowIso: '2026-11-11T17:00:00.000Z', taskTypeRequired: false });
    expect(se.find((s) => s.id === 'submit')!.ids).toEqual([]);
    expect(ae.find((s) => s.id === 'submit')!.ids).toEqual(['a1']);
    expect(se.find((s) => s.id === 'approve')!.why).toMatch(/type, opp/);
    expect(JSON.stringify(ae)).not.toMatch(/task type|the type/);
  });
});

describe('Getting started for an AE', () => {
  const canvas = (forecast: boolean, status = 'sent') => ({ status, destination: { kind: 'action', action: 'slack_canvas.create', input: forecast ? { forecast: { kind: 'specialist_forecast', updates: [] } } : { eventIds: ['a1'] } } }) as never;
  const sig = (persona: typeof AE, drafts: never[]) => guideSignals({ connectors: [], drafts, assistantMessages: 0, firstScan: null, persona, personaVersion: 1, guide: { seen: {}, checklistDismissed: false } });

  it('"Apply your first forecast notes batch" ticks on an applied forecast canvas only; an SE\'s logging batch on a logging canvas only', () => {
    expect(sig(AE, [canvas(false)]).batches).toBe(0);
    expect(sig(AE, [canvas(true)]).batches).toBe(1);
    expect(sig(SE, [canvas(false)]).batches).toBe(1);
    expect(sig(SE, [canvas(true)]).batches).toBe(0);
    // staged and waiting for its Apply: not yet the batch
    expect(sig(AE, [canvas(true, 'ready')])).toMatchObject({ batches: 0, batchesStaged: 1 });
  });

  it('every AE item names a page and a tip whose first anchor is on that page', () => {
    const items = guidePayload({ connectors: [], drafts: [], assistantMessages: 0, firstScan: null, persona: AE, personaVersion: 1, guide: { seen: {}, checklistDismissed: false } }).items;
    expect(items.find((i) => i.id === 'batch')).toMatchObject({ href: '/activity?view=forecast', page: 'time' });
    expect(itemGuideFor('batch', AE).map((s) => s.selector)).toEqual(['[data-testid="forecast-queue"]', '[data-testid="forecast-stage"]']);
    // the Time tour an AE takes lands on Forecast: its forecast step is there
    expect(pageHelpFor('time', AE)!.marks.map((m) => m.selector)).toContain('[data-testid="forecast-queue"]');
  });
});

describe('the Assistant for an AE', () => {
  it('reads and stages the forecast routes, the check and the sync too (A7: each on the user\'s Apply); no VDP, DC or missed-opp routes until activated', () => {
    const read = appRoutes('read', AE);
    const stage = appRoutes('stage', AE);
    expect(read).toEqual(expect.arrayContaining(['getForecast', 'getForecastRecord']));
    expect(stage).toEqual(expect.arrayContaining(['patchForecast', 'stageForecast']));
    // A7 (2026-11-13): a queued worker read needs no denial; it waits for the user's Apply like any change
    expect(stage).toEqual(expect.arrayContaining(['checkMissingForecast', 'syncForecast']));
    expect(read).not.toContain('checkMissingForecast');
    for (const k of ['getVdpCoverage', 'getVdpDetail', 'getMissed', 'listDcRequests'] as const) expect(read, k).not.toContain(k);
    for (const k of ['draftVdpUpdate', 'claimMissed', 'createDcRequest'] as const) expect(stage, k).not.toContain(k);
    const on = personaOf({ persona: { id: 'ae', features: { vdp: true, missedOpps: true, dealContributions: true } } });
    expect(appRoutes('read', on)).toEqual(expect.arrayContaining(['getVdpCoverage', 'getMissed', 'listDcRequests']));
    // an SE never sees the forecast routes
    expect(appRoutes('read', SE)).not.toContain('getForecast');
  });
});

describe('Feedback and page help for an AE', () => {
  it("an AE's report never blames VDP (not active for them); an SE's can", async () => {
    const body = { kind: 'bug', text: 'The stage button is confusing', context: { route: '/activity?view=forecast' } };
    const se = await (await mock({ id: 'se' })).diagnoseFeedback({ body } as never);
    expect(se.report.diagnosis.cause).toMatch(/vdp/i);
    const ae = await (await mock({ id: 'ae' })).diagnoseFeedback({ body } as never);
    expect(ae.report.diagnosis.cause).not.toMatch(/vdp/i);
    expect(ae.message).toContain('persona Specialist AE');
  });

  it("the AE's Deals and Home help say where the forecast rows are", () => {
    expect(pageHelpFor('deals', AE)!.note).toMatch(/Activity ▸ Forecast/);
    expect(pageHelpFor('deals', AE)!.note).not.toMatch(/Needs you/);
    expect(pageHelpFor('home', AE)!.note).toMatch(/Specialist Forecast/);
    expect(pageHelpFor('deals', SE)!.note).toMatch(/VDP/);
  });
});
