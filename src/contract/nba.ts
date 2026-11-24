/**
 * Next best actions, drafts (TipTap documents with per-destination renditions) and the Outbox.
 */
import { z } from 'zod';
import { Confidence, DispatchMode, Id, IsoDateTime, NbaVerb, PersonRef, SourceRef, Url, Version } from './common';

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

export const SlackDestination = z.object({
  kind: z.literal('slack'),
  /** "thread" replies in threadTs; "channel" posts top-level; "dm" to a person. */
  target: z.enum(['thread', 'channel', 'dm']),
  channelId: z.string(),
  channelName: z.string(), // "#acme-ext" or "@Dana Reyes"
  threadTs: z.string().nullable().default(null),
  workspace: z.string().optional(),
});
export type SlackDestination = z.infer<typeof SlackDestination>;

export const EmailAddress = z.object({ name: z.string().optional(), email: z.string() });
export type EmailAddress = z.infer<typeof EmailAddress>;

export const EmailDestination = z.object({
  kind: z.literal('email'),
  target: z.enum(['reply', 'reply_all', 'new', 'forward']),
  to: z.array(EmailAddress).min(1),
  cc: z.array(EmailAddress).default([]),
  subject: z.string(),
  threadId: z.string().nullable().default(null),
  inReplyTo: z.string().nullable().default(null),
});
export type EmailDestination = z.infer<typeof EmailDestination>;

/**
 * Structured (non-message) Outbox actions, one generic destination kind for all of them. The prefix names the
 * channel and its adapter: `vdp.*` → the VDP MCP (approved 2026-11-10); `feedback.post` → one Slack post to the team's
 * feedback channel (D-56, src/outbox/adapters/feedback.ts); `release.*` → the two items a release stages (D-90,
 * src/outbox/adapters/release-handoff.ts): `release.announce` one Slack post to the team's announcement channel, and
 * `release.drive_upload` a hand-off with no tool call at all (the app's Drive access is read-only). Add an action here
 * and TypeScript lists every map that needs its family (src/lib/actions.ts, src/outbox/settings.ts, the db draft store).
 */
export const OutboxAction = z.enum([
  'vdp.update_use_case',
  'vdp.create_use_case',
  'vdp.update_vdp_header',
  // D-59: a new VDP, and (once VDP's server lists them) a company, an asset, the AE/TA owners, a use case's Generate
  'vdp.create_vdp',
  'vdp.create_company',
  'vdp.add_vdp_asset',
  'vdp.set_vdp_owners',
  'vdp.generate_use_case',
  'slack_canvas.create',
  'feedback.post',
  // D-90 (W12-7): what `npm run release -- --publish` stages, approved in the Outbox like any other item
  'release.announce',
  'release.drive_upload',
]);
export type OutboxAction = z.infer<typeof OutboxAction>;

/** One line of an action's preview: a field and its value before → after (null = empty). */
export const ActionChange = z.object({
  label: z.string(),
  before: z.union([z.string(), z.number()]).nullable().default(null),
  after: z.union([z.string(), z.number()]).nullable().default(null),
});
export type ActionChange = z.infer<typeof ActionChange>;

/**
 * A structured action item: read-only once drafted (no composer editing). `input` is the draft body, stored in
 * `drafts.payload`; the action's adapter turns it into its one tool call. `changes` and `text` are the preview.
 */
export const ActionDestination = z.object({
  kind: z.literal('action'),
  action: OutboxAction,
  /** Where it lands ("<company> FY27 Q4 · <use case>"), with a deep link when there is one. */
  target: z.object({ label: z.string(), url: z.string().nullable().default(null) }),
  /** The structured request (per action family; VDP: `VdpActionInput` in ./vdp). */
  input: z.record(z.string(), z.unknown()),
  changes: z.array(ActionChange).default([]),
  /** An optional long text block shown under the changes (a canvas body). */
  text: z.string().nullable().default(null),
});
export type ActionDestination = z.infer<typeof ActionDestination>;

export const Destination = z.discriminatedUnion('kind', [SlackDestination, EmailDestination, ActionDestination]);
export type Destination = z.infer<typeof Destination>;

/**
 * The editor capability profile a destination implies (UI-SPEC §7). Same names as the DB `rendition_format`
 * enum. The compose lib's profile `plain` is `plain_text` here (src/lib/compose/profiles.ts maps them).
 * CONTRACT-1 added `slack_blocks` and `plain_text`.
 */
