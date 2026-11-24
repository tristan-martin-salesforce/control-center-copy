// VDP coverage: gaps, open items, status, the Changes tree, identity and push payloads. Split from vdp.ts (max-lines); vdp.ts re-exports every name.
import { z } from 'zod';

import { Id, IsoDateTime, Url } from './common';
import { ActionDestination, Draft } from './nba';

export const VdpGapCode = z.enum([
  /** The VDP has no use case (its opp is engaged). */
  'no_use_case',
  /** A required human input of a use case is empty. */
  'use_case_field',
  /** A use case has no AI fields (Generate runs in the VDP UI only). */
  'no_ai_fields',
  'no_ae',
  'no_ta',
  'no_assets',
  /** The VDP header has no Org62 opportunity id. */
  'no_opp_link',
  'no_fiscal_period',
  /** An engaged account of mine has no VDP at all. */
  'company_not_in_vdp',
  /** An engaged opp of mine is linked to no VDP, and its account has no current VDP to add it to. */
  'opp_without_vdp',
  /** An engaged opp of mine is not on its account's current VDP: add it (`add_opportunity_ids`). */
  'opp_not_on_vdp',
  /** Looks wrong (D-60): the fiscal period is not the linked open opp's close quarter. */
  'wrong_fiscal_period',
  /** Looks wrong: the header's Org62 account id is not the linked opps' account. */
  'wrong_account_id',
  /** Looks wrong: a linked opp is closed lost, or belongs to another account. */
  'wrong_opp_link',
  /** Looks wrong: two use cases with (nearly) the same title. */
  'duplicate_use_case',
  /** Looks wrong: an asset link that is not http(s), or the same link twice. */
  'bad_asset_url',
  /** The VDP header has no Org62 account id (the Use_Case__c export needs it). */
  'no_account_id',
  /** No Deal Contribution note is cached on a VDP with an open opp. D-63: auto-generated, no longer checked. */
  'no_dc_note',
  /** D-63: the VDP's read carries `entitlement_leveraged` and it is empty (an input: Data Services, Flex, Conversations). */
  'no_entitlement',
  /**
   * D-69 (VD-30): looks wrong: the Specialist Forecast now names an AE the VDP does not list (the forecast owner changed
   * after the AE was set). The fix adds them (set_vdp_owners with the live list plus the new AE), never a replace.
   */
  'ae_not_on_vdp',
  /** D-67: a Use_Case__c on an opp of this VDP that no VDP use case is: add it (`create_use_case`). */
  'org62_use_case',
  /** D-67: a use case and its Use_Case__c disagree and VDP should follow (or both changed): `update_use_case`, both values shown. */
  'use_case_drift',
]);
export type VdpGapCode = z.infer<typeof VdpGapCode>;
/**
 * The VDP MCP writes an Outbox item may make (D-46, D-59). The last four exist only once VDP's server lists them
 * (feature detection, src/lib/vdp/capabilities.ts); until then their work stays a handoff.
 */
