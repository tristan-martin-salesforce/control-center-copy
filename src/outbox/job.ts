/**
 * `outbox.dispatch` job handler: the db path's delivery step. `POST /drafts/:id/dispatch` with dry-run off
 * records the approval (approved_at + approved_content_hash, the payload hash in the job payload) and
 * enqueues this job; the worker runs it after the client's undo window has already passed.
 *
 * The handler re-derives the payload with the one serializer, mints the confirm proof from the recorded
 * approval (refused if the draft or payload changed since the confirm), re-reads dry-run, and runs the
 * delivery engine. It never retries a write on its own: a failure is saved as an Outbox error, and the user
 * retries with a fresh confirm (an ambiguous timeout could otherwise post twice).
 *
 * 2026-11-13 audit B3, never twice: the job is enqueued with one attempt and the lease reaper never requeues it; the
 * attempt is marked "write started" (durably) right before the write; a run that finds that mark with no outcome
 * (the worker died between the write and its record) never writes again: it ends as `outcome_unknown`, "check
 * before you try again". A run the reaper hands back (`recoverOnly`) never writes at all.
 *
 * Wiring (orchestrator, one line in the worker registry):
 *   r.register(outboxJobDef({ port: (ctx) => dbOutboxPort(ctx.db, ctx.userId, { extractorId: () => ensureExtractor(ctx.db), now: ctx.clock }),
 *                             gateway: new OutboxGateway(liveOutboxTransport()) }));
 * In this build `liveOutboxTransport()` is fail-closed, so a live attempt ends as an Outbox error.
 */
import type { DispatchMode, Draft } from '@/contract';
import type { JobHandler, JobHandlerDef } from '@/jobs/types';
import { payloadFor } from '@/server/datasource/mock/render';

import { confirmFromApproval, NotConfirmedError, type DeliveryConfirmation } from './confirm';
import { OutboxDelivery } from './delivery';
import type { OutboxGateway } from './gateway';
import { payloadHash } from './hash';
import { channelOf } from './settings';
import type { DeliveryRecord } from './types';

export interface OutboxJobPayload {
  draftId: string;
  attemptId: string;
  mode: DispatchMode;
  /** Draft version after the dispatch write. */
  version: number;
  /** Payload hash at the confirm. */
  payloadHash?: string;
}

export interface OutboxJobState {
  draft: Draft;
  attemptNo: number;
  approvedAt: string | null;
  approvalMethod: string | null;
  approvedContentHash: string | null;
  currentContentHash: string;
  dryRun: boolean;
  verifyReadback: boolean;
  /** B3: this attempt's write began (the durable mark) and no outcome was recorded after it. */
  writeStarted?: boolean;
  /**
   * D-60: for an autonomy-policy approval, VDP autopilot's verdict on this draft from the stored settings now (null =
   * allowed, else why not); undefined for a human approval.
   */
  policyRefusal?: string | null;
}

/** Storage port (db implementation: src/server/datasource/db/outbox.ts). */
export interface OutboxJobPort {
  load(p: OutboxJobPayload): Promise<OutboxJobState | null>;
  isDryRun(): Promise<boolean>;
  /** Persist one record state in its own change set. */
  save(p: OutboxJobPayload, rec: DeliveryRecord): Promise<void>;
  /** B3: the durable "write started" mark on this attempt, committed before the write leaves. */
  markWriteStarted?(p: OutboxJobPayload): Promise<void>;
}

export interface OutboxJobDeps<S = unknown> {
  port: (ctx: Parameters<JobHandler<S>>[0]) => OutboxJobPort;
  gateway: OutboxGateway | null;
  /**
   * 2026-11-20 (06 R9): after a logging canvas was really created (state `delivered`, not a dry run), queue the Org62
   * re-checks, so they no longer wait for the user to copy the Slackbot prompt. Best effort: a failure here never
   * touches the delivery's result. Read-only work (it only enqueues Org62 reads).
   */
  onCanvasApplied?: (ctx: Parameters<JobHandler<S>>[0], draftId: string) => Promise<void>;
}

export function parseJobPayload(raw: Record<string, unknown>): OutboxJobPayload | null {
  const { draftId, attemptId, mode, version } = raw;
  if (typeof draftId !== 'string' || (typeof attemptId !== 'string' && typeof attemptId !== 'number') || (mode !== 'draft' && mode !== 'send') || typeof version !== 'number') return null;
  return { draftId, attemptId: String(attemptId), mode, version, ...(typeof raw.payloadHash === 'string' ? { payloadHash: raw.payloadHash } : {}) };
}

/**
 * Run one queued delivery. Returns ids, states and codes only (stored in jobs.result). `recoverOnly`: the job's lease
 * expired and the reaper handed it back (src/jobs/queue-ops.ts): it resolves the attempt and never writes.
 */