export const RenditionFormat = z.enum(['slack_mrkdwn', 'slack_blocks', 'email_html', 'plain_text']);
export type RenditionFormat = z.infer<typeof RenditionFormat>;

// ---------------------------------------------------------------------------
// TipTap JSON document
// ---------------------------------------------------------------------------

export interface TipTapMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  marks?: TipTapMark[];
  text?: string;
}
export const TipTapMarkSchema: z.ZodType<TipTapMark> = z.object({
  type: z.string(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});
export const TipTapNodeSchema: z.ZodType<TipTapNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(TipTapNodeSchema).optional(),
    marks: z.array(TipTapMarkSchema).optional(),
    text: z.string().optional(),
  }),
);
/** A TipTap/ProseMirror JSON document: `{type:"doc", content:[…]}`. Mentions use node type "mention" with attrs {id,label,kind}. */
export const TipTapDoc = z.object({
  type: z.literal('doc'),
  content: z.array(TipTapNodeSchema).default([]),
});
export type TipTapDoc = z.infer<typeof TipTapDoc>;

// ---------------------------------------------------------------------------
// Draft
// ---------------------------------------------------------------------------

export const DraftStatus = z.enum([
  'drafting',
  'ready', // pending approval in Outbox
  'scheduled',
  'sending',
  'sent',
  'staged', // destination-side draft created (Draft mode)
  'verified',
  'verify_failed',
  'failed',
  'rejected',
  'discarded',
]);
export type DraftStatus = z.infer<typeof DraftStatus>;

export const ThreadMessage = z.object({
  id: Id,
  author: PersonRef,
  at: IsoDateTime,
  text: z.string(),
  isMe: z.boolean().default(false),
});
export type ThreadMessage = z.infer<typeof ThreadMessage>;

export const Rendition = z.object({
  format: RenditionFormat,
  /** Exact serialized body that would be sent (mrkdwn text or email HTML). */
  body: z.string(),
  /** Plain-text fallback (email) or the same text (Slack). */
  text: z.string(),
  /** Formatting the channel cannot render, dropped or converted (lossy-conversion list). */
  lossy: z.array(z.string()).default([]),
});
export type Rendition = z.infer<typeof Rendition>;

export const DispatchAttempt = z.object({
  id: Id,
  at: IsoDateTime,
  mode: DispatchMode,
  dryRun: z.boolean(),
  outcome: z.enum(['rendered', 'staged', 'sent', 'failed', 'unconfirmed']),
  detail: z.string().optional(),
});
export type DispatchAttempt = z.infer<typeof DispatchAttempt>;

export const Verification = z.object({
  state: z.enum(['pending', 'verified', 'unverified', 'failed']),
  at: IsoDateTime.nullable(),
  detail: z.string(), // "Verified in Slack ✓" / "Read-back: not found"
});
export type Verification = z.infer<typeof Verification>;

