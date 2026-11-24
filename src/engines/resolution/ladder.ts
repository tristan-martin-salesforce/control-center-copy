/**
 * The decision ladder (lane 03 §4.1): what decides "is this done?" for a set of items, cheapest first.
 *
 *   1. rules     D1–D6 (src/scanner/resolution/rules.ts) over the pack: a rule that decides needs no model at all
 *   2. cheap     the remaining items, batched up to 8 per call when they share a conversation, on the cheap model with
 *                the skill as the cached system prefix and nothing but the packs as the prompt (no tools)
 *   3. strong    one item at a time, only when the cheap verdict is unsure and the item is worth it, and the data says
 *                escalating that reason still changes verdicts (escalation.ts)
 *
 * It never writes: outcome.ts maps each decision onto the closure machine or Settle's policy, and the caller records
 * and (live) applies it. The model seam is the completion pass's `CompletionModel` (cassette-able in the evals); the
 * skill (prompt, frontmatter, default models) comes in through `LadderOptions.skill`, loaded by the caller.
 */
import { evaluateRules, type RulesResult } from '@/scanner/resolution/rules';

import { shouldEscalate } from './escalation';
import { packLines, ruleInputOfPack } from './pack';
import { parseBatchReply, renderBatchPrompt } from './prompt';
import type { LadderDecision, LadderOptions, ModelVerdict, ResolutionItem, ResolutionPack, ResolutionRaw, ResolutionSkill } from './types';

export interface LadderEntry {
  item: ResolutionItem;
  pack: ResolutionPack;
  raw: Pick<ResolutionRaw, 'record' | 'sessions' | 'lastCheck' | 'latestInputAt'>;
}

export const DEFAULT_BATCH = 8;

function fm(n: unknown, d: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : d;
}

export function ladderThresholds(skill: Pick<ResolutionSkill, 'frontmatter'>): { sure: number; likely: number } {
  const s = skill.frontmatter;
  return { sure: fm(s.sure_min_confidence, 0.85), likely: fm(s.likely_min_confidence, 0.65) };
}

function blank(e: LadderEntry, rules: RulesResult): LadderDecision {
  return { itemId: e.item.id, decidedBy: 'skip', rules, ruleHit: null, verdict: null, basis: null, confidence: null, certainty: null, cite: null, needs: null, escalated: false, escalationReason: null, escalationChanged: null, model: null, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 };
}

/** A model verdict's certainty: Sure only for a done citing my own line in the ask's conversation, at the skill's bar. */
export function certaintyOf(v: ModelVerdict, t: { sure: number; likely: number }): 'sure' | 'likely' | null {
  if (!v.valid || v.verdict === 'not_done' || v.verdict === 'partial') return null;
  if (v.confidence < t.likely) return null;
  const own = !!v.cite && v.cite.fromMe && v.cite.kind === 'after';
  if (v.verdict === 'done' && own && v.confidence >= t.sure && (v.basis === 'delivered' || v.basis === 'answered')) return 'sure';
  return 'likely';
}

/** Group items by conversation, then into calls of at most `size`. */
export function batchesOf<T extends { pack: ResolutionPack }>(entries: T[], size = DEFAULT_BATCH): T[][] {
  const by = new Map<string, T[]>();
  for (const e of entries) by.set(e.pack.conversationKey, [...(by.get(e.pack.conversationKey) ?? []), e]);
  const out: T[][] = [];
  for (const group of by.values()) for (let i = 0; i < group.length; i += size) out.push(group.slice(i, i + size));
  return out;
}

