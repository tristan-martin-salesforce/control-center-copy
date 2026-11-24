/**
 * VDP coverage (the gap check over the read-only VDP mirror) and VDP update items for the Outbox.
 *
 * A gap says what is missing and how it gets fixed: `app` = a VDP MCP write the user approves (a header field, a use
 * case, a new VDP), `handoff` = something VDP can't take over MCP yet: a deep link plus copy-ready text (*tenet: Every
 * handoff is one click away*). Gaps roll up into open items (`VdpStep`): one row per thing to do, each saying who does
 * it ("the app can fix", one Apply; or "you, in VDP"), and one status per VDP (Done, N open, Waiting for VDP to
 * refresh, Past), computed once on the server (src/engines/vdp/status.ts) for every surface (D-59).
 */
import { z } from 'zod';

import { Id, IsoDateTime, Url } from './common';
import {
  VdpHandoff, VdpApply, VdpGap, VdpStep, VdpStatus, VdpRowSummary, VdpAutopilotState, DEFAULT_VDP_AUTOPILOT_STATE,
  VdpIdentityPick, VdpCompanyIdentity,
} from './vdp.coverage';
export {
  VdpGapCode, VdpWriteOp, VdpValue, VdpAppFix, VdpInAppFix, VdpHandoff, VdpGap, VdpStepKind, VdpSection,
  VdpStepPolicy, VdpSuggestion, VdpStepAutopilot, VdpStepState, VdpApplyField, VdpApply, VdpStep, VdpStatusState,
  VdpStatus, VdpRowPeople, VdpRowSummary, VdpAutopilotEntry, VdpAutopilotState, VdpAssetItem,
  DEFAULT_VDP_AUTOPILOT_STATE, VdpCoverageRow, VdpNotInVdpRow, VdpTreeLeaf, VdpTreeItem, VdpTreeSection, VdpTreeVdp,
  VdpIdentityPick, VdpIdentityAlternative, VdpCompanyIdentity, VdpTreeCompany, VdpPushNode, VdpPushStage, VdpPushRun,
  VdpCoveragePayload, DraftVdpUpdateRequest, VdpFieldChange, VdpActionInput, PushVdpChangesRequest,
  PushVdpChangesResult, DraftVdpUpdateResult,
} from './vdp.coverage';

// ---------------------------------------------------------------------------
// VDP details (Time ▸ VDP ▸ one VDP or one account not in VDP yet): steps, assets to add, what VDP already has
// ---------------------------------------------------------------------------

/**
 * The key of one VDP details view: a VDP's slug, or `account:<accountId>` for an engaged account with no VDP yet.
 * It is also the panel entity id (kind `vdp`) and what the Assistant passes to `chat_read vdp_detail`.
 */
export const vdpKeyOfAccount = (accountId: string) => `account:${accountId}`;
export const accountOfVdpKey = (key: string): string | null => (key.startsWith('account:') ? key.slice(8) || null : null);
/** Time ▸ VDP with this VDP's details open (the docked panel restores from the URL). */
export const vdpHrefFor = (key: string) => `/activity?view=vdp&panel=details&kind=vdp&item=${encodeURIComponent(key)}`;

/**
 * One open item as a panel / chat ref (D-60): the VDP's details key, `#`, the item's id (`acme-fy27-q4#use_case_fields:<uc>`).
 * It opens the same `vdp` panel focused on that item, and the Assistant reads it with `vdp_detail` (the key before `#`).
 */
export const vdpItemRef = (key: string, stepId: string) => `${key}#${stepId}`;
export function parseVdpRef(id: string): { key: string; stepId: string | null } {
  const i = id.indexOf('#');
  return i < 0 ? { key: id, stepId: null } : { key: id.slice(0, i), stepId: id.slice(i + 1) || null };
}

/** What kind of link an asset is (VDP's asset types are labels: Deck, Doc, Canvas…; the copy text maps these). */
export const VdpAssetKind = z.enum(['deck', 'doc', 'sheet', 'pdf', 'recording', 'demo', 'canvas', 'link']);
export type VdpAssetKind = z.infer<typeof VdpAssetKind>;

