/**
 * The batched, tool-less classifier (review 04 §4.1 #3, decision H-3): N items per call by token budget, one shared
 * cached system prefix, strict JSON validated with zod. A verdict below the confidence floor, a ref the model left
 * out, or an entry that failed validation gets a second pass with more context (the conversation around it, more of
 * the body) before anything reaches Triage. What is still unsure after that is returned as such: the apply step
 * flags it for Triage (never dropped, never guessed).
 *
 * Each call is keyed like the completion pass (`ledgerHash(model, skill version, system, user)`), so the cassette
 * model (src/scanner/completion/cassette.ts) replays it offline, and the same hash is the call's D0 content hash.
 * Logs and traces carry ids, counts and hashes, never message text.
 */
import { ledgerHash } from '@/db/ledger';
import { classifyError, type ErrorClass } from '@/llm/errors';

import { packBatches, replyTokensFor, type BatchBudget } from './batch';
import { renderBatch } from './render';
import { ACTS, CONFIDENCE_FLOOR, parseClassifierOutput, type Verdict } from './schema';
import type { ClassifierCall, ClassifierModel, InterpretItem } from './types';

export interface ClassifyRun {
  model: ClassifierModel;
  modelId: string;
  /** `classify-items@<version>`: part of every call's hash. */
  skillVersion: string;
  system: string;
  cacheBoundary: number;
  budget: BatchBudget;
  /** Hard stop for one call (USD). TODO(spend-governor): hold the p90 estimate of the batch instead of a flat cap. */
  maxBudgetUsd: number;
  signal?: AbortSignal;
  floor?: number;
  /** The second pass: the same items with more context (the conversation from the store). */
  widen?: (items: InterpretItem[]) => Promise<InterpretItem[]>;
  /** F-4: checked before each batch's first call; true stops the run there (`ClassifyPaused`): past the spend hold. */
  pauseBefore?: () => boolean;
  /** Each call as it returns (awaited: the runner traces its `pass` row before the next request). */
  onCall?: (c: ClassifierCall) => unknown;
}

export interface BatchOutcome {
  /** Final verdicts at or above the floor, by ref. */
  verdicts: Map<string, Verdict>;
  /** Refs still unsure after the second pass → why (the low verdict when there was one). */
  unsure: Map<string, { why: string; verdict?: Verdict }>;
}

export class ClassifierCallError extends Error {
  override name = 'ClassifierCallError';
  constructor(
    message: string,
    readonly errorClass: ErrorClass,
  ) {
    super(message);
  }
}

/** The run stopped before a batch to raise a hand about spend (H-5): what earlier batches applied stays. */
export class ClassifyPaused extends Error {
  override name = 'ClassifyPaused';
  constructor(
    readonly batchesDone: number,
    readonly batches: number,
  ) {
    super(`paused before batch ${batchesDone + 1} of ${batches}`);
  }
}

/** The call's key: the cassette hash and the D0 content hash. */
export const classifierHash = (modelId: string, skillVersion: string, system: string, user: string) => ledgerHash(modelId, skillVersion, system, user);

/** Prompt tokens of one request, estimated (prose and data mixed: about 3.2 characters a token). */
export const promptTokensEst = (system: string, user: string) => Math.ceil((system.length + user.length) / 3.2);

async function callOnce(run: ClassifyRun, items: InterpretItem[], pass: 'classify' | 'reclassify', idx: { index: number; total: number }) {
  const user = renderBatch(items, { ...idx, wide: pass === 'reclassify' });
  const t0 = Date.now();
  const res = await run.model({ model: run.modelId, system: run.system, user, effort: 'low', maxBudgetUsd: run.maxBudgetUsd, cacheBoundary: run.cacheBoundary, maxTokens: replyTokensFor(items.length), ...(run.signal ? { signal: run.signal } : {}) });
  const parsed = res.ok ? parseClassifierOutput(res.text) : { verdicts: [], invalid: [], malformed: true };
  const call: ClassifierCall = {
    pass,
    model: run.modelId,
    ok: res.ok,
    ...(res.ok ? {} : { error: res.error?.message ?? 'call failed' }),
    costUsd: res.costUsd,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    cacheReadTokens: res.cacheReadTokens ?? 0,
    cacheWriteTokens: res.cacheWriteTokens ?? 0,
    contentHash: classifierHash(run.modelId, run.skillVersion, run.system, user),
    prefixHash: ledgerHash(run.modelId, run.skillVersion, run.system.slice(0, run.cacheBoundary)),
    promptTokensEst: promptTokensEst(run.system, user),
    itemsIn: items.length,
    verdicts: parsed.verdicts.length,
    acts: parsed.verdicts.filter((v) => ACTS.has(v.v)).length,
    invalid: parsed.invalid.length,
    malformed: parsed.malformed,
    ms: Date.now() - t0,
  };
  await run.onCall?.(call);
  if (!res.ok) {
    const c = res.error?.errorClass ?? classifyError(res.error?.message ?? '').errorClass;
    throw new ClassifierCallError(`classifier call failed: ${res.error?.message ?? 'no result'}`.slice(0, 300), c === 'unknown' ? 'transient' : c);
  }
  return parsed.verdicts;
}

/** Valid verdicts for exactly this batch's refs (the first one per ref; a ref the batch does not hold is ignored). */
function byRef(items: InterpretItem[], verdicts: Verdict[]): Map<string, Verdict> {
  const want = new Set(items.map((x) => x.ref));
  const out = new Map<string, Verdict>();
  for (const v of verdicts) if (want.has(v.ref) && !out.has(v.ref)) out.set(v.ref, v);
  return out;
}

/**
 * Classify `items` batch by batch; `apply` runs after each batch (and its second pass), so a later failure never redoes
 * what is already applied. Throws `ClassifierCallError` when a call fails (the run fails and the runtime retries).
 */
export async function classifyInBatches(items: InterpretItem[], run: ClassifyRun, apply: (batch: InterpretItem[], out: BatchOutcome) => Promise<void>): Promise<void> {
  const floor = run.floor ?? CONFIDENCE_FLOOR;
  const batches = packBatches(items, run.budget);
  for (const [i, batch] of batches.entries()) {
    if (run.signal?.aborted) throw new ClassifierCallError('aborted', 'transient');
    if (run.pauseBefore?.()) throw new ClassifyPaused(i, batches.length);
    const first = byRef(batch, await callOnce(run, batch, 'classify', { index: i + 1, total: batches.length }));
    const verdicts = new Map<string, Verdict>();
    const low: InterpretItem[] = [];
    for (const x of batch) {
      const v = first.get(x.ref);
      if (v && v.conf >= floor) verdicts.set(x.ref, v);
      else low.push(x);
    }
    const unsure = new Map<string, { why: string; verdict?: Verdict }>();
    if (low.length) {
      const wide = run.widen ? await run.widen(low) : low;
      const wideBatches = packBatches(wide, run.budget, { wide: true });
      for (const [j, wb] of wideBatches.entries()) {
        const second = byRef(wb, await callOnce(run, wb, 'reclassify', { index: j + 1, total: wideBatches.length }));
        for (const x of wb) {
          const v = second.get(x.ref) ?? first.get(x.ref);
          if (v && v.conf >= floor) verdicts.set(x.ref, v);
          else unsure.set(x.ref, { why: v?.why ? `${v.v}: ${v.why}` : v ? `${v.v} at ${v.conf.toFixed(2)}` : 'no usable verdict from the classifier', ...(v ? { verdict: v } : {}) });
        }
      }
    }
    await apply(batch, { verdicts, unsure });
  }
}