export const VdpWriteOp = z.enum(['update_use_case', 'create_use_case', 'update_vdp_header', 'create_vdp', 'create_company', 'add_vdp_asset', 'set_vdp_owners', 'generate_use_case']);
export type VdpWriteOp = z.infer<typeof VdpWriteOp>;
/** A field value on the wire: text, a number, or a list (opportunity ids, owner emails). */
export const VdpValue = z.union([z.string(), z.number(), z.array(z.string())]);
export type VdpValue = z.infer<typeof VdpValue>;
export const VdpAppFix = z.object({
  kind: z.literal('app'),
  op: VdpWriteOp,
  /** Wire field name (`persona`, `details_input`, `add_opportunity_ids`…). */
  field: z.string(),
  current: VdpValue.nullable(),
  /** A value the app can propose (an unambiguous opp id, the current quarter), else null: the user types it. */
  suggested: VdpValue.nullable().default(null),
  /** Allowed values when the field is an enum (priority, execution phase, duration unit). */
  options: z.array(z.string()).default([]),
  /** The other fields the same call sets (create_vdp: fiscal period, account id, opportunity ids). */
  values: z.record(VdpValue).default({}),
  /**
   * D-60: the suggestion (and every value it carries) is a known fact, not a default or a guess: an Org62 id or close
   * quarter, VDP's own company match, who I am. Only a known app fix can be applied by VDP autopilot.
   */
  known: z.boolean().default(false),
  /**
   * D-63: VDP's MCP does not list the tool or argument this needs yet ("VDP's MCP can't take this yet: <tool/arg>"). The
   * item shows, disabled; once the server lists it (feature detection) the same item becomes pushable.
   */
  unsupported: z.string().nullable().default(null),
});
export type VdpAppFix = z.infer<typeof VdpAppFix>;
/** D-63: a gap the app works on in-app, not in VDP (no assets and no candidates: "Find assets", route findVdpAssets). */
export const VdpInAppFix = z.object({
  kind: z.literal('in_app'),
  action: z.enum(['find_assets']),
  label: z.string(),
});
export type VdpInAppFix = z.infer<typeof VdpInAppFix>;
export const VdpHandoff = z.object({
  kind: z.literal('handoff'),
  /** Button text: "Open the VDP's Assets tab". */
  label: z.string(),
  url: Url,
  /** Copy-ready text for the VDP form (names, ids, links). */
  copyText: z.string(),
});
export type VdpHandoff = z.infer<typeof VdpHandoff>;
export const VdpGap = z.object({
  /** Stable across reads: `<vdp or account>:<code>[:<use case>][:<field>]`. */
  id: z.string(),
  code: VdpGapCode,
  severity: z.enum(['high', 'medium', 'low']),
  title: z.string(),
  vdpSlug: z.string().nullable(),
  vdpUrl: Url.nullable(),
  useCaseId: z.string().nullable().default(null),
  useCaseTitle: z.string().nullable().default(null),
  accountId: Id.nullable().default(null),
  opportunityId: Id.nullable().default(null),
  fix: z.discriminatedUnion('kind', [VdpAppFix, VdpHandoff, VdpInAppFix]),
  /** `missing`: VDP lacks it; `wrong` (D-60): a value VDP holds looks wrong ("N to check"), with `why`. */
  check: z.enum(['missing', 'wrong']).default('missing'),
  /** Why a `wrong` check fired, in one line ("The opp closes FY27 Q4; the VDP says FY27 Q3"). */
  why: z.string().nullable().default(null),
});
export type VdpGap = z.infer<typeof VdpGap>;
export const VdpStepKind = z.enum([
  /** No VDP yet: New VDP (pick the company, or create it) makes the company's VDP. */
  'create_vdp',
  /** VDP doesn't know the company yet: create it first (`create_company`, or New VDP's "+ Create new company"). */
  'create_company',
  /** An engaged opp is not on its account's current VDP: add it (`add_opportunity_ids`). */
  'add_opp',
  'link_opp',
  /** The header has no Org62 account id. */
  'account_id',
  'fiscal_period',
  'create_use_case',
  /** A use case's empty required inputs (one step per use case). */
  'use_case_fields',
  'ai_fields',
  /** Research the account's history for assets (Drive, Slack, Gmail, Calendar). */
  'find_assets',
  /** The assets to confirm and to add (each candidate is its own row under "Assets to add"). */
  'assets',
  /** No asset known: add them by hand. */
  'add_assets_manually',
  'ae',
  'ta',
  /** AE and TA both missing: one item. */
  'owners',
  /** The Deal Contribution note (generated in VDP). */
  'dc_note',
  /** A value that looks wrong (D-60): a suggested fix, or the place to fix it in VDP. */
  'check',
  /** D-63: the entitlement leveraged (an input on the header). */
  'entitlement',
  /** D-63: a closed-lost (or another account's) linked opp, taken off the header (`remove_opportunity_ids`, a suggestion). */
  'remove_opp',
]);
export type VdpStepKind = z.infer<typeof VdpStepKind>;
/** D-63: where an item sits under its VDP (Company → VDP → these). */
export const VdpSection = z.enum(['opportunities', 'people', 'use_cases', 'assets', 'header']);
export type VdpSection = z.infer<typeof VdpSection>;
/**
 * D-60, who applies an item:
 *   auto     VDP autopilot applies it by itself (every value it sends is known: an Org62 id, VDP's own match, me)
 *   suggest  the app drafted the values, a person approves them (judgment fields, a value that looks wrong)
 *   you      only you, in VDP (a link and the text to paste)
 */
export const VdpStepPolicy = z.enum(['auto', 'suggest', 'you']);
export type VdpStepPolicy = z.infer<typeof VdpStepPolicy>;
/** Suggested values for a judgment item (D-60): shown as "Suggested: Priority = 3 - High · Persona = CIO", never auto-applied. */
export const VdpSuggestion = z.object({
  /** Wire field → value (the Apply's `values`). */
  values: z.record(z.string()),
  /** "Priority = 3 - High · Persona = CIO" */
  line: z.string(),
  /** Why each value, one short line each ("the opp closes this quarter"). */
  basis: z.array(z.string()).default([]),
  /** `rules`: drafted deterministically from what the app knows (no model call, no spend). */
  by: z.enum(['rules']).default('rules'),
});
export type VdpSuggestion = z.infer<typeof VdpSuggestion>;
/** What VDP autopilot did or will do with an item (D-60). */
export const VdpStepAutopilot = z.object({
  /** queued: it applies on the next run; paused: it would, but autopilot is paused; applied / failed: it ran. */
  state: z.enum(['queued', 'paused', 'applied', 'failed']),
  at: IsoDateTime.nullable().default(null),
  /** The error (failed), why it is paused, or what was applied. */
  detail: z.string().nullable().default(null),
  draftId: Id.nullable().default(null),
  url: Url.nullable().default(null),
});
export type VdpStepAutopilot = z.infer<typeof VdpStepAutopilot>;
/**
 * todo, blocked (waits for an earlier step: `blockedBy`), staged (its Apply waits for you on Time), waiting (applied
 * or marked added: the next VDP read confirms it), maybe_made (D-69, VD-23: a create whose write timed out or whose
 * read-back did not confirm it: a push looks in VDP first and never sends it again blind).
 */
