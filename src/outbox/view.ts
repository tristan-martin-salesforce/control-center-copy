/**
 * Delivery record → the contract's Draft fields (`attempts[]`, `status`, `verification`), shared by the mock
 * and db DataSources so both show the same Outbox. A dry run never changes the draft status (it never looks
 * like a delivery); its attempt says "Dry-run delivered" and carries the payload hash.
 */
import type { DispatchAttempt, Draft, Verification } from '@/contract';
import { canvasUrlFor } from '@/lib/canvas/payload';

import { shortHash } from './hash';
import type { DeliveryRecord } from './types';

const DEST: Record<DeliveryRecord['channel'], string> = { slack: 'Slack', gmail: 'Gmail', vdp: 'VDP', slack_canvas: 'Slack canvas', feedback: 'the feedback channel', release: 'the announcement channel' };

/** Where a retryable failure is tried again: messages from the Outbox, Activity's writes on Activity. */
const RETRY_WHERE: Record<DeliveryRecord['channel'], string> = { slack: 'retry from the Outbox', gmail: 'retry from the Outbox', feedback: 'retry from the Outbox', release: 'retry from the Outbox', slack_canvas: 'Apply it again on Activity', vdp: 'push it again on Activity ▸ VDP' };

/** B3: a write that may have landed (no answer, or the app stopped mid-delivery): never "failed, nothing was sent". */
export const isOutcomeUnknown = (rec: Pick<DeliveryRecord, 'state' | 'error'>) => rec.state === 'failed' && rec.error?.code === 'outcome_unknown';

export function attemptOutcome(rec: DeliveryRecord): DispatchAttempt['outcome'] {
  switch (rec.state) {
    case 'dry_run_delivered':
      return 'rendered';
    case 'delivered':
      return rec.mode === 'draft' ? 'staged' : 'sent';
    case 'failed':
      return isOutcomeUnknown(rec) ? 'unconfirmed' : 'failed';
    default:
      return 'unconfirmed';
  }
}

/** One quiet, body-free line for the Outbox row and history. */
export function attemptDetail(rec: DeliveryRecord): string {
  const dest = DEST[rec.channel];
  const h = shortHash(rec.payloadHash);
  switch (rec.state) {
    case 'dry_run_delivered':
      return `Dry-run delivered: payload recorded (${h}), nothing sent`;
    case 'delivered':
      return rec.mode === 'draft' ? `Draft created in ${dest} (${h})` : `Sent to ${dest} (${h})`;
    case 'failed': {
      if (isOutcomeUnknown(rec)) return `${rec.error!.message} (${rec.error!.code})`;
      const msg = rec.error?.message ?? 'Delivery failed';
      // where to try again: Activity's own writes (a logging canvas, a VDP change) never point at the Outbox
      const retry = rec.error?.retryable ? RETRY_WHERE[rec.channel] : '';
      return `${msg} (${rec.error?.code ?? 'unknown'}).${/nothing was sent/i.test(msg) ? '' : ' Nothing was sent'}${retry ? `${/nothing was sent/i.test(msg) ? ' ' : '; '}${retry}` : ''}`.replace(/\.$/, '').trim();
    }
    case 'cancelled':
      return 'Cancelled during the undo window: nothing sent';
    case 'countdown':
      return `Sending to ${dest} after the undo window`;
    default:
      return `Delivering to ${dest}…`;
  }
}

export function attemptOf(rec: DeliveryRecord, id: string = rec.id): DispatchAttempt {
  return { id, at: rec.startedAt ?? rec.confirmedAt, mode: rec.mode, dryRun: rec.dryRun, outcome: attemptOutcome(rec), detail: attemptDetail(rec) };
}

/**
 * Draft status after the record. A dry run or a cancel leaves it unchanged, except that a draft queued as
 * `sending` (dry-run was switched back on before the job ran, or the countdown was cancelled) returns to
 * pending approval: nothing left.
 */
export function draftStatusOf(rec: DeliveryRecord, current: Draft['status']): Draft['status'] {
  switch (rec.state) {
    case 'delivering':
      return 'sending';
    case 'failed':
      return 'failed';
    case 'dry_run_delivered':
    case 'cancelled':
      return current === 'sending' ? 'ready' : current;
    case 'delivered':
      if (rec.readback === 'confirmed') return 'verified';
      if (rec.readback === 'missing') return 'verify_failed';
      if (rec.readback === 'unconfirmed') return rec.mode === 'draft' ? 'staged' : 'verify_failed';
      return rec.mode === 'draft' ? 'staged' : 'sent';
    default:
      return current;
  }
}

export function verificationOf(rec: DeliveryRecord, current: Draft['verification']): Draft['verification'] {
  // Non-null on purpose: the db keeps verification as append-only rows, so "nothing to verify" is a row too.
  if (rec.state === 'failed') return { state: 'failed', at: rec.finishedAt, detail: 'Not delivered, so there is nothing to verify' };
  if (rec.state === 'dry_run_delivered' || rec.state === 'cancelled') {
    if (current?.state !== 'pending') return current;
    return { state: 'unverified', at: rec.finishedAt, detail: rec.state === 'cancelled' ? 'Cancelled: nothing was sent' : 'Dry run: nothing was sent' };
  }
  if (rec.state !== 'delivered') return current;
  if (!rec.readback) return { state: 'pending', at: null, detail: 'Verifying by read-back…' };
  const state: Verification['state'] = rec.readback === 'confirmed' ? 'verified' : rec.readback === 'missing' ? 'failed' : 'unverified';
  return { state, at: rec.readbackAt, detail: rec.readbackDetail ?? '' };
}

/**
 * Where a delivered draft's result lives (`Draft.resultUrl`): the adapter's link (the canvas URL, the Slack permalink,
 * the VDP record); else, for a canvas Slack answered with its id only, the link built from a canvas link the app
 * already knows (`known`: other canvases, Settings ▸ Time ▸ Work-order canvas link); else a VDP change's target link.
 * Null when nothing links there.
 */
export function resultUrlOf(d: Pick<Draft, 'destination' | 'resultUrl'>, rec: Pick<DeliveryRecord, 'result'>, known: ReadonlyArray<string | null | undefined> = []): string | null {
  const link = rec.result?.link?.trim();
  if (link) return link;
  const dest = d.destination;
  if (dest.kind === 'action' && dest.action === 'slack_canvas.create') return canvasUrlFor(rec.result?.externalId, known) ?? d.resultUrl ?? null;
  if (dest.kind === 'action' && dest.action.startsWith('vdp.')) return dest.target.url ?? d.resultUrl ?? null;
  return d.resultUrl ?? null;
}
