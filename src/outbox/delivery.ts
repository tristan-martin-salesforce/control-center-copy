/**
 * The Outbox delivery engine (BE-OUTBOX). One confirmed attempt runs:
 *
 *   prepare (proof checked, payload hashed, tool call derived)
 *     → countdown (optional server-side undo window; cancel() stops it, nothing is called)
 *     → dry-run? record the payload + would-be call, mark "dry-run delivered", touch nothing external
 *     → else write through the gateway (allowlist + single-use confirm proof) → parse the external id
 *     → read-back through read tools → confirmed | unconfirmed | missing
 *   Failures end in `failed` with a classified, retryable-or-not error; a retry is a new confirmed attempt.
 *
 * Dry-run is decided fail-safe: only an explicit `false` goes live, and it is re-read right before the write,
 * so switching dry-run back on during the countdown wins. The engine holds no persistence of its own: every
 * state change goes to `onChange`, which the DataSource records in a change set.
 */
import { randomUUID } from 'node:crypto';

import type { Destination, DispatchMode } from '@/contract';

import { adapterFor } from './adapters';
import { assertConfirmedFor, type DeliveryConfirmation } from './confirm';
import { classifyDeliveryError } from './errors';
import type { OutboxGateway } from './gateway';
import { payloadHash } from './hash';
import { channelOf } from './settings';
import type { DeliveryRecord } from './types';

export interface DeliveryDeps {
  /** The guarded gateway. `null`: no transport, so a live attempt fails closed (`no_transport`). */
  gateway: OutboxGateway | null;
  now?: () => Date;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Re-read right before the write. Anything but `false` means dry-run. */
  isDryRun?: () => boolean | Promise<boolean>;
  /** Persist each state change (countdown, delivering, final, read-back). */
  onChange?: (rec: DeliveryRecord) => void | Promise<void>;
  /**
   * 2026-11-13 audit B3: persist a durable "write started" mark right before the write leaves (the queued path: the
   * attempt row). A run that finds the mark and no outcome never writes again. If it can't be recorded, nothing is sent.
   */
  beforeWrite?: (rec: DeliveryRecord) => void | Promise<void>;
}

/** Errors that leave it open whether the destination got the write (a timeout, a dropped connection, a 5xx). */
const AMBIGUOUS: ReadonlySet<string> = new Set(['transient', 'unknown']);

/**
 * Channels whose write is not safe to repeat blind: a second logging canvas would be a second work order for Slackbot.
 * An ambiguous failure there ends as `outcome_unknown` (never "retry"), and the user checks the destination first.
 */
const CHECK_BEFORE_RETRY: ReadonlySet<DeliveryRecord['channel']> = new Set(['slack_canvas']);

const WHERE: Record<DeliveryRecord['channel'], string> = { slack: 'Slack', gmail: 'Gmail', vdp: 'VDP', slack_canvas: 'Slack', feedback: 'Slack', release: 'Slack' };

/** The error of a write whose outcome is unknown: it may have landed, so it is never retried on its own. */
export function outcomeUnknown(channel: DeliveryRecord['channel'], why: 'no_answer' | 'interrupted'): NonNullable<DeliveryRecord['error']> {
  const what = channel === 'slack_canvas' ? 'the canvas' : 'it';
  const lead = why === 'no_answer' ? `${WHERE[channel]} didn't answer in time` : 'The app stopped while delivering';
  return { code: 'outcome_unknown', message: `${lead}: ${what} may have been created. Check ${WHERE[channel]} before you try again`, retryable: false };
}

export interface PrepareInput {
  draftId: string;
  draftVersion: number;
  destination: Destination;
  mode: DispatchMode;
  /** `payloadFor(destination, doc, mode)`: exactly what the preview showed. */
  payload: Record<string, unknown>;
  dryRun: boolean;
  attemptNo: number;
  confirmation: DeliveryConfirmation | unknown;
  idempotencyKey?: string;
}

export interface DeliverOptions {
  /** Server-side undo window before the write (0 when the client already ran its countdown). */
  holdMs?: number;
  /** Run read-back after a real write (Settings → Sending `verifyReadback`). Default true. */
  verifyReadback?: boolean;
  signal?: AbortSignal;
}

