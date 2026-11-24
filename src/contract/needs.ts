/**
 * Needs you: one mechanism to resolve or set aside every "needs you" row (Deals ▸ Log & fix, Think ahead and
 * Waiting, the account page's need, the account panel, Home ▸ Log & fix). Nothing a rule raises is left stranded in
 * the UI: each row says how it can be set aside (`NeedResolve`), and the choice is stored as a decision per subject.
 *
 *   snooze       hidden until `until` (Snooze 1 week, Not now): the row comes back by itself.
 *   not_needed   hidden with a reason ("Not my deal", "Too small", …) until something material changes, as the rule
 *                says (a DC gap: I join the opp team, or log 2 h more on it; a Home row: a new subject appears).
 *
 * A decision is keyed by (rule, subjectId): one per opp for a DC gap, one per account for Think ahead and Waiting, one
 * per Home row. Every decision is one audited, undoable change set; the Assistant reads them (listNeedDecisions)
 * and stages them (decideNeed, clearNeedDecision) like any other change.
 */
import { z } from 'zod';
import { Confidence, Id, IsoDateTime, Url } from './common';
import { PersonaFeature } from './persona';

/**
 * The rule a decision belongs to: `dc_gap` (subject: the opp), `deals_ahead` and `deals_chase` (subject: the
 * account), `home:<gap rule>` (subject: the Home row id, e.g. `home:missed_dc` / `gap:missed_dc`).
 */
export const NeedRule = z.string().trim().min(2).max(60).regex(/^[a-z_]+(?::[a-z0-9_]+)?$/, 'a rule id: dc_gap, deals_ahead, deals_chase or home:<rule>');
export type NeedRule = z.infer<typeof NeedRule>;

export const NeedDecisionKind = z.enum(['snooze', 'not_needed']);
export type NeedDecisionKind = z.infer<typeof NeedDecisionKind>;

/** What a rule compares against when it decides a dismissed row has changed enough to come back. */
export const NeedBaseline = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
export type NeedBaseline = z.infer<typeof NeedBaseline>;

export const NeedDecision = z.object({
  rule: NeedRule,
  subjectId: Id,
  kind: NeedDecisionKind,
  /** Snooze: when the row comes back. */
  until: IsoDateTime.nullable().default(null),
  /** Not needed: why ("Not my deal", "Already covered by a teammate", "Too small", "Other"). */
  reason: z.string().nullable().default(null),
  /** What the row was about when it was set aside ("ACME – Data 360 Expansion"), for the list and the Assistant. */
  label: z.string().nullable().default(null),
  /** The rule's facts at decision time (a DC gap: on the team, hours this quarter). */
  baseline: NeedBaseline.default({}),
  decidedAt: IsoDateTime,
});
export type NeedDecision = z.infer<typeof NeedDecision>;

export const NeedDecisionsPayload = z.object({ decisions: z.array(NeedDecision) });
export type NeedDecisionsPayload = z.infer<typeof NeedDecisionsPayload>;

/** How a row can be set aside: the rule, its subjects, Snooze and/or Not needed (with the reasons offered). */
export const NeedResolve = z.object({
  rule: NeedRule,
  /** One decision per subject (a DC gap row on an account: one per opp it names). */
  subjectIds: z.array(Id).min(1),
  /** Snooze 1 week (Deals) / Not now (Home). */
  snooze: z.boolean(),
  /** Not needed, with these reasons (empty: not offered; the row is real outstanding work). */
  reasons: z.array(z.string()),
  /** The facts a Not needed is compared against later (sent back with the decision). */
  baseline: NeedBaseline.default({}),
  /** What the subjects are, in words ("CUSTOMER_1 – Renewal"). */
  label: z.string().nullable().default(null),
});
export type NeedResolve = z.infer<typeof NeedResolve>;

