/**
 * The engine switch, the shadow preview and the feedback snapshot (lane 07 R8), pure: both DataSources (db/priority.ts
 * for the I/O, mock/priority.ts in memory) call these over the same inputs builder, so mock and db agree.
 *
 * `settings.priority.engine`: `v1` shows and stores priority@1.1; `shadow` (the default) shows priority@1.1 and ranks
 * priority@2 beside it; `v2` shows and stores priority@2.
 */
import { prioritySettingsOf, type PriorityEngineSetting, type PriorityPreview } from '@/contract';
import { rankWork } from '../rank';
import { PRIORITY_ENGINE_VERSION, type PriorityInputs, type RankingResult } from '../types';
import { overbookedLabel } from './capacity';
import { agreementAt3 } from './compare';
import type { PriorityNudge } from './config';
import type { FeedbackSnapshot, TermVector } from './feedback';
import { PRIORITY_ENGINE_VERSION_V2, rankWorkV2 } from './rank';

/** Where accepted learning nudges live (the user's kv; the read model holds it, and Undo reverts it). */
export const NUDGES_KEY = 'cc.priority.nudges';

/** The engine a settings object asks for (absent or malformed: shadow). */
export function engineOf(settings: { priority?: unknown }): PriorityEngineSetting {
  return prioritySettingsOf(settings.priority).engine;
}

/** Accepted learning nudges from a kv map. */
export function nudgesOf(kv: ReadonlyMap<string, unknown> | undefined): PriorityNudge[] {
  const v = kv?.get(NUDGES_KEY);
  return Array.isArray(v) ? (v as PriorityNudge[]).filter((n) => n && typeof n.target === 'string' && (n.direction === 1 || n.direction === -1)) : [];
}

/** Rank with the engine the setting shows (v2 only when switched on; shadow and v1 show priority@1.1). */
export function rankShown(engine: PriorityEngineSetting, inputs: PriorityInputs): RankingResult {
  return engine === 'v2' ? rankWorkV2(inputs) : rankWork(inputs);
}

export const shownEngineVersion = (engine: PriorityEngineSetting): string => (engine === 'v2' ? PRIORITY_ENGINE_VERSION_V2 : PRIORITY_ENGINE_VERSION);

/** Today's "Preview new ranking": priority@2 over the inputs, with each row's priority@1.1 rank. Nothing is written. */
export function previewOf(inputs: PriorityInputs, titleOf: (id: string) => string): PriorityPreview {
  const v1 = rankWork(inputs);
  const v2 = rankWorkV2(inputs);
  const v1Rank = new Map(v1.ranked.map((s, i) => [s.workItemId, i + 1]));
  const rows = v2.ranked.slice(0, 10).map((s, i) => {
    const before = v1Rank.get(s.workItemId) ?? null;
    return {
      workItemId: s.workItemId,
      title: titleOf(s.workItemId) || s.title,
      rank: i + 1,
      v1Rank: before,
      moved: before === null ? 0 : before - (i + 1),
      why: s.why,
      value: s.v2?.value ?? 0,
      urgency: s.v2?.urgency ?? 0,
      startBy: s.v2?.startBy ?? s.startBy,
    };
  });
  const over = v2.capacity.youMinToday - v2.capacity.freeMin;
  return {
    engineVersion: v2.engineVersion,
    baselineVersion: v1.engineVersion,
    computedAt: inputs.now,
    top3: v2.top3,
    rows,
    agreement3: agreementAt3(v1.top3, v2.top3),
    capacity: { fits: v2.capacity.fits, youMinToday: v2.capacity.youMinToday, freeMin: v2.capacity.freeMin, overByMin: over, label: v2.capacity.fits ? null : overbookedLabel(over) },
    adminBlock: v2.adminBatch ? { label: v2.adminBatch.label, count: v2.adminBatch.count, itemIds: v2.adminBatch.itemIds, promoted: v2.adminBatch.promoted, youMin: v2.adminBatch.youMin, slot: v2.adminBatch.slot } : null,
    makeRoom: v2.makeRoom ?? null,
  };
}

/** The terms snapshot for one item and up to five neighbours above and below it (ids and numbers only). */
export function feedbackSnapshot(itemId: string, r: RankingResult): FeedbackSnapshot {
  const order = r.ranked.map((s) => s.workItemId);
  const termsOf = (id: string): TermVector => {
    const s = r.scores[id];
    return s?.v2 ? { ...s.v2.terms } : {};
  };
  const i = order.indexOf(itemId);
  const rank = i < 0 ? null : i + 1;
  const near = i < 0 ? order.slice(0, 5) : [...order.slice(Math.max(0, i - 5), i), ...order.slice(i + 1, i + 6)];
  return { item: { id: itemId, rank, terms: termsOf(itemId) }, neighbours: near.map((id) => ({ id, rank: order.indexOf(id) + 1, terms: termsOf(id) })) };
}
