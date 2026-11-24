/**
 * BE-OUTBOX · the delivery engine, gateway and confirm proof against a fake MCP transport.
 * Covers: dry-run records the payload and touches nothing; draft mode → fake create-draft (+ read-back);
 * send mode → fake send then read-back; cancel during the countdown; failure → retry needs a fresh
 * confirm; and no path writes without a confirm.
 */
import { describe, expect, it } from 'vitest';

import { eventually } from '../support/until';

import type { Destination, DispatchMode, TipTapDoc } from '../../src/contract';
import {
  confirmDelivery,
  confirmFromApproval,
  isConsumed,
  NotConfirmedError,
  OutboxDelivery,
  OutboxGateway,
  payloadHash,
  type DeliveryConfirmation,
  type DeliveryRecord,
} from '../../src/outbox';
import { payloadFor } from '../../src/server/datasource/mock/render';
import { FakeMcp } from './fake';

const doc = (text: string): TipTapDoc => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const SLACK: Destination = { kind: 'slack', target: 'channel', channelId: 'C0TEST', channelName: '#test', threadTs: null };
const SLACK_THREAD: Destination = { kind: 'slack', target: 'thread', channelId: 'C0TEST', channelName: '#test', threadTs: '1730700000.000100' };
const EMAIL: Destination = { kind: 'email', target: 'new', to: [{ name: 'Pat Example', email: 'pat@example.com' }], cc: [], subject: 'Phase 2 plan', threadId: null, inReplyTo: null };
const BODY = 'Hi, confirming Thursday at 13:00 for the phase 2 review. Agenda to follow.';
const NOW = new Date('2026-11-05T17:00:00.000Z');