export async function runLadder(entries: LadderEntry[], o: LadderOptions): Promise<LadderDecision[]> {
  const skill = o.skill;
  const f = skill.frontmatter;
  const cheap = o.cheapModel ?? (typeof f.model === 'string' ? f.model : skill.defaultModels.cheap);
  const strong = o.strongModel ?? (typeof f.strong_model === 'string' ? f.strong_model : skill.defaultModels.strong);
  const thresholds = ladderThresholds(skill);
  const maxCallUsd = o.maxCallUsd ?? fm(f.budget_usd_per_call, 0.03);
  const size = Math.min(o.batchSize ?? fm(f.max_items_per_call, DEFAULT_BATCH), DEFAULT_BATCH);
  const out = new Map<string, LadderDecision>();

  // ---- 1. rules
  const toModel: LadderEntry[] = [];
  for (const e of entries) {
    const rules = evaluateRules(ruleInputOfPack(e.pack, e.raw));
    const d = blank(e, rules);
    const r = rules.decision;
    if (r?.decides === 'done') {
      Object.assign(d, { decidedBy: 'rule', ruleHit: r.rule, verdict: 'done', basis: r.rule === 'D3' ? 'record_fixed' : r.rule === 'D5' ? 'confirmed' : r.rule === 'D2' ? 'answered' : 'delivered', confidence: r.confidence === 'sure' ? 1 : 0.75, certainty: r.confidence, cite: r.cite ? (packLines(e.pack).get(r.cite) ?? null) : null });
      out.set(e.item.id, d);
    } else if (r?.decides === 'skip') {
      Object.assign(d, { decidedBy: 'skip', ruleHit: 'D6' });
      out.set(e.item.id, d);
    } else {
      out.set(e.item.id, d);
      toModel.push(e);
    }
  }

  // ---- 2. the cheap model, batched by conversation
  const call = async (model: string, batch: LadderEntry[], tier: 'cheap' | 'strong', extra: { escalationReason?: LadderDecision['escalationReason'] } = {}) => {
    const { user, aliases } = renderBatchPrompt(batch.map((b) => b.pack), { now: o.now, me: o.me });
    const res = await o.model({ system: skill.body, user, model, effort: tier === 'cheap' ? 'low' : 'medium', maxBudgetUsd: tier === 'cheap' ? maxCallUsd : Math.max(maxCallUsd, 0.1), ...(o.signal ? { signal: o.signal } : {}), tag: batch.map((b) => b.item.id).join(',') });
    const parsed = res.ok ? parseBatchReply(res.text, batch.map((b) => b.pack), aliases) : { verdicts: new Map<string, ModelVerdict>(), error: res.error?.message ?? 'call failed' };
    return { res, parsed, aliases, user, tier, ...extra };
  };
  const share = (d: LadderDecision, res: { costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number }, n: number, model: string) => {
    d.costUsd += res.costUsd / n;
    d.inputTokens += Math.round(res.inputTokens / n);
    d.outputTokens += Math.round(res.outputTokens / n);
    d.cacheReadTokens += Math.round((res.cacheReadTokens ?? 0) / n);
    d.calls += 1;
    d.model = model;
  };

  for (const batch of batchesOf(toModel, size)) {
    if (o.signal?.aborted) break;
    const r = await call(cheap, batch, 'cheap');
    await o.onCall?.({ model: cheap, tier: 'cheap', itemIds: batch.map((b) => b.item.id), system: skill.body, user: r.user, ok: r.res.ok && !r.parsed.error, costUsd: r.res.costUsd, inputTokens: r.res.inputTokens, outputTokens: r.res.outputTokens, cacheReadTokens: r.res.cacheReadTokens ?? 0, cacheWriteTokens: r.res.cacheWriteTokens ?? 0, ...(r.res.error?.errorClass ? { errorClass: r.res.error.errorClass } : {}) });
    for (let i = 0; i < batch.length; i++) {
      const e = batch[i]!;
      const d = out.get(e.item.id)!;
      share(d, r.res, batch.length, cheap);
      const v = r.parsed.verdicts.get(r.aliases[i]!);
      if (!v) {
        d.decidedBy = 'failed';
        d.error = r.parsed.error ?? (r.res.ok ? 'no verdict for the item' : 'call failed');
        continue;
      }
      Object.assign(d, { decidedBy: 'model', verdict: v.verdict, basis: v.basis, confidence: v.confidence, cite: v.cite, needs: v.needs, certainty: certaintyOf(v, thresholds) });
      if (!v.valid) d.certainty = null;

      // ---- 3. the narrow escalation
      const esc = shouldEscalate(v, e.pack.ruleHints, e.item.worth, o.escalationStats, o.strongerModel !== false);
      d.escalationReason = esc.why;
      if (!esc.escalate || o.signal?.aborted) continue;
      const s = await call(strong, [e], 'strong');
      share(d, s.res, 1, strong);
      const sv = s.parsed.verdicts.get('w1');
      const changed = !!sv && sv.valid && sv.verdict !== v.verdict;
      await o.onCall?.({ model: strong, tier: 'strong', itemIds: [e.item.id], system: skill.body, user: s.user, ok: s.res.ok && !!sv, costUsd: s.res.costUsd, inputTokens: s.res.inputTokens, outputTokens: s.res.outputTokens, cacheReadTokens: s.res.cacheReadTokens ?? 0, cacheWriteTokens: s.res.cacheWriteTokens ?? 0, escalationReason: esc.reason!, changed, ...(s.res.error?.errorClass ? { errorClass: s.res.error.errorClass } : {}) });
      d.escalated = true;
      d.escalationChanged = changed;
      if (sv && sv.valid) Object.assign(d, { decidedBy: 'escalation', verdict: sv.verdict, basis: sv.basis, confidence: sv.confidence, cite: sv.cite, needs: sv.needs, certainty: certaintyOf(sv, thresholds) });
    }
  }
  return entries.map((e) => out.get(e.item.id)!);
}
