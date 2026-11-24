/**
 * 06 R9: a logging canvas that was really created queues its Org62 re-checks on Apply, not only when the user copies
 * the Slackbot prompt. The dispatch job against fakes (nothing external): the hook fires for a delivered canvas only
 * (not a dry run, not a failure, not a Slack message), and a failing hook never changes the delivery's result.
 * Also: `autoAt` moves the activity.sync slot (withAutoAt), and a missing or malformed value keeps 17:30.
 */
import { describe, expect, it } from 'vitest';

import { CheckCanvasOrg62Request, type Destination, type Draft } from '../../src/contract';
import { canvasAppliedRecheck } from '../../src/jobs/handlers/activity-sync';
import type { JobContext } from '../../src/jobs/types';
import { actionDoc } from '../../src/lib/actions';
import { planRecheck, RECHECK_AFTER_MIN } from '../../src/lib/canvas/checks';
import { canvasActionFor } from '../../src/lib/canvas/payload';
import { OutboxGateway, outboxDispatchHandler, payloadHash, type DeliveryRecord, type OutboxJobPayload, type OutboxJobPort } from '../../src/outbox';
import { payloadFor } from '../../src/server/datasource/mock/render';
import { DEFAULT_MAINTENANCE, withAutoAt } from '../../src/worker/schedules';
import { FakeMcp } from '../outbox/fake';

const NOW = new Date('2026-11-20T17:00:00.000Z');
const CANVAS = canvasActionFor({ title: 'Activity log · Nov 19 · 1 row', markdown: '::: {.callout}\n**Slackbot: this canvas is a complete work order.**\n:::\n\n# ADD (1 rows · 1.00 h of activities)\n', eventIds: ['e1'], hours: 1, updates: 0, part: 1, parts: 1 });