export const VdpStepState = z.enum(['todo', 'blocked', 'staged', 'waiting', 'maybe_made']);
export type VdpStepState = z.infer<typeof VdpStepState>;
/** One input of an Apply: the field, what VDP has, the app's suggestion, the allowed values. */
export const VdpApplyField = z.object({
  field: z.string(),
  label: z.string(),
  current: VdpValue.nullable(),
  /** Pre-filled; null = you type it. */
  suggested: VdpValue.nullable(),
  options: z.array(z.string()).default([]),
  /** The Apply needs a value here (a new use case's title, a fiscal year). */
  required: z.boolean().default(false),
  multiline: z.boolean().default(false),
  /** Shown, not editable: an id the app knows (the company, the account, the opps). */
  fixed: z.boolean().default(false),
});
export type VdpApplyField = z.infer<typeof VdpApplyField>;
/** What an item's Apply stages: ONE VDP call (POST /deals/vdp/updates with `itemKey` = `key` and the typed values). */
export const VdpApply = z.object({
  key: z.string(),
  op: VdpWriteOp,
  /** The fields you can see and edit before staging (none: nothing to type, e.g. add an opp, generate). */
  fields: z.array(VdpApplyField),
  /** "Create the VDP", "Add the opp", "Fill in 3 fields" */
  label: z.string(),
});
export type VdpApply = z.infer<typeof VdpApply>;
export const VdpStep = z.object({
  id: z.string(),
  kind: VdpStepKind,
  title: z.string(),
  detail: z.string().nullable(),
  state: VdpStepState,
  /** Who does it: `app` = an Apply here stages it (the app can fix); `you` = in VDP (a link and the text to paste). */
  who: z.enum(['app', 'you']).default('you'),
  /** The Apply (`who: app`). */
  apply: VdpApply.nullable().default(null),
  /** The Outbox item staged for it (`staged`) or applied (`waiting`). */
  draftId: Id.nullable().default(null),
  /** The step this one waits for (its id), and why. */
  blockedBy: z.string().nullable(),
  blockedReason: z.string().nullable(),
  /** The gaps the step fixes: app fixes stage one change each, handoffs are a link + copy text. */
  gaps: z.array(VdpGap),
  /** A handoff of its own (a VDP that does not exist yet has no gaps to carry one). */
  handoff: VdpHandoff.nullable(),
  /** `assets`: the open candidates (ids into the payload's `candidates`). */
  candidateIds: z.array(Id),
  /** D-60: who applies it (autopilot, a person approving suggestions, or you in VDP). */
  policy: VdpStepPolicy.default('you'),
  /** Suggested values for a judgment item (never auto-applied). */
  suggestion: VdpSuggestion.nullable().default(null),
  /** What autopilot did with it, or will do. */
  autopilot: VdpStepAutopilot.nullable().default(null),
  /** `missing` (VDP lacks it) or `wrong` (a value looks wrong: a check). */
  check: z.enum(['missing', 'wrong']).default('missing'),
  /**
   * D-63: the items (their Apply keys) that must be applied first, outermost first: a VDP under a company VDP lacks,
   * a use case under a VDP that does not exist yet, a Generate under its use case's inputs. A push applies them first
   * and passes their new ids down.
   */
  requires: z.array(z.string()).default([]),
  /** D-63: shown but not pushable, and why ("VDP's MCP can't take this yet: update_vdp_header.entitlement_leveraged"). */
  disabled: z.string().nullable().default(null),
  /** D-63: its place under the VDP (null for the company and the VDP themselves). */
  section: VdpSection.nullable().default(null),
  /** D-63: the item it sits under in the tree (a Generate under its use case's inputs), by Apply key. */
  parentKey: z.string().nullable().default(null),
});
export type VdpStep = z.infer<typeof VdpStep>;
/**
 * One VDP's status, the same everywhere (card, panel, head sentence, Home, the Time badge):
 *   done        nothing open (a check and "Done")
 *   open        N items need you (an Apply to review, or something to do in VDP)
 *   waiting     everything left was applied or marked added; the next VDP read confirms it (`nextReadAt`)
 *   waiting_dc  D-69 (VD-11): a current VDP I am on whose account has no open opp where my DC is 100% yet: not
 *               checked until the DC lands ("Waiting for your DC"), never Past
 *   past        an old fiscal period on closed opps: not checked
 */
