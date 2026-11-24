/**
 * Interpret one run's recorded items (FTI): rules → candidates → batched classifier → apply, with every rule decision
 * recorded (`llm_decisions` kind skip, reason `rule_<why>`) and every classifier call returned for booking.
 */
import { createCcHandlers, type CcRunState } from '@/llm/cc-tools';
import { loadSkill } from '@/llm/skill-loader';

import { trace } from '../trace';
import type { ScanContext, ScannerStore, TimeWindow } from '../types';
import { actionsFor, runActions, unsureAction } from './apply';
import { BACKFILL_BUDGET, LIVE_BUDGET, type BatchBudget } from './batch';
import { classifyInBatches } from './classify';
import { CLASSIFIER_MODEL } from './model';
import { renderSystem } from './render';
import { ACTS } from './schema';
import type { ClassifierCall, ClassifierModel, RuleDecision } from './types';
import { buildUnits, widener } from './units';

export const CLASSIFY_SKILL_PATH = 'skills/classify-items.md';
export const CLASSIFY_SKILL_KEY = 'classify-items';

export interface InterpretInput {
  store: ScannerStore;
  state: CcRunState;
  ctx: ScanContext;
  window: TimeWindow;
  fresh: ReadonlySet<string>;
  model: ClassifierModel;
  modelId?: string;
  /** `backfill` (first scan, catch-up): large batches. */
  mode?: string;
  budget?: BatchBudget;
  maxBudgetUsdPerCall?: number;
  signal?: AbortSignal;
  repoRoot?: string;
  trigger?: string;
  /** F-4: checked before each batch (true: stop there, `ClassifyPaused`; the batches already applied keep their verdicts). */
  pauseBefore?: () => boolean;
  /** Each classifier call as it returns, with how many items rules decided (the runner traces its `pass` row then; awaited). */
  onCall?: (c: ClassifierCall, decidedByRules: number) => void | Promise<void>;
}

export interface InterpretResult {
  calls: ClassifierCall[];
  decided: RuleDecision[];
  /** Units the classifier read (items_in of the calls). */
  units: number;
  /** Units still unsure after the second pass (flagged for Triage). */
  unsure: number;
  /** Verdicts by kind (ids only in the trace). */
  verdicts: Record<string, number>;
  failedWrites: number;
}

const BACKFILL_MODES = new Set(['backfill', 'head', 'continuation', 'reconcile']);

