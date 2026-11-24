/**
 * The attribution engine's API (src/engines/attribution; holistic review 2026-11-20 lane 06 R2-R7):
 *   learned rules        GET /attribution/rules, PATCH /attribution/rules/:id (on / off), POST …/:id/delete
 *   DC suggestions       GET /attribution/dc-suggestions, POST …/:id (accept · edit · reject), POST …/refresh
 *   the opp rundown      GET /attribution/rundown?entryId=… (the likely opps with what I did on each lately)
 *   AEs I cover lookup   POST /attribution/covered-aes/lookup (the app's people, then one read-only Org62 User read)
 * Nothing here sends anything: Accept on a DC suggestion drafts a DC request that rides the next logging canvas (an
 * Outbox item applied by the user, tenet: Nothing leaves without approval).
 */
import { z } from 'zod';
import { Id, IsoDate, IsoDateTime } from './common';

export const AttributionReason = z.object({
  code: z.string(),
  weight: z.number(),
  text: z.string(),
  ruleId: z.string().optional(),
});
export type AttributionReason = z.infer<typeof AttributionReason>;

/**
 * D-103 (c): why a row logs where it does, as one factual sentence computed from facts (never a model):
 * `account_no_open_opp` the account has no open opportunity, so the row logs to the account; `opp_single` the
 * account's only open opportunity; `opp_pick` several could take it and this is the pick (with my hours there this
 * month); `rule` learned from my earlier pick; `internal` no customer.
 */
export const Groundwork = z.object({
  code: z.enum(['account_no_open_opp', 'opp_single', 'opp_pick', 'rule', 'internal']),
  text: z.string(),
});
export type Groundwork = z.infer<typeof Groundwork>;

export const MappingRuleKind = z.enum(['domain', 'channel', 'person', 'keyword', 'series', 'repo']);
export type MappingRuleKind = z.infer<typeof MappingRuleKind>;

/** One learned rule, as Settings ▸ Time ▸ Learned rules lists it. */
export const MappingRuleView = z.object({
  id: Id,
  kind: MappingRuleKind,
  /** The key (a domain, a channel id, an email, a word, a series id, a repo). */
  pattern: z.string(),
  /** The key in words: "#acme-ext", "acme.example", "the word “falcon”", "the series ‘ACME weekly’". */
  label: z.string(),
  target: z.object({ kind: z.enum(['opp', 'account', 'internal']), id: Id.nullable(), name: z.string() }),
  hits: z.number().int().min(0),
  misses: z.number().int().min(0),
  lastUsedAt: IsoDateTime.nullable(),
  enabled: z.boolean(),
  /** Read by the engine now: on, and more agreement than disagreement. */
  active: z.boolean(),
  source: z.enum(['user_correction', 'seed', 'accept']),
});
export type MappingRuleView = z.infer<typeof MappingRuleView>;

export const MappingRulesPayload = z.object({ rules: z.array(MappingRuleView) });
export type MappingRulesPayload = z.infer<typeof MappingRulesPayload>;

export const PatchMappingRuleRequest = z.object({ enabled: z.boolean() });
export type PatchMappingRuleRequest = z.infer<typeof PatchMappingRuleRequest>;

export const DcSuggestionState = z.enum(['new', 'accepted', 'edited', 'rejected', 'closed', 'stale', 'resolved']);
export type DcSuggestionState = z.infer<typeof DcSuggestionState>;

/** One DC the app suggests claiming (src/engines/attribution/dc.ts), with why and the evidence. */
export const DcSuggestion = z.object({
  id: Id,
  oppId: Id,
  oppName: z.string(),
  accountId: Id.nullable(),
  accountName: z.string().nullable(),
  amount: z.number().nullable(),
  stage: z.string().nullable(),
  closeDate: IsoDate.nullable(),
  quarter: z.string(),
  /** One engagement, several opps: the suggestions sharing it. */
  groupKey: z.string(),
  groupSize: z.number().int().min(1),
  /** This opp's share of the group's evidence (whole percents adding to 100 in the group). */
  sharePercent: z.number().int().min(0).max(100),
  /** The default DC split; null: another architect holds a DC on it (agree the split first). */
  splitPercent: z.number().int().min(1).max(100).nullable(),
  /** Pre-ticked in the batch (strong evidence, no split question). Pre-ticked is never claimed: Accept is your click. */
  preTicked: z.boolean(),
  state: DcSuggestionState,
  reasons: z.array(z.object({ code: z.string(), text: z.string() })),
  evidence: z.array(z.object({ label: z.string(), url: z.string().nullable(), at: IsoDateTime })),
  coveredAe: z.string().nullable(),
  dcRequestId: Id.nullable(),
  decidedAt: IsoDateTime.nullable(),
  /**
   * D-103 (b), J-1: who else is on this opp (per opp, never per account). `dcs`: the other Data & AI DCs Org62 shows on
   * it (not mine); `specialists`: the specialists on its team and the owners of its Specialist Forecasts. `via`: how a
   * covered AE reaches it ('sfr': their Specialist Forecast names it, with `viaAe`; 'team': the opp team).
   */
  context: z
    .object({
      dcs: z.array(z.object({ ownerName: z.string(), role: z.string().nullable().optional(), product: z.string().nullable().optional(), split: z.number().nullable().optional() })),
      specialists: z.array(z.object({ name: z.string(), isMe: z.boolean() })),
      via: z.enum(['sfr', 'team']).nullable().default(null),
      viaAe: z.string().nullable().default(null),
    })
    .default({ dcs: [], specialists: [], via: null, viaAe: null }),
});
export type DcSuggestion = z.infer<typeof DcSuggestion>;
export type DcSuggestionContext = DcSuggestion['context'];
export const EMPTY_DC_CONTEXT: DcSuggestionContext = { dcs: [], specialists: [], via: null, viaAe: null };