export const VdpStatusState = z.enum(['done', 'open', 'waiting', 'waiting_dc', 'past']);
export type VdpStatusState = z.infer<typeof VdpStatusState>;
export const VdpStatus = z.object({
  state: VdpStatusState,
  /** Items that need you (to do, staged for your Apply, or waiting on an earlier one). */
  open: z.number().int(),
  /** Of those, the ones the app can fix with an Apply. */
  appCanFix: z.number().int(),
  /** Items applied or marked added that the next read has not confirmed yet. */
  waiting: z.number().int(),
  /** D-60: of the open items, the ones for something VDP lacks ("N missing") and for a value that looks wrong ("N to check"). */
  missing: z.number().int().optional(),
  toCheck: z.number().int().optional(),
  /** "Done", "3 open", "Waiting for VDP to refresh", "Past" */
  label: z.string(),
  /** When the next VDP read is due (the read every 30 min), for "Waiting for VDP to refresh". */
  nextReadAt: IsoDateTime.nullable(),
});
export type VdpStatus = z.infer<typeof VdpStatus>;
/** One person on a VDP, as VDP records them. */
const VdpRowPerson = z.object({ name: z.string().nullable(), email: z.string().nullable() });
/** Who is on a VDP, as VDP records it (D-60 summary: owners, collaborators, stakeholders). */
export const VdpRowPeople = z.object({
  aes: z.array(VdpRowPerson).default([]),
  tas: z.array(VdpRowPerson).default([]),
  collaborators: z.array(VdpRowPerson).default([]),
  stakeholders: z.array(z.object({ name: z.string(), title: z.string().nullable(), role: z.string().nullable() })).default([]),
});
export type VdpRowPeople = z.infer<typeof VdpRowPeople>;
/** My VDPs (the summary tab): who is on it, its use cases and the assets it links, at a glance. */
export const VdpRowSummary = z.object({
  people: VdpRowPeople,
  useCases: z.array(z.object({ id: z.string(), title: z.string(), track: z.string(), inputsComplete: z.boolean(), hasAi: z.boolean(), missing: z.array(z.string()).default([]) })).default([]),
  assets: z.array(z.object({ title: z.string().nullable(), url: z.string(), type: z.string().nullable(), deliverableType: z.string().nullable().default(null) })).default([]),
});
export type VdpRowSummary = z.infer<typeof VdpRowSummary>;
/** One thing VDP autopilot applied or tried (D-60), newest first in the payload. */
export const VdpAutopilotEntry = z.object({
  key: z.string(),
  title: z.string(),
  /** The VDP slug, or `account:<id>` before it has one. */
  vdpKey: z.string(),
  companyName: z.string(),
  op: VdpWriteOp,
  at: IsoDateTime,
  state: z.enum(['applied', 'failed']),
  detail: z.string().nullable().default(null),
  draftId: Id.nullable().default(null),
  url: Url.nullable().default(null),
});
export type VdpAutopilotEntry = z.infer<typeof VdpAutopilotEntry>;
/** VDP autopilot's state for the VDP view's head, Health and the Changes tab (D-60). */
export const VdpAutopilotState = z.object({
  on: z.boolean(),
  /** Why it is not writing now: re-auth VDP, dry run is on, or today's cap is reached. */
  paused: z.enum(['reauth', 'dry_run', 'cap']).nullable().default(null),
  pausedSince: IsoDateTime.nullable().default(null),
  appliedToday: z.number().int().default(0),
  failedToday: z.number().int().default(0),
  cap: z.number().int(),
  /** Items it applies on its next run. */
  queued: z.number().int().default(0),
  lastRunAt: IsoDateTime.nullable().default(null),
  recent: z.array(VdpAutopilotEntry).default([]),
  /** "Autopilot: on · 12 applied today · paused: re-auth VDP" */
  line: z.string(),
});
export type VdpAutopilotState = z.infer<typeof VdpAutopilotState>;
/** One asset candidate as a change (Time ▸ VDP ▸ Changes, D-60): add it with one Apply, or autopilot adds a strong one. */
export const VdpAssetItem = z.object({
  candidateId: Id,
  title: z.string(),
  url: z.string(),
  why: z.string(),
  confidence: z.number(),
  /** todo · staged (waits for your Apply) · waiting (applied: the next VDP read confirms it) */
  state: z.enum(['todo', 'staged', 'waiting']),
  apply: VdpApply.nullable(),
  draftId: Id.nullable().default(null),
  policy: VdpStepPolicy,
  /** Why it is not autopilot's (not the strongest grade, not an http(s) link, a demo org). */
  policyReason: z.string().nullable().default(null),
  autopilot: VdpStepAutopilot.nullable().default(null),
  /** D-63: the items it waits for (the VDP to create, when it has none yet). */
  requires: z.array(z.string()).default([]),
  /** D-63: shown but not pushable, and why. */
  disabled: z.string().nullable().default(null),
});
export type VdpAssetItem = z.infer<typeof VdpAssetItem>;
export const DEFAULT_VDP_AUTOPILOT_STATE: VdpAutopilotState = { on: false, paused: null, pausedSince: null, appliedToday: 0, failedToday: 0, cap: 40, queued: 0, lastRunAt: null, recent: [], line: 'Autopilot: off' };
export const VdpCoverageRow = z.object({
  vdpSlug: z.string(),
  vdpId: z.string().nullable(),
  url: Url.nullable(),
  companyName: z.string(),
  fiscalYear: z.number().int().nullable(),
  fiscalQuarter: z.number().int().nullable(),
  accountId: Id.nullable(),
  opportunityId: Id.nullable(),
  opportunityName: z.string().nullable(),
  /** Every local opp the VDP links (its Org62 opportunity ids, primary first), and their names. */
  opportunityIds: z.array(Id).default([]),
  opportunityNames: z.array(z.string()).default([]),
  /** D-69: every Org62 account of the VDP's company group (`accountId` is its primary): their candidates go on it. */
  accountIds: z.array(Id).default([]),
  useCaseCount: z.number().int(),
  useCaseWithAiCount: z.number().int(),
  assetCount: z.number().int(),
  hasAe: z.boolean(),
  hasTa: z.boolean(),
  lastActivityAt: IsoDateTime.nullable(),
  /**
   * `current`: checked (this or next fiscal period, or an open linked opp); `waiting_dc` (D-69): current, but no open opp
   * where my DC is 100% yet (not checked until it lands); `past`: an old period on closed opps, not checked.
   */
  scope: z.enum(['current', 'waiting_dc', 'past']).default('current'),
  /** Empty for a past VDP. */
  gaps: z.array(VdpGap),
  /** What is open, in order, each with who does it: the card and the details panel list exactly these. */
  steps: z.array(VdpStep).default([]),
  status: VdpStatus,
  /** My VDPs' summary (people, use cases, assets); null on rows built without it. */
  summary: VdpRowSummary.nullable().default(null),
  /** D-60: each asset to add as its own change (the candidates that have an Apply), with who applies it. */
  assetItems: z.array(VdpAssetItem).default([]),
});
export type VdpCoverageRow = z.infer<typeof VdpCoverageRow>;
/** "Not in VDP yet": an engaged account with no VDP, or an engaged opp no VDP links (create one, or add it). */
export const VdpNotInVdpRow = z.object({
  /** The details key: `account:<id>`. */
  key: z.string(),
  accountId: Id.nullable(),
  opportunityId: Id.nullable(),
  /** "Acme" / "Acme · Expansion" */
  title: z.string(),
  /** The one item: create the VDP (or the company first). */
  step: VdpStep,
  status: VdpStatus,
  /**
   * D-63: what comes under it once it exists (each `requires` it): the VDP to create under a new company, then the
   * VDP's own items (its people, a use case). A push applies them in order and passes the new ids down.
   */
  children: z.array(VdpStep).default([]),
  /** D-63: the assets waiting for the VDP to create (each an add_vdp_asset that `requires` it). */
  assetItems: z.array(VdpAssetItem).default([]),
});
export type VdpNotInVdpRow = z.infer<typeof VdpNotInVdpRow>;
// ---------------------------------------------------------------------------
// D-63: the Changes tree (Company → VDP → items) and the chained push
// ---------------------------------------------------------------------------