export async function interpretRun(i: InterpretInput): Promise<InterpretResult> {
  const { store, state, ctx } = i;
  const runId = state.runId;
  const handlers = createCcHandlers(store, state);
  const res: InterpretResult = { calls: [], decided: [], units: 0, unsure: 0, verdicts: {}, failedWrites: 0 };
  const built = await buildUnits({ store, state, ctx, window: i.window, fresh: i.fresh });
  res.decided = built.decided;
  res.units = built.units.length;
  if (built.actions.length) res.failedWrites += (await runActions(handlers, state, built.actions)).failed;
  // D0: what rules settled without the model, one decision row per reason
  const byReason = new Map<string, number>();
  for (const d of built.decided) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
  for (const [reason, count] of byReason) await store.recordDecision?.({ skill: CLASSIFY_SKILL_KEY, kind: 'skip', reason: `rule_${reason}`, trigger: i.trigger ?? null, subject: `${ctx.scope.connector}:${ctx.scope.scope}`, count, detail: { runId } }).catch(() => undefined);
  trace(runId, 'triage_select', () => ({ fti: true, units: built.units.length, decided: built.decided.length, byRule: Object.fromEntries(byReason), ruleActions: built.actions.length }));
  if (!built.units.length) return res;

  const skill = loadSkill(CLASSIFY_SKILL_PATH, i.repoRoot);
  const { system, cacheBoundary } = renderSystem(skill.body, ctx);
  const knownAccounts = new Set([...ctx.aliases.accounts.map((a) => a.accountId), ...ctx.aliases.channels.flatMap((c) => (c.accountId ? [c.accountId] : []))]);
  const verdictsToSave: Array<{ sourceItemId: string; v: 'act' | 'noise' | 'unsure'; why?: string }> = [];
  try {
    await classifyInBatches(
      built.units,
      {
        model: i.model,
        modelId: i.modelId ?? CLASSIFIER_MODEL,
        skillVersion: skill.versionTag,
        system,
        cacheBoundary,
        budget: i.budget ?? (BACKFILL_MODES.has(i.mode ?? '') ? BACKFILL_BUDGET : LIVE_BUDGET),
        maxBudgetUsd: i.maxBudgetUsdPerCall ?? (typeof skill.frontmatter.budget_usd_per_run === 'number' ? skill.frontmatter.budget_usd_per_run : 0.02),
        ...(i.signal ? { signal: i.signal } : {}),
        widen: widener(store),
        onCall: async (c) => {
          res.calls.push(c);
          await i.onCall?.(c, res.decided.length);
        },
        ...(i.pauseBefore ? { pauseBefore: i.pauseBefore } : {}),
      },
      async (batch, out) => {
        // In batch order (a conversation in time order), so a verdict can link to an earlier item of the same batch:
        // the ask and my reply to it in one first-scan chunk ("Done, see deck" completes the ask proposed just before).
        const proposed = new Map<string, { workItemId: string; title: string }>();
        for (const x of batch) {
          const v = out.verdicts.get(x.ref);
          const u = out.unsure.get(x.ref);
          if (v) {
            res.verdicts[v.v] = (res.verdicts[v.v] ?? 0) + 1;
            const same = v.link ? proposed.get(v.link) : undefined;
            const unit = same ? { ...x, candidates: [...x.candidates, { alias: v.link!, workItemId: same.workItemId, title: same.title, why: 'same batch', score: 1, state: 'open' }] } : x;
            const r = await runActions(handlers, state, actionsFor(unit, v, { knownAccounts }));
            res.failedWrites += r.failed;
            if (r.proposed) proposed.set(x.ref, { workItemId: r.proposed, title: v.title ?? '' });
            verdictsToSave.push({ sourceItemId: x.sourceItemId, v: ACTS.has(v.v) || v.link ? 'act' : 'noise', why: `fti:${v.v}${v.why ? ` ${v.why}` : ''}`.slice(0, 200) });
            trace(runId, 'verdict', () => ({ pass: 'classify', ref: x.ref, v: v.v, conf: v.conf, link: v.link ?? null, sameBatch: !!same, why: v.why ?? null }), { sourceItemId: x.sourceItemId });
          } else if (u) {
            res.unsure += 1;
            // only a possible ask, promise or delivery is worth the user's look; a doubtful "noise" stays recorded
            if (!u.verdict || ACTS.has(u.verdict.v)) res.failedWrites += (await runActions(handlers, state, [unsureAction(x, u.why)])).failed;
            verdictsToSave.push({ sourceItemId: x.sourceItemId, v: 'unsure', why: `fti: ${u.why}`.slice(0, 200) });
            trace(runId, 'verdict', () => ({ pass: 'reclassify', ref: x.ref, v: 'unsure', why: u.why }), { sourceItemId: x.sourceItemId });
          }
        }
      },
    );
  } finally {
    // the batches applied so far keep their verdicts even when a later one fails or pauses (they are not sent again)
    if (verdictsToSave.length && store.recordTriageVerdicts) {
      // TRI-NOISE: one verdict per source item (a notes doc's steps share one), saved for the next run to carry forward
      const one = new Map<string, (typeof verdictsToSave)[number]>();
      for (const v of verdictsToSave) if (!one.has(v.sourceItemId) || v.v === 'act') one.set(v.sourceItemId, v);
      await store.recordTriageVerdicts([...one.values()]).catch(() => undefined);
    }
  }
  return res;
}