export const DcSuggestionsPayload = z.object({
  quarter: z.string(),
  /** Waiting for you (state new), groups together, pre-ticked first. */
  suggestions: z.array(DcSuggestion),
  /** Decided this quarter (accepted, edited, rejected), newest first. */
  decided: z.array(DcSuggestion),
  generatedAt: IsoDateTime.nullable(),
  /** The products that count (Settings ▸ Time). */
  dcProducts: z.array(z.string()),
  /** The persona claims DCs (D-55 feature dealContributions). */
  enabled: z.boolean(),
});
export type DcSuggestionsPayload = z.infer<typeof DcSuggestionsPayload>;

export const DecideDcSuggestionRequest = z.object({
  decision: z.enum(['accept', 'edit', 'reject']),
  /** Edit (or Accept with a split question answered): the split to claim. */
  split: z.number().int().min(1).max(100).optional(),
  comment: z.string().trim().min(3).max(1000).optional(),
  role: z.string().trim().min(2).max(80).optional(),
});
export type DecideDcSuggestionRequest = z.infer<typeof DecideDcSuggestionRequest>;

export const DecideDcSuggestionResult = z.object({ suggestion: DcSuggestion, dcRequestId: Id.nullable() });
export type DecideDcSuggestionResult = z.infer<typeof DecideDcSuggestionResult>;

export const RefreshDcSuggestionsResult = z.object({
  /** The db queues the batch for the worker; the mock runs it at once. */
  queued: z.boolean(),
  suggestions: z.number().int().min(0),
  note: z.string().nullable(),
});
export type RefreshDcSuggestionsResult = z.infer<typeof RefreshDcSuggestionsResult>;

export const OppRundownQuery = z.object({ entryId: Id.optional(), accountId: Id.optional() });
export type OppRundownQuery = z.infer<typeof OppRundownQuery>;

export const RundownOpp = z.object({
  oppId: Id,
  name: z.string(),
  accountId: Id.nullable(),
  accountName: z.string().nullable(),
  stage: z.string().nullable(),
  closeDate: IsoDate.nullable(),
  amount: z.number().nullable(),
  isMine: z.boolean(),
  myDc: z.boolean(),
  coveredAe: z.string().nullable(),
  meetings4w: z.number(),
  slack4w: z.number(),
  hours4w: z.number(),
  lastTouchAt: IsoDateTime.nullable(),
  confidence: z.number().min(0).max(1),
  why: z.string().nullable(),
});
export type RundownOpp = z.infer<typeof RundownOpp>;

export const OppRundown = z.object({
  entryId: Id.nullable(),
  /** The engine can't settle it (top under the settle line, or a close second). */
  needsAsk: z.boolean(),
  opps: z.array(RundownOpp),
});
export type OppRundown = z.infer<typeof OppRundown>;

export const CoveredAeLookupRequest = z.object({ q: z.string().trim().min(2).max(80) });
export type CoveredAeLookupRequest = z.infer<typeof CoveredAeLookupRequest>;

export const CoveredAeHit = z.object({
  name: z.string(),
  org62UserId: z.string().nullable(),
  email: z.string().nullable(),
  title: z.string().nullable(),
  /** Where it came from: the app's own people and opp teams, or one read-only Org62 User read. */
  source: z.enum(['app', 'org62']),
});
export type CoveredAeHit = z.infer<typeof CoveredAeHit>;

export const CoveredAeLookupResult = z.object({
  q: z.string(),
  hits: z.array(CoveredAeHit),
  /** An Org62 read ran. */
  live: z.boolean(),
  note: z.string().nullable(),
});
export type CoveredAeLookupResult = z.infer<typeof CoveredAeLookupResult>;