/** One row of the tree: an item (its step, or the asset it adds). */
export const VdpTreeLeaf = z.object({
  /** The panel / chat ref (`<details key>#<item id>`). */
  ref: z.string(),
  /** The Apply key when the item has one. */
  key: z.string().nullable(),
  title: z.string(),
  step: VdpStep.nullable().default(null),
  asset: VdpAssetItem.nullable().default(null),
});
export type VdpTreeLeaf = z.infer<typeof VdpTreeLeaf>;
/** An item and what sits under it (a Generate under its use case's inputs). */
export const VdpTreeItem = VdpTreeLeaf.extend({ children: z.array(VdpTreeLeaf).default([]) });
export type VdpTreeItem = z.infer<typeof VdpTreeItem>;
export const VdpTreeSection = z.object({ kind: VdpSection, title: z.string(), items: z.array(VdpTreeItem) });
export type VdpTreeSection = z.infer<typeof VdpTreeSection>;
/** One VDP under its company: one that exists (its items), or the one to create (`node`: its create_vdp item). */
export const VdpTreeVdp = z.object({
  /** The details key: its slug, or `account:<id>` for the VDP to create. */
  key: z.string(),
  /** "FY27 Q4" / "New VDP · FY27 Q4" */
  label: z.string(),
  exists: z.boolean(),
  url: Url.nullable(),
  status: VdpStatus.nullable(),
  /** The opps it links, or will link (names). */
  opportunities: z.array(z.string()).default([]),
  node: VdpTreeLeaf.nullable().default(null),
  sections: z.array(VdpTreeSection),
});
export type VdpTreeVdp = z.infer<typeof VdpTreeVdp>;
// ---------------------------------------------------------------------------
// D-69: company identity (which VDP company each engaged account belongs to, and which accounts go together)
// ---------------------------------------------------------------------------