/**
 * unsure     the matcher thinks it belongs here but is not sure: waits for your confirm
 * suggested  a step: add it in VDP (link + copy text), then mark it added
 * added      you said you added it: the next VDP read confirms it
 * in_vdp     the mirror shows it on the VDP: closed
 * dismissed  not for this VDP (never suggested again)
 */
export const VdpCandidateStatus = z.enum(['unsure', 'suggested', 'added', 'in_vdp', 'dismissed']);
export type VdpCandidateStatus = z.infer<typeof VdpCandidateStatus>;
export const OPEN_CANDIDATE_STATUSES: readonly VdpCandidateStatus[] = ['unsure', 'suggested', 'added'];

/** Who found it: the deterministic matcher over new source items, a backfill research run, or the Assistant. */
export const VdpCandidateOrigin = z.enum(['matcher', 'backfill', 'chat']);
export type VdpCandidateOrigin = z.infer<typeof VdpCandidateOrigin>;

/** Where the asset was seen (provenance): the message, mail, meeting or file that shared it. */
export const VdpCandidateSource = z.object({
  source: z.enum(['drive', 'slack', 'gmail', 'calendar', 'gemini', 'org62', 'other']),
  /** "#acme-ext · Dana", "Gmail · Re: pricing", "Calendar · ACME QBR", "Drive" */
  label: z.string(),
  url: Url.nullable(),
  at: IsoDateTime.nullable(),
});
export type VdpCandidateSource = z.infer<typeof VdpCandidateSource>;

export const VdpAssetCandidate = z.object({
  id: Id,
  /** The VDP it goes on; null = the account has no VDP yet (it waits for the one you create). */
  vdpSlug: z.string().nullable(),
  accountId: Id.nullable(),
  companyName: z.string(),
  title: z.string(),
  url: Url,
  kind: VdpAssetKind,
  /** Why it belongs to this VDP, in one line. */
  why: z.string(),
  confidence: z.number().min(0).max(1),
  origin: VdpCandidateOrigin,
  status: VdpCandidateStatus,
  sources: z.array(VdpCandidateSource),
  firstSeenAt: IsoDateTime,
  statusAt: IsoDateTime.nullable(),
  /** "Add <asset> to <VDP>": the VDP's Assets tab (or New VDP when there is none yet) and the text to paste. */
  handoff: VdpHandoff,
  /** The Apply that adds it (`add_vdp_asset`, D-59), once VDP's server lists that tool and the VDP exists. */
  apply: VdpApply.nullable().default(null),
  /** The Outbox item staged or applied for it. */
  draftId: Id.nullable().default(null),
});
export type VdpAssetCandidate = z.infer<typeof VdpAssetCandidate>;

export const VdpPersonView = z.object({ name: z.string().nullable(), email: z.string().nullable() });
export type VdpPersonView = z.infer<typeof VdpPersonView>;

export const VdpDetailUseCase = z.object({
  id: z.string(),
  track: z.string(),
  title: z.string(),
  priority: z.string().nullable(),
  division: z.string().nullable(),
  persona: z.string().nullable(),
  details: z.string().nullable(),
  executionPhase: z.string().nullable(),
  executionStartDate: z.string().nullable(),
  executionTargetDate: z.string().nullable(),
  /** "6 weeks" */
  duration: z.string().nullable(),
  hasAi: z.boolean(),
  /** Names of the AI-generated fields VDP holds ("executive_summary"…), when the detail was read. */
  aiFields: z.array(z.string()),
  /** Labels of the empty required inputs ("Persona"). */
  missing: z.array(z.string()),
  /** False: only the VDP's use-case index was read (details unknown). */
  detailLoaded: z.boolean(),
});
export type VdpDetailUseCase = z.infer<typeof VdpDetailUseCase>;

export const VdpDetailAsset = z.object({ id: z.string(), title: z.string().nullable(), url: Url, type: z.string().nullable(), description: z.string().nullable() });
export type VdpDetailAsset = z.infer<typeof VdpDetailAsset>;

