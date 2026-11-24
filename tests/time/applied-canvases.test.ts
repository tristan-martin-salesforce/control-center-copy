/**
 * Applied actions keep a home and a link; logged rows never re-log (mock DataSource + pure parts; placeholders only).
 *
 *   result link    the adapter's link lands on the draft (`resultUrl`); a canvas Slack answered with its id only gets
 *                  its link from a canvas link the app already knows; a VDP change falls back to its target
 *   a home         a sent canvas is in Time's receipts (logCanvases), never on the Outbox page (D-75); the
 *                  feedback post is the Outbox's own; the Time badge counts only what Time shows
 *   re-logging     chat edits a row's opportunity and status → the canvas is applied → the row is synced_to_canvas →
 *                  the next batch is empty (and a row stuck at approved on a sent canvas is never offered again)
 *   Assistant      compactOutbox lists what was applied, with its link and what the status means
 *   prompt         each canvas's own Slackbot prompt, in the persona's record-type wording
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, Seed, type ActivityEntry, type Draft, type LogCanvas, type RouteKey, type RouteOutput } from '@/contract';
import { outboxStatus } from '@/components/lists/outbox';
import { q4Steps } from '@/components/time/derive';
import { sendingOf } from '@/components/time/sending-derive';
import { adminOnTime } from '@/personas';
import { canvasHolds, canvasUrlFor } from '@/lib/canvas/payload';
import { canvasPromptFor, logCanvasPrompt } from '@/lib/canvas/prompt';
import { resultUrlOf } from '@/outbox';
import { createChatHost } from '@/server/chat/host';
import { compactOutbox } from '@/server/chat/compact';
import { logCanvasesOf } from '@/server/datasource/log-canvases';
import { MockDataSource } from '@/server/datasource/mock';
import { FakeMcp } from '../outbox/fake';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const fast = { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 };
const CANVAS_URL = 'https://example.slack.com/docs/T0PLACE/F0PLACEHOLD1';

let ds: MockDataSource;
let fake: FakeMcp;
let created = '';
beforeEach(() => {
  ds = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
  created = '';
  fake = new FakeMcp()
    .on('slack_create_canvas', (call) => ((created = String(call.args.content)), { text: JSON.stringify({ ok: true, canvas_id: 'F0PLACEHOLD1', canvas_url: CANVAS_URL }) }))
    .on('slack_read_canvas', () => ({ text: created }));
  ds.outbox.useTransport(fake);
});
afterEach(() => ds.dispose());

async function call<K extends RouteKey>(key: K, input: unknown): Promise<RouteOutput<K>> {
  const out = await (ds[key as keyof MockDataSource] as (i: unknown) => Promise<unknown>).call(ds, input);
  const r = routes[key].response.safeParse(out);
  if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
  return out as RouteOutput<K>;
}

async function liveMode() {
  const s = await ds.getSettings({} as never);
  await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun: false }, confirm: true } });
}

async function apply(id: string) {
  const p = await call('previewDraft', { params: { id }, body: { mode: 'send' } });
  return call('dispatchDraft', { params: { id }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } });
}

const settle = () => new Promise((r) => setTimeout(r, 40));

describe('the result link', () => {
  it("is the adapter's link; a canvas with only its id gets one from a known canvas link; a VDP change falls back to its target", () => {
    const canvas = { destination: { kind: 'action', action: 'slack_canvas.create', target: { label: 'Activity log', url: null }, input: {}, changes: [], text: null }, resultUrl: null } as unknown as Draft;
    expect(resultUrlOf(canvas, { result: { externalId: 'F0PLACEHOLD1', link: CANVAS_URL } })).toBe(CANVAS_URL);
    expect(resultUrlOf(canvas, { result: { externalId: 'F0PLACEHOLD2', link: null } }, [null, 'https://example.slack.com/docs/T0PLACE/F0OTHERCANVAS'])).toBe('https://example.slack.com/docs/T0PLACE/F0PLACEHOLD2');
    expect(resultUrlOf(canvas, { result: { externalId: 'F0PLACEHOLD2', link: null } }, ['https://example.slack.com/archives/C0X/p1'])).toBeNull();
    expect(canvasUrlFor('not-a-canvas', [CANVAS_URL])).toBeNull();
    const vdp = { destination: { kind: 'action', action: 'vdp.update_use_case', target: { label: 'CUSTOMER_1 FY27 Q4', url: 'https://vdp.example.test/vdp/customer-1' }, input: {}, changes: [], text: null }, resultUrl: null } as unknown as Draft;
    expect(resultUrlOf(vdp, { result: { externalId: 'u1', link: null } })).toBe('https://vdp.example.test/vdp/customer-1');
  });
});

describe('an applied logging canvas has a home and a link (mock)', () => {
  it('Apply stores the link; it is in the Time receipts (never as waiting) and never on the Outbox page (D-75)', async () => {
    const staged = await call('stageLogBatch', { body: {} });
    const id = staged.entity.draftIds[0]!;
    expect(id).toBeTruthy();
    // waiting for Apply: Time shows it (the badge counts it), the Outbox only points there
    expect((await call('getToday', {})).navCounts.adminWaiting).toBeGreaterThanOrEqual(1);
    expect((await call('getOutbox', {})).admin.items.map((i) => i.draft.id)).toContain(id);
    const pending = (await call('getTime', { query: {} })).logCanvases.find((c) => c.draftId === id)!;
    expect(pending).toMatchObject({ state: 'pending', url: null, appliedAt: null });
    // where its hours land: the seed's rows are all in one fiscal quarter, so one entry carries every row
    expect(pending.quarters.map((q) => q.label)).toEqual([seed.meta.quarter.label]);
    expect(pending.quarters[0]!.rows).toBe(staged.entity.events);
    expect(pending.quarters[0]!.hours).toBeCloseTo(staged.entity.hours, 2);

    await liveMode();
    const r = await apply(id);
    expect(r.draft.resultUrl).toBe(CANVAS_URL);
    await settle(); // the read-back
    const d = await call('getDraft', { params: { id } });
    expect(d).toMatchObject({ status: 'verified', resultUrl: CANVAS_URL });

    const out = await call('getOutbox', {});
    // D-75: Activity's, never the Outbox page's: not under Sent; the payload's applied list (the assistant's) has its link
    expect(out.groups.flatMap((g) => g.items).some((i) => i.draft.destination.kind === 'action' && i.draft.destination.action === 'slack_canvas.create')).toBe(false);
    expect(out.admin.applied.find((i) => i.draft.id === id)?.draft.resultUrl).toBe(CANVAS_URL);
    expect(out.admin.items.map((i) => i.draft.id)).not.toContain(id);

    const t = await call('getTime', { query: {} });
    const receipt = t.logCanvases.find((c) => c.draftId === id)!;
    expect(receipt).toMatchObject({ state: 'verified', url: CANVAS_URL, rows: staged.entity.events });
    expect(receipt.appliedAt).toBeTruthy();
    expect(receipt.org62).toMatchObject({ logged: 0, missing: 0, waiting: staged.entity.events });
    // C6 lane 3: before Apply the batch's one action is Review & apply; after it, Send to Org62 via Slackbot
    // (R2-11) the filled step is the one the batch is at: Staged before Apply, Applied while it waits for the send
    const before = sendingOf({ canvases: [pending] }).batches[0]!;
    expect(before).toMatchObject({ next: 'apply', rows: staged.entity.events });
    expect(before.steps.map((x) => x.state)).toEqual(['current', 'todo', 'todo', 'todo']);
    const lane = sendingOf({ canvases: [receipt] });
    expect(lane.batches[0]!.steps.map((x) => x.state)).toEqual(['done', 'current', 'todo', 'todo']);
    expect(lane.batches[0]!.next).toBe('send');
    expect(lane.header).toMatchObject({ batches: 1, failed: 0 });
    for (const rid of receipt.rowIds) expect(t.entries.find((e) => e.id === rid)?.status ?? 'synced_to_canvas').toBe('synced_to_canvas');

    // the Assistant sees it: created, with its link
    const c = compactOutbox(out);
    expect(c.applied.find((a) => a.draftId === id)).toMatchObject({ kind: 'Logging canvas', status: 'verified', url: CANVAS_URL, meaning: expect.stringMatching(/created/) });
    expect(c.waitingOnTime.map((w) => w.draftId)).not.toContain(id);
  });

  it('a canvas applied as a dry run stays waiting, and the Assistant is told nothing was created', async () => {
    const staged = await call('stageLogBatch', { body: {} });
    const id = staged.entity.draftIds[0]!;
    const r = await apply(id);
    expect(r.dryRun).toBe(true);
    const c = compactOutbox(await call('getOutbox', {}));
    expect(c.applied.map((a) => a.draftId)).not.toContain(id);
    expect(c.waitingOnTime.find((w) => w.draftId === id)).toMatchObject({ kind: 'Logging canvas', status: 'ready', lastDryRunAt: expect.any(String), href: `/activity?view=week&draft=${id}` });
  });
});

describe('a logged row never re-logs (mock)', () => {
  it('chat edits the opp and status → canvas applied → the row is synced_to_canvas → the next batch is empty', async () => {
    const host = createChatHost(ds, ds.be6.backend(), () => ds.now());
    const tid = (await ds.listChatThreads({} as never)).threads.find((t) => t.isDefault)!.id;
    const preview = await host.previewChanges([{ op: 'edit_activities', entryIds: ['ac_wed_hooli'], patch: { oppId: 'opp_acme_af', status: 'approved', taskType: 'Solution Design' } }], tid);
    expect(preview.errors).toEqual([]);
    const p = await host.stageChanges({ threadId: tid, messageId: 'msg_relog', changes: preview.changes, lines: preview.lines, entity: preview.entity, reason: 'Log it on the ACME opp?' });
    await ds.applyProposal({ params: { id: p.id }, body: {} } as never);
    const edited = (await call('getActivityLog', { query: {} })).entries.find((e) => e.id === 'ac_wed_hooli')!;
    expect(edited).toMatchObject({ status: 'approved', oppId: 'opp_acme_af' });
    expect(edited.userLockedFields).toContain('oppId');
    expect(edited.userLockedFields).not.toContain('status');

    const staged = await call('stageLogBatch', { body: {} });
    const id = staged.entity.draftIds.find((d) => ds.store.get('drafts', d)!.destination.kind === 'action' && (ds.store.get('drafts', d)!.destination as unknown as { input: { eventIds: string[] } }).input.eventIds.includes('ac_wed_hooli'))!;
    expect(id).toBeTruthy();
    await liveMode();
    for (const d of staged.entity.draftIds) await apply(d);
    await settle();
    expect((await call('getActivityLog', { query: {} })).entries.find((e) => e.id === 'ac_wed_hooli')!.status).toBe('synced_to_canvas');

    const next = await call('stageLogBatch', { body: {} });
    expect(next.entity.draftIds).toEqual([]);
    expect(next.entity.waiting.rows).toBe(0);
  });

  it('a row a sent canvas carries is never taken again, even when its status still reads approved', async () => {
    const staged = await call('stageLogBatch', { body: {} });
    await liveMode();
    for (const d of staged.entity.draftIds) await apply(d);
    await settle();
    // the old bug's state: the row is back at approved while its canvas exists
    const rid = (ds.store.get('drafts', staged.entity.draftIds[0]!)!.destination as unknown as { input: { eventIds: string[] } }).input.eventIds[0]!;
    const row = ds.store.get('activity', rid)!;
    await call('patchActivity', { params: { id: rid }, body: { ifVersion: row.version, patch: { status: 'approved' } } });
    expect(ds.store.get('activity', rid)!.status).toBe('approved');
    expect(canvasHolds(ds.store.all('drafts')).sent?.get(rid)).toBe(staged.entity.draftIds[0]);
    const next = await call('stageLogBatch', { body: {} });
    expect(next.entity.canvases.flatMap((c) => c.draftId)).toEqual([]);
    // Time does not offer it to Log either: it waits for Org62 on its canvas (Confirm lists that canvas)
    const t = await call('getTime', { query: {} });
    const rows = (await call('getActivityLog', { query: {} })).entries;
    const steps = q4Steps({ rows, week: t, nowIso: ds.now().toISOString() });
    expect(steps.find((s) => s.id === 'submit')!.ids).not.toContain(rid);
    const confirm = steps.find((s) => s.id === 'confirm')!;
    expect(confirm.ids).toContain(rid);
    expect(confirm.canvases!.map((c) => c.draftId)).toContain(staged.entity.draftIds[0]);
  });
});

describe('admin items are classified by family', () => {
  const action = (id: string, act: string, input: Record<string, unknown> = {}) =>
    ({ id, status: 'ready', updatedAt: '2026-11-05T10:00:00.000Z', destination: { kind: 'action', action: act, target: { label: `CUSTOMER_1 · ${id}`, url: null }, input, changes: [], text: null } }) as unknown as Draft;
  const log = action('log', 'slack_canvas.create', { eventIds: ['r1'] });
  const fc = action('fc', 'slack_canvas.create', { eventIds: [], forecast: { kind: 'specialist_forecast', updates: [] } });
  const vdp = action('vdp', 'vdp.update_use_case');
  const fb = action('fb', 'feedback.post');

  it('the Time badge counts what Time shows: logging canvases, and forecast canvases and VDP changes only while the role has them', () => {
    const se = { features: { vdp: true, specialistForecast: false } } as never;
    const ae = { features: { vdp: false, specialistForecast: true } } as never;
    expect([log, fc, vdp, fb].filter((d) => adminOnTime(d, se)).map((d) => d.id)).toEqual(['log', 'vdp']);
    expect([log, fc, vdp, fb].filter((d) => adminOnTime(d, ae)).map((d) => d.id)).toEqual(['log', 'fc']);
  });

  it('an applied action reads as applied in Outbox ▸ Sent; a message still reads as sent', () => {
    expect(outboxStatus({ ...log, status: 'verified', verification: null } as Draft, 'sent').label).toBe('Applied · verified');
    expect(outboxStatus({ ...fb, status: 'sent', verification: null } as Draft, 'sent').label).toBe('Applied');
    const msg = { ...log, destination: { kind: 'slack', target: 'channel', channelId: 'C0X', channelName: '#x', threadTs: null }, status: 'sent', verification: null } as unknown as Draft;
    expect(outboxStatus(msg, 'sent').label).toBe('Sent');
  });
});

describe('Time receipts and prompts (pure)', () => {
  const draft = (id: string, status: Draft['status'], eventIds: string[], o: Partial<Draft> = {}): Draft =>
    ({
      id,
      status,
      createdAt: '2026-11-04T10:00:00.000Z',
      updatedAt: '2026-11-04T10:05:00.000Z',
      attempts: status === 'ready' ? [] : [{ id: 'a1', at: '2026-11-04T10:05:00.000Z', mode: 'send', dryRun: false, outcome: 'sent' }],
      resultUrl: status === 'ready' ? null : CANVAS_URL,
      destination: { kind: 'action', action: 'slack_canvas.create', target: { label: `Activity log · ${id}`, url: null }, input: { title: `Activity log · ${id}`, markdown: '|1|Deal_Contribution__c|x|', eventIds, hours: 2, updates: 0, part: 1, parts: 1 }, changes: [], text: null },
      ...o,
    }) as unknown as Draft;
  const row = (id: string, status: ActivityEntry['status']) => ({ id, status });
  const NOW = new Date('2026-11-05T12:00:00.000Z');

  it('lists pending and applied canvases; an old applied one only while a row is not in Org62', () => {
    const list = logCanvasesOf(
      [
        draft('p', 'ready', ['r0']),
        draft('v', 'verified', ['r1', 'r2']),
        draft('old', 'sent', ['r3'], { attempts: [{ id: 'a', at: '2026-10-01T10:00:00.000Z', mode: 'send', dryRun: false, outcome: 'sent' }] }),
        draft('oldWaiting', 'sent', ['r4'], { attempts: [{ id: 'a', at: '2026-10-02T10:00:00.000Z', mode: 'send', dryRun: false, outcome: 'sent' }] }),
        draft('gone', 'rejected', ['r5']),
      ],
      // D-65 (TL-45): "missing" is a row not in Org62 after all (deleted there); one whose fields differ is in Org62
      [row('r1', 'verified'), { ...row('r2', 'verify_failed'), issues: ['Org62 check: Deleted in Org62'] }, row('r3', 'logged'), row('r4', 'synced_to_canvas')],
      NOW,
    );
    expect(list.map((c) => c.draftId)).toEqual(['v', 'p', 'oldWaiting']);
    expect(list[0]).toMatchObject({ state: 'verified', url: CANVAS_URL, rows: 2, dcs: 1, org62: { logged: 1, missing: 1, waiting: 0 } });
    expect(list[1]).toMatchObject({ state: 'pending', url: null, appliedAt: null, org62: null });
  });

  it("each canvas's prompt names it, its link and the persona's record type", () => {
    const se = logCanvasPrompt({ title: 'Activity log · Nov 3 · 2 rows', url: CANVAS_URL, rows: 2, hours: 2.5, dcs: 1, recordTypeName: 'Solutions Event', taskType: true });
    expect(se).toContain(`"Activity log · Nov 3 · 2 rows" canvas now (${CANVAS_URL})`);
    expect(se).toContain('2 activity rows (2.5 h)');
    expect(se).toContain('1 Deal Contribution to add');
    expect(se).toContain('create the Solutions Event');
    expect(se).toContain('keep the task type, opp');
    const ae = logCanvasPrompt({ title: 'Activity log · 1 row', url: null, rows: 1, hours: 1, recordTypeName: 'Sales Events', taskType: false });
    expect(ae).toContain('create the Sales Event (or update');
    expect(ae).not.toContain('Solutions Event');
    expect(ae).not.toContain('task type');
    const d = draft('v', 'verified', ['r1']);
    expect(canvasPromptFor(d.destination as never, { url: d.resultUrl, recordTypeName: 'Sales Events', taskType: false })).toContain('create the Sales Event');
    const fc = { ...d.destination, input: { ...(d.destination as { input: object }).input, forecast: { kind: 'specialist_forecast', updates: [{ field: 'ForecastNotes__c' }, { field: 'Deal_Role__c' }] } } };
    expect(canvasPromptFor(fc as never, { url: CANVAS_URL, recordTypeName: 'Sales Events' })).toContain('1 forecast note and 1 Deal Role on my Specialist Forecasts');
  });

  it('the Confirm step lists each handed-off canvas; a row on an applied canvas is not offered to Log', () => {
    const e = (id: string, status: ActivityEntry['status']): ActivityEntry =>
      ({ id, version: 1, date: '2026-11-03', start: '2026-11-03T17:00:00.000Z', end: '2026-11-03T18:00:00.000Z', durationH: 1, taskType: 'Demo', oppId: 'o1', oppName: 'CUSTOMER_1 opp', accountName: 'CUSTOMER_1', meetingType: 'CF', description: 'd', status, confidence: 'likely', sources: [], userLockedFields: [], issues: [], updatedAt: '2026-11-03T18:00:00.000Z' }) as unknown as ActivityEntry;
    const canvases: LogCanvas[] = logCanvasesOf([draft('c1', 'sent', ['s1', 'stuck'])], [row('s1', 'synced_to_canvas'), row('stuck', 'approved')], NOW);
    const week = { entries: [], canvas: { lastSyncedAt: null, rowsChangedSince: 0, confirmRequired: false, label: 'Work-order canvas' }, quarter: { label: 'Q4 FY27', loggedH: 0, targetH: 60, due: null }, logCanvases: canvases };
    const steps = q4Steps({ rows: [e('s1', 'synced_to_canvas'), e('stuck', 'approved'), e('new', 'approved')], week, nowIso: NOW.toISOString() });
    expect(steps.find((s) => s.id === 'submit')).toMatchObject({ ids: ['new'], why: expect.stringContaining('to Apply here') });
    expect(steps.find((s) => s.id === 'submit')!.why).not.toMatch(/Outbox/);
    const confirm = steps.find((s) => s.id === 'confirm')!;
    expect(confirm.ids.sort()).toEqual(['s1', 'stuck']);
    expect(confirm.canvases!.map((c) => c.draftId)).toEqual(['c1']);
  });
});
