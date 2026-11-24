/**
 * First-launch onboarding (B-079): six steps a new user goes through on an empty database instead of empty pages.
 *
 *   role → you → priorities → sources → history → review   (Back always works; jumping goes up to the furthest step reached)
 *
 * The role step picks the persona and its level (D-55). It decides the starter priorities (the level's template),
 * which sources are preconfigured (the rest are listed as available and can be activated) and the copy. A draft from
 * before personas has only `you.role` (se_ic / se_manager): it reads as the SE persona at that level.
 *
 * The draft is saved step by step (`POST /onboarding/step`), so a reload resumes where you were. `POST
 * /onboarding/complete` bootstraps the user (the same `bootstrapUser()` that `npm run setup` runs), saves the
 * choices through the Settings writers and records the first-scan request. A user bootstrapped by the CLI counts as
 * onboarded. In mock mode the flow is reachable at /onboarding but never required.
 */
import { z } from 'zod';
import { IsoDateTime } from './common';
import { PersonaId, PersonaLevel } from './persona';
import { PolicyRule, PolicyWeights } from './settings';

export const ONBOARDING_STEPS = ['role', 'you', 'priorities', 'sources', 'history', 'review'] as const;
export const OnboardingStep = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

/** The SE profile role (Settings ▸ Profile). Before personas it was the whole choice (kept: old drafts, profile.json). */
export const RolePack = z.enum(['se_ic', 'se_manager']);
export type RolePack = z.infer<typeof RolePack>;

/** A starter priority policy: a persona level's template (src/personas `priorityTemplate`). */
export const StarterTemplate = z.enum(['se_ic', 'se_manager', 'ae']);
export type StarterTemplate = z.infer<typeof StarterTemplate>;

/**
 * Step 1, the role: the persona and level you picked, plus what you activated on the Sources step. The overrides have
 * the shape of `settings.persona` (a feature or source switched on against the preset) and are written there when you
 * finish. Changing the persona clears them: they were relative to the other preset.
 */
export const OnboardingPersonaDraft = z.object({
  id: PersonaId.optional(),
  level: PersonaLevel.optional(),
  features: z.record(z.string(), z.boolean()).default({}),
  connectors: z.record(z.string(), z.boolean()).default({}),
});
export type OnboardingPersonaDraft = z.infer<typeof OnboardingPersonaDraft>;

/** The role step, checked (the server also checks that the level is one the persona has). */
export const OnboardingRole = z.object({
  id: PersonaId,
  level: PersonaLevel,
  features: z.record(z.string(), z.boolean()),
  connectors: z.record(z.string(), z.boolean()),
});
export type OnboardingRole = z.infer<typeof OnboardingRole>;

/** How far back the first scan reads. 30 is the default (Tristan, B-080). */
export const LOOKBACK_DAYS = [7, 14, 30, 90] as const;
export const LookbackDays = z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(90)]);
export type LookbackDays = z.infer<typeof LookbackDays>;
export const DEFAULT_LOOKBACK_DAYS: LookbackDays = 30;

/**
 * How long a first scan takes, wall time, every source (docs/archive/2026-build/FIRST-SCAN-RAMP.md, one SE's real data on a fresh
 * database): 7 days ≈ 54 min, 14 days ≈ 114 min, 30 days ≈ 4 h. Other lookbacks: about 8 minutes per day of history.
 */
export const FIRST_SCAN_MEASURED_MINUTES: Readonly<Partial<Record<number, number>>> = { 7: 54, 14: 114, 30: 240 };
export const FIRST_SCAN_MINUTES_PER_DAY = 8;
export function firstScanMinutes(days: number): number {
  return FIRST_SCAN_MEASURED_MINUTES[days] ?? Math.max(10, Math.round(days * FIRST_SCAN_MINUTES_PER_DAY));
}

