/**
 * VDP autopilot's run (D-60), shared by the db and mock DataSources: settings → sign-in → the shared coverage and its
 * queue → each item staged from the mirror and applied through the Outbox under the autonomy policy → the ledger.
 * Storage, staging and delivery are the port's; the decisions are src/engines/vdp/autopilot.ts.
 *
 *   off               nothing (skipped: off)
 *   dry run on        nothing is staged or sent; paused: dry_run (the VDP view and Health say so)
 *   sign-in stale     nothing is staged or sent; paused: reauth, told once ("VDP autopilot is paused: re-auth VDP")
 *   cap reached       what is left waits for tomorrow; paused: cap
 *   otherwise         the queue in order, each item once: applied (read back) or failed (back to you, with the error)
 *
 * A run never retries a failure and never makes the same call twice (the ledger: item key + values). The Outbox
 * re-checks the policy, dry run and the payload right before each write, so a setting switched mid-run wins.
 */
import type { SendingSettings, VdpCoveragePayload } from '@/contract';
import type { VdpSnapshot } from '@/lib/vdp/types';
import { localDay } from '@/engines/activity/time';
import { entriesOn, nextLedger, type AutopilotItem, type AutopilotLedger, type AutopilotLedgerEntry } from '@/engines/vdp/autopilot';
import { sendingOf } from '@/outbox/settings';

import { vdpActionForItem, type ApplyableCandidate, type CoverageAutopilot } from './coverage';

/** How one applied item ended. `dry_run`: dry run came on mid-run (nothing reached VDP; it is not recorded). */
export interface AutopilotApplyResult {
  draftId: string | null;
  outcome: 'applied' | 'failed' | 'dry_run';
  detail: string | null;
  url: string | null;
}

export interface AutopilotPort {
  now(): Date;
  /** The stored sending section and the user's time zone, read now. */
  settings(): Promise<{ sending: Partial<SendingSettings> | null | undefined; timezone: string }>;
  /** VDP's sign-in, from the stored config only (no network): a stale cookie or no PAT pauses autopilot. */
  auth(): Promise<'ok' | 'stale'>;
  ledger(): Promise<AutopilotLedger>;
  /** `changed`: anything new to keep (an item applied or failed, the pause changed); an idle run need not write. */
  saveLedger(next: AutopilotLedger, o: { applied: number; failed: number; changed: boolean }): Promise<void>;
  /** The shared coverage for these inputs, its queue, and the mirror (to rebuild each item's call). */
  plan(ap: CoverageAutopilot): Promise<{ coverage: VdpCoveragePayload; queue: AutopilotItem[]; snapshots: readonly VdpSnapshot[] }>;
  /** Stage the item (the same call your Apply would make) and apply it under the autonomy policy. */
  apply(item: AutopilotItem, dest: ReturnType<typeof vdpActionForItem>): Promise<AutopilotApplyResult>;
  /** Tell the user once that autopilot paused (the change to `paused`); Health and the VDP view keep showing it. */
  notifyPaused?(why: 'reauth' | 'dry_run' | 'cap'): Promise<void>;
}

/** The asset candidates an `asset:<id>` item adds, from the coverage rows (their Apply), for `vdpActionForItem`. */
export function applyableCandidates(cov: Pick<VdpCoveragePayload, 'vdps'>): ApplyableCandidate[] {
  return cov.vdps.flatMap((r) => (r.assetItems ?? []).map((a) => ({ id: a.candidateId, vdpSlug: r.vdpSlug, title: a.title, apply: a.apply, draftId: a.draftId })));
}

export interface AutopilotRunResult extends Record<string, unknown> {
  skipped?: 'off';
  paused?: 'reauth' | 'dry_run' | 'cap' | null;
  applied: number;
  failed: number;
  queued: number;
}

export async function runVdpAutopilot(port: AutopilotPort, opts: { signal?: AbortSignal } = {}): Promise<AutopilotRunResult> {
  const { sending: raw, timezone } = await port.settings();
  const sending = sendingOf(raw);
  if (!sending.channels.vdp.autopilot) return { skipped: 'off', applied: 0, failed: 0, queued: 0 };
  const now = port.now();
  const dayOf = (iso: string) => localDay(Date.parse(iso), timezone);
  const today = dayOf(now.toISOString());
  const ledger = await port.ledger();
  // dry run first (no sign-in read needed); then VDP's sign-in
  const auth = sending.dryRun ? 'ok' : await port.auth();
  const settings = { on: true, dryRun: sending.dryRun, cap: sending.channels.vdp.dailyCap, assetHosts: sending.autopilotAssetHosts };
  const plan = await port.plan({ settings, ledger, auth, today, dayOf });
  const st = plan.coverage.autopilot;
  if (st.paused === 'dry_run' || st.paused === 'reauth') {
    if (ledger.paused !== st.paused) await port.notifyPaused?.(st.paused);
    await port.saveLedger(nextLedger(ledger, [], { now: now.toISOString(), paused: st.paused }), { applied: 0, failed: 0, changed: ledger.paused !== st.paused });
    return { paused: st.paused, applied: 0, failed: 0, queued: st.queued };
  }
  const cands = applyableCandidates(plan.coverage);
  const added: AutopilotLedgerEntry[] = [];
  let stoppedByDryRun = false;
  for (const item of plan.queue) {
    if (opts.signal?.aborted) break;
    let r: AutopilotApplyResult;
    try {
      const dest = vdpActionForItem(plan.coverage, plan.snapshots, { itemKey: item.key, values: {} }, cands);
      r = await port.apply(item, dest);
    } catch (err) {
      // not staged (the item changed under it, a value failed its rules): back to you, never retried
      r = { draftId: null, outcome: 'failed', detail: ((err as Error).message || 'Could not stage it').slice(0, 300), url: null };
    }
    if (r.outcome === 'dry_run') {
      stoppedByDryRun = true;
      break;
    }
    added.push({ key: item.key, hash: item.hash, at: port.now().toISOString(), state: r.outcome, title: item.title, vdpKey: item.vdpKey, companyName: item.companyName, op: item.op, detail: r.detail, draftId: r.draftId, url: r.url });
  }
  const after = { ...ledger, entries: [...ledger.entries, ...added] };
  const usedToday = entriesOn(after, today, dayOf).length;
  const left = plan.queue.length - added.length;
  const paused = stoppedByDryRun ? 'dry_run' : usedToday >= settings.cap && (left > 0 || st.queued > plan.queue.length) ? 'cap' : null;
  if (paused && ledger.paused !== paused) await port.notifyPaused?.(paused);
  const applied = added.filter((e) => e.state === 'applied').length;
  const failed = added.length - applied;
  await port.saveLedger(nextLedger(ledger, added, { now: port.now().toISOString(), paused }), { applied, failed, changed: added.length > 0 || paused !== ledger.paused });
  return { paused, applied, failed, queued: Math.max(0, st.queued - added.length) };
}