function setup(opts: { dryRun?: () => boolean } = {}) {
  const fake = new FakeMcp();
  const changes: DeliveryRecord[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const engine = new OutboxDelivery({
    gateway: new OutboxGateway(fake),
    now: () => NOW,
    isDryRun: opts.dryRun,
    onChange: (r) => void changes.push(r),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  return { fake, engine, changes, timers };
}

function confirmed(dest: Destination, mode: DispatchMode, text = BODY) {
  const payload = payloadFor(dest, doc(text), mode);
  const token = `ct_test_${mode}`;
  const confirmation = confirmDelivery({ draftId: 'dr_1', draftVersion: 3, mode, payloadHash: payloadHash(payload), confirmToken: token, expectedToken: token, at: NOW.toISOString() });
  return { payload, confirmation };
}

function prepare(engine: OutboxDelivery, dest: Destination, mode: DispatchMode, dryRun: boolean) {
  const { payload, confirmation } = confirmed(dest, mode);
  const rec = engine.prepare({ draftId: 'dr_1', draftVersion: 3, destination: dest, mode, payload, dryRun, attemptNo: 1, confirmation });
  return { rec, payload, confirmation };
}

describe('dry-run (the default)', () => {
  it('records the exact payload and the would-be tool call, marks it dry-run delivered, and touches nothing', async () => {
    const { fake, engine, changes } = setup();
    const { rec, payload, confirmation } = prepare(engine, SLACK, 'send', true);
    const out = await engine.deliver(rec, confirmation);
    expect(out.state).toBe('dry_run_delivered');
    expect(out.dryRun).toBe(true);
    expect(out.payload).toEqual(payload);
    expect(out.payloadHash).toBe(payloadHash(payload));
    expect(out.toolCall).toMatchObject({ server: 'slack', tool: 'slack_send_message', args: { channel_id: 'C0TEST' } });
    expect(String(out.toolCall.args.message)).toContain('confirming Thursday');
    expect(out.readback).toBeNull();
    expect(fake.calls).toHaveLength(0);
    expect(changes.map((c) => c.state)).toEqual(['dry_run_delivered']);
    expect(isConsumed(confirmation)).toBe(false);
  });

  it('only an explicit `false` goes live; dry-run switched back on during the countdown wins', async () => {
    let dry = false;
    const { fake, engine, timers } = setup({ dryRun: () => dry });
    const { rec, confirmation } = prepare(engine, EMAIL, 'send', false);
    const p = engine.deliver(rec, confirmation, { holdMs: 10_000 });
    await eventually(() => expect(engine.inCountdown(rec.id)).toBe(true));
    dry = true; // user flips dry-run back on inside the undo window
    timers[0]!.fn();
    const out = await p;
    expect(out.state).toBe('dry_run_delivered');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('draft mode, after the confirm', () => {
  it('Slack: calls the fake slack_send_message_draft once; read-back is unconfirmed (Slack has no draft read tool)', async () => {
    const { fake, engine } = setup({ dryRun: () => false });
    const { rec, confirmation } = prepare(engine, SLACK_THREAD, 'draft', false);
    const out = await engine.deliver(rec, confirmation);
    expect(fake.writes()).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ server: 'slack', tool: 'slack_send_message_draft', args: { channel_id: 'C0TEST', thread_ts: '1730700000.000100' } });
    expect(fake.calls.some((c) => c.tool === 'slack_send_message')).toBe(false);
    expect(out.state).toBe('delivered');
    expect(out.result?.link).toContain('app.slack.com');
    expect(out.readback).toBe('unconfirmed');
    expect(out.readbackDetail).toMatch(/Drafts & Sent/);
    expect(isConsumed(confirmation)).toBe(true);
  });

  it('Gmail: calls the fake draft_gmail_message with the compose HTML, then finds the draft by read-back', async () => {
    const { fake, engine } = setup({ dryRun: () => false });
    const { rec, payload, confirmation } = prepare(engine, EMAIL, 'draft', false);
    const out = await engine.deliver(rec, confirmation);
    expect(fake.calls.map((c) => c.tool)).toEqual(['draft_gmail_message', 'search_gmail_messages', 'get_gmail_message_content']);
    expect(fake.calls[0]!.args).toMatchObject({ to: 'Pat Example <pat@example.com>', subject: 'Phase 2 plan', body: payload.html, body_format: 'html', include_signature: false });
    expect(out.state).toBe('delivered');
    expect(out.result?.externalId).toBe('r-msg000000');
    expect(out.readback).toBe('confirmed');
  });
});

describe('send mode, after the confirm', () => {
  it('Slack: calls the fake send, then reads the message back (confirmed)', async () => {
    const { fake, engine } = setup({ dryRun: () => false });
    const { rec, confirmation } = prepare(engine, SLACK, 'send', false);
    const out = await engine.deliver(rec, confirmation);
    expect(fake.calls.map((c) => c.tool)).toEqual(['slack_send_message', 'slack_read_thread']);
    expect(fake.calls[1]!.args).toMatchObject({ channel_id: 'C0TEST', message_ts: out.result!.externalId });
    expect(out.result?.externalId).toMatch(/^1730800000\.\d{6}$/);
    expect(out.readback).toBe('confirmed');
    expect(out.readbackDetail).toBe('Verified in Slack ✓');
  });

  it('Gmail: calls the fake send, then reads it back by message id', async () => {
    const { fake, engine } = setup({ dryRun: () => false });
    const { rec, confirmation } = prepare(engine, EMAIL, 'send', false);
    const out = await engine.deliver(rec, confirmation);
    expect(fake.calls.map((c) => c.tool)).toEqual(['send_gmail_message', 'get_gmail_message_content']);
    expect(out.readback).toBe('confirmed');
    expect(out.readbackDetail).toBe('Verified in Gmail ✓');
  });

  it('read-back reports missing when the message is not there, unconfirmed when the read fails or the text differs', async () => {
    const a = setup({ dryRun: () => false });
    a.fake.on('slack_read_thread', () => ({ isError: true, text: 'thread_not_found' }));
    const pa = prepare(a.engine, SLACK, 'send', false);
    expect((await a.engine.deliver(pa.rec, pa.confirmation)).readback).toBe('missing');

    const b = setup({ dryRun: () => false });
    b.fake.on('slack_read_thread', () => ({ isError: true, text: 'ratelimited' }));
    const pb = prepare(b.engine, SLACK, 'send', false);
    const rb = await b.engine.deliver(pb.rec, pb.confirmation);
    expect(rb.readback).toBe('unconfirmed');
    expect(rb.readbackDetail).toContain('rate_limited');

    const c = setup({ dryRun: () => false });
    c.fake.on('get_gmail_message_content', (call) => ({ text: `Subject: Phase 2 plan\nMessage ${String(call.args.message_id)}: something else entirely` }));
    const pc = prepare(c.engine, EMAIL, 'send', false);
    expect((await c.engine.deliver(pc.rec, pc.confirmation)).readback).toBe('unconfirmed');
  });

  it('verifyReadback: false skips the read tools', async () => {
    const { fake, engine } = setup({ dryRun: () => false });
    const { rec, confirmation } = prepare(engine, SLACK, 'send', false);
    const out = await engine.deliver(rec, confirmation, { verifyReadback: false });
    expect(fake.calls.map((c) => c.tool)).toEqual(['slack_send_message']);
    expect(out.readback).toBeNull();
  });
});

describe('countdown (undo window)', () => {
  it('cancel during the countdown: no tool is called and the record ends cancelled', async () => {
    const { fake, engine, timers, changes } = setup({ dryRun: () => false });
    const { rec, confirmation } = prepare(engine, SLACK, 'send', false);
    const p = engine.deliver(rec, confirmation, { holdMs: 10_000 });
    await eventually(() => expect(engine.inCountdown(rec.id)).toBe(true));
    expect(changes.at(-1)?.state).toBe('countdown');
    expect(changes.at(-1)?.deliverAt).toBe(new Date(NOW.getTime() + 10_000).toISOString());
    expect(engine.cancel(rec.id)).toBe(true);
    const out = await p;
    expect(out.state).toBe('cancelled');
    expect(out.cancelledAt).toBe(NOW.toISOString());
    expect(timers[0]!.cleared).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(isConsumed(confirmation)).toBe(false);
  });

  it('once the window runs out it delivers, and cancel no longer applies', async () => {
    const { fake, engine, timers } = setup({ dryRun: () => false });
    const { rec, confirmation } = prepare(engine, SLACK, 'send', false);
    const p = engine.deliver(rec, confirmation, { holdMs: 10_000 });
    await eventually(() => expect(timers).toHaveLength(1));
    timers[0]!.fn();
    const out = await p;
    expect(engine.cancel(rec.id)).toBe(false);
    expect(out.state).toBe('delivered');
    expect(fake.writes()).toHaveLength(1);
  });
});

describe('failure → retry', () => {
  it('a destination error ends in failed (classified, body-free); the used confirm cannot be replayed; a fresh confirm retries', async () => {
    const { fake, engine } = setup({ dryRun: () => false });
    fake.failOnce('slack_send_message', 'ratelimited: too many requests');
    const first = prepare(engine, SLACK, 'send', false);
    const failed = await engine.deliver(first.rec, first.confirmation);
    expect(failed.state).toBe('failed');
    expect(failed.error).toEqual({ code: 'rate_limited', message: 'Rate limited by the destination: retry shortly', retryable: true });
    expect(failed.readback).toBeNull();

    // replaying the same proof is refused before the transport is touched
    const replay = await engine.execute({ ...first.rec, id: 'dlv_replay' }, first.confirmation);
    expect(replay.state).toBe('failed');
    expect(replay.error?.code).toBe('not_confirmed');
    expect(fake.writes()).toHaveLength(1);

    // the retry is a new attempt with a new confirm
    const second = prepare(engine, SLACK, 'send', false);
    const ok = await engine.deliver({ ...second.rec, attemptNo: 2 }, second.confirmation);
    expect(ok.state).toBe('delivered');
    expect(ok.readback).toBe('confirmed');
    expect(fake.writes()).toHaveLength(2);
  });

  it('non-retryable codes say so (channel_not_found, auth)', async () => {
    const { fake, engine } = setup({ dryRun: () => false });
    fake.failOnce('slack_send_message_draft', 'channel_not_found');
    const p = prepare(engine, SLACK, 'draft', false);
    const out = await engine.deliver(p.rec, p.confirmation);
    expect(out.error).toMatchObject({ code: 'channel_not_found', retryable: false });
  });

  it('no transport configured: live delivery fails closed', async () => {
    const engine = new OutboxDelivery({ gateway: null, now: () => NOW });
    const p = prepare(engine, EMAIL, 'send', false);
    const out = await engine.deliver(p.rec, p.confirmation);
    expect(out.state).toBe('failed');
    expect(out.error?.code).toBe('no_transport');
  });
});

describe('no path sends without a confirm', () => {
  const payload = payloadFor(SLACK, doc(BODY), 'send');
  const hash = payloadHash(payload);

  it('confirmDelivery refuses a missing or mismatched token', () => {
    expect(() => confirmDelivery({ draftId: 'dr_1', draftVersion: 3, mode: 'send', payloadHash: hash, confirmToken: '', expectedToken: 'ct_x', at: NOW.toISOString() })).toThrow(NotConfirmedError);
    expect(() => confirmDelivery({ draftId: 'dr_1', draftVersion: 3, mode: 'send', payloadHash: hash, confirmToken: 'forged', expectedToken: 'ct_x', at: NOW.toISOString() })).toThrow(/does not match/);
  });

  it('the engine refuses to even prepare (or dry-run) without a minted proof', () => {
    const { engine } = setup();
    const forged = { draftId: 'dr_1', draftVersion: 3, mode: 'send', payloadHash: hash, by: 'user', via: 'confirm_token', at: NOW.toISOString() };
    expect(() => engine.prepare({ draftId: 'dr_1', draftVersion: 3, destination: SLACK, mode: 'send', payload, dryRun: true, attemptNo: 1, confirmation: forged })).toThrow(NotConfirmedError);
    expect(() => engine.prepare({ draftId: 'dr_1', draftVersion: 3, destination: SLACK, mode: 'send', payload, dryRun: true, attemptNo: 1, confirmation: undefined })).toThrow(NotConfirmedError);
  });

  it('the gateway refuses forged, mismatched or reused proofs before the transport is touched', async () => {
    const fake = new FakeMcp();
    const gw = new OutboxGateway(fake);
    const forged = { draftId: 'dr_1', draftVersion: 3, mode: 'send', payloadHash: hash, by: 'user', via: 'confirm_token', at: NOW.toISOString() } as unknown as DeliveryConfirmation;
    await expect(gw.write({ draftId: 'dr_1', channel: 'slack', mode: 'send', payload }, forged)).rejects.toThrow(NotConfirmedError);
    await expect(gw.write({ draftId: 'dr_1', channel: 'slack', mode: 'send', payload }, undefined)).rejects.toThrow(NotConfirmedError);

    const { confirmation: draftProof } = confirmed(SLACK, 'draft');
    // a draft-mode confirm can never become a send
    await expect(gw.write({ draftId: 'dr_1', channel: 'slack', mode: 'send', payload }, draftProof)).rejects.toThrow(/Confirmed mode is draft/);
    // the confirmed payload cannot be swapped for another
    const { confirmation: sendProof } = confirmed(SLACK, 'send');
    await expect(gw.write({ draftId: 'dr_1', channel: 'slack', mode: 'send', payload: payloadFor(SLACK, doc('Something else'), 'send') }, sendProof)).rejects.toThrow(/Payload differs/);
    // another draft's confirm does not carry over
    await expect(gw.write({ draftId: 'dr_2', channel: 'slack', mode: 'send', payload }, sendProof)).rejects.toThrow(/another draft/);
    expect(fake.calls).toHaveLength(0);

    await gw.write({ draftId: 'dr_1', channel: 'slack', mode: 'send', payload }, sendProof);
    await expect(gw.write({ draftId: 'dr_1', channel: 'slack', mode: 'send', payload }, sendProof)).rejects.toThrow(/already used/);
    expect(fake.writes()).toHaveLength(1);
  });

  it('the gateway reads only allowlisted read-back tools', async () => {
    const fake = new FakeMcp();
    const gw = new OutboxGateway(fake);
    await expect(gw.read({ server: 'slack', tool: 'slack_send_message', args: {} })).rejects.toThrow(/not on the outbox read allowlist/);
    await expect(gw.read({ server: 'slack', tool: 'slack_delete_message', args: {} })).rejects.toThrow(/not on the outbox read allowlist/);
    await expect(gw.read({ server: 'mcp-adaptor', tool: 'trash_message', args: {} })).rejects.toThrow(/not on the outbox read allowlist/);
    expect(fake.calls).toHaveLength(0);
  });

  it('a recorded approval only counts if it was a human click and nothing changed since', () => {
    const base = { draftId: 'dr_1', draftVersion: 4, mode: 'send' as const, payloadHash: hash, approvedAt: NOW.toISOString(), approvalMethod: 'click', approvedContentHash: 'c1', currentContentHash: 'c1', confirmedPayloadHash: hash, at: NOW.toISOString() };
    expect(confirmFromApproval(base).via).toBe('approval_record');
    expect(() => confirmFromApproval({ ...base, approvedAt: null })).toThrow(/never approved/);
    // D-60: an autonomy-policy approval (VDP autopilot) counts only when the policy was re-checked for this draft
    expect(() => confirmFromApproval({ ...base, approvalMethod: 'autonomy_policy' })).toThrow(/needs the policy re-checked/);
    expect(() => confirmFromApproval({ ...base, approvalMethod: 'autonomy_policy', policyRefusal: 'VDP autopilot is off (Settings ▸ Sending)' })).toThrow(/autopilot is off/);
    expect(confirmFromApproval({ ...base, approvalMethod: 'autonomy_policy', policyRefusal: null })).toMatchObject({ by: 'autopilot', via: 'autonomy_policy' });
    expect(() => confirmFromApproval({ ...base, approvalMethod: 'chat_confirm' })).toThrow(/not an explicit user confirm/);
    expect(() => confirmFromApproval({ ...base, currentContentHash: 'c2' })).toThrow(/changed after it was approved/);
    expect(() => confirmFromApproval({ ...base, confirmedPayloadHash: 'sha256:other' })).toThrow(/Payload changed/);
  });
});