/** A VDP company: one VDP has (`match`), or the one to create with this name and these aliases (`create`). */
export const VdpIdentityPick = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('match'), id: z.string().min(1).max(100), name: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('create'), name: z.string().trim().min(1).max(200), aliases: z.array(z.string().trim().min(1).max(200)).max(50).default([]) }),
]);
export type VdpIdentityPick = z.infer<typeof VdpIdentityPick>;
export const VdpIdentityAlternative = z.object({
  pick: VdpIdentityPick,
  /** "VDP has “Acme” (2 VDPs)", "Its own brand: create “Nexus Care”" */
  why: z.string(),
  /** How many VDPs VDP holds for that company (`get_company`), when read. */
  vdpCount: z.number().int().nullable().default(null),
});
export type VdpIdentityAlternative = z.infer<typeof VdpIdentityAlternative>;
/**
 * One company node's identity (D-69): the VDP company of a group of engaged accounts, how the app decided it, and how
 * sure it is.
 *   resolved       a match (by a VDP of mine, VDP's own name rule, or the judgment) or the company to create
 *   needs_you      the evidence is ambiguous and the judgment is not sure (or not run): `pick` is the best guess,
 *                  pre-selected in Change…; nothing under it is pushable until you confirm or change it
 *   not_looked_up  a name up its Org62 chain was not looked up in VDP yet: the next VDP read does
 *   hidden_vdps    VDP holds VDPs for the company that you are not on: no new VDP (ask to be added)
 *   tombstoned     its VDP was archived in VDP, or you are no longer on it: never created again
 * `by`: vdp (a VDP of mine links its opps or carries its account id) · name (VDP's name rule, up the Org62 chain) ·
 * rules (no match; the closest plain parent) · judgment (the vdp-company-identity skill) · you (Change…).
 */
export const VdpCompanyIdentity = z.object({
  /** The company node's key (`account:<primary account id>`). */
  key: z.string(),
  state: z.enum(['resolved', 'needs_you', 'not_looked_up', 'hidden_vdps', 'tombstoned']),
  by: z.enum(['vdp', 'name', 'rules', 'judgment', 'you']),
  pick: VdpIdentityPick,
  confidence: z.number().min(0).max(1),
  /** Zero ambiguity: VDP autopilot may act on it (D-60). */
  deterministic: z.boolean(),
  /** One line: why this company. */
  reason: z.string(),
  alternatives: z.array(VdpIdentityAlternative).default([]),
  /** The Org62 accounts in the group (my book), each with its cleaned chain names (self first). */
  accounts: z.array(z.object({ id: Id, name: z.string(), chain: z.array(z.string()).default([]) })),
  /** Other engaged accounts of mine that could join it (siblings first), for Change…. */
  candidates: z.array(z.object({ id: Id, name: z.string(), why: z.string() })).default([]),
  /** VDPs VDP holds for the company that I am not on (`get_company` vdp_count minus the ones I can see). */
  hiddenVdps: z.number().int().default(0),
  /** Set by you (Change…): when. Undo / Reset puts the app's own decision back. */
  override: z.object({ at: IsoDateTime }).nullable().default(null),
});
export type VdpCompanyIdentity = z.infer<typeof VdpCompanyIdentity>;
export const VdpTreeCompany = z.object({
  key: z.string(),
  accountId: Id.nullable(),
  companyName: z.string(),
  /** VDP has the company (false: `node` is its create_company item, the top-level one). */
  exists: z.boolean(),
  node: VdpTreeLeaf.nullable().default(null),
  vdps: z.array(VdpTreeVdp),
  /** D-69: which VDP company this is, how the app decided it, the alternatives (null: a VDP's own company). */
  identity: VdpCompanyIdentity.nullable().default(null),
});
export type VdpTreeCompany = z.infer<typeof VdpTreeCompany>;
/** One item of a push (D-63), in the order it runs. */
export const VdpPushNode = z.object({
  key: z.string(),
  title: z.string(),
  companyName: z.string(),
  op: z.string(),
  requires: z.array(z.string()).default([]),
  draftId: Id.nullable().default(null),
  /** queued · running · applied (read back) · dry_run (recorded) · failed · skipped (an item it needs failed) */
  state: z.enum(['queued', 'running', 'applied', 'dry_run', 'failed', 'skipped']),
  detail: z.string().nullable().default(null),
  /** The id VDP gave a new company, VDP or use case (passed to the items under it). */
  externalId: z.string().nullable().default(null),
  /** A new VDP's slug (from its link), for the items under it. */
  slug: z.string().nullable().default(null),
  at: IsoDateTime.nullable().default(null),
});
export type VdpPushNode = z.infer<typeof VdpPushNode>;
/**
 * An item the worker stages right before it pushes it (2026-11-16): the click returns at once, the 4½ minutes that
 * staging 133 items took happen in the background. Server-side only: the coverage payload never carries it.
 */