function setup(o: { dryRun: boolean; dest?: Destination; fake?: FakeMcp }) {
  const dest = o.dest ?? CANVAS;
  const doc = dest.kind === 'action' ? actionDoc(dest) : { type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello there' }] }] };
  const draft = { id: 'dr_1', status: 'sending', destination: dest, doc, attempts: [], version: 2 } as unknown as Draft;
  const saved: DeliveryRecord[] = [];
  const port: OutboxJobPort = {
    load: async () => ({ draft, attemptNo: 1, approvedAt: NOW.toISOString(), approvalMethod: 'click', approvedContentHash: 'h', currentContentHash: 'h', dryRun: o.dryRun, verifyReadback: false }),
    isDryRun: async () => o.dryRun,
    save: async (_p: OutboxJobPayload, rec: DeliveryRecord) => void saved.push(rec),
    markWriteStarted: async () => undefined,
  };
  const fake = o.fake ?? new FakeMcp().on('slack_create_canvas', () => ({ text: JSON.stringify({ ok: true, canvas_id: 'F0PLACEHOLD1' }) }));
  const applied: string[] = [];
  const hash = payloadHash(payloadFor(dest, doc as never, 'send'));
  const ctx = { job: { payload: { draftId: 'dr_1', attemptId: '7', mode: 'send', version: 2, payloadHash: hash } }, userId: 'u1', clock: () => NOW, log: () => undefined, signal: new AbortController().signal } as unknown as JobContext;
  return { port, fake, applied, ctx };
}

describe('canvas Apply queues the Org62 re-checks (06 R9)', () => {
  it('a really created canvas fires the hook once, with its draft id', async () => {
    const t = setup({ dryRun: false });
    const h = outboxDispatchHandler({ port: () => t.port, gateway: new OutboxGateway(t.fake), onCanvasApplied: async (_c, id) => void t.applied.push(id) });
    expect(await h(t.ctx)).toMatchObject({ state: 'delivered', channel: 'slack_canvas' });
    expect(t.applied).toEqual(['dr_1']);
  });

  it('a dry run, a failed create and a non-canvas item never fire it', async () => {
    const dry = setup({ dryRun: true });
    await outboxDispatchHandler({ port: () => dry.port, gateway: new OutboxGateway(dry.fake), onCanvasApplied: async (_c, id) => void dry.applied.push(id) })(dry.ctx);
    expect(dry.applied).toEqual([]);

    const bad = setup({ dryRun: false, fake: new FakeMcp().failOnce('slack_create_canvas', 'invalid_arguments') });
    expect(await outboxDispatchHandler({ port: () => bad.port, gateway: new OutboxGateway(bad.fake), onCanvasApplied: async (_c, id) => void bad.applied.push(id) })(bad.ctx)).toMatchObject({ state: 'failed' });
    expect(bad.applied).toEqual([]);

    const slack: Destination = { kind: 'slack', target: 'channel', channelId: 'C0TEST', channelName: '#test', threadTs: null };
    const msg = setup({ dryRun: false, dest: slack });
    await outboxDispatchHandler({ port: () => msg.port, gateway: new OutboxGateway(msg.fake), onCanvasApplied: async (_c, id) => void msg.applied.push(id) })(msg.ctx);
    expect(msg.applied).toEqual([]);
  });

  it('a hook that throws never changes the delivery result', async () => {
    const t = setup({ dryRun: false });
    const h = outboxDispatchHandler({
      port: () => t.port,
      gateway: new OutboxGateway(t.fake),
      onCanvasApplied: async () => {
        throw new Error('queue down');
      },
    });
    expect(await h(t.ctx)).toMatchObject({ state: 'delivered' });
  });

  it('the hook asks the existing canvas check with reason applied (reads 5, 15, 30 and 60 minutes later), nothing new', async () => {
    const asked: unknown[] = [];
    const hook = canvasAppliedRecheck({} as never, () => ({ checkCanvasOrg62: async (i: unknown) => (asked.push(i), {}) as never }));
    await hook({ userId: 'u1' }, 'dr_1');
    expect(asked).toEqual([{ params: { id: 'dr_1' }, body: { reason: 'applied' } }]);
  });

  it('W0-10: applied queues the same re-checks as copied but does not mark Slackbot as told (the canvas does not read "checking")', () => {
    const applied = planRecheck({}, 'dr_1', 'applied', NOW);
    const copied = planRecheck({}, 'dr_1', 'copied', NOW);
    expect(applied.slots).toEqual(copied.slots);
    expect(applied.slots).toHaveLength(RECHECK_AFTER_MIN.length);
    expect(applied.next['dr_1']).toMatchObject({ toldAt: null, askedAt: null });
    expect(copied.next['dr_1']!.toldAt).toBe(NOW.toISOString());
    // a later copy still marks it told, keeping the queued checks
    const after = planRecheck(applied.next, 'dr_1', 'copied', new Date(NOW.getTime() + 60_000));
    expect(after.next['dr_1']!.toldAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
    expect(CheckCanvasOrg62Request.parse({ reason: 'applied' })).toEqual({ reason: 'applied' });
  });
});

describe('autoAt moves the activity.sync slot (06 TA-9)', () => {
  const slot = (specs: ReturnType<typeof withAutoAt>) => specs.find((s) => s.key === 'activity.sync')!.atLocal;
  it('uses the setting, leaves every other schedule alone', () => {
    const specs = withAutoAt(DEFAULT_MAINTENANCE, '16:45');
    expect(slot(specs)).toBe('16:45');
    expect(specs.filter((s) => s.key !== 'activity.sync')).toEqual(DEFAULT_MAINTENANCE.filter((s) => s.key !== 'activity.sync'));
  });
  it('keeps 17:30 without a setting, and does not mutate the defaults', () => {
    expect(slot(withAutoAt(DEFAULT_MAINTENANCE, null))).toBe('17:30');
    withAutoAt(DEFAULT_MAINTENANCE, '08:00');
    expect(slot(DEFAULT_MAINTENANCE)).toBe('17:30');
  });
});