/** Everything the mirror read for one VDP. */
export const VdpDetailVdp = z.object({
  slug: z.string(),
  id: z.string(),
  url: Url.nullable(),
  companyName: z.string(),
  industry: z.string().nullable(),
  fiscalYear: z.number().int().nullable(),
  fiscalQuarter: z.number().int().nullable(),
  salesforceAccountId: z.string().nullable(),
  salesforceOpportunityId: z.string().nullable(),
  /** Every Org62 opportunity id on the VDP, primary first. */
  salesforceOpportunityIds: z.array(z.string()).default([]),
  isSeed: z.boolean(),
  lastActivityAt: IsoDateTime.nullable(),
  executiveSummary: z.string().nullable(),
  aes: z.array(VdpPersonView),
  tas: z.array(VdpPersonView),
  collaborators: z.array(VdpPersonView),
  createdBy: VdpPersonView.nullable(),
  useCases: z.array(VdpDetailUseCase),
  assets: z.array(VdpDetailAsset),
  stakeholders: z.array(z.object({ name: z.string(), title: z.string().nullable(), role: z.string().nullable() })),
});
export type VdpDetailVdp = z.infer<typeof VdpDetailVdp>;

/** The newest "Find assets" run for this VDP or account (a research run over its history). */
export const VdpBackfillRun = z.object({
  status: z.enum(['queued', 'running', 'done', 'failed', 'skipped']),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  /** Candidates it added (new ones; ones already known only gain a source). */
  found: z.number().int(),
  costUsd: z.number().nullable(),
  /** Why it failed or was skipped ("budget", "VDP research is not available here"). */
  note: z.string().nullable(),
});
export type VdpBackfillRun = z.infer<typeof VdpBackfillRun>;

export const VdpBackfillState = z.object({
  last: VdpBackfillRun.nullable(),
  /** One run's cap (Settings ▸ Budgets ▸ Assistant limits ▸ research), the estimate shown on the button. */
  perRunUsd: z.number(),
  /** What is left on the assistant's day line (research spend counts there). */
  dayLeftUsd: z.number(),
  /** False when research can't run here; `note` says why. */
  available: z.boolean(),
  note: z.string().nullable(),
});
export type VdpBackfillState = z.infer<typeof VdpBackfillState>;

/** `key`: a VDP slug, `account:<id>`, or either with `#<item id>` (one item, D-60). */
export const VdpDetailQuery = z.object({ key: z.string().min(1).max(400) });
export type VdpDetailQuery = z.infer<typeof VdpDetailQuery>;

export const VdpDetailPayload = z.object({
  key: z.string(),
  companyName: z.string(),
  account: z.object({ id: Id, name: z.string() }).nullable(),
  opportunity: z.object({ id: Id, name: z.string() }).nullable(),
  /** Null: no VDP yet (the steps start with creating it). */
  vdp: VdpDetailVdp.nullable(),
  gaps: z.array(VdpGap),
  /** The open items in order (the coverage row's own); a blocked one names the one it waits for. */
  steps: z.array(VdpStep),
  /** The same status the Time ▸ VDP card shows. */
  status: VdpStatus,
  /** Every candidate for this VDP (open first, then in VDP, then dismissed). */
  candidates: z.array(VdpAssetCandidate),
  backfill: VdpBackfillState,
  lastReadAt: IsoDateTime.nullable(),
  vdpBaseUrl: Url.nullable(),
  /** The item the ref named (`<key>#<item id>`), when it is still open; the panel shows it first. */
  focus: z.string().nullable().default(null),
  /** Who is on the VDP, its use cases and assets (the My VDPs summary of it). */
  summary: VdpRowSummary.nullable().default(null),
  autopilot: VdpAutopilotState.default(() => ({ ...DEFAULT_VDP_AUTOPILOT_STATE })),
});
export type VdpDetailPayload = z.infer<typeof VdpDetailPayload>;

/** Confirm (unsure → suggested), mark added, dismiss, or put a dismissed one back (→ suggested). */
export const SetVdpCandidateRequest = z.object({ status: z.enum(['suggested', 'added', 'dismissed']) });
export type SetVdpCandidateRequest = z.infer<typeof SetVdpCandidateRequest>;