interface Pending {
  rec: DeliveryRecord;
  handle: unknown;
  resolve: (cancelled: boolean) => void;
}

export class OutboxDelivery {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: DeliveryDeps) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async emit(rec: DeliveryRecord): Promise<DeliveryRecord> {
    await this.deps.onChange?.(rec);
    return rec;
  }

  /** Build the record for a confirmed attempt. Throws `NotConfirmedError` unless the proof matches. */
  prepare(i: PrepareInput): DeliveryRecord {
    const hash = payloadHash(i.payload);
    assertConfirmedFor(i.confirmation, { draftId: i.draftId, mode: i.mode, payloadHash: hash });
    const channel = channelOf(i.destination);
    const adapter = adapterFor(channel);
    // a dry run records the call; one that waits for a parent's new id (D-63) is recorded with its placeholder. Live,
    // the strict mapping refuses it (and the gateway derives the call again with it before anything leaves).
    const toolCall = i.dryRun !== false && adapter.dryRunCall ? adapter.dryRunCall(i.payload, i.mode) : adapter.toolCall(i.payload, i.mode);
    const at = this.now().toISOString();
    return {
      id: (this.deps.newId ?? (() => `dlv_${randomUUID().replace(/-/g, '').slice(0, 16)}`))(),
      draftId: i.draftId,
      draftVersion: i.draftVersion,
      attemptNo: i.attemptNo,
      channel,
      mode: i.mode,
      dryRun: i.dryRun !== false,
      payload: i.payload,
      payloadHash: hash,
      toolCall,
      idempotencyKey: i.idempotencyKey ?? `outbox:${i.draftId}:${i.draftVersion}:${i.mode}:${i.attemptNo}`,
      state: 'delivering',
      result: null,
      error: null,
      readback: null,
      readbackDetail: null,
      confirmedBy: (i.confirmation as DeliveryConfirmation).by ?? 'user',
      confirmedAt: (i.confirmation as DeliveryConfirmation).at ?? at,
      deliverAt: at,
      startedAt: null,
      finishedAt: null,
      readbackAt: null,
      cancelledAt: null,
    };
  }

  /** Countdown (if any) → execute → read-back. Resolves with the final record. */
  async deliver(rec0: DeliveryRecord, confirmation: DeliveryConfirmation | unknown, opts: DeliverOptions = {}): Promise<DeliveryRecord> {
    let rec = rec0;
    const holdMs = Math.max(0, opts.holdMs ?? 0);
    if (holdMs > 0) {
      rec = await this.emit({ ...rec, state: 'countdown', deliverAt: new Date(this.now().getTime() + holdMs).toISOString() });
      const cancelled = await new Promise<boolean>((resolve) => {
        const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
        const handle = set(() => {
          this.pending.delete(rec.id);
          resolve(false);
        }, holdMs);
        this.pending.set(rec.id, { rec, handle, resolve });
      });
      if (cancelled) return this.emit({ ...rec, state: 'cancelled', cancelledAt: this.now().toISOString(), finishedAt: this.now().toISOString() });
    }
    rec = await this.execute(rec, confirmation, opts);
    if (rec.state === 'delivered' && opts.verifyReadback !== false) rec = await this.verify(rec, opts);
    return rec;
  }

  /** Cancel inside the countdown. Returns false once the window has passed (or for an unknown id). */
  cancel(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    (this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(p.handle);
    p.resolve(true);
    return true;
  }

  inCountdown(id: string): boolean {
    return this.pending.has(id);
  }

  /** The write (or the dry-run record). Never throws for delivery failures: they end in `failed`. */
  async execute(rec0: DeliveryRecord, confirmation: DeliveryConfirmation | unknown, opts: { signal?: AbortSignal } = {}): Promise<DeliveryRecord> {
    const startedAt = this.now().toISOString();
    let dryRun = rec0.dryRun;
    if (!dryRun && this.deps.isDryRun) dryRun = (await this.deps.isDryRun()) !== false;
    if (dryRun) {
      // Nothing external: the record keeps the exact payload and the call that would have been made.
      return this.emit({ ...rec0, dryRun: true, state: 'dry_run_delivered', startedAt, finishedAt: startedAt });
    }
    if (!this.deps.gateway) {
      return this.emit({ ...rec0, state: 'failed', startedAt, finishedAt: startedAt, error: { code: 'no_transport', message: 'No outbox transport is configured: nothing was sent', retryable: false } });
    }
    const rec = await this.emit({ ...rec0, state: 'delivering', startedAt });
    // D-69 (VD-21): the live check right before the write (read tools only): a conflict refuses it, nothing is sent
    const adapter = adapterFor(rec.channel);
    if (adapter.preflight) {
      const gw = this.deps.gateway;
      let pf: Awaited<ReturnType<NonNullable<typeof adapter.preflight>>>;
      try {
        pf = await adapter.preflight((call) => gw.read(call, opts), { payload: rec.payload, mode: rec.mode });
      } catch (err) {
        pf = { ok: false, code: 'preflight_failed', detail: `Could not check the destination first (${classifyDeliveryError(err).code}): nothing was sent`, retryable: true };
      }
      if (!pf.ok) return this.emit({ ...rec, state: 'failed', error: { code: pf.code, message: pf.detail.slice(0, 300), retryable: pf.retryable ?? false }, finishedAt: this.now().toISOString() });
    }
    // B3: the durable "write started" mark first; without it, nothing leaves
    if (this.deps.beforeWrite) {
      try {
        await this.deps.beforeWrite(rec);
      } catch {
        return this.emit({ ...rec, state: 'failed', error: { code: 'not_started', message: 'Could not record the start of the delivery, so nothing was sent', retryable: true }, finishedAt: this.now().toISOString() });
      }
    }
    try {
      const { call, result } = await this.deps.gateway.write({ draftId: rec.draftId, channel: rec.channel, mode: rec.mode, payload: rec.payload }, confirmation, opts);
      const write = adapterFor(rec.channel).parseWrite(result, rec.mode);
      return this.emit({ ...rec, toolCall: call, state: 'delivered', result: write, finishedAt: this.now().toISOString() });
    } catch (err) {
      const e = classifyDeliveryError(err);
      // B3: a canvas whose create got no answer (the relay's 90 s timeout) may exist: never offered as a plain retry
      const error = AMBIGUOUS.has(e.code) && CHECK_BEFORE_RETRY.has(rec.channel) ? outcomeUnknown(rec.channel, 'no_answer') : e;
      return this.emit({ ...rec, state: 'failed', error, finishedAt: this.now().toISOString() });
    }
  }

  /**
   * B3: a run that finds its attempt's write started and never resolved (the worker died, or the laptop slept, between
   * the write and its record). It never writes again: the attempt ends as `outcome_unknown` ("check before you try
   * again"). Without a write started (the run stopped before it), nothing left: `interrupted`, safe to Apply again.
   */
  async recover(rec0: DeliveryRecord, o: { writeStarted: boolean }): Promise<DeliveryRecord> {
    const at = this.now().toISOString();
    const error = o.writeStarted ? outcomeUnknown(rec0.channel, 'interrupted') : { code: 'interrupted', message: 'The app stopped before it delivered, so nothing was sent', retryable: true };
    return this.emit({ ...rec0, dryRun: false, state: 'failed', error, startedAt: rec0.startedAt ?? at, finishedAt: at });
  }

  /** Read-back after a real write. Leaves anything but `delivered` untouched. */
  async verify(rec: DeliveryRecord, opts: { signal?: AbortSignal } = {}): Promise<DeliveryRecord> {
    if (rec.state !== 'delivered' || rec.dryRun || !rec.result) return rec;
    const at = () => this.now().toISOString();
    const gw = this.deps.gateway;
    if (!gw) return this.emit({ ...rec, readback: 'unconfirmed', readbackDetail: 'No read tool available', readbackAt: at() });
    try {
      const out = await adapterFor(rec.channel).readback((call) => gw.read(call, opts), { payload: rec.payload, mode: rec.mode, write: rec.result });
      return this.emit({ ...rec, readback: out.readback, readbackDetail: out.detail, readbackAt: at() });
    } catch (err) {
      return this.emit({ ...rec, readback: 'unconfirmed', readbackDetail: `Read-back failed (${classifyDeliveryError(err).code})`, readbackAt: at() });
    }
  }
}
