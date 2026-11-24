/**
 * Feedback (D-56): "Report a bug / idea" posts a redacted, diagnosed report to the team's feedback channel when the
 * user clicks Send.
 *
 *   GET  /feedback           the panel's state: the channel (settings, else config/team.json), dry run, post live,
 *                            the server's version and sha, the reporter's first name
 *   POST /feedback/diagnose  one read-only agent (or the deterministic fallback) over the app's errors, jobs,
 *                            connector health, scan runs, the entity's trace, the page payload and the code; the
 *                            user's text is scrubbed before the agent sees it and the report again after
 *   POST /feedback/reports   the edited message → ONE Outbox item (`feedback.post`, status ready) plus its preview
 *                            (exact payload + confirm token). Send is then `POST /drafts/:id/dispatch` with that
 *                            token: dry run applies, and the live post goes only to the configured channel.
 *
 * Reports live in the Outbox item's payload (no table of their own). No real names: every account, person, opp,
 * email, Slack id and Org62 id the app knows becomes a placeholder (CUSTOMER_1, PERSON_2, OPP_3).
 */
import { z } from 'zod';
import { EntityType, Id, Version } from './common';
import { Draft, DraftPreview } from './nba';

export const FeedbackSettings = z.object({
  version: Version,
  /** The team's feedback channel (C… / G…). Empty: from config/team.json, else the panel asks for it. */
  channelId: z.string().regex(/^(|[CG][A-Z0-9]{6,})$/, 'A Slack channel id starts with C or G').default(''),
  /** Display name ("#command-center-feedback"). */
  channelName: z.string().max(80).default(''),
  /** Post on Send (still behind global dry run). Off: Send shows the payload and copies it. */
  postLive: z.boolean().default(true),
});
export type FeedbackSettings = z.infer<typeof FeedbackSettings>;
export const DEFAULT_FEEDBACK_SETTINGS: FeedbackSettings = FeedbackSettings.parse({ version: 1 });

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export const FeedbackKind = z.enum(['bug', 'idea']);
export type FeedbackKind = z.infer<typeof FeedbackKind>;

export const FeedbackConfidence = z.enum(['low', 'medium', 'high']);
export type FeedbackConfidence = z.infer<typeof FeedbackConfidence>;

/** What the panel captured about where the user was. Display only: the server never routes on it. */
export const FeedbackContextInput = z.object({
  /** The page's title ("Time", "Home"). */
  page: z.string().max(120).default(''),
  /** Path and query ("/time?tab=log"). */
  route: z.string().max(400).default(''),
  /** "Looking at": the entity the user had open (src/components/chat/context-store.ts or the panel). */
  lookingAt: z.object({ kind: EntityType, id: Id, label: z.string().max(200).default('') }).nullable().default(null),
  /** The build the browser runs (package.json version, NEXT_PUBLIC_CC_GIT_SHA). */
  version: z.string().max(40).default(''),
  sha: z.string().max(64).nullable().default(null),
  persona: z.string().max(40).nullable().default(null),
  /** Recent client errors (window errors, unhandled rejections, console errors), newest last. */
  clientErrors: z.array(z.string().max(400)).max(10).default([]),
  /** "1440×900". */
  viewport: z.string().max(20).nullable().default(null),
});
export type FeedbackContextInput = z.infer<typeof FeedbackContextInput>;

export const FeedbackReportContext = z.object({
  version: z.string().max(40),
  sha: z.string().max(64).nullable(),
  persona: z.string().max(40).nullable(),
  /** "Time · /time?tab=log" (ids in the route are placeholders). */
  page: z.string().max(400),
  entityKind: EntityType.nullable(),
});
export type FeedbackReportContext = z.infer<typeof FeedbackReportContext>;

export const FeedbackDiagnosis = z.object({
  /** The likely root cause, in plain words ("" when unknown). */
  cause: z.string().max(1200),
  /** Repo-relative files ("src/components/time/TimePage.tsx"). */
  files: z.array(z.string().max(200)).max(8),
  confidence: FeedbackConfidence,
});
export type FeedbackDiagnosis = z.infer<typeof FeedbackDiagnosis>;