export const Draft = z.object({
  id: Id,
  version: Version,
  workItemId: Id.nullable(),
  nbaId: Id.nullable(),
  destination: Destination,
  mode: DispatchMode,
  doc: TipTapDoc,
  /** Plain text of the doc (search, first-line previews). */
  plainText: z.string(),
  /** Renditions at the current version, keyed by format (Slack drafts always carry `slack_mrkdwn`). */
  rendered: z.object({
    slack_mrkdwn: Rendition.optional(),
    /** CONTRACT-1: present when the compose profile picks rich_text blocks (lists, code). */
    slack_blocks: Rendition.optional(),
    email_html: Rendition.optional(),
    plain_text: Rendition.optional(),
  }),
  /** Set once the user edits; engines then propose instead of overwrite (R-UI-20). */
  userTouched: z.boolean(),
  userLockedFields: z.array(z.enum(['doc', 'destination', 'mode'])).default([]),
  status: DraftStatus,
  threadContext: z.array(ThreadMessage).default([]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  savedAt: IsoDateTime.nullable().default(null),
  scheduledFor: IsoDateTime.nullable().default(null),
  attempts: z.array(DispatchAttempt).default([]),
  verification: Verification.nullable().default(null),
  rejectedReason: z.string().nullable().default(null),
  /**
   * Where the result lives once it was applied or sent: the canvas, the posted message's permalink, the VDP record
   * (the adapter's link, else one built from what the app knows). Null before that, or when there is no link.
   */
  resultUrl: Url.nullable().default(null),
  /**
   * D-60: `autopilot` when VDP autopilot approved it to leave (under the autonomy policy you turned on): Outbox ▸ Sent
   * shows "Applied automatically". Absent for everything you approved yourself (`user` is reserved).
   */
  appliedBy: z.enum(['user', 'autopilot']).nullable().optional(),
  /**
   * D-63: the id the destination gave what this created (a VDP company, VDP or use case; a message ts), once delivered.
   * A chained VDP push passes it to the items under it. Absent before delivery or when the tool returned none.
   */
  externalId: z.string().nullable().optional(),
});
export type Draft = z.infer<typeof Draft>;

// ---------------------------------------------------------------------------
// NBA card
// ---------------------------------------------------------------------------

export const NbaAlternative = z.object({
  verb: NbaVerb,
  label: z.string(), // "Reply", "Nudge AE", "Wait"
  reason: z.string(),
});
export type NbaAlternative = z.infer<typeof NbaAlternative>;

/** The 24 h update strip on a card (UI-SPEC §5.1). */
export const NbaUpdate = z.object({
  at: IsoDateTime,
  reason: z.string(), // "Dana added 'include pricing'"
  /** revised: untouched draft was updated in place · proposal: draft is user-touched, so a Proposal awaits Apply/Keep mine. */
  kind: z.enum(['revised', 'proposal']),
  proposalId: Id.nullable().default(null),
  diffSummary: z.string().nullable().default(null),
  source: SourceRef.nullable().default(null),
});
export type NbaUpdate = z.infer<typeof NbaUpdate>;

export const NbaVersionEntry = z.object({
  version: Version,
  at: IsoDateTime,
  reason: z.string(),
  diffSummary: z.string().nullable().default(null),
});
export type NbaVersionEntry = z.infer<typeof NbaVersionEntry>;

export const NbaStatus = z.enum(['generating', 'ready', 'needs_input', 'stale', 'accepted', 'executing', 'completed', 'dismissed', 'failed']);
export type NbaStatus = z.infer<typeof NbaStatus>;

export const ClaudeLaunch = z.object({
  /** claude://code/new?folder=<abs>&q=<prompt ≤14336 chars, carries [cc:<work_item_id>]> */
  url: Url,
  folder: z.string(),
  promptPreview: z.string(),
});
export type ClaudeLaunch = z.infer<typeof ClaudeLaunch>;

export const NbaCard = z.object({
  id: Id,
  workItemId: Id,
  version: Version,
  verb: NbaVerb,
  /** Button text for the ONE primary action ("Send", "Start in Claude", "Run Talk Track"). */
  primaryLabel: z.string(),
  confidence: Confidence,
  title: z.string(), // verb-first, e.g. "Reply to Dana: confirm Thursday demo scope"
  why: z.string(),
  whyDetail: z.string().nullable().default(null),
  sources: z.array(SourceRef),
  status: NbaStatus,
  draftId: Id.nullable().default(null),
  /** Up to three alternatives replace the single primary when confidence is low (Guess). Kept at 3: the card design shows three expanded (two collapsed) and the engine's prompt asks for 1-3 (brief 08 §2.3). */
  alternatives: z.array(NbaAlternative).max(3).default([]),
  toolAdapterId: Id.nullable().default(null),
  toolInputs: z.record(z.string(), z.unknown()).nullable().default(null),
  claudeLaunch: ClaudeLaunch.nullable().default(null),
  /** For verb `answer`: the agent run waiting on the user. */
  runId: Id.nullable().default(null),
  update: NbaUpdate.nullable().default(null),
  versions: z.array(NbaVersionEntry).default([]),
  generatedAt: IsoDateTime,
  model: z.string().nullable().default(null),
});
export type NbaCard = z.infer<typeof NbaCard>;

// ---------------------------------------------------------------------------
// Preview / dispatch results
// ---------------------------------------------------------------------------

export const DraftPreview = z.object({
  draftId: Id,
  version: Version,
  destination: Destination,
  mode: DispatchMode,
  rendition: Rendition,
  /** The exact request payload that would be sent ("View payload" shows these bytes). */
  payload: z.record(z.string(), z.unknown()),
  /** Pass back to dispatch; binds the confirm to this exact version + mode. */
  confirmToken: z.string(),
  dryRun: z.boolean(),
  /**
   * CONTRACT-1: "Preview as recipient" HTML, rendered by src/lib/compose `renderPreview` from this same
   * payload (allowlist-sanitized). Still DOMPurify it before injecting.
   */
  html: z.string().optional(),
});
export type DraftPreview = z.infer<typeof DraftPreview>;

export const DispatchResult = z.object({
  draft: Draft,
  dryRun: z.boolean(),
  /** What was (or in dry-run, would have been) sent. Nothing leaves the machine in mock mode, ever. */
  payload: z.record(z.string(), z.unknown()),
  rendition: Rendition,
  attempt: DispatchAttempt,
  auditId: Id,
});
export type DispatchResult = z.infer<typeof DispatchResult>;

// ---------------------------------------------------------------------------
// The message a draft replies to (GET /drafts/:id/source)
// ---------------------------------------------------------------------------

/**
 * How much of a source message the app still has: `full` (the stored, redacted body), `purged` (the body was cleared
 * after the 90-day retention; `text` falls back to the evidence line), `none` (no body was ever stored).
 */
export const SourceBodyState = z.enum(['full', 'purged', 'none']);
export type SourceBodyState = z.infer<typeof SourceBodyState>;

export const SourceMessage = z.object({
  id: Id,
  /** Display name ("Dana Reyes"); null when the source did not say. */
  author: z.string().nullable(),
  isMe: z.boolean(),
  at: IsoDateTime,
  /**
   * Rich text rendered from the body's format (Slack mrkdwn: bold, italics, links, mentions by name, code, lists;
   * email HTML: allowlist-sanitized), by src/lib/compose `renderSourceBody`. Still DOMPurify it before injecting.
   */
  html: z.string(),
  /** The same as plain text (mentions by name, links as "text (url)"). */
  text: z.string(),
  body: SourceBodyState,
  /** The message's own permalink, when known. */
  url: Url.nullable(),
  /** Email only: the subject, sender and recipients as the message carried them. */
  subject: z.string().nullable().default(null),
  from: z.string().nullable().default(null),
  to: z.string().nullable().default(null),
});
export type SourceMessage = z.infer<typeof SourceMessage>;

export const DraftSource = z.object({
  draftId: Id,
  /** Where the original lives (`slack` or `gmail`); null for a structured action (nothing is replied to). */
  kind: z.enum(['slack', 'gmail']).nullable(),
  /**
   * `reply`: the draft answers this thread (a Slack thread or DM, an email reply) and `message` is the one it answers.
   * `source`: a new message (a channel post, a new email); `message` is the work item's origin, the reason it exists.
   */
  relation: z.enum(['reply', 'source']),
  /** "#acme-ext" · "@Priya Shah" · the email subject. */
  where: z.string(),
  /** "Open in Slack" / "Open in Gmail": the message's permalink, else the thread's. */
  url: Url.nullable(),
  /** The message being replied to: the latest one from someone else in the thread (else the latest). */
  message: SourceMessage.nullable(),
  /** Up to 5 messages before it in the thread, oldest first. */
  earlier: z.array(SourceMessage).max(5),
  /** How many messages before it the app knows of in all (`earlier` holds the last 5). */
  earlierTotal: z.number().int().min(0),
});
export type DraftSource = z.infer<typeof DraftSource>;

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export const OutboxGroup = z.enum(['pending_approval', 'scheduled', 'sent', 'failed']);
export type OutboxGroup = z.infer<typeof OutboxGroup>;

export const OutboxItem = z.object({
  draft: Draft,
  group: OutboxGroup,
  workItem: z.object({ id: Id, title: z.string() }).nullable(),
  /** First lines rendered from the payload (pending rows use the dashed style). */
  previewText: z.string(),
  history: z.array(z.object({ at: IsoDateTime, label: z.string() })),
  /**
   * The message this draft answers, as a deep link: the row's "Open in Slack" / "Open in Gmail" (tenet: Provenance on
   * everything). Null for an admin item or when nothing links back. The full message: GET /drafts/:id/source.
   */
  source: SourceRef.nullable().default(null),
});
export type OutboxItem = z.infer<typeof OutboxItem>;

/**
 * Where on Time an admin item is reviewed and applied (D-52): `log` a logging canvas (Week), `forecast` a Specialist
 * Forecast canvas (Forecast), `vdp` a VDP change (VDP). Null: not an admin item. Messages and the feedback post (D-56,
 * one Slack message to the team channel) stay in the Outbox's own list.
 */
export type AdminSurface = 'log' | 'forecast' | 'vdp';

/** `input.forecast.kind` of a forecast canvas (src/engines/forecast/canvas.ts FORECAST_CANVAS_KIND). */
const FORECAST_KIND = 'specialist_forecast';

export function adminSurfaceOf(d: Pick<Draft, 'destination'>): AdminSurface | null {
  const dest = d.destination;
  if (dest.kind !== 'action') return null;
  if (dest.action.startsWith('vdp.')) return 'vdp';
  if (dest.action === 'slack_canvas.create') return (dest.input as { forecast?: { kind?: unknown } }).forecast?.kind === FORECAST_KIND ? 'forecast' : 'log';
  return null;
}

/**
 * Admin items (D-52, D-75): structured app actions, a logging or forecast canvas or a VDP change, as opposed to
 * messages. They go through the same delivery engine and approval gate (preview, confirm, dry run, audit; *tenet:
 * Nothing leaves without approval*), but they are Activity's alone: you review, Apply and follow them on Activity (Log
 * it, Forecast, VDP). The Outbox page lists messages and the feedback post only, never an admin item, applied or not.
 */
export const isAdminDraft = (d: Pick<Draft, 'destination'>): boolean => adminSurfaceOf(d) !== null;

/** Where an admin item is applied: its Time view with the draft panel open (`?draft=`). */
export function adminDraftHref(d: Pick<Draft, 'id' | 'destination'>): string {
  return adminHrefFor(d.id, adminSurfaceOf(d) ?? 'log');
}

/** The same, from an id: `vdp` (or true) = a VDP change (Time ▸ VDP), `forecast` = Time ▸ Forecast, else a logging canvas (Time ▸ Week). */
export function adminHrefFor(id: string, surface: AdminSurface | boolean): string {
  const view = surface === true || surface === 'vdp' ? 'vdp' : surface === 'forecast' ? 'forecast' : 'week';
  return `/activity?view=${view}&draft=${encodeURIComponent(id)}`;
}

export const OutboxPayload = z.object({
  /** Messages (Slack, email) and the feedback post, in every group. Never an admin item (canvases, VDP changes; D-75). */
  groups: z.array(z.object({ group: OutboxGroup, label: z.string(), items: z.array(OutboxItem) })),
  counts: z.record(OutboxGroup, z.number().int()),
  dryRun: z.boolean(),
  /**
   * Admin items (D-75), read by Activity and the assistant, never shown on the Outbox page: `items` still to act on
   * (pending approval or failed), `applied` the latest 50 applied (their status and the link to the result), newest first.
   */
  admin: z
    .object({ items: z.array(OutboxItem), pending: z.number().int(), failed: z.number().int(), applied: z.array(OutboxItem).default([]) })
    .default({ items: [], pending: 0, failed: 0, applied: [] }),
});
export type OutboxPayload = z.infer<typeof OutboxPayload>;

// ---------------------------------------------------------------------------
// Release drafts (D-90, W12-7): POST /outbox/releases
// ---------------------------------------------------------------------------

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 is 64 lowercase hex characters');
const AbsPath = z.string().min(1).max(1024);

/**
 * What `npm run release -- <bump> --publish` (scripts/release/publish.ts) or `npm run release:outbox` hands the running
 * app: one built release. The server turns it into the two Outbox items (`release.drive_upload`, `release.announce`),
 * resolving the Drive folder and the announcement channel from the `distribution` settings key / config/team.json itself (the
 * request's own `folderId` / `announceChannel` are used only when the server has none). Idempotent per version.
 */
export const StageReleaseRequest = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'a semver version (1.4.0, 2.0.0-beta.1)'),
  channel: z.enum(['stable', 'beta']).default('stable'),
  artifactName: z.string().min(1).max(200),
  artifactPath: AbsPath,
  feedPath: AbsPath,
  installShPath: AbsPath,
  sha256: Sha256,
  bytes: z.number().int().min(0),
  /** The version's CHANGELOG section (markdown). */
  notes: z.string().max(20_000).default(''),
  folderId: z.string().max(200).default(''),
  announceChannel: z.string().max(40).default(''),
  announceChannelName: z.string().max(120).default(''),
});
export type StageReleaseRequest = z.infer<typeof StageReleaseRequest>;

export const StageReleaseResult = z.object({
  version: z.string(),
  /** The hand-off item, then the announcement (the order you apply them). */
  drafts: z.array(Draft).length(2),
  /**
   * Per item: `created` (new) · `updated` (a pending item of this version, rewritten in place) · `unchanged` (pending and
   * already exactly this) · `kept` (already applied or handed off: left as it is, never a second item).
   */
  outcomes: z.array(z.enum(['created', 'updated', 'unchanged', 'kept'])).length(2),
  /** The app's dry run (Settings ▸ Sending; on by default): Approve then only renders the announcement's payload. */
  dryRun: z.boolean(),
});
export type StageReleaseResult = z.infer<typeof StageReleaseResult>;