export const DecideNeedRequest = z
  .object({
    rule: NeedRule,
    subjectIds: z.array(Id).min(1),
    kind: NeedDecisionKind,
    /** Snooze: ISO instant it comes back (default: a week from now). */
    until: IsoDateTime.optional(),
    /** Not needed: the reason (required). */
    reason: z.string().trim().min(2).max(200).optional(),
    label: z.string().trim().max(200).optional(),
    /** The row's `resolve.baseline` (a DC gap's is read on the server). */
    baseline: NeedBaseline.optional(),
  })
  .refine((b) => b.kind !== 'not_needed' || !!b.reason, { message: 'Not needed takes a reason', path: ['reason'] });
export type DecideNeedRequest = z.infer<typeof DecideNeedRequest>;

/** Bring rows back: drop the decisions on these subjects (Undo does the same for the last decision). */
export const ClearNeedRequest = z.object({ rule: NeedRule, subjectIds: z.array(Id).min(1) });
export type ClearNeedRequest = z.infer<typeof ClearNeedRequest>;

/** The reasons a DC gap's Not needed offers (Deals ▸ Log & fix, the account page, the account panel). */
export const DC_GAP_REASONS = ['Not my deal', 'Already covered by a teammate', 'Too small', 'Other'] as const;
/** The reasons a Think ahead or Waiting row's Not needed offers. */
export const DEALS_ROW_REASONS = ['Already handled', 'Not my deal', 'Other'] as const;
/** The reasons a Home Log & fix row's Not needed offers (rules that can be "not needed": a missed-opp claim, a deal role, a missing forecast). */
export const HOME_GAP_REASONS = ['Not mine', 'Already handled', 'Not needed for this deal', 'Other'] as const;

/** A week from `now` (Snooze 1 week). */
export const SNOOZE_MS = 7 * 24 * 3_600_000;

// ---------------------------------------------------------------------------------------------------------------------
// The Needs-you queue (2026-11-20 review, 01 R1; D-86): GET /needs, one row per fact, composed from the engines
// (src/engines/needs). Every surface that says what waits on you reads it: the sidebar count, Home's Needs-you block,
// the Activity page's needs area and its review mode.
// ---------------------------------------------------------------------------------------------------------------------

/** What kind of fact a row is. Each kind has one provider (src/engines/needs/providers). */
export const NeedKind = z.enum([
  'triage_guess',
  'outbox_draft',
  'time_ready_to_log',
  'vdp_change',
  'dc_suggestion',
  'mapping_question',
  'spend_ask',
  'resolution_confirm',
  'setup_step',
  'use_case_candidate',
  'reopen_review',
]);
export type NeedKind = z.infer<typeof NeedKind>;

/** The kit's verb ids (ActionRow / ReviewQueue): what a row lets you do. */
export const NeedVerbId = z.enum(['accept', 'answer', 'confirm', 'not_done', 'keep', 'close', 'claim', 'edit', 'dismiss', 'reject', 'snooze', 'open', 'review', 'allow', 'allow_today', 'stop', 'seen', 'done']);
export type NeedVerbId = z.infer<typeof NeedVerbId>;

/** What a page groups the queue by. */
export const NeedGroupKey = z.enum(['today', 'this_week', 'deal', 'admin']);
export type NeedGroupKey = z.infer<typeof NeedGroupKey>;

/**
 * The existing routes a verb may run through POST /needs/:id/decide. None of them sends anything (*tenet: Nothing
 * leaves without approval*): approving a draft stays the Outbox's own path, a VDP push or a canvas Apply stays on Activity.
 */
export const NeedDispatchRoute = z.enum(['acceptTriage', 'dismissTriage', 'itemAction', 'markItemSeen', 'rejectDraft', 'decideDcSuggestion', 'answerSpendHold', 'decideNeed', 'decideUseCaseCandidate']);
export type NeedDispatchRoute = z.infer<typeof NeedDispatchRoute>;

