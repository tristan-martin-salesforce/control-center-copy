/**
 * The worker's day-budget gate (holistic review 2026-11-20, 04 §4.3): before it starts a job that calls a model, the
 * worker estimates it and holds p90 against today. When today's booked spend plus every live hold plus this one would
 * pass the daily hard cap (a user budget: the runaway guard), the job does not start: it waits for later and one
 * SPEND.DAY_BUDGET event says so (Health), instead of starting and being skipped silently. A job that started settles
 * its hold with what it booked (llm_calls by job id).
 *
 * Scans are not gated here: the scanner runtime holds per run itself, and a scan past the cap still records
 * deterministically (BUD-1).
 */
import { readInModelFor, type ReadInTrigger } from '@/contract';

import { dayBudgetFingerprint, fmtUsd, type SpendGovernor } from './governor';
import { spendHoldIdOf } from './job-spend';
import type { Hold, SpendScope } from './types';

/** How the governor prices one job kind: its scope, the llm_calls skill (and model) its history is read from. */
export interface LlmJobKind {
  scope: SpendScope;
  /** llm_calls.skill_key the handler books (and prices its own hold with): the estimate reads this skill's runs. */
  skill?: string;
  model?: string;
  /** When the skill or model depends on the payload (a read-in's entity type and trigger). */
  price?: (payload: Record<string, unknown>) => { skill?: string; model?: string };
  /**
   * false: the handler holds on the governor itself under `<kind>:<id>` and must not get a start-gate hold too (one
   * spend, one hold). The kind stays here so the worker's crash recovery releases those holds when the job is dead.
   */
  startHold?: false;
}

/** A read-in is priced like its handler holds it: the skill by entity type, the model by trigger (D2). */
export function readInPrice(payload: Record<string, unknown>): { skill: string; model: string } {
  const triggers: ReadInTrigger[] = ['direct_ask', 'top_rank', 'meeting_prep', 'new_evidence', 'on_demand'];
  const trigger = triggers.find((t) => t === payload.trigger) ?? 'on_demand';
  return { skill: payload.entity_type === 'calendar_event' ? 'readin-meeting' : 'readin-ask', model: readInModelFor(trigger).model };
}

/**
 * Every job kind whose handler can call a model, and how the governor prices it (post-job-kinds, 2026-11-21).
 *
 * The rule: a kind is listed exactly when its handler can call a model, i.e. its registry entry says `spends: true`
 * (src/jobs/types.ts). Listed, the worker's start gate (`gateJobStart`) holds the estimate before the job starts and
 * declines it when today's hard cap has no room; the handler runs under that hold (`startJobSpend` finds it by
 * `<kind>:<id>`) and never takes a second one. A listed kind no handler registers, or a handler that calls a model
 * and is not listed, fails tests/jobs/job-kinds.test.ts. The skill is the one the handler books in llm_calls: the
 * estimate reads that skill's history (with no skill it would read every call of the user).
 */
export const LLM_JOB_KINDS: Record<string, LlmJobKind> = {
  'settle.check': { scope: 'settle_pass', skill: 'settle-item' },
  'completion.check': { scope: 'job', skill: 'completion-check' },
  'brief.generate': { scope: 'job', skill: 'brief-channel' },
  'readin.generate': { scope: 'research', price: readInPrice },
  'activity.suggest': { scope: 'job', skill: 'activity-suggest' },
  'activity.notes': { scope: 'job', skill: 'activity-note' },
  'vdp.assets.find': { scope: 'research', skill: 'vdp-assets' },
  'vdp.identity': { scope: 'job', skill: 'vdp-company-identity' },
  'vdp.specialist_aes': { scope: 'relay', skill: 'vdp-specialist-aes' },
  'accounts.hierarchy': { scope: 'relay', skill: 'accounts-hierarchy' },
  'org62.readback': { scope: 'relay', skill: 'org62-readback' },
  'org62.discover': { scope: 'relay', skill: 'org62-discover' },
  'forecast.sync': { scope: 'relay', skill: 'forecast-sync' },
  'forecast.draft': { scope: 'research', skill: 'forecast-notes' },
  'resolution.check': { scope: 'job', skill: 'resolve-item' },
  // its confirm pass holds per page itself (and resumes an allowed hold of an earlier pass); a day with no room runs
  // the rules without the model, so a start-gate hold would be a second hold and would defer the rules too
  'use_cases.extract': { scope: 'job', skill: 'extract-use-cases', startHold: false },
};

/** The scope, skill and model the gate holds a job with (null: not a model job, or one that holds itself). */
export function jobPricing(job: { kind: string; payload?: Record<string, unknown> | null }, kinds: Record<string, LlmJobKind> = LLM_JOB_KINDS): { scope: SpendScope; skill?: string; model?: string } | null {
  const k = kinds[job.kind];
  if (!k || k.startHold === false) return null;
  const p = k.price ? k.price(job.payload ?? {}) : {};
  const skill = p.skill ?? k.skill;
  const model = p.model ?? k.model;
  return { scope: k.scope, ...(skill ? { skill } : {}), ...(model ? { model } : {}) };
}

/** A declined job tries again after this long (a raise in Settings, or midnight, lets it run). */
export const DAY_GATE_RETRY_MS = 30 * 60_000;

export type GateDecision = { start: true; hold: Hold | null } | { start: false; retryAt: Date; reason: string };

export async function gateJobStart(gov: SpendGovernor, job: { id: number | string; kind: string; payload?: Record<string, unknown> }, o: { kinds?: Record<string, LlmJobKind> } = {}): Promise<GateDecision> {
  const kind = jobPricing(job, o.kinds);
  if (!kind) return { start: true, hold: null };
  // F-4: a continuation of a job that raised its hand brings its own hold (job-spend.ts); a second one would hold twice
  if (spendHoldIdOf(job.payload)) return { start: true, hold: null };
  // A first-scan job spends the first scan's own envelope (B-080), never the day.
  const budget = job.payload?.budget === 'first_scan' ? 'first_scan' : 'daily';
  const spendJob = { ...kind, jobKey: `${job.kind}:${job.id}`, budget } as const;
  const est = await gov.estimate(spendJob);
  const r = await gov.hold(spendJob, est);
  if (r.ok) return { start: true, hold: r.hold };
  const now = gov.store.now();
  const message = `Jobs that use the model wait until tomorrow or a higher cap: today has ${fmtUsd(r.day.spentUsd)} spent and ${fmtUsd(r.day.heldUsd)} held of ${fmtUsd(r.day.hardUsd)}.`;
  await gov.store
    .recordEvent({ code: 'SPEND.DAY_BUDGET', message, fingerprint: dayBudgetFingerprint(r.day.day), severity: 'warn', detail: { day: r.day.day, spentUsd: r.day.spentUsd, heldUsd: r.day.heldUsd, hardUsd: r.day.hardUsd, wantUsd: r.wantUsd, kind: job.kind, jobId: String(job.id) } })
    .catch(() => undefined);
  return { start: false, retryAt: new Date(now.getTime() + DAY_GATE_RETRY_MS), reason: 'day_budget' };
}
