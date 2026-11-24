/**
 * priority@2 (lane 07 §4, H-8): the engine switch, the shadow preview, the learning loop's Health line and rules.
 *
 * - `settings.priority.engine`: `v1` (priority@1.1 only), `shadow` (the default: v1 is shown and stored; v2 is computed
 *   beside it on every re-rank and recorded in `priority_runs`), `v2` (v2 is shown and stored as `priority@2`).
 * - GET /priority/preview: the v2 ranking for the session's "Preview new ranking" toggle (nothing is persisted).
 * - Health: agreement@3 between the two over the last 7 days, the biggest disagreements, and at most one suggested
 *   rule from `priority_feedback` ("the model keeps ranking X above Y; you keep doing Y first") with one click.
 */
import { z } from 'zod';

import { Id, IsoDateTime, Version } from './common';

export const PriorityEngineSetting = z.enum(['v1', 'shadow', 'v2']);
export type PriorityEngineSetting = z.infer<typeof PriorityEngineSetting>;

export const PrioritySettings = z.object({
  version: Version,
  engine: PriorityEngineSetting.default('shadow'),
});
export type PrioritySettings = z.infer<typeof PrioritySettings>;
export const DEFAULT_PRIORITY_SETTINGS: PrioritySettings = { version: 1, engine: 'shadow' };

/** A stored section in any shape as the contract's (a bad row never breaks the model: defaults). */
export function prioritySettingsOf(v: unknown): PrioritySettings {
  const p = v ? PrioritySettings.safeParse(v) : undefined;
  return p?.success ? p.data : { ...DEFAULT_PRIORITY_SETTINGS };
}

/** Every user move the learning loop reads (one `priority_feedback` row each). */
export const PriorityFeedbackAction = z.enum(['reorder', 'snooze', 'not_today', 'pin', 'do_first']);
export type PriorityFeedbackAction = z.infer<typeof PriorityFeedbackAction>;

export const MakeRoomRow = z.object({
  itemId: Id,
  title: z.string(),
  youMin: z.number().int().min(0),
  /** V (0–100): what it is worth, independent of time. */
  value: z.number(),
  needBy: IsoDateTime.nullable(),
  /** "lowest value · due Fri 17:00". */
  reason: z.string(),
});
export type MakeRoomRow = z.infer<typeof MakeRoomRow>;

/** When today is overbooked: what to move, lowest value × latest deadline first (data; Home's briefing draws the card). */
export const MakeRoom = z.object({
  overByMin: z.number().int().min(0),
  /** "Overbooked by 45 min". */
  label: z.string(),
  rows: z.array(MakeRoomRow).max(5),
  /** Minutes the rows free (≥ overByMin when the list covers it). */
  freesMin: z.number().int().min(0),
});
export type MakeRoom = z.infer<typeof MakeRoom>;

/** The quiet admin batch: one row ("Admin: 4 items · ~25m · next due Fri 16:00"), never individual rows at the top. */
export const AdminBlock = z.object({
  label: z.string(),
  count: z.number().int().min(0),
  itemIds: z.array(Id),
  /** Due within the persona's window (or must start today): the block is today's load. */
  promoted: z.boolean(),
  youMin: z.number().int().min(0),
  /** Where the block goes today: the lowest-value free slot (null when quiet or no room). */
  slot: z.object({ start: IsoDateTime, end: IsoDateTime }).nullable(),
});
export type AdminBlock = z.infer<typeof AdminBlock>;

export const PriorityPreviewRow = z.object({
  workItemId: Id,
  title: z.string(),
  rank: z.number().int().min(1),
  /** The item's rank in what is shown now (priority@1.1); null when v1 does not rank it. */
  v1Rank: z.number().int().min(1).nullable(),
  /** Positive = higher under v2. */
  moved: z.number().int(),
  why: z.object({ matters: z.string().nullable(), now: z.string().nullable() }),
  value: z.number(),
  urgency: z.number(),
  startBy: IsoDateTime.nullable(),
});
export type PriorityPreviewRow = z.infer<typeof PriorityPreviewRow>;

export const PriorityPreview = z.object({
  engineVersion: z.string(),
  baselineVersion: z.string(),
  computedAt: IsoDateTime,
  /** v2's Top N, in order. */
  top3: z.array(Id),
  rows: z.array(PriorityPreviewRow).max(10),
  /** |v1 Top 3 ∩ v2 Top 3| / 3. */
  agreement3: z.number().min(0).max(1),
  capacity: z.object({ fits: z.boolean(), youMinToday: z.number().int().min(0), freeMin: z.number().int().min(0), overByMin: z.number().int(), label: z.string().nullable() }),
  adminBlock: AdminBlock.nullable(),
  makeRoom: MakeRoom.nullable(),
});
export type PriorityPreview = z.infer<typeof PriorityPreview>;

export const PriorityNudgeTarget = z.enum(['who', 'deal', 'kind', 'importance', 'goal', 'urgencyFloor']);
export const PriorityRuleStatus = z.enum(['suggested', 'applied', 'dismissed']);

/** A learning rule (`priority_rules`): a bounded nudge of one persona weight, suggested from your moves. */
export const PriorityRule = z.object({
  id: Id,
  /** "The model keeps ranking bigger deals above the most urgent work; you keep doing the most urgent work first (7 of 9 times)." */
  text: z.string(),
  term: z.enum(['who', 'deal', 'kind', 'importance', 'goal', 'urgency']),
  nudge: z.object({ target: PriorityNudgeTarget, direction: z.union([z.literal(1), z.literal(-1)]) }),
  status: PriorityRuleStatus,
  pairs: z.number().int().min(0),
  createdAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
});
export type PriorityRule = z.infer<typeof PriorityRule>;

export const PriorityDisagreement = z.object({ workItemId: Id, title: z.string(), v1Rank: z.number().int().nullable(), v2Rank: z.number().int().nullable() });
export type PriorityDisagreement = z.infer<typeof PriorityDisagreement>;

/** Health's one priority line. */
export const PriorityHealth = z.object({
  engine: PriorityEngineSetting,
  /** Shadow runs over the window (both rankings recorded). */
  runs: z.number().int().min(0),
  /** Mean agreement@3 v1 vs v2 over the window; null with no shadow runs. */
  agreement3: z.number().min(0).max(1).nullable(),
  disagreements: z.array(PriorityDisagreement).max(3),
  /** "Ranking: priority@2 in shadow · agrees 0.67 on the Top 3 over 7 days (12 runs)". */
  line: z.string(),
  /** At most one suggestion waiting for a click. */
  suggestion: PriorityRule.nullable(),
  appliedRules: z.number().int().min(0),
});
export type PriorityHealth = z.infer<typeof PriorityHealth>;

export const PriorityRuleParams = z.object({ id: Id });
export const DecidePriorityRuleRequest = z.object({ decision: z.enum(['apply', 'dismiss']) });
export type DecidePriorityRuleRequest = z.infer<typeof DecidePriorityRuleRequest>;

export const RerankAllResult = z.object({ users: z.number().int().min(0), enqueued: z.number().int().min(0) });
export type RerankAllResult = z.infer<typeof RerankAllResult>;