export const NeedVerb = z.object({
  id: NeedVerbId,
  /** The button's words ("Accept", "Confirm done", "Allow $0.02 more"). */
  label: z.string(),
  /** The single key on a focused row ("a"). */
  kbd: z.string().max(3).nullable().default(null),
  /** The row's one primary verb (exactly one per row). */
  primary: z.boolean().default(false),
  /** The route and payload the page already calls; null: a navigation (`href`). */
  call: z.object({ route: NeedDispatchRoute, params: z.record(z.string(), z.string()).default({}), body: z.record(z.string(), z.unknown()).default({}) }).nullable().default(null),
  /** Where the verb goes when it is a navigation (Review in the Outbox, Open on Activity). */
  href: z.string().nullable().default(null),
  /** `answer`: the choices offered (a mapping question). */
  choices: z.array(z.object({ id: Id, label: z.string() })).optional(),
  /** The call is audited and Undo reverts it (POST /audit/:id/undo). */
  undoable: z.boolean().default(false),
  /** The persona feature the verb needs (D-55): a row whose primary verb the persona disables is never shown. */
  feature: PersonaFeature.nullable().default(null),
});
export type NeedVerb = z.infer<typeof NeedVerb>;

/** A person, account or opportunity a row is about, when known. */
export const NeedRef = z.object({ id: Id.nullable(), label: z.string(), href: z.string().nullable().default(null) });
export type NeedRef = z.infer<typeof NeedRef>;

export const NeedRow = z.object({
  /** Stable: `kind:sourceId` (the triage item, draft, suggestion, hold … it stands for). */
  id: z.string().regex(/^[a-z_]+:.+$/, 'kind:sourceId'),
  kind: NeedKind,
  title: z.string().min(1),
  /** One line: why it waits on you. */
  why: z.string(),
  who: NeedRef.nullable().default(null),
  account: NeedRef.nullable().default(null),
  opp: NeedRef.nullable().default(null),
  verbs: z.array(NeedVerb).min(1),
  groupKey: NeedGroupKey,
  /** 0–1: priority@2's urgency term when the fact is a work item, else the kind's default. */
  urgency: z.number().min(0).max(1),
  /** When the fact appeared (asked, drafted, suggested). */
  since: IsoDateTime,
  /** The deep link to where it came from (tenet: Provenance on everything). */
  source: z.object({ label: z.string(), url: Url }).nullable().default(null),
  /** Minutes of your time it takes, when known. */
  estimateMin: z.number().int().min(0).nullable().default(null),
  confidence: Confidence.nullable().default(null),
  /** What it is about (`item:<id>`): two providers surfacing the same thing keep one row (`also` names the other kinds). */
  subject: z.string().nullable().default(null),
  also: z.array(NeedKind).default([]),
});
export type NeedRow = z.infer<typeof NeedRow>;

export const NeedsPayload = z.object({
  /** Ordered: urgency, then oldest first. Never capped. */
  rows: z.array(NeedRow),
  /** The one count (the sidebar, Home, Activity): rows.length. */
  total: z.number().int().min(0),
  byKind: z.record(NeedKind, z.number().int().min(0)),
  generatedAt: IsoDateTime,
  /** Kinds whose provider failed this time (they show zero rows; the page still renders). */
  partial: z.array(NeedKind).default([]),
});
export type NeedsPayload = z.infer<typeof NeedsPayload>;

export const NeedRowParams = z.object({ id: z.string().min(3).max(400) });
export type NeedRowParams = z.infer<typeof NeedRowParams>;

export const DecideNeedRowRequest = z.object({
  verb: NeedVerbId,
  /** `answer`: the picked choice. */
  choiceId: Id.optional(),
  /** `dismiss` / `reject`: a reason other than the row's default. */
  reason: z.string().trim().min(2).max(200).optional(),
  /** `snooze`: when it comes back (default: the next working morning). */
  until: IsoDateTime.optional(),
});
export type DecideNeedRowRequest = z.infer<typeof DecideNeedRowRequest>;

export const DecideNeedRowResult = z.object({
  /** The row as it was decided (the client puts it back on Undo). */
  row: NeedRow,
  verb: NeedVerbId,
  /** The existing route that ran. */
  route: NeedDispatchRoute,
  /** Undo reverts it (the auditId is on the envelope). */
  undoable: z.boolean(),
});
export type DecideNeedRowResult = z.infer<typeof DecideNeedRowResult>;