export const VdpPushStage = z.object({ key: z.string(), dest: ActionDestination, replaces: Id.nullable().default(null) });
export type VdpPushStage = z.infer<typeof VdpPushStage>;
/** One "Push N to VDP" (D-63): the ordered items and how each ended (the worker runs it; live events follow). */
export const VdpPushRun = z.object({
  id: z.string(),
  at: IsoDateTime,
  dryRun: z.boolean(),
  /** stopped: its worker job ended before it did (a restart, a deploy, its time limit): what was left was not pushed. */
  state: z.enum(['queued', 'running', 'done', 'stopped']),
  nodes: z.array(VdpPushNode),
  finishedAt: IsoDateTime.nullable().default(null),
  /** What the worker still stages (server-side; empty in every payload). */
  stage: z.array(VdpPushStage).optional(),
});
export type VdpPushRun = z.infer<typeof VdpPushRun>;
export const VdpCoveragePayload = z.object({
  vdps: z.array(VdpCoverageRow),
  /** Account / opp gaps that no single VDP owns (company not in VDP, opp linked to no VDP, opp not on its VDP). */
  unlinked: z.array(VdpGap),
  /** The same, as rows with their one item each. */
  notInVdp: z.array(VdpNotInVdpRow).default([]),
  /** D-69 (VD-14): VDPs archived in VDP, or ones I am no longer on: listed quietly, never created again. */
  tombstones: z.array(z.object({ vdpSlug: z.string(), companyName: z.string(), accountId: Id.nullable(), why: z.string(), at: IsoDateTime.nullable() })).default([]),
  counts: z.object({ vdps: z.number().int(), gaps: z.number().int(), appFixable: z.number().int(), handoffs: z.number().int() }),
  /** VDPs by status (the head: "3 VDPs need you, 2 waiting, 9 done"), plus the Not-in-VDP rows that need you. */
  summary: z
    .object({ needYou: z.number().int(), waiting: z.number().int(), done: z.number().int(), past: z.number().int(), notInVdp: z.number().int(), appCanFix: z.number().int(), waitingDc: z.number().int().optional() })
    .default({ needYou: 0, waiting: 0, done: 0, past: 0, notInVdp: 0, appCanFix: 0, waitingDc: 0 }),
  /** When the next VDP read is due. */
  nextReadAt: IsoDateTime.nullable().default(null),
  /** What the app can write in VDP today (D-59 / D-63 feature detection); false = those items show disabled. */
  automation: z
    .object({
      toolsKnown: z.boolean(),
      createVdp: z.boolean(),
      addOpportunities: z.boolean(),
      removeOpportunities: z.boolean().default(true),
      createCompany: z.boolean(),
      addAsset: z.boolean(),
      setOwners: z.boolean(),
      generateUseCase: z.boolean(),
      entitlementHeader: z.boolean().default(false),
      entitlementCreate: z.boolean().default(false),
      salesSegment: z.boolean().default(false),
    })
    .default({ toolsKnown: false, createVdp: true, addOpportunities: true, removeOpportunities: true, createCompany: true, addAsset: true, setOwners: true, generateUseCase: true, entitlementHeader: false, entitlementCreate: false, salesSegment: false }),
  /** D-63: the Changes tab's tree: Company → VDP → items, in the order the work happens. */
  tree: z.array(VdpTreeCompany).default([]),
  /** D-63: the latest push, while it runs and after (how each item ended). */
  push: VdpPushRun.nullable().default(null),
  /** The recent pushes, newest first (VDP ▸ Changes ▸ Push runs: each with its status and what it pushed). */
  pushes: z.array(VdpPushRun).default([]),
  /** D-69: every company node's identity (the tree's nodes carry theirs). */
  identities: z.array(VdpCompanyIdentity).default([]),
  /**
   * D-69 (VD-28): VDP's sign-in as the connector last saw it: `stale` gates a live push (re-auth VDP first); null =
   * not connected yet.
   */
  signIn: z.enum(['ok', 'stale']).nullable().default(null),
  /** When the mirror last read VDP; null = never (VDP not connected yet). */
  lastReadAt: IsoDateTime.nullable(),
  /** D-60: VDP autopilot (Settings ▸ Sending ▸ VDP autopilot): on or off, paused why, what it applied. */
  autopilot: VdpAutopilotState.default(() => ({ ...DEFAULT_VDP_AUTOPILOT_STATE })),
  /** Base URL of the VDP app, for handoff links. */
  vdpBaseUrl: Url.nullable(),
  /** Asset candidates waiting per details key (VDP slug or `account:<id>`), and what "Find assets for all" costs. */
  assets: z
    .object({
      byKey: z.record(z.object({ toAdd: z.number().int(), toConfirm: z.number().int() })),
      toAdd: z.number().int(),
      toConfirm: z.number().int(),
      /** Keys "Find assets for all" runs over (every VDP and engaged account without one). */
      targets: z.number().int(),
      perRunUsd: z.number(),
      /** What one run is expected to cost (src/server/vdp/find.ts expectedRunUsd); the button's estimate. */
      runUsd: z.number().default(0.2),
      dayLeftUsd: z.number(),
      /** Runs queued or running now. */
      running: z.number().int(),
    })
    .default({ byKey: {}, toAdd: 0, toConfirm: 0, targets: 0, perRunUsd: 0.5, runUsd: 0.2, dayLeftUsd: 0, running: 0 }),
});
export type VdpCoveragePayload = z.infer<typeof VdpCoveragePayload>;
/**
 * Stage one VDP change as an Outbox item (pending approval). Preferred: `itemKey` (an open item's `apply.key`) plus
 * the values you typed (`values`, by wire field): the server rebuilds the item from the mirror and stages its ONE
 * call (a whole use case, the fiscal period, a new VDP). Legacy: one field (`vdpSlug`, `op`, `field`, `value`).
 */