export async function runOutboxJob(p: OutboxJobPayload, port: OutboxJobPort, gateway: OutboxGateway | null, opts: { now?: () => Date; signal?: AbortSignal; recoverOnly?: boolean } = {}): Promise<Record<string, unknown>> {
  const s = await port.load(p);
  if (!s) return { skipped: 'draft_missing', draftId: p.draftId };
  if (s.draft.status !== 'sending') return { skipped: `draft_${s.draft.status}`, draftId: p.draftId };
  const d = s.draft;
  const payload = payloadFor(d.destination, d.doc, p.mode);
  const hash = payloadHash(payload);
  const now = opts.now ?? (() => new Date());
  const engine = new OutboxDelivery({
    gateway,
    now,
    isDryRun: () => port.isDryRun(),
    onChange: async (rec) => {
      if (rec.state !== 'delivering' && rec.state !== 'countdown') await port.save(p, rec);
    },
    ...(port.markWriteStarted ? { beforeWrite: () => port.markWriteStarted!(p) } : {}),
  });
  // B3: a write that started and never resolved is never made again; a handed-back run never writes at all
  if (s.writeStarted || opts.recoverOnly) {
    const at = now().toISOString();
    const rec = await engine.recover(
      {
        id: `dlv_${p.attemptId}`,
        draftId: d.id,
        draftVersion: p.version,
        attemptNo: s.attemptNo,
        channel: channelOf(d.destination),
        mode: p.mode,
        dryRun: false,
        payload,
        payloadHash: hash,
        toolCall: { server: '', tool: '', args: {} },
        idempotencyKey: `outbox.dispatch:${d.id}:${p.attemptId}`,
        state: 'delivering',
        result: null,
        error: null,
        readback: null,
        readbackDetail: null,
        confirmedBy: s.approvalMethod === 'autonomy_policy' ? 'autopilot' : 'user',
        confirmedAt: s.approvedAt ?? at,
        deliverAt: at,
        startedAt: null,
        finishedAt: null,
        readbackAt: null,
        cancelledAt: null,
      },
      { writeStarted: !!s.writeStarted },
    );
    return { state: rec.state, code: rec.error?.code ?? null, draftId: d.id, attemptId: p.attemptId, recovered: true };
  }
  let confirmation: DeliveryConfirmation;
  try {
    confirmation = confirmFromApproval({
      draftId: d.id,
      draftVersion: p.version,
      mode: p.mode,
      payloadHash: hash,
      approvedAt: s.approvedAt,
      approvalMethod: s.approvalMethod,
      approvedContentHash: s.approvedContentHash,
      currentContentHash: s.currentContentHash,
      confirmedPayloadHash: p.payloadHash ?? null,
      at: now().toISOString(),
      // null = the policy allows it; undefined = the port did not re-check it (refused)
      ...(s.approvalMethod === 'autonomy_policy' ? { policyRefusal: s.policyRefusal === undefined ? 'The autonomy policy was not re-checked' : s.policyRefusal } : {}),
    });
  } catch (err) {
    if (!(err instanceof NotConfirmedError)) throw err;
    const at = now().toISOString();
    const rec: DeliveryRecord = {
      id: `dlv_${p.attemptId}`,
      draftId: d.id,
      draftVersion: p.version,
      attemptNo: s.attemptNo,
      channel: channelOf(d.destination),
      mode: p.mode,
      dryRun: false,
      payload,
      payloadHash: hash,
      toolCall: { server: '', tool: '', args: {} },
      idempotencyKey: `outbox.dispatch:${d.id}:${p.attemptId}`,
      state: 'failed',
      result: null,
      error: { code: 'not_confirmed', message: err.message, retryable: false },
      readback: null,
      readbackDetail: null,
      confirmedBy: s.approvalMethod === 'autonomy_policy' ? 'autopilot' : 'user',
      confirmedAt: s.approvedAt ?? at,
      deliverAt: at,
      startedAt: at,
      finishedAt: at,
      readbackAt: null,
      cancelledAt: null,
    };
    await port.save(p, rec);
    return { state: 'failed', code: 'not_confirmed', draftId: d.id };
  }
  const rec0 = engine.prepare({ draftId: d.id, draftVersion: p.version, destination: d.destination, mode: p.mode, payload, dryRun: s.dryRun, attemptNo: s.attemptNo, confirmation, idempotencyKey: `outbox.dispatch:${d.id}:${p.attemptId}` });
  const rec = await engine.deliver({ ...rec0, id: `dlv_${p.attemptId}` }, confirmation, { holdMs: 0, verifyReadback: s.verifyReadback, signal: opts.signal });
  return { state: rec.state, draftId: d.id, attemptId: p.attemptId, channel: rec.channel, ...(rec.readback ? { readback: rec.readback } : {}), ...(rec.error ? { code: rec.error.code } : {}) };
}

/** The queue `POST /drafts/:id/dispatch` enqueues `outbox.dispatch` on. */
export const OUTBOX_QUEUE = 'outbox';

export function outboxJobDef<S = unknown>(deps: OutboxJobDeps<S>): JobHandlerDef<S> {
  return { kind: 'outbox.dispatch', queue: OUTBOX_QUEUE, wired: true, description: 'Outbox delivery (adapters + read-back) after the user confirm', handler: outboxDispatchHandler(deps) };
}

export function outboxDispatchHandler<S = unknown>(deps: OutboxJobDeps<S>): JobHandler<S> {
  return async (ctx) => {
    const p = parseJobPayload(ctx.job.payload);
    if (!p) return { skipped: 'bad_payload' };
    const res = await runOutboxJob(p, deps.port(ctx), deps.gateway, { now: ctx.clock, signal: ctx.signal });
    if (res.state === 'delivered' && res.channel === 'slack_canvas' && deps.onCanvasApplied) {
      try {
        await deps.onCanvasApplied(ctx, p.draftId);
      } catch (err) {
        ctx.log('org62 re-check not queued after canvas apply', { code: err instanceof Error ? err.name : 'error' });
      }
    }
    return res;
  };
}
