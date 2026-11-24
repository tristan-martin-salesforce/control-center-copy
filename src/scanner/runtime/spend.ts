/**
 * A scan run's spend, booked with every D0 field (shared by the runtime and the reconciler, so no scan path books
 * dollars without its tokens, trigger, model reason, outcome or content hash).
 */
import { ledgerHash } from '../../db/ledger';
import type { ConnectorId, SpendBooked } from '../types';
import type { ScanSkillRunResult } from './contract-ext';

/** D0: a short code for what came of a run (llm_calls.outcome): `new:2,changed:0,linked:1,proposed:0`, `nothing_new`, `error:auth`. */
export function runOutcome(r: Pick<ScanSkillRunResult, 'ok' | 'counts' | 'error'>): string {
  if (!r.ok) return `error:${r.error?.errorClass ?? 'unknown'}`;
  const c = r.counts;
  if (!c || c.new + c.changed + c.linked + c.proposed === 0) return 'nothing_new';
  return `new:${c.new},changed:${c.changed},linked:${c.linked},proposed:${c.proposed}`;
}

/**
 * The booked spend of one run: its tokens (per model when the SDK says), and why it ran. `hashOf` names what the run
 * was asked to do, for a run that failed before it built its prompt (no prompt hash).
 */
export function runSpend(
  result: ScanSkillRunResult,
  o: { connector: ConnectorId; model: string; runId?: string; budget?: 'daily' | 'first_scan'; jobId?: number; skill?: string; trigger: string; modelReason: string; hashOf: Array<string | number | null | undefined> },
): SpendBooked {
  return {
    connector: o.connector,
    model: o.model,
    costUsd: result.costUsd,
    ...(o.runId ? { runId: o.runId } : {}),
    ...(o.budget ? { budget: o.budget } : {}),
    ...(o.jobId != null ? { jobId: o.jobId } : {}),
    ...(o.skill ? { skill: o.skill } : {}),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens ?? 0,
    cacheWriteTokens: result.cacheWriteTokens ?? 0,
    ...(result.usage ? { usage: result.usage } : {}),
    trigger: o.trigger,
    modelReason: o.modelReason,
    contentHash: result.contentHash ?? ledgerHash(o.model, ...o.hashOf),
    outcome: runOutcome(result),
    // 0027: what the run measured, for a row no pass trace row covers.
    ...(result.measure ? { measure: result.measure } : {}),
  };
}
