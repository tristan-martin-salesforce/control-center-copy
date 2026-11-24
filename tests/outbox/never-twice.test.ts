/**
 * 2026-11-13 audit B3: a crash, a restart or a timeout never sends twice. The engine and the job against fakes only:
 * a canvas create that got no answer ends as "may have been created, check Slack" (never a plain retry); the durable
 * "write started" mark comes before the write (nothing leaves without it); a run that finds the mark never writes
 * again, and a run the reaper hands back never writes at all. No real tool is called.
 */
import { describe, expect, it } from 'vitest';

import type { Destination, Draft } from '../../src/contract';
import { actionDoc } from '../../src/lib/actions';
import { canvasActionFor } from '../../src/lib/canvas/payload';
import {
  attemptOf,
  confirmDelivery,
  draftStatusOf,
  OutboxDelivery,
  OutboxGateway,
  payloadHash,
  runOutboxJob,
  type DeliveryRecord,
  type OutboxJobPayload,
  type OutboxJobPort,
  type OutboxJobState,
} from '../../src/outbox';
import { RelayNotSentError } from '../../src/outbox/errors';
import { payloadFor } from '../../src/server/datasource/mock/render';
import { FakeMcp } from './fake';

const NOW = new Date('2026-11-13T17:00:00.000Z');
const CANVAS = canvasActionFor({ title: 'Activity log · Nov 12 · 1 row', markdown: '::: {.callout}\n**Slackbot: this canvas is a complete work order.**\n:::\n\n# ADD (1 rows · 1.00 h of activities)\n', eventIds: ['e1'], hours: 1, updates: 0, part: 1, parts: 1 });
const SLACK: Destination = { kind: 'slack', target: 'channel', channelId: 'C0TEST', channelName: '#test', threadTs: null };
const docOf = (d: Destination) => (d.kind === 'action' ? actionDoc(d) : { type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello there' }] }] });

function attempt(dest: Destination, deps: { fake: FakeMcp; beforeWrite?: () => Promise<void> }) {
  const payload = payloadFor(dest, docOf(dest) as never, 'send');
  const token = 'ct_never_twice';
  const confirmation = confirmDelivery({ draftId: 'dr_1', draftVersion: 2, mode: 'send', payloadHash: payloadHash(payload), confirmToken: token, expectedToken: token, at: NOW.toISOString() });
  const changes: DeliveryRecord[] = [];
  const engine = new OutboxDelivery({ gateway: new OutboxGateway(deps.fake), now: () => NOW, onChange: (r) => void changes.push(r), ...(deps.beforeWrite ? { beforeWrite: deps.beforeWrite } : {}) });
  const rec = engine.prepare({ draftId: 'dr_1', draftVersion: 2, destination: dest, mode: 'send', payload, dryRun: false, attemptNo: 1, confirmation });
  return { engine, rec, confirmation, changes };
}

describe('a canvas create with no answer is never offered as a plain retry', () => {
  it('the relay timeout ends as outcome_unknown: "may have been created, check Slack", not "nothing was sent"', async () => {
    const fake = new FakeMcp().failOnce('slack_create_canvas', 'slack_create_canvas returned an error: timed out');
    const { engine, rec, confirmation } = attempt(CANVAS, { fake });
    const out = await engine.execute(rec, confirmation);
    expect(out.state).toBe('failed');
    expect(out.error).toEqual({ code: 'outcome_unknown', message: "Slack didn't answer in time: the canvas may have been created. Check Slack before you try again", retryable: false });
    expect(attemptOf(out)).toMatchObject({ outcome: 'unconfirmed', detail: expect.stringMatching(/may have been created\. Check Slack before you try again \(outcome_unknown\)$/) });
    expect(attemptOf(out).detail).not.toMatch(/Nothing was sent/);
    // the item stays in the Outbox (its rows held), it does not read as sent
    expect(draftStatusOf(out, 'sending')).toBe('failed');
  });

  it('2026-11-16: the relay stopped before it called Slack: "nothing was sent, try again", never "check Slack first"', async () => {
    const fake = new FakeMcp().on('slack_create_canvas', () => {
      throw new RelayNotSentError('slack_create_canvas', 'timed out');
    });
    const { engine, rec, confirmation } = attempt(CANVAS, { fake });
    const out = await engine.execute(rec, confirmation);
    expect(out.state).toBe('failed');
    expect(out.error).toEqual({ code: 'not_sent', message: 'Nothing was sent: the app stopped before it reached the destination. Try again', retryable: true });
    expect(attemptOf(out).detail).not.toMatch(/may have been created/);
  });

  it('a refusal Slack answered stays a plain failure; a Slack message keeps its retry', async () => {
    const refused = attempt(CANVAS, { fake: new FakeMcp().failOnce('slack_create_canvas', 'invalid_arguments') });
    expect((await refused.engine.execute(refused.rec, refused.confirmation)).error).toMatchObject({ code: 'invalid_request' });
    const msg = attempt(SLACK, { fake: new FakeMcp().failOnce('slack_send_message', 'ETIMEDOUT') });
    expect((await msg.engine.execute(msg.rec, msg.confirmation)).error).toMatchObject({ code: 'transient', retryable: true });
  });
});

describe('the durable "write started" mark', () => {
  it('is recorded before the write; when it cannot be, nothing leaves', async () => {
    const order: string[] = [];
    const fake = new FakeMcp().on('slack_create_canvas', () => {
      order.push('write');
      return { text: JSON.stringify({ ok: true, canvas_id: 'F0PLACEHOLD1' }) };
    });
    const ok = attempt(CANVAS, { fake, beforeWrite: async () => void order.push('mark') });
    expect((await ok.engine.execute(ok.rec, ok.confirmation)).state).toBe('delivered');
    expect(order).toEqual(['mark', 'write']);

    const none = new FakeMcp();
    const down = attempt(CANVAS, { fake: none, beforeWrite: async () => Promise.reject(new Error('db down')) });
    const out = await down.engine.execute(down.rec, down.confirmation);
    expect(out).toMatchObject({ state: 'failed', error: { code: 'not_started', retryable: true } });
    expect(none.calls).toHaveLength(0);
  });
});

describe('runOutboxJob on re-entry', () => {
  const draft = { id: 'dr_1', status: 'sending', destination: CANVAS, doc: actionDoc(CANVAS), attempts: [], version: 2 } as unknown as Draft;
  const p: OutboxJobPayload = { draftId: 'dr_1', attemptId: '7', mode: 'send', version: 2 };
  function port(state: Partial<OutboxJobState>): OutboxJobPort & { saved: DeliveryRecord[]; marked: number } {
    const saved: DeliveryRecord[] = [];
    const out = {
      saved,
      marked: 0,
      load: async () => ({ draft, attemptNo: 1, approvedAt: NOW.toISOString(), approvalMethod: 'click', approvedContentHash: 'h', currentContentHash: 'h', dryRun: false, verifyReadback: true, ...state }),
      isDryRun: async () => false,
      save: async (_p: OutboxJobPayload, rec: DeliveryRecord) => void saved.push(rec),
      markWriteStarted: async () => void (out.marked += 1),
    };
    return out;
  }

  it('a write that started and never resolved is never made again: outcome_unknown, no tool call', async () => {
    const fake = new FakeMcp();
    const pt = port({ writeStarted: true });
    expect(await runOutboxJob(p, pt, new OutboxGateway(fake), { now: () => NOW })).toMatchObject({ state: 'failed', code: 'outcome_unknown', recovered: true });
    expect(fake.calls).toHaveLength(0);
    expect(pt.marked).toBe(0);
    expect(pt.saved.at(-1)!.error!.message).toMatch(/The app stopped while delivering: the canvas may have been created/);
  });

  it('a run the reaper handed back never writes: interrupted, nothing was sent', async () => {
    const fake = new FakeMcp();
    const pt = port({});
    expect(await runOutboxJob(p, pt, new OutboxGateway(fake), { now: () => NOW, recoverOnly: true })).toMatchObject({ state: 'failed', code: 'interrupted' });
    expect(fake.calls).toHaveLength(0);
    expect(attemptOf(pt.saved.at(-1)!).detail).toMatch(/nothing was sent/i);
  });
});