/**
 * "Find assets": one research run per key, or `all` (every VDP and engaged account without one), stopped at `capUsd`
 * in total (default: what is left on the assistant's day line). `estimateOnly` returns the plan and starts nothing.
 * `allowUsd` (the user's "Allow $N more today", never the Assistant's): raise today's assistant line by that much (and
 * today's hard cap when it would bind) before planning, recorded as a raise with its reason; today only.
 */
export const FindVdpAssetsRequest = z.object({
  key: z.string().min(1).max(200).optional(),
  all: z.boolean().optional(),
  capUsd: z.number().min(0).max(50).optional(),
  estimateOnly: z.boolean().optional(),
  allowUsd: z.number().positive().max(50).optional(),
});
export type FindVdpAssetsRequest = z.infer<typeof FindVdpAssetsRequest>;

export const FindVdpAssetsResult = z.object({
  /** The keys that run (queued), in order; the ones the cap left out are in `skipped`. */
  queued: z.array(z.object({ key: z.string(), companyName: z.string() })),
  skipped: z.array(z.object({ key: z.string(), companyName: z.string(), why: z.string() })),
  perRunUsd: z.number(),
  /** What one run is expected to cost (the finished runs' 75th percentile, at most perRunUsd). */
  runUsd: z.number().default(0),
  /** About: queued runs × runUsd. */
  estimateUsd: z.number(),
  /** At most: queued runs × the per-run cap. */
  ceilingUsd: z.number().default(0),
  /** About what every open target would cost (open × runUsd). */
  allUsd: z.number().default(0),
  /** How much more today's line needs to run every open target (0 when they fit). */
  shortUsd: z.number().default(0),
  /** Targets not already queued or running. */
  open: z.number().int().default(0),
  capUsd: z.number(),
  started: z.boolean(),
  note: z.string().nullable(),
});
export type FindVdpAssetsResult = z.infer<typeof FindVdpAssetsResult>;

/**
 * D-69 Change… on a company node: pick the VDP company (one VDP has, or one to create with the name you type) and the
 * Org62 accounts that belong to it. Stored as a user-locked mapping (survives every read, used by the tree, the
 * linking and the push); one undoable change. `key`: the node it replaces (its old mapping is dropped).
 */
export const SetVdpIdentityRequest = z.object({
  key: z.string().min(1).max(200).optional(),
  /** The accounts that belong to it, the one whose details key the node keeps first. */
  accountIds: z.array(Id).min(1),
  pick: VdpIdentityPick,
});
export type SetVdpIdentityRequest = z.infer<typeof SetVdpIdentityRequest>;

/** Reset a node to the app's own decision (drops your mapping). */
export const ClearVdpIdentityRequest = z.object({ key: z.string().min(1).max(200) });
export type ClearVdpIdentityRequest = z.infer<typeof ClearVdpIdentityRequest>;

export const VdpIdentityResult = z.object({
  /** The node as it reads now (null: none of its accounts is engaged any more). */
  identity: VdpCompanyIdentity.nullable(),
  /** Your mappings in force. */
  overrides: z.number().int(),
});
export type VdpIdentityResult = z.infer<typeof VdpIdentityResult>;

/** Change… ▸ search VDP companies (read-only: the mirror, the stored lookups, and `list_companies` when live). */
export const SearchVdpCompaniesQuery = z.object({ q: z.string().trim().min(1).max(200) });
export type SearchVdpCompaniesQuery = z.infer<typeof SearchVdpCompaniesQuery>;

export const VdpCompanyHit = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable().default(null),
  aliases: z.array(z.string()).default([]),
  vdpCount: z.number().int().nullable().default(null),
  /** mirror: a VDP of mine names it · lookup: a stored list_companies result · live: asked VDP just now */
  source: z.enum(['mirror', 'lookup', 'live']),
});
export type VdpCompanyHit = z.infer<typeof VdpCompanyHit>;

export const SearchVdpCompaniesResult = z.object({
  q: z.string(),
  companies: z.array(VdpCompanyHit),
  /** VDP was asked live (false: from what the app already read). */
  live: z.boolean(),
  note: z.string().nullable().default(null),
});
export type SearchVdpCompaniesResult = z.infer<typeof SearchVdpCompaniesResult>;