export const DraftVdpUpdateRequest = z.object({
  itemKey: z.string().min(1).max(300).optional(),
  /** itemKey: what you typed per wire field (the rest take the item's suggestion). */
  values: z.record(z.string().max(10_000)).optional(),
  vdpSlug: z.string().min(1).optional(),
  op: VdpWriteOp.optional(),
  /** Wire field name; for `create_use_case` only `title`. */
  field: z.string().min(1).optional(),
  /** The new value as text (numbers are parsed for numeric fields). */
  value: z.string().optional(),
  /** update_use_case: the use case. */
  useCaseId: z.string().nullable().optional(),
  /** create_use_case: the track. */
  track: z.enum(['d360', 'agentforce']).nullable().optional(),
  /** The gap this fixes (provenance), when it came from the gap check. */
  gapId: z.string().nullable().optional(),
  workItemId: Id.nullable().optional(),
});
export type DraftVdpUpdateRequest = z.infer<typeof DraftVdpUpdateRequest>;
/** One field an Outbox item sets, with what the mirror read before it. */
export const VdpFieldChange = z.object({ field: z.string(), before: VdpValue.nullable().default(null), value: VdpValue });
export type VdpFieldChange = z.infer<typeof VdpFieldChange>;
/**
 * `ActionDestination.input` of a `vdp.*` action: ONE call, with every field it sets (`changes`) and what the mirror
 * read before it. `field`/`before`/`value` repeat the first change (items staged before D-59 carry only those).
 */
export const VdpActionInput = z.object({
  /** The VDP's slug; for `create_vdp` / `create_company` the details key of the account (`account:<id>`). */
  vdpSlug: z.string(),
  /** The VDP's id in vdp-app (every VDP write takes it); empty for `create_vdp` / `create_company`. */
  vdpId: z.string().default(''),
  /** update_use_case / generate_use_case: the use case. */
  useCaseId: z.string().nullable().default(null),
  useCaseTitle: z.string().nullable().default(null),
  /** create_use_case: the track. */
  track: z.enum(['d360', 'agentforce']).nullable().default(null),
  /** Wire field name (`persona`, `execution_target_date`, `add_opportunity_ids`…). */
  field: z.string(),
  before: VdpValue.nullable().default(null),
  /** The new value, already checked and normalized for the wire. */
  value: VdpValue,
  /** Every field this one call sets, first = `field`; empty on a single-field item. */
  changes: z.array(VdpFieldChange).default([]),
  /** The open item it closes (`VdpApply.key`): how the page shows it staged, then waiting for the read. */
  itemKey: z.string().nullable().default(null),
  /** add_vdp_asset: the asset candidate it adds. */
  candidateId: z.string().nullable().default(null),
  /**
   * D-63: ids a parent item has to create first, by that item's Apply key (a VDP under a new company, a use case
   * under a new VDP, a Generate under a new use case). The payload carries placeholders and is never sent; the push
   * stages it again with the real id once the parent is applied.
   */
  pending: z.object({ vdpId: z.string().optional(), companyId: z.string().optional(), useCaseId: z.string().optional() }).nullable().default(null),
});
export type VdpActionInput = z.infer<typeof VdpActionInput>;
/**
 * "Push N to VDP" (Time ▸ VDP ▸ Changes, D-60): the items you ticked, each staged and applied on this one click (your
 * approval), with the same payload, dry run and read-back as one Apply. `useSuggestion`: take the item's suggested
 * values. The Assistant never calls this route (it stages; you push).
 */
export const PushVdpChangesRequest = z.object({
  // any number of items: VDP's real limits (60 calls a minute, 20 Generates per 10 minutes) are paced by the push
  items: z.array(z.object({ itemKey: z.string().min(1).max(300), values: z.record(z.string().max(10_000)).optional(), useSuggestion: z.boolean().optional() })).min(1),
});
export type PushVdpChangesRequest = z.infer<typeof PushVdpChangesRequest>;
export const PushVdpChangesResult = z.object({
  dryRun: z.boolean(),
  /** D-63: the push (its progress is `VdpCoveragePayload.push`). */
  pushId: z.string().nullable().default(null),
  /** Every item it pushes, in order: the ticked ones and the ones they need first (a new company, a new VDP). */
  results: z.array(
    z.object({
      itemKey: z.string(),
      draftId: Id.nullable(),
      /**
       * dry_run: recorded, nothing sent · queued: on its way to VDP, in order (read back after) · applied: in VDP (the
       * mock's simulated transport) · failed: not staged or not sent · skipped: not pushed, an item it needs failed
       */
      state: z.enum(['dry_run', 'queued', 'applied', 'failed', 'skipped']),
      error: z.string().nullable().default(null),
      /** D-63: not ticked: a ticked item needs it first. */
      required: z.boolean().default(false),
    }),
  ),
});
export type PushVdpChangesResult = z.infer<typeof PushVdpChangesResult>;
export const DraftVdpUpdateResult = z.object({
  draft: Draft,
  destination: ActionDestination,
});
export type DraftVdpUpdateResult = z.infer<typeof DraftVdpUpdateResult>;