export const FeedbackReport = z.object({
  title: z.string().trim().min(1).max(120),
  kind: FeedbackKind,
  summary: z.string().max(2000),
  steps: z.array(z.string().max(300)).max(12),
  expected: z.string().max(800),
  actual: z.string().max(800),
  diagnosis: FeedbackDiagnosis,
  context: FeedbackReportContext,
});
export type FeedbackReport = z.infer<typeof FeedbackReport>;

/** Where Send posts, and whether it would. */
export const FeedbackChannelState = z.object({
  /** Slack channel id ("" when none is configured). */
  id: z.string(),
  /** "#command-center-feedback" ("" when unknown). */
  name: z.string(),
  /** Where the id came from: Settings ▸ Feedback, else config/team.json. */
  source: z.enum(['settings', 'team', 'none']),
  /** Settings ▸ Feedback "Post live". */
  postLive: z.boolean(),
  /** Settings ▸ Sending global dry run. */
  dryRun: z.boolean(),
  /** True when Send would really post (a channel, post live on, dry run off). */
  live: z.boolean(),
});
export type FeedbackChannelState = z.infer<typeof FeedbackChannelState>;

export const FeedbackState = z.object({
  channel: FeedbackChannelState,
  /** The server's build (the panel shows it when the browser has none). */
  version: z.string(),
  sha: z.string().nullable(),
  /** The reporter line: first name only. */
  reporter: z.string(),
  /** The real diagnose agent runs (else the deterministic fallback, no model call). */
  agent: z.boolean(),
  /** The agent's cap per report (USD), on the Assistant's spend line. */
  capUsd: z.number(),
});
export type FeedbackState = z.infer<typeof FeedbackState>;

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

export const DiagnoseFeedbackRequest = z.object({
  kind: FeedbackKind,
  text: z.string().trim().min(3, 'Say what happened in a few words').max(4000),
  context: FeedbackContextInput.default({}),
});
export type DiagnoseFeedbackRequest = z.infer<typeof DiagnoseFeedbackRequest>;

export const DiagnoseFeedbackResult = z.object({
  report: FeedbackReport,
  /** The Slack mrkdwn the user reviews and edits before Send (already scrubbed). */
  message: z.string(),
  /** How many names and ids were swapped for placeholders (input, tool results and output). */
  scrubbed: z.number().int().min(0),
  /** `agent`: the read-only diagnose agent; `fallback`: the deterministic report (no model call). */
  diagnosedBy: z.enum(['agent', 'fallback']),
  model: z.string().nullable(),
  costUsd: z.number().min(0),
  /** Why the fallback ran, or what the agent could not do ("The Assistant's daily limit is used up"). */
  note: z.string().nullable(),
  channel: FeedbackChannelState,
});
export type DiagnoseFeedbackResult = z.infer<typeof DiagnoseFeedbackResult>;

export const StageFeedbackRequest = z.object({
  report: FeedbackReport,
  /** The final message, as the user edited it. Scrubbed again on the server. */
  message: z.string().trim().min(1).max(6000),
  /** A ready feedback item this one replaces (the user went back and edited): it leaves the Outbox, nothing sent. */
  replaces: Id.nullable().default(null),
});
export type StageFeedbackRequest = z.infer<typeof StageFeedbackRequest>;

export const StageFeedbackResult = z.object({
  /** The Outbox item (`feedback.post`, status ready). */
  draft: Draft,
  /** Its preview: the exact payload Send posts, and the confirm token Send passes back. */
  preview: DraftPreview,
  channel: FeedbackChannelState,
  /** Names and ids the second scrub swapped in the edited message. */
  scrubbed: z.number().int().min(0),
});
export type StageFeedbackResult = z.infer<typeof StageFeedbackResult>;
