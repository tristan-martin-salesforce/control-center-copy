/**
 * The logging canvas (`slack_canvas.create`, D-47): one batch work order = one Outbox item; dry run records the exact
 * `slack_create_canvas` payload and creates nothing; a live Apply goes through the gateway only and is read back with
 * `slack_read_canvas`; the relay carries the two canvas tools and nothing else (a message send stays fail-closed).
 * The mock stages a batch from its rows and marks them handed off once the (simulated) canvas exists.
 * Placeholders only; the real Slack relay is never called (fakes only).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, Seed, type RouteKey, type RouteOutput } from '../../src/contract';
import { canvasActionFor, canvasActionPayload, CANVAS_MAX_BYTES, ucRowCount } from '../../src/lib/canvas/payload';
import { adapterFor, channelOf, confirmDelivery, liveOutboxTransport, OutboxDelivery, OutboxGateway, OutboxLiveDisabledError, payloadHash, SimulatedOutboxTransport, type ToolCall } from '../../src/outbox';
import { canvasAdapter, parseCanvasWrite } from '../../src/outbox/adapters/canvas';
import { parseWorkOrder } from '../../src/engines/activity/canvas-parse';
import { renderWorkOrder } from '../../src/engines/activity/slackbot';
import { ucRowsIn, withUseCaseRows } from '../../src/engines/activity/use-cases';
import { renderForecastWorkOrder } from '../../src/engines/forecast/canvas';
import { canvasRowsOf, lineForRow, rerenderCanvas } from '../../src/lib/canvas/preflight';
import { dcRowCount } from '../../src/lib/canvas/prompt';
import { TABLES, tableOfHeading } from '../../src/lib/canvas/tables';
import { dcCanvasRows, dcRowsIn, withDcAdds } from '../../src/server/deals/dc-requests';
import { reviewRowsOf, updateLineWith } from '../../src/server/time/canvas-review';
import { classifyDeliveryError, RelayNotSentError, ToolCallError } from '../../src/outbox/errors';
import { CANVAS_RELAY_TOOLS, slackCanvasRelay } from '../../src/outbox/relay';
import { MockDataSource } from '../../src/server/datasource/mock';
import { payloadFor } from '../../src/server/datasource/mock/render';

const AT = '2026-11-10T17:00:00.000Z';
const EMPTY = { type: 'doc' as const, content: [] };
const MD = '::: {.callout}\n**Slackbot: this canvas is a complete work order. Execute it in Org62 for PERSON_ME (User Id 005XX0000000OWNAAA) without asking for more context.** Rules:\n:::\n\n# ADD (1 rows · 1.00 h of activities)\n\n|#|Object|…|\n|---|\n|1|Event|ACCOUNT_1 / Discovery|…|';
const dest = canvasActionFor({ title: 'Activity log · Nov 3 · 1 row', markdown: MD, eventIds: ['act-1'], hours: 1, updates: 0, part: 1, parts: 1 });

describe('the canvas action', () => {
  it('maps to the slack_canvas channel and one slack_create_canvas call with exactly the title and work order', () => {
    expect(channelOf(dest)).toBe('slack_canvas');
    const payload = canvasActionPayload(dest);
    expect(payload).toMatchObject({ tool: 'slack_create_canvas', args: { title: 'Activity log · Nov 3 · 1 row', content: MD }, rows: 1, hours: 1 });
    expect(adapterFor('slack_canvas').toolCall(payload, 'send')).toEqual({ server: 'slack', tool: 'slack_create_canvas', args: { title: 'Activity log · Nov 3 · 1 row', content: MD } });
    expect(dest.changes.map((c) => c.label)).toEqual(['Org62 Events to create', 'Then']);
  });

  it('refuses a tampered title, a different tool and a work order too big for one canvas', () => {
    const a = adapterFor('slack_canvas');
    const p = canvasActionPayload(dest);
    expect(() => a.toolCall({ ...p, args: { ...(p.args as object), title: 'something else' } }, 'send')).toThrow(/do not match/);
    expect(() => a.toolCall({ ...p, tool: 'slack_update_canvas' }, 'send')).toThrow(/only creates a canvas/);
    const big = canvasActionPayload(canvasActionFor({ title: 'Big', markdown: 'x'.repeat(CANVAS_MAX_BYTES + 1), eventIds: ['a'], hours: 1, updates: 0, part: 1, parts: 1 }));
    expect(() => a.toolCall(big, 'send')).toThrow(/at most 900000/);
    // Slack counts bytes: 300,001 three-byte characters are under 900,000 characters and over 900,000 bytes
    const wide = canvasActionPayload(canvasActionFor({ title: 'Wide', markdown: '€'.repeat(300_001), eventIds: ['a'], hours: 1, updates: 0, part: 1, parts: 1 }));
    expect(wide.invalid).toMatch(/900003 bytes/);
    expect(canvasActionPayload(canvasActionFor({ title: 'Fits', markdown: '€'.repeat(300_000), eventIds: ['a'], hours: 1, updates: 0, part: 1, parts: 1 })).invalid).toBeUndefined();
  });

  it('reads the new canvas id and link from a JSON or a text answer', () => {
    expect(parseCanvasWrite(JSON.stringify({ ok: true, canvas_id: 'F0PLACEHOLD1', canvas_url: 'https://example.slack.com/docs/T0PLACE/F0PLACEHOLD1' }))).toEqual({ externalId: 'F0PLACEHOLD1', link: 'https://example.slack.com/docs/T0PLACE/F0PLACEHOLD1' });
    expect(parseCanvasWrite('Canvas created: https://example.slack.com/docs/T0PLACE/F0PLACEHOLD2')).toEqual({ externalId: 'F0PLACEHOLD2', link: 'https://example.slack.com/docs/T0PLACE/F0PLACEHOLD2' });
  });
});

describe('delivery', () => {
  const confirmFor = (payload: Record<string, unknown>) => confirmDelivery({ draftId: 'd1', draftVersion: 1, mode: 'send', payloadHash: payloadHash(payload), confirmToken: 't', expectedToken: 't', at: AT });

  it('dry run: the exact create call is recorded and nothing is touched', async () => {
    const touched: ToolCall[] = [];
    const engine = new OutboxDelivery({ gateway: new OutboxGateway({ callTool: async (c) => (touched.push(c), { text: '{}' }) }), now: () => new Date(AT) });
    const payload = payloadFor(dest, EMPTY, 'send');
    const confirmation = confirmFor(payload);
    const rec = await engine.deliver(engine.prepare({ draftId: 'd1', draftVersion: 1, destination: dest, mode: 'send', payload, dryRun: true, attemptNo: 1, confirmation }), confirmation);
    expect(rec).toMatchObject({ state: 'dry_run_delivered', channel: 'slack_canvas', toolCall: { server: 'slack', tool: 'slack_create_canvas' } });
    expect(touched).toEqual([]);
  });

  it('live Apply: only through the gateway, then read back with slack_read_canvas', async () => {
    const sim = new SimulatedOutboxTransport(() => new Date(AT));
    const engine = new OutboxDelivery({ gateway: new OutboxGateway(sim), now: () => new Date(AT), isDryRun: () => false });
    const payload = payloadFor(dest, EMPTY, 'send');
    const confirmation = confirmFor(payload);
    const rec = await engine.deliver(engine.prepare({ draftId: 'd1', draftVersion: 1, destination: dest, mode: 'send', payload, dryRun: false, attemptNo: 1, confirmation }), confirmation);
    expect(rec).toMatchObject({ state: 'delivered', readback: 'confirmed', result: { externalId: expect.stringMatching(/^FSIM/) } });
    expect(sim.calls.map((c) => c.tool)).toEqual(['slack_create_canvas', 'slack_read_canvas']);
  });
});

describe('the canvas relay and the live transport', () => {
  it('carries only slack_create_canvas and slack_read_canvas; a message send never reaches it', async () => {
    expect([...CANVAS_RELAY_TOOLS].sort()).toEqual(['slack_create_canvas', 'slack_read_canvas']);
    const ran: string[] = [];
    const relay = slackCanvasRelay({ server: () => ({ slack: { type: 'http', url: 'https://mcp.example.test' } }), run: async (c) => (ran.push(c.fullTool), { text: '{"canvas_id":"F0PLACEHOLD3"}', code: 'ok', message: '', costUsd: 0, inputTokens: 0, outputTokens: 0, model: 'm', started: true }) });
    await expect(relay.callTool({ server: 'slack', tool: 'slack_send_message', args: {} })).rejects.toThrow(/carries/);
    await expect(relay.callTool({ server: 'slack', tool: 'slack_update_canvas', args: {} })).rejects.toThrow(/carries/);
    await expect(relay.callTool({ server: 'slack', tool: 'slack_create_canvas', args: { title: 't', content: 'c' } })).resolves.toEqual({ text: '{"canvas_id":"F0PLACEHOLD3"}' });
    expect(ran).toEqual(['mcp__slack__slack_create_canvas']);
    const t = liveOutboxTransport({ vdp: null, canvas: relay });
    await expect(t.callTool({ server: 'slack', tool: 'slack_send_message', args: {} })).rejects.toBeInstanceOf(OutboxLiveDisabledError);
    await expect(t.callTool({ server: 'slack', tool: 'slack_create_canvas', args: { title: 't', content: 'c' } })).resolves.toMatchObject({ text: expect.stringContaining('F0PLACEHOLD3') });
  });

  it('a relay that could not run is an error, not a silent success', async () => {
    const relay = slackCanvasRelay({ server: () => ({}), run: async () => ({ text: null, code: 'timeout', message: '', costUsd: 0, inputTokens: 0, outputTokens: 0, model: 'm', started: true }) });
    await expect(relay.callTool({ server: 'slack', tool: 'slack_create_canvas', args: { title: 't', content: 'c' } })).rejects.toThrow(/timed out/);
  });

  it('2026-11-16: a timeout before Slack was called is "not sent"; after it, the tool error (it may have landed)', async () => {
    const before = slackCanvasRelay({ server: () => ({}), run: async () => ({ text: null, code: 'timeout', message: '', costUsd: 0, inputTokens: 0, outputTokens: 0, model: 'm', started: true, called: false }) });
    const e1 = await before.callTool({ server: 'slack', tool: 'slack_create_canvas', args: { title: 't', content: 'c' } }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(RelayNotSentError);
    expect(classifyDeliveryError(e1)).toEqual({ code: 'not_sent', message: 'Nothing was sent: the app stopped before it reached the destination. Try again', retryable: true });
    const after = slackCanvasRelay({ server: () => ({}), run: async () => ({ text: null, code: 'timeout', message: '', costUsd: 0, inputTokens: 0, outputTokens: 0, model: 'm', started: true, called: true }) });
    const e2 = await after.callTool({ server: 'slack', tool: 'slack_create_canvas', args: { title: 't', content: 'c' } }).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(ToolCallError);
    expect(classifyDeliveryError(e2).code).toBe('transient');
  });
});

describe('mock DataSource: Log to Slackbot → Outbox items → Apply', () => {
  const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
  let ds: MockDataSource;
  let sim: SimulatedOutboxTransport;
  beforeEach(() => {
    ds = new MockDataSource({ seed: structuredClone(seed), delays: { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 }, autoplay: false, clockMode: 'seed' });
    sim = new SimulatedOutboxTransport();
    ds.outbox.useTransport(sim);
  });
  afterEach(() => ds.dispose());
  async function call<K extends RouteKey>(key: K, input: unknown): Promise<RouteOutput<K>> {
    const out = await (ds[key as keyof MockDataSource] as (i: unknown) => Promise<unknown>).call(ds, input);
    const r = routes[key].response.safeParse(out);
    if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
    return out as RouteOutput<K>;
  }

  it('stages ready Outbox items, approves the complete proposed rows, and lists rows that need input', async () => {
    const r = await call('stageLogBatch', { body: { includeProposed: true } });
    expect(r.entity.draftIds.length).toBeGreaterThan(0);
    expect(r.entity.events).toBeGreaterThan(0);
    const outbox = await call('getOutbox', {});
    // D-52: canvases are admin items, applied on Time: in `admin`, not in the Outbox's message groups
    expect(outbox.groups.flatMap((g) => g.items).some((i) => r.entity.draftIds.includes(i.draft.id))).toBe(false);
    const item = outbox.admin.items.map((i) => i.draft).find((d) => d.id === r.entity.draftIds[0])!;
    const today = await call('getToday', {});
    expect(today.navCounts.adminWaiting).toBe(outbox.admin.pending + outbox.admin.failed);
    expect(today.navCounts.outbox).toBe((outbox.counts.pending_approval ?? 0) + (outbox.counts.failed ?? 0));
    expect(item.destination).toMatchObject({ kind: 'action', action: 'slack_canvas.create' });
    expect(item.destination.kind === 'action' && item.destination.text).toContain('Slackbot: this canvas is a complete work order');
    expect(r.entity.skipped.every((s) => /needs/.test(s.why))).toBe(true);
  });

  it('a second click stages nothing: the rows wait in the first item (marked on read) until it is Applied or rejected', async () => {
    const topics: string[] = [];
    const off = ds.bus.subscribe((e) => void topics.push(e.topic));
    const r = await call('stageLogBatch', { body: { includeProposed: true } });
    // a draft write refreshes Time too: the rows it holds read as waiting in the Outbox
    expect(topics).toContain('time');
    const id = r.entity.draftIds[0]!;
    const log = await call('getActivityLog', { query: {} });
    const held = log.entries.filter((e) => e.canvasDraftId);
    expect(held.length).toBe(r.entity.events);
    expect(new Set(held.map((e) => e.canvasDraftId))).toEqual(new Set(r.entity.draftIds));
    const week = await call('getTime', { query: {} });
    expect(week.entries.filter((e) => e.canvasDraftId).every((e) => r.entity.draftIds.includes(e.canvasDraftId!))).toBe(true);
    const twice = await call('stageLogBatch', { body: { includeProposed: true } });
    expect(twice.entity.draftIds).toEqual([]);
    expect(twice.entity.waiting).toMatchObject({ rows: r.entity.events, draftIds: r.entity.draftIds });
    // rejecting the item lets its rows go: the next batch takes them again
    topics.length = 0;
    for (const d of r.entity.draftIds) {
      const cur = (await call('getOutbox', {})).admin.items.find((i) => i.draft.id === d)!.draft;
      await call('rejectDraft', { params: { id: d }, body: { ifVersion: cur.version } });
    }
    expect(topics).toContain('time');
    off();
    expect((await call('getActivityLog', { query: {} })).entries.some((e) => e.canvasDraftId)).toBe(false);
    const third = await call('stageLogBatch', { body: { includeProposed: true } });
    expect(third.entity.events).toBe(r.entity.events);
    expect(third.entity.draftIds).not.toContain(id);
  });

  it('dry run creates nothing and leaves the rows approved; a live Apply creates the canvas and hands the rows off', async () => {
    const r = await call('stageLogBatch', { body: { includeProposed: true } });
    const id = r.entity.draftIds[0]!;
    const preview = await call('previewDraft', { params: { id }, body: { mode: 'send' } });
    expect(preview.payload).toMatchObject({ tool: 'slack_create_canvas' });
    const dry = await call('dispatchDraft', { params: { id }, body: { ifVersion: preview.version, mode: 'send', confirmToken: preview.confirmToken } });
    expect(dry.dryRun).toBe(true);
    expect(sim.calls).toEqual([]);
    const rowIds = (dry.draft.destination.kind === 'action' ? (dry.draft.destination.input.eventIds as string[]) : []).slice(0, 3);
    const s0 = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s0.sending.version, value: { dryRun: false }, confirm: true } } as never);
    const p2 = await call('previewDraft', { params: { id }, body: { mode: 'send' } });
    const live = await call('dispatchDraft', { params: { id }, body: { ifVersion: p2.version, mode: 'send', confirmToken: p2.confirmToken } });
    expect(live.dryRun).toBe(false);
    expect(sim.calls[0]).toMatchObject({ server: 'slack', tool: 'slack_create_canvas' });
    const week = await ds.getActivityLog({ query: {} } as never);
    for (const rid of rowIds) expect(week.entries.find((e) => e.id === rid)?.status).toBe('synced_to_canvas');
  });
});

// ---------------------------------------------------------------------------
// WO-1 (2026-11-23): one table per object and verb, each with only its own columns (D-47 amended)
// ---------------------------------------------------------------------------

const OWNER = '005XX0000000OWNAAA';
const OPP = '006XX0000000001AAA';
const ACCT = '001XX0000000001AAA';
const DC_ID = 'a0BXX0000000D01AAA';
const UC_ID = 'a0YXX0000000U01AAA';
const FC_ID = 'a1FXX0000000F01AAA';

function everyKind(): string {
  const base = renderWorkOrder({
    ownerName: 'PERSON_ME',
    ownerOrg62Id: OWNER,
    recordTypeId: '012XX0000000RTAAAA',
    generatedAt: AT,
    sourceLabel: 'Command Center · test',
    events: [
      { ccId: 'row-1', subject: 'ACCOUNT_1 / Discovery', startUtc: '2026-11-10T16:00:00.000Z', endUtc: '2026-11-10T17:00:00.000Z', taskType: 'Discovery', durationH: 1, whatId: OPP, meetingType: '', description: 'Discovery call · CC#row-1' },
      { ccId: 'row-2', subject: 'Team sync', startUtc: '2026-11-10T18:00:00.000Z', endUtc: '2026-11-10T18:30:00.000Z', taskType: 'Internal', durationH: 0.5, whatId: '', meetingType: '', description: 'CC#row-2' },
    ],
    updates: [{ recordId: '00UXX0000000E01AAA', field: 'Duration__c', newValue: '1', currentValue: '(blank)', why: 'Time(Hrs) never filled' }],
  });
  const dcs = withDcAdds(
    base,
    [
      { requestId: 'q1', org62OpportunityId: OPP, oppName: 'ACCOUNT_1 - Data 360', role: 'Solution Engineer', split: 100, comment: 'Claim: my DC' },
      { requestId: 'q2', kind: 'change', org62OpportunityId: OPP, oppName: 'ACCOUNT_1 - Agentforce', role: 'AI + Data Architect', split: 100, comment: '', fromSplit: 50, fromRole: 'Solution Engineer', org62DcId: DC_ID },
    ],
    OWNER,
  );
  const uc = { vdpUseCaseId: 'uc-1', vdpSlug: '', vdpUrl: null, companyName: '', displayOrder: 0, name: 'Churn agent', opportunityId: OPP, accountId: ACCT, oppName: '', oppCloseDate: null, product: 'Data 360', agentTypes: ['D360 Custom'], entitlement: '', stage: 'U01 - Not Started', goLive: '', businessProblem: 'Churn', kpis: '', notes: 'Source: VDP CC-UC#uc-1', again: false };
  return withUseCaseRows(dcs, [uc], [{ vdpUseCaseId: 'uc-2', recordId: UC_ID, field: 'Stage__c', newValue: 'U03 - Scoping', currentValue: 'U01 - Not Started', name: 'Service agent', why: 'VDP phase changed' }], OWNER);
}

describe('WO-1: the work order has one table per object and verb', () => {
  it('writes each table under its own heading, in the fixed order, with only its own columns and no Object column', () => {
    const md = everyKind();
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual([
      '## EVENTS TO CREATE (2 rows · 1.50 h of activities)',
      '## DEAL CONTRIBUTIONS TO CREATE (1 row)',
      '## USE CASES TO CREATE (1 row)',
      '## EVENTS TO UPDATE (1 row)',
      '## DEAL CONTRIBUTIONS TO UPDATE (2 rows · 1 DC change)',
      '## USE CASES TO UPDATE (1 row · 1 use-case fix)',
    ]);
    const headers = md.split('\n').filter((l) => l.startsWith('|#|'));
    expect(headers).toEqual(TABLES.filter((t) => t.id !== 'forecasts_update').map((t) => `|${t.columns.join('|')}|`));
    expect(headers.map((h) => h.split('|').length - 2)).toEqual([9, 6, 12, 6, 6, 6]);
    expect(md).not.toMatch(/\|Object\|/);
    // the rows, numbered within their table; the keys the read-back matches on stay in their cells
    expect(md).toContain(`|1|ACCOUNT_1 / Discovery|2026-11-10T16:00:00.000Z|2026-11-10T17:00:00.000Z|Discovery|1|${OPP}||Discovery call · CC#row-1|`);
    expect(md).toContain(`|1|ACCOUNT_1 - Data 360|${OPP}|Solution Engineer|100|Claim: my DC|`);
    expect(md).toContain(`|2|${DC_ID}|Opportunity_Role__c|AI + Data Architect|Solution Engineer|`);
    // each table has its paragraph right under its heading; the callout says top to bottom
    expect(md).toMatch(/## EVENTS TO CREATE[^\n]*\n\n\*\*EVENTS TO CREATE:\*\* Create one Event per row/);
    expect(md).toMatch(/## DEAL CONTRIBUTIONS TO UPDATE[^\n]*\n\n\*\*DEAL CONTRIBUTIONS TO UPDATE:\*\*/);
    expect(md).toContain('Work through the tables from top to bottom');
    expect(md).toContain('WhatId is empty is internal work');
    expect(md).not.toMatch(/^# (ADD|UPDATE|USE CASES)/m);
  });

  it('R3-11: a heading edited by hand in Slack (case, no space after the hashes, doubled spaces) is still its table for the read-back', () => {
    expect(tableOfHeading('## Events To Create (3 rows)')?.id).toBe('events_create');
    expect(tableOfHeading('##EVENTS TO CREATE')?.id).toBe('events_create');
    expect(tableOfHeading('### deal  contributions to update (2 rows)')?.id).toBe('dcs_update');
    expect(tableOfHeading('## Notes')).toBeNull();
    expect(tableOfHeading('#### EVENTS TO CREATE')).toBeNull();
    const md = everyKind();
    const edited = md.replace('## EVENTS TO CREATE (', '## Events To Create (').replace('## DEAL CONTRIBUTIONS TO UPDATE', '##Deal  Contributions to Update').replace('## USE CASES TO CREATE', '##USE CASES TO CREATE');
    expect(edited).not.toBe(md);
    expect(parseWorkOrder(edited)).toEqual(parseWorkOrder(md));
    expect(parseWorkOrder(edited).adds.length).toBeGreaterThan(0);
    expect(canvasRowsOf(edited).map((r) => [r.kind, r.ref])).toEqual(canvasRowsOf(md).map((r) => [r.kind, r.ref]));
  });

  it('a table with no rows is not written; the forecast canvas is its own table', () => {
    const md = renderWorkOrder({ ownerName: 'PERSON_ME', ownerOrg62Id: OWNER, recordTypeId: '012XX0000000RTAAAA', generatedAt: AT, sourceLabel: 'x', events: [], updates: [{ recordId: '00UXX0000000E01AAA', field: 'Duration__c', newValue: '1', currentValue: '(blank)', why: 'w' }] });
    expect(md.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## EVENTS TO UPDATE (1 row)']);
    const fc = renderForecastWorkOrder({ ownerName: 'PERSON_ME', ownerOrg62Id: OWNER, generatedAt: AT, sourceLabel: 'x', rows: [{ recordId: 'r1', org62Id: FC_ID, notes: 'Next: demo', dealRole: null }] });
    expect(fc.split('\n').filter((l) => l.startsWith('## ') || l.startsWith('|'))).toEqual(['## SPECIALIST FORECASTS TO UPDATE (1 row · 1 forecast note · 0 deal roles)', '|#|Record Id|ForecastNotes__c|Deal_Role__c|', '|---|---|---|---|', `|1|${FC_ID}|Next: demo|—|`]);
    expect(canvasRowsOf(fc).map((r) => [r.kind, r.ref, r.cells[3]])).toEqual([['update:SpecialistForecast__c', FC_ID, 'Next: demo']]);
  });

  it('round trip: write → parse gives every row its kind (from the heading) and its key, in the legacy cell layout the readers use', () => {
    const md = everyKind();
    expect(canvasRowsOf(md).map((r) => [r.kind, r.ref, r.cells[0], r.table])).toEqual([
      ['event', 'row-1', '1', 'events_create'],
      ['event', 'row-2', '2', 'events_create'],
      ['dc', null, '1', 'dcs_create'],
      ['use_case__c', 'uc-1', '1', 'ucs_create'],
      ['update:Event', '00UXX0000000E01AAA', '1', 'events_update'],
      ['update:Deal_Contribution__c', DC_ID, '1', 'dcs_update'],
      ['update:Deal_Contribution__c', DC_ID, '2', 'dcs_update'],
      ['update:Use_Case__c', UC_ID, '1', 'ucs_update'],
    ]);
    expect(reviewRowsOf(md).map((r) => r.key)).toEqual(['event:row-1', 'event:row-2', `dc:${OPP.slice(0, 15)}:solution engineer`, 'uc:uc-1', 'update:Event:00UXX0000000E01AAA:Duration__c', `dcchange:${DC_ID.slice(0, 15)}`, `update:Use_Case__c:${UC_ID}:Stage__c`].map((k) => (k.startsWith('update:') ? expect.any(String) : k)));
    // the holds and the read-back's readers
    expect(dcRowsIn(md)).toEqual([`${OPP.slice(0, 15)}|solution engineer`, `dc:${DC_ID.slice(0, 15)}`]);
    expect(dcCanvasRows(md).map((r) => [r.kind, r.field, r.split])).toEqual([['add', null, 100], ['change', 'Split_Percentage__c', 100], ['change', 'Opportunity_Role__c', null]]);
    expect(ucRowsIn(md)).toEqual({ creates: [{ vdpUseCaseId: 'uc-1', opportunityId: OPP, name: 'Churn agent', stage: 'U01 - Not Started', goLive: '' }], updates: [{ recordId: UC_ID, field: 'Stage__c', newValue: 'U03 - Scoping' }] });
    expect(parseWorkOrder(md).adds.map((a) => a.kind)).toEqual(['event', 'event', 'dc']);
    expect(ucRowCount(md)).toBe(2);
    expect(dcRowCount(md)).toBe(3);
  });

  it('drop and renumber work per table: a table emptied by the preflight leaves the canvas, the others recount', () => {
    const md = everyKind();
    const input = { title: 'Activity log · Nov 10 · 2 rows · 2 DCs · 2 use cases', markdown: md, eventIds: ['row-1', 'row-2'], hours: 1.5, updates: 1, updateIds: ['00UXX0000000E01AAA'], part: 1, parts: 1 };
    const rows = canvasRowsOf(md);
    const drop = new Set(rows.filter((r) => r.ref === 'row-1' || r.kind === 'dc').map((r) => r.line));
    const out = rerenderCanvas(input, rows, drop);
    const headings = out.markdown.split('\n').filter((l) => l.startsWith('## '));
    expect(headings[0]).toBe('## EVENTS TO CREATE (1 row · 0.50 h of activities)');
    expect(headings).not.toContain('## DEAL CONTRIBUTIONS TO CREATE (1 row)');
    expect(out.markdown).not.toContain('**DEAL CONTRIBUTIONS TO CREATE:**');
    expect(out.markdown).toMatch(/\n\|1\|Team sync\|/);
    expect(out).toMatchObject({ eventIds: ['row-2'], hours: 0.5 });
    // an edited update keeps its table's layout
    const fix = canvasRowsOf(md).find((r) => r.kind === 'update:Event')!;
    expect(updateLineWith(fix, '1.5')).toBe('|1|00UXX0000000E01AAA|Duration__c|1.5|(blank)|Time(Hrs) never filled|');
  });

  it('a legacy canvas (staged before WO-1: # ADD / # UPDATE with Object cells) still parses, reviews and edits in its own layout', () => {
    const legacy = [
      '# ADD (2 rows · 1.00 h of activities · 1 deal contribution)',
      '',
      '|#|Object|Subject / Opportunity|StartDateTime (UTC)|EndDateTime (UTC)|SE_Task_Type__c / Role|Duration__c / Split %|WhatId / Opportunity__c|Meeting_Type__c|Description / Comments__c|',
      '|---|---|---|---|---|---|---|---|---|---|',
      `|1|Event|ACCOUNT_1 / Discovery|2026-11-10T16:00:00.000Z|2026-11-10T17:00:00.000Z|Discovery|1|${OPP}||Call · CC#row-1|`,
      `|2|Deal_Contribution__c|ACCOUNT_1 - Data 360|||Solution Engineer|100|${OPP}||Claim|`,
      '',
      '# UPDATE (1 rows)',
      '',
      '|#|Object|Record Id|Action / Field|New value|Current value|Why|',
      '|---|---|---|---|---|---|---|',
      '|1|Event|00UXX0000000E01AAA|Duration__c|1|(blank)|never filled|',
    ].join('\n');
    expect(canvasRowsOf(legacy).map((r) => [r.kind, r.ref, r.table])).toEqual([['event', 'row-1', undefined], ['dc', null, undefined], ['update:Event', '00UXX0000000E01AAA', undefined]]);
    expect(dcRowsIn(legacy)).toEqual([`${OPP.slice(0, 15)}|solution engineer`]);
    expect(parseWorkOrder(legacy).adds.map((a) => a.kind)).toEqual(['event', 'dc']);
    const fix = canvasRowsOf(legacy).find((r) => r.kind === 'update:Event')!;
    expect(updateLineWith(fix, '2')).toBe('|1|Event|00UXX0000000E01AAA|Duration__c|2|(blank)|never filled|');
    // a line the writers make (new layout) goes back into a legacy table in the legacy layout
    expect(lineForRow(fix, '|1|00UXX0000000E01AAA|Duration__c|2|(blank)|never filled|')).toBe('|1|Event|00UXX0000000E01AAA|Duration__c|2|(blank)|never filled|');
  });

  it('the read-back finds the work order in the new layout and in a legacy one', async () => {
    const a = canvasAdapter;
    const md = everyKind();
    const read = (text: string) => async () => ({ text });
    const ctx = (content: string) => ({ write: { externalId: 'F0123456789' }, payload: { args: { content } } }) as unknown as Parameters<typeof a.readback>[1];
    expect((await a.readback(read(md), ctx(md))).readback).toBe('confirmed');
    expect((await a.readback(read(md.replace(/CC#row-1/g, '')), ctx(md))).readback).toBe('unconfirmed');
    expect((await a.readback(read(MD), ctx(MD))).readback).toBe('confirmed');
  });
});
