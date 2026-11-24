/**
 * Run the resolution check on a set of items: load each one (store), build its pack, run the ladder, plan the outcome,
 * record one closure_checks row per item and, in `live` mode only, hand the plans to `apply` (the job links evidence
 * through the scanner's writer and applies Settle-policy actions; the eval harness does the same in memory). In
 * `shadow` mode nothing but the row is written: the legacy closers still act. Logs carry ids and counts only.
 */
import type { ClosingSettings } from '@/contract';

import { runLadder, type LadderEntry } from './ladder';
import { planOutcome, type OutcomePlan } from './outcome';
import { buildResolutionPack, packLineCount } from './pack';
import { RESOLUTION_ENGINE_VERSION, type CallRecord, type CheckRecord, type EscalationStat, type LadderDecision, type ResolutionItem, type ResolutionPack, type ResolutionRaw, type ResolutionSkill, type ResolutionTrigger } from './types';
import type { CompletionModel } from '@/scanner/completion/types';

export interface ResolutionStore {
  /** The item and its raw rows (null: gone, merged, or not mine). */
  loadForCheck(itemId: string, now: Date): Promise<{ item: ResolutionItem; raw: ResolutionRaw } | null>;
  recordCheck(row: CheckRecord): Promise<number | void>;
  escalationStats?(now: Date): Promise<EscalationStat[]>;
}

export interface CheckResult {
  itemId: string;
  trigger: ResolutionTrigger;
  pack: ResolutionPack;
  decision: LadderDecision;
  plan: OutcomePlan;
  record: CheckRecord;
}

export interface RunChecksInput {
  items: Array<{ id: string; trigger: ResolutionTrigger }>;
  mode: 'shadow' | 'live';
  store: ResolutionStore;
  model: CompletionModel;
  settings: ClosingSettings;
  now: Date;
  me: string;
  timezone?: string;
  signal?: AbortSignal;
  /** The resolution skill (`loadResolutionSkill`, src/scanner/resolution/skill.ts). */
  skill: ResolutionSkill;
  /** Book each model call (the job's llm_calls); returns its id, when booked. */
  onCall?: (c: CallRecord) => Promise<number | null | void> | number | null | void;
  /** Live only: apply the plans (evidence links, Settle actions). */
  apply?: (results: CheckResult[]) => Promise<void>;
  /** Token cap per pack (default PACK_TOKEN_CAP). */
  tokenCap?: number;
}

export interface RunChecksOutput {
  results: CheckResult[];
  calls: number;
  costUsd: number;
  outcomes: Record<string, number>;
  missing: string[];
}

export async function runResolutionChecks(input: RunChecksInput): Promise<RunChecksOutput> {
  const started = Date.now();
  const entries: Array<LadderEntry & { trigger: ResolutionTrigger }> = [];
  const missing: string[] = [];
  for (const it of input.items) {
    const loaded = await input.store.loadForCheck(it.id, input.now);
    if (!loaded) {
      missing.push(it.id);
      continue;
    }
    const pack = buildResolutionPack(loaded.raw, { now: input.now, timezone: input.timezone ?? 'UTC', me: input.me, rules: input.settings.rules || null, ...(input.tokenCap ? { tokenCap: input.tokenCap } : {}) });
    entries.push({ item: loaded.item, pack, raw: loaded.raw, trigger: it.trigger });
  }
  const stats = input.store.escalationStats ? await input.store.escalationStats(input.now) : [];
  let calls = 0;
  const callIds = new Map<string, number>();
  const decisions = await runLadder(entries, {
    model: input.model,
    skill: input.skill,
    now: input.now,
    me: input.me,
    escalationStats: stats,
    strongerModel: input.settings.strongerModelForUnclear,
    ...(input.signal ? { signal: input.signal } : {}),
    onCall: async (c) => {
      calls += 1;
      const id = await input.onCall?.(c);
      if (typeof id === 'number') for (const i of c.itemIds) callIds.set(i, id);
    },
  });
  const per = Math.round((Date.now() - started) / Math.max(1, entries.length));
  const results: CheckResult[] = entries.map((e, i) => {
    const d = decisions[i]!;
    const plan = planOutcome(e.item, d, e.pack, input.settings, input.now);
    const record: CheckRecord = {
      workItemId: e.item.id,
      at: input.now.toISOString(),
      trigger: e.trigger,
      mode: input.mode,
      statusBefore: e.item.status,
      packDigest: e.pack.digest,
      packTokens: e.pack.tokens,
      packLines: packLineCount(e.pack),
      rulesFired: d.rules.fired.map((f) => f.rule),
      ruleHit: d.ruleHit,
      decidedBy: d.decidedBy,
      verdict: d.verdict,
      basis: d.basis,
      confidence: d.confidence == null ? null : Math.round(d.confidence * 1000) / 1000,
      citeAlias: d.cite?.id ?? null,
      citeSourceItemId: d.cite?.sourceItemId ?? null,
      escalated: d.escalated,
      escalationReason: d.escalationReason,
      escalationChanged: d.escalationChanged,
      outcome: plan.outcome,
      blockedBy: plan.blockedBy,
      model: d.model,
      costUsd: Math.round(d.costUsd * 1e6) / 1e6,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheReadTokens: d.cacheReadTokens,
      llmCallId: callIds.get(e.item.id) ?? null,
      durationMs: per,
      engineVersion: RESOLUTION_ENGINE_VERSION,
    };
    return { itemId: e.item.id, trigger: e.trigger, pack: e.pack, decision: d, plan, record };
  });
  for (const r of results) await input.store.recordCheck(r.record);
  if (input.mode === 'live' && input.apply) await input.apply(results.filter((r) => r.plan.evidence || r.plan.settle));
  const outcomes: Record<string, number> = {};
  for (const r of results) outcomes[r.plan.outcome] = (outcomes[r.plan.outcome] ?? 0) + 1;
  return { results, calls, costUsd: results.reduce((n, r) => n + r.decision.costUsd, 0), outcomes, missing };
}