/** "about 4 h", "about 55 min", "a few minutes" (the History step, the review, the banner). */
export function durationText(minutes: number): string {
  if (!(minutes > 0)) return 'a few minutes';
  if (minutes < 8) return 'a few minutes';
  if (minutes < 90) return `about ${Math.round(minutes / 5) * 5} min`;
  const h = Math.round((minutes / 60) * 2) / 2;
  return `about ${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}
/** One-time backfill budget ceiling (B-080's default). */
/**
 * D6 (audit 2026-11-13): $25, was $100. The measured 30-day first scan is $13–23 (src/server/onboarding/cost.ts), so $25
 * covers the recommended choice with room, and a teammate paying for their own usage never starts with a $100 ceiling.
 */
export const DEFAULT_BACKFILL_BUDGET_USD = 25;
export const BACKFILL_BUDGET_RANGE = { min: 5, max: 1000 } as const;

// ---------------------------------------------------------------------------
// Field rules (shared by the server and the form, so both say the same thing)
// ---------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const SLACK_MEMBER_ID = /^[UW][A-Z0-9]{6,}$/;
export const ORG62_USER_ID = /^005[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;

export function isIanaZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz.includes('/') || tz === 'UTC';
  } catch {
    return false;
  }
}

const blankToNull = (v: unknown) => (typeof v === 'string' ? v.trim() || null : (v ?? null));

export const WorkingHours = z.object({ start: z.string(), end: z.string(), days: z.array(z.number().int().min(0).max(6)) });
export type WorkingHours = z.infer<typeof WorkingHours>;

/** Step 1 as the draft keeps it: anything half-typed is fine to keep (it is checked when you move on). */
export const OnboardingYouDraft = z
  .object({
    name: z.string(),
    email: z.string(),
    /** Set from the role step (SE manager → se_manager, else se_ic); a draft from before personas has only this. */
    role: RolePack,
    timezone: z.string(),
    workingHours: WorkingHours,
    slackUserId: z.string(),
    org62UserId: z.string(),
  })
  .partial();
export type OnboardingYouDraft = z.infer<typeof OnboardingYouDraft>;

/** Step 1, checked: what `bootstrapUser()` needs. */
export const OnboardingYou = z.object({
  name: z.string().trim().min(1, 'Enter your name.'),
  email: z.string().trim().toLowerCase().email('Enter your work email, like you@company.com.'),
  role: RolePack.default('se_ic'),
  timezone: z.string().refine(isIanaZone, 'Pick a time zone like America/Denver.'),
  workingHours: z
    .object({
      start: z.string().regex(HHMM, 'Use 24-hour times like 07:30.'),
      end: z.string().regex(HHMM, 'Use 24-hour times like 17:30.'),
      days: z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one working day.'),
    })
    .refine((h) => h.start < h.end, { message: 'Start must be before end.', path: ['end'] }),
  /** Slack member id: the Slack scan searches from:/to: you with it. */
  slackUserId: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(SLACK_MEMBER_ID, 'Slack member IDs start with U or W, like U0123ABCD.')),
  /** Org62 user id (optional): the Org62 scan finds your opportunities and events with it. */
  org62UserId: z.preprocess(blankToNull, z.string().regex(ORG62_USER_ID, 'Org62 user IDs start with 005 and are 15 or 18 characters.').nullable()),
});
export type OnboardingYou = z.infer<typeof OnboardingYou>;

/** Step 1's own fields (the two ids sit on the Sources step, next to their source). */
export const OnboardingYouBasics = OnboardingYou.omit({ slackUserId: true, org62UserId: true });
/** The ids the Sources step asks for (detected when the source is connected, always editable). */
export const OnboardingIds = OnboardingYou.pick({ slackUserId: true, org62UserId: true });

// ---------------------------------------------------------------------------
// Identity detection (Sources step): who you are on Slack and in Org62, read with one read-only lookup each
// ---------------------------------------------------------------------------

export const IdentityKind = z.enum(['slack', 'org62']);
export type IdentityKind = z.infer<typeof IdentityKind>;

/**
 * One lookup's outcome. Only `found` fills the field: `ambiguous` (several candidates, or the Slack email isn't
 * yours), `not_found`, `failed` and `not_connected` leave it empty with the usual hint.
 */
export const IdentityDetection = z.object({
  status: z.enum(['found', 'not_found', 'ambiguous', 'failed', 'not_connected']),
  id: z.string().nullable(),
  name: z.string().nullable(),
  message: z.string(),
  at: IsoDateTime,
  costUsd: z.number().min(0),
  /** Mock mode: placeholder ids, no lookup ran. */
  simulated: z.boolean().default(false),
});
export type IdentityDetection = z.infer<typeof IdentityDetection>;

/** The LLM spend of one lookup, kept with the draft and written to the ledger (`llm_calls`) when you finish. */
export const DetectionSpend = z.object({
  kind: IdentityKind,
  model: z.string(),
  costUsd: z.number().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  status: z.enum(['ok', 'error', 'timeout']),
  errorCode: z.string().nullable(),
  startedAt: IsoDateTime,
  ms: z.number().int().min(0),
});
export type DetectionSpend = z.infer<typeof DetectionSpend>;

/** The priorities step: the role's starter weights and rules, as you left them. `basedOn` is the template they started from. */
export const OnboardingPriorities = z.object({ basedOn: StarterTemplate, weights: PolicyWeights, rules: z.array(PolicyRule) });
export type OnboardingPriorities = z.infer<typeof OnboardingPriorities>;

/** Step 4: how far back the first scan reads, and the one-time budget it may spend doing it. */
export const OnboardingHistory = z.object({
  lookbackDays: LookbackDays,
  budgetUsd: z
    .number({ invalid_type_error: 'Enter an amount in dollars.', required_error: 'Enter an amount in dollars.' })
    .min(BACKFILL_BUDGET_RANGE.min, `At least $${BACKFILL_BUDGET_RANGE.min}.`)
    .max(BACKFILL_BUDGET_RANGE.max, `At most $${BACKFILL_BUDGET_RANGE.max}.`),
});
export type OnboardingHistory = z.infer<typeof OnboardingHistory>;

/** Step 4 as the draft keeps it: an out-of-range or cleared budget is kept (and flagged) rather than refused. */
export const OnboardingHistoryDraft = z.object({ lookbackDays: LookbackDays, budgetUsd: z.number().nullable() }).partial();
export type OnboardingHistoryDraft = z.infer<typeof OnboardingHistoryDraft>;

export const OnboardingDraft = z.object({
  persona: OnboardingPersonaDraft.default({}),
  you: OnboardingYouDraft.default({}),
  priorities: OnboardingPriorities.nullable().default(null),
  history: OnboardingHistoryDraft.default({}),
  /** When you last saw the Sources step. */
  sourcesSeenAt: IsoDateTime.nullable().default(null),
  /** The last lookup per id (Sources step). */
  identities: z.object({ slack: IdentityDetection.optional(), org62: IdentityDetection.optional() }).default({}),
  /** Every lookup's spend so far, written to the ledger when you finish. */
  spend: z.array(DetectionSpend).default([]),
});
export type OnboardingDraft = z.infer<typeof OnboardingDraft>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const OnboardingStatus = z.enum(['not_started', 'in_progress', 'complete']);
export type OnboardingStatus = z.infer<typeof OnboardingStatus>;

/**
 * Why the state is what it is:
 * `no_user` an empty database · `incomplete_user` a user row the bootstrap hasn't finished · `onboarded` finished
 * here · `cli` bootstrapped by `npm run setup` / `npm run db:bootstrap` (never sees the flow) · `mock` mock mode.
 */
export const OnboardingReason = z.enum(['no_user', 'incomplete_user', 'onboarded', 'cli', 'mock']);
export type OnboardingReason = z.infer<typeof OnboardingReason>;

/** A starter policy, exactly what `bootstrapUser()` writes as v1 for that template. */
export const OnboardingRolePack = z.object({ role: StarterTemplate, name: z.string(), weights: PolicyWeights, rules: z.array(PolicyRule) });
export type OnboardingRolePack = z.infer<typeof OnboardingRolePack>;

export const UsdRange = z.object({ lowUsd: z.number().min(0), highUsd: z.number().min(0) });
export type UsdRange = z.infer<typeof UsdRange>;

/** One lookback choice with its estimated one-time cost. `measured` = the stress campaign's number for that lookback. */
export const FirstScanEstimate = UsdRange.extend({
  days: LookbackDays,
  basis: z.enum(['per_day', 'measured']),
  /** About how long it takes, wall time (`firstScanMinutes`). */
  minutes: z.number().int().min(0).default(0),
});
export type FirstScanEstimate = z.infer<typeof FirstScanEstimate>;

export const OnboardingCost = z.object({
  /** Estimated cost of one day of history, every scanner, a busy weekday. */
  perDay: UsdRange,
  /** Where the numbers come from, in one line. */
  basis: z.string(),
  options: z.array(FirstScanEstimate),
  defaultDays: LookbackDays,
  defaultBudgetUsd: z.number(),
  /** Today's daily scanning cap (Settings ▸ Budgets), for "after the first scan" context. */
  dailyHardUsd: z.number().nullable(),
});
export type OnboardingCost = z.infer<typeof OnboardingCost>;

/**
 * The first-scan request. `started`: saved where the worker reads it (`user_settings` key `onboarding`); the worker
 * plans the lookback under the backfill budget when it starts scanning for you (src/worker/first-scan-config.ts).
 * `recorded`: saved only (mock mode, or the worker's env sets its own lookback).
 */
export const FirstScanRequest = z.object({
  lookbackDays: LookbackDays,
  budgetUsd: z.number(),
  requestedAt: IsoDateTime,
  status: z.enum(['recorded', 'started']),
  message: z.string(),
});
export type FirstScanRequest = z.infer<typeof FirstScanRequest>;

export const OnboardingIssue = z.object({ step: OnboardingStep, field: z.string(), message: z.string() });
export type OnboardingIssue = z.infer<typeof OnboardingIssue>;

export const OnboardingState = z.object({
  mode: z.enum(['mock', 'db']),
  /** Every page sends you to /onboarding while this is true. Never true in mock mode. */
  required: z.boolean(),
  status: OnboardingStatus,
  reason: OnboardingReason,
  /** The step to show (where you left off). */
  step: OnboardingStep,
  /** The furthest step reached: Back and the step list go up to here. */
  reached: OnboardingStep,
  draft: OnboardingDraft,
  /** What still blocks each step (empty when the step is fine). */
  issues: z.array(OnboardingIssue),
  /** Fields you can't change here (an existing user's email). */
  locked: z.array(z.enum(['email'])),
  /** Every starter template (SE IC, SE manager, Specialist AE): the role step picks one. */
  rolePacks: z.object({ se_ic: OnboardingRolePack, se_manager: OnboardingRolePack, ae: OnboardingRolePack }),
  cost: OnboardingCost,
  completedAt: IsoDateTime.nullable(),
  firstScan: FirstScanRequest.nullable(),
  updatedAt: IsoDateTime.nullable(),
  /** Id lookups on the Sources step: `live` (read-only lookups), `simulated` (mock placeholders), `off`. */
  detection: z.enum(['live', 'simulated', 'off']).default('off'),
});
export type OnboardingState = z.infer<typeof OnboardingState>;

// ---------------------------------------------------------------------------
// Sources (read-only status; never starts auth)
// ---------------------------------------------------------------------------

export const OnboardingSourceId = z.enum(['slack', 'org62', 'google', 'vdp', 'claude', 'gemini', 'trainings']);
export type OnboardingSourceId = z.infer<typeof OnboardingSourceId>;

/**
 * The scanner connectors (src/scanner `ConnectorId`) each Sources row stands for. A row is in your role's
 * preconfiguration when the persona has any of them active; otherwise it sits under "Available" with an Activate
 * toggle.
 */
export const ONBOARDING_SOURCE_CONNECTORS: Readonly<Record<OnboardingSourceId, readonly string[]>> = {
  slack: ['slack'],
  org62: ['org62'],
  google: ['gmail', 'calendar', 'drive'],
  vdp: ['vdp'],
  claude: ['claude_sessions'],
  gemini: ['gemini_notes'],
  trainings: ['trainings'],
};

export const OnboardingSourceState = z.enum(['ok', 'auth_needed', 'offline', 'unknown']);
export type OnboardingSourceState = z.infer<typeof OnboardingSourceState>;

export const OnboardingSource = z.object({
  id: OnboardingSourceId,
  label: z.string(),
  /** What it reads, in one line. */
  reads: z.string(),
  state: OnboardingSourceState,
  message: z.string(),
  /** The exact command to run yourself, when one is needed. Never contains secrets. */
  command: z.string().nullable(),
  instructions: z.string().nullable(),
  /** Rides on another source's sign-in (Gemini notes and Trainings on Google). */
  via: OnboardingSourceId.nullable(),
});
export type OnboardingSource = z.infer<typeof OnboardingSource>;

export const OnboardingSourcesQuery = z.object({
  /** 1 = check again now instead of the last result (kept for 2 minutes). */
  refresh: z
    .enum(['1', '0', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});
export type OnboardingSourcesQuery = z.infer<typeof OnboardingSourcesQuery>;

export const OnboardingSourcesPayload = z.object({
  checkedAt: IsoDateTime,
  /** Mock mode: states come from the seed's connectors, nothing on this Mac was checked. */
  simulated: z.boolean(),
  sources: z.array(OnboardingSource),
});
export type OnboardingSourcesPayload = z.infer<typeof OnboardingSourcesPayload>;

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

const StepBody = <S extends OnboardingStep, V extends z.ZodTypeAny>(step: S, value: V) =>
  z.object({
    step: z.literal(step),
    value,
    /** The step to show next (Back, Next or a step in the list). Moving forward needs this step to check out. */
    goTo: OnboardingStep.optional(),
    /** Mock only: start over after finishing (development). */
    restart: z.boolean().optional(),
  });

export const SaveOnboardingStepRequest = z.discriminatedUnion('step', [
  StepBody('role', OnboardingPersonaDraft.pick({ id: true, level: true }).partial().default({})),
  StepBody('you', OnboardingYouDraft),
  StepBody('priorities', OnboardingPriorities),
  StepBody(
    'sources',
    z
      .object({
        slackUserId: z.string(),
        org62UserId: z.string(),
        /** The sources you activated outside your role's preconfiguration (persona overrides; replaces the draft's). */
        features: z.record(z.string(), z.boolean()),
        connectors: z.record(z.string(), z.boolean()),
        /** Run these lookups now (only for a connected source); the step does not move. */
        detect: z.array(IdentityKind),
      })
      .partial()
      .default({}),
  ),
  StepBody('history', OnboardingHistoryDraft),
  StepBody('review', z.object({}).default({})),
]);
export type SaveOnboardingStepRequest = z.infer<typeof SaveOnboardingStepRequest>;

export const CompleteOnboardingRequest = z.object({}).default({});

export const OnboardingCompleteResult = z.object({
  state: OnboardingState,
  /** What the bootstrap did (`mock`: the mock store's settings were updated instead). */
  bootstrap: z.enum(['created', 'completed', 'up_to_date', 'mock']),
  /** What it wrote, names only. */
  wrote: z.array(z.string()),
  policyVersion: z.number().int(),
  firstScan: FirstScanRequest,
  /** Where to go next (Home). */
  redirect: z.string(),
});
export type OnboardingCompleteResult = z.infer<typeof OnboardingCompleteResult>;
