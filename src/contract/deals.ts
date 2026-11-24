/**
 * Deals: accounts, opportunities, missed-opportunity findings (R-UI-14).
 */
import { z } from 'zod';
import { Id, IsoDate, IsoDateTime, PersonRef, Url } from './common';
import { NeedResolve } from './needs';

export const Account = z.object({
  id: Id,
  name: z.string(),
  industry: z.string().nullable().default(null),
  /** My Deal Contribution (DC) status on the account's open opps. */
  dcStatus: z.enum(['assigned', 'partial', 'none', 'requested']),
  vdpStatus: z.enum(['linked', 'stale', 'none']),
  hoursQtd: z.number(),
  team: z.array(PersonRef).default([]),
  org62Url: Url.nullable().default(null),
  notes: z.string().default(''),
});
export type Account = z.infer<typeof Account>;

/**
 * My Deal Contribution on an opportunity, as the Org62 scans last read it (the `deal_contributions` mirror; the mock
 * keeps it on the opp). Holding a DC is not being on the opp team: `Opportunity.isMine` is the team, `myDc` the DC.
 */
export const MyDc = z.object({
  /** Split_Percentage__c (null when the scan didn't carry it). */
  split: z.number().nullable(),
  /** Opportunity_Role__c. */
  role: z.string().nullable(),
  /** The Deal_Contribution__c id. */
  org62DcId: z.string().nullable(),
  /** When a scan last read it. */
  lastSeenAt: IsoDateTime.nullable().default(null),
  /**
   * DC-14: how many DCs of mine this sums (two on one opp: a Flex 50/50, both mine). `split` is their sum, `role`,
   * `org62DcId` and `lastSeenAt` the newest one's. Absent = one.
   */
  dcCount: z.number().int().min(1).optional(),
});
export type MyDc = z.infer<typeof MyDc>;

/** "Your DC: 100% · AI + Data Architect" (the words every surface and the Assistant use). */
export function myDcWords(dc: (Pick<MyDc, 'split' | 'role'> & Partial<Pick<MyDc, 'dcCount'>>) | null | undefined): string | null {
  if (!dc) return null;
  // DC-14: two of mine on one opp read as their sum, and say so
  const n = (dc.dcCount ?? 1) > 1 ? ` (${dc.dcCount} DCs)` : '';
  return `Your DC: ${dc.split === null ? 'split not read yet' : `${dc.split}%`}${n}${dc.role ? ` · ${dc.role}` : ''}`;
}

export const Opportunity = z.object({
  id: Id,
  accountId: Id,
  name: z.string(),
  stage: z.string(),
  amount: z.number().nullable(),
  closeDate: IsoDate.nullable(),
  isOpen: z.boolean().default(true),
  /** I'm on the opp team (or own it). A DC alone is `myDc`, never the team. */
  isMine: z.boolean(),
  /** Org62 shows a DC of mine on it (`myDc` has its split and role once the scan has read them). */
  dcAssigned: z.boolean(),
  vdpLinked: z.boolean(),
  hoursQtd: z.number().default(0),
  nextStep: z.string().nullable().default(null),
  /**
   * A read that carries NextStep has seen the opp, so a null `nextStep` means it has none. False when only the daily
   * book read (which selects no NextStep) or a DC row has: no next step is then unknown, not missing.
   */
  nextStepRead: z.boolean().default(true),
  products: z.array(z.string()).default([]),
  owner: PersonRef.nullable().default(null),
  /** Opportunity team members besides the owner, when read (D-103 (a): a covered AE matches as one). Absent: not read. */
  team: z.array(PersonRef.extend({ org62UserId: z.string().nullable().optional() })).optional(),
  org62Url: Url.nullable().default(null),
  /** My DC on it (split, role), or null. */
  myDc: MyDc.nullable().default(null),
  /** ForecastCategoryName as the Org62 scans read it ("Commit", "Best Case", "Pipeline", "Omitted", "Closed"); null when not read. */
  forecastCategory: z.string().nullable().default(null),
  /** IsWon (closed won). */
  isWon: z.boolean().default(false),
  updatedAt: IsoDateTime,
});
export type Opportunity = z.infer<typeof Opportunity>;

export const MissedOpp = z.object({
  id: Id,
  /** Claim = clearly mine and missing a DC; Check = ambiguous. */
  verdict: z.enum(['claim', 'check']),
  oppId: Id.nullable(), // set when the opp is also in `opps`
  oppName: z.string(),
  accountName: z.string(),
  amount: z.number().nullable(),
  stage: z.string(),
  closeDate: IsoDate.nullable(),
  evidence: z.array(z.string()), // "D360 product line", "Your account, no DC", "Activity 3w ago"
  otherDcs: z.array(z.string()).default([]),
  status: z.enum(['new', 'claimed', 'dismissed', 'resolved']),
  dismissReason: z.string().nullable().default(null),
  /** The fallback task when the app didn't know the opp (a claim is otherwise a DC request: `dcRequestId`). */
  claimedWorkItemId: Id.nullable().default(null),
  /** The DC request a Claim added (Deals ▸ DCs). */
  dcRequestId: Id.nullable().default(null),
  foundAt: IsoDateTime,
});
export type MissedOpp = z.infer<typeof MissedOpp>;

/** One of my DCs on an account's open opps (the Deals list row's words). */
export const AccountDc = z.object({ oppId: Id, oppName: z.string(), split: z.number().nullable(), role: z.string().nullable() });
export type AccountDc = z.infer<typeof AccountDc>;

export const AccountRow = Account.extend({
  /** My DCs on its open opps. */
  myDcs: z.array(AccountDc).default([]),
  openOpps: z.number().int(),
  openTasks: z.number().int(),
  pipelineAmount: z.number(),
  nextCloseDate: IsoDate.nullable(),
});
export type AccountRow = z.infer<typeof AccountRow>;

/**
 * Why an open opp is a DC gap (src/engines/deals/needs.ts): I'm on its team · I logged ≥ 1 h on it this quarter ·
 * the missed-opp sweep has a Claim finding on it · a VDP I'm on links it (DC-32, read from the VDP mirror).
 */
export const DcGapReason = z.enum(['team', 'hours', 'sweep', 'vdp']);
export type DcGapReason = z.infer<typeof DcGapReason>;

/** One opp a DC-gap row stands for: open, no DC of mine, no request in flight, and strong evidence it is mine. */
export const DcGapOpp = z.object({
  oppId: Id,
  oppName: z.string(),
  amount: z.number().nullable(),
  hoursQtd: z.number(),
  onTeam: z.boolean(),
  reasons: z.array(DcGapReason),
  /** The sweep's evidence lines, when it has a Claim finding on the opp. */
  evidence: z.array(z.string()).default([]),
});
export type DcGapOpp = z.infer<typeof DcGapOpp>;

/**
 * One "needs you" row on Deals (computed once on the server: getDeals `needs`, getAccount `needs`; the Assistant
 * reads the same rows). Log & fix = DC gaps (`opps` names each one), Think ahead = closing soon or past close,
 * Chase = a DC requested and not granted yet. `resolve` says how it can be set aside (Not needed, Snooze 1 week).
 */
export const DealsNeed = z.object({
  id: z.string(),
  section: z.enum(['fix', 'ahead', 'chase']),
  accountId: Id,
  accountName: z.string(),
  title: z.string(),
  why: z.string(),
  badge: z.string().nullable(),
  tone: z.enum(['danger', 'warning', 'none']),
  verb: z.object({ label: z.string(), href: z.string() }),
  /** Sort key inside the section (lower first). */
  rank: z.number(),
  /** A DC gap: the opp Claim DC opens the form on (the first of `opps`). */
  claimOppId: Id.nullable().default(null),
  /** A DC gap: exactly the opps it counts, with why each one counts. */
  opps: z.array(DcGapOpp).default([]),
  resolve: NeedResolve.nullable().default(null),
});
export type DealsNeed = z.infer<typeof DealsNeed>;

// ---------------------------------------------------------------------------
// Pipeline: the Deals summary and pipeline by fiscal quarter (src/server/deals/pipeline.ts, one pure function both
// DataSources call; the filters in src/lib/pipeline-filter.ts, shared by the summary and the list it links to)
// ---------------------------------------------------------------------------

/**
 * Where a deal sits. Forecast basis (Org62 ForecastCategoryName, or an AE's ForecastStatus__c): won, commit,
 * best_case, pipeline, omitted. Stage basis (when no opp of mine carries a forecast category): won, late, mid, early.
 * Lost deals are left out of the pipeline.
 */
export const PipelineCategory = z.enum(['won', 'commit', 'best_case', 'pipeline', 'late', 'mid', 'early', 'omitted']);
export type PipelineCategory = z.infer<typeof PipelineCategory>;

/** One chart segment, in stack order (bottom first). `tier` is how sure it is: 0 won, 1 most likely … 3 least. */
export const PipelineSegmentDef = z.object({ key: PipelineCategory, label: z.string(), tier: z.number().int().min(0).max(3) });
export type PipelineSegmentDef = z.infer<typeof PipelineSegmentDef>;

/** A sum and how many deals make it. */
export const PipeSum = z.object({ amount: z.number(), count: z.number().int() });
export type PipeSum = z.infer<typeof PipeSum>;

/** One of my deals as the pipeline counts it: an opp (SE), or a Specialist Forecast I own (AE). */
export const PipelineRow = z.object({
  /** The row key: the opp id, or the Specialist Forecast's id. */
  id: z.string(),
  oppId: Id.nullable(),
  /** The Specialist Forecast behind the row (AE). */
  forecastId: Id.nullable().default(null),
  accountId: Id.nullable(),
  accountName: z.string().nullable(),
  name: z.string(),
  stage: z.string().nullable(),
  /** The amount the pipeline sums (`DealsPipeline.amountField`), at 100%. */
  amount: z.number().nullable(),
  closeDate: IsoDate.nullable(),
  /** The fiscal quarter it closes in ("Q4 FY27"), null without a close date. */
  quarter: z.string().nullable(),
  category: PipelineCategory,
  /** forecast: Org62 says so · stage: grouped by its stage · default: no forecast category read, counted as Pipeline. */
  categoryFrom: z.enum(['forecast', 'stage', 'default']),
  /** The Org62 value behind `category` ("Best Case", "Closed Won"), when there is one. */
  forecastLabel: z.string().nullable(),
  isOpen: z.boolean(),
  isWon: z.boolean(),
  nextStep: z.string().nullable(),
  /** Why it needs a look: close date passed while open; no next step on a deal closing this quarter. */
  attention: z.array(z.enum(['past_close', 'no_next_step'])),
  /** How it is mine: on the opp team, holding my DC, both, or my Specialist Forecast. */
  via: z.enum(['team', 'dc', 'team_dc', 'forecast']),
  /** My DC split (%), when the scans read one. */
  dcSplit: z.number().nullable(),
  url: Url.nullable(),
});
export type PipelineRow = z.infer<typeof PipelineRow>;

export const PipelineQuarter = z.object({
  label: z.string(),
  start: IsoDate,
  end: IsoDate,
  /** previous: shown for its wins only · current · next (the 3 after it). */
  role: z.enum(['previous', 'current', 'next']),
  /** Every segment in `DealsPipeline.segments` order (zeros included). */
  segments: z.array(PipeSum.extend({ key: PipelineCategory })),
  total: PipeSum,
});
export type PipelineQuarter = z.infer<typeof PipelineQuarter>;

export const DealsSummary = z.object({
  /** Open deals in the pipeline (omitted ones left out). */
  open: PipeSum,
  /** This quarter's open deals by segment: commit and best case (or late and mid stage) lead. */
  thisQuarter: z.object({ label: z.string(), segments: z.array(PipeSum.extend({ key: PipelineCategory })) }),
  wonThisQuarter: PipeSum,
  closingSoon: PipeSum.extend({ days: z.number().int() }),
  attention: PipeSum.extend({ pastClose: z.number().int(), noNextStep: z.number().int() }),
});
export type DealsSummary = z.infer<typeof DealsSummary>;

export const DealsPipeline = z.object({
  /** Whose deals: opps I'm on the team of or hold a DC on (SE), or the Specialist Forecasts I own (AE). */
  basis: z.enum(['team_or_dc', 'specialist_forecast']),
  /** The Org62 field every amount sums, and its words. */
  amountField: z.object({ field: z.string(), label: z.string() }),
  /** forecast: segments are forecast categories · stage: stage groups (no forecast category was read). */
  categoryBasis: z.enum(['forecast', 'stage']),
  segments: z.array(PipelineSegmentDef),
  today: IsoDate,
  currentQuarter: z.string(),
  /** The previous quarter (its wins), this quarter and the next 3. */
  quarters: z.array(PipelineQuarter),
  summary: DealsSummary,
  /** Open and won deals, closing soonest first. */
  rows: z.array(PipelineRow),
  /** Whether next steps are read at all (some deal carries one): without them no deal is flagged for a missing one. */
  nextStepRead: z.boolean(),
  /** Plain-English gaps ("2 open opps have no close date, so no quarter"). */
  notes: z.array(z.string()),
});
export type DealsPipeline = z.infer<typeof DealsPipeline>;

/**
 * GET /deals paging (p4-page-scoped-reads, additive): `limit` accounts from `cursor` (the previous page's
 * `nextCursor`). No `limit` = every account, as before; the summary, pipeline and needs always count every account.
 */
export const DealsQuery = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type DealsQuery = z.infer<typeof DealsQuery>;

export const DealsPayload = z.object({
  accounts: z.array(AccountRow),
  missedCount: z.number().int(),
  pipeline: DealsPipeline,
  /** What needs you on a deal (Log & fix, Think ahead, Chase), set-aside rows left out: the same rows the Assistant reads. */
  needs: z.array(DealsNeed).default([]),
  /** With `limit`: the cursor of the next page, null on the last (absent without `limit`). */
  nextCursor: z.string().nullable().optional(),
});
export type DealsPayload = z.infer<typeof DealsPayload>;

export const MissedPayload = z.object({
  missed: z.array(MissedOpp),
  lastSweepAt: IsoDateTime.nullable(),
});
export type MissedPayload = z.infer<typeof MissedPayload>;

// ---------------------------------------------------------------------------
// Deal Contribution requests (D-58): DCs to claim, handed to Slackbot as ADD rows on the next logging canvas
// ---------------------------------------------------------------------------

/** The Opportunity_Role__c a DC is claimed with unless the request names one (the SE's role). */
export const DEFAULT_DC_ROLE = 'AI + Data Architect';

/** The DC comment a Claim uses when the user gave none: the sweep's evidence, in a line. */
export function claimComment(evidence: readonly string[]): string {
  const ev = evidence.filter(Boolean).slice(0, 3).join('; ');
  return (ev ? `Claimed from Missed opportunities: ${ev}` : 'Claimed from Missed opportunities').slice(0, 1000);
}

/** The Opportunity_Role__c a persona claims with by default (Claim forms prefill it; the request can name another). */
const DC_ROLE_BY_PERSONA: Readonly<Record<string, string>> = { se: DEFAULT_DC_ROLE };
export function dcRoleFor(personaId: string | null | undefined): string {
  return (personaId && DC_ROLE_BY_PERSONA[personaId]) || DEFAULT_DC_ROLE;
}

export const DcRequestStatus = z.enum(['proposed', 'approved', 'synced_to_canvas', 'logged', 'verified', 'dismissed']);
export type DcRequestStatus = z.infer<typeof DcRequestStatus>;

/**
 * `add` claims a DC I don't hold; `change` changes the split of the one I hold (`fromSplit` → `splitPercent`): an
 * UPDATE row on that Deal_Contribution__c. A request never changes an existing DC unless it is a change.
 */
export const DcRequestKind = z.enum(['add', 'change']);
export type DcRequestKind = z.infer<typeof DcRequestKind>;

/**
 * Why the app closed a request by itself (D-68), never silently: `not_created` (a canvas handed it to Slackbot, and a
 * complete Org62 read since shows no such DC: ask again), `changed_in_org62` (a change still waiting, and someone set
 * another split in Org62: Org62 wins, never overwritten), `dc_removed` (a change whose DC is gone from Org62),
 * `opp_deleted` (the opportunity was deleted in Org62).
 */
export const DcRequestOutcome = z.enum(['not_created', 'changed_in_org62', 'dc_removed', 'opp_deleted']);
export type DcRequestOutcome = z.infer<typeof DcRequestOutcome>;

export const DcRequest = z.object({
  id: Id,
  kind: DcRequestKind.default('add'),
  /** The app's opportunity. */
  oppId: Id,
  oppName: z.string(),
  accountId: Id.nullable(),
  accountName: z.string().nullable(),
  /** The 006… id Slackbot creates the DC on (null when the app doesn't know it yet: the row waits). */
  org62OpportunityId: z.string().nullable(),
  role: z.string(),
  splitPercent: z.number().min(0).max(100),
  /** A change: the split of my DC when it was requested (null when the scan hadn't read it). */
  fromSplit: z.number().nullable().default(null),
  comment: z.string().nullable(),
  status: DcRequestStatus,
  /**
   * Where it is now: `waiting` for the next logging canvas with rows (or Log DCs now), `in_canvas` (a canvas item on
   * Time holds it, waiting for Apply), `handed_off` (the canvas exists; Slackbot has the row), `confirmed` (an Org62
   * scan read my DC on the opp: an add confirms whatever split Org62 shows), `not_created` (DC-06: handed off, and a
   * complete Org62 read since shows no such DC; the opp is a gap again and "Ask again" makes a new request),
   * `dismissed` (withdrawn, by you or, with `outcome`, by the app).
   */
  stage: z.enum(['waiting', 'in_canvas', 'handed_off', 'confirmed', 'not_created', 'dismissed']),
  /** Why the app closed it by itself (null: it didn't). */
  outcome: DcRequestOutcome.nullable().default(null),
  /** The app's words for `outcome` ("Org62 now shows 75%: changed there, so it was withdrawn"), else null. */
  note: z.string().nullable().default(null),
  /** The canvas item that holds or carried it. */
  canvasDraftId: Id.nullable(),
  /** The canvas in Slack, once that item was applied (its result link). */
  canvasUrl: Url.nullable().default(null),
  /** My DC on the opp now (a change targets it; a confirmed request is linked to it). */
  dc: MyDc.nullable().default(null),
  /** Null: you can edit or withdraw it. Otherwise why not (on a canvas, handed to Slackbot, confirmed, withdrawn). */
  lockedReason: z.string().nullable().default(null),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DcRequest = z.infer<typeof DcRequest>;

/** One of my DCs as Deals ▸ DCs and the Assistant list them. */
export const MyDcRow = MyDc.extend({
  oppId: Id,
  oppName: z.string(),
  /** The opp's 006… id (null when the app has none for it). */
  org62OpportunityId: z.string().nullable().default(null),
  accountId: Id.nullable(),
  accountName: z.string().nullable(),
  isOpen: z.boolean(),
});
export type MyDcRow = z.infer<typeof MyDcRow>;

export const DcRequestsPayload = z.object({
  requests: z.array(DcRequest),
  /** Every DC of mine the Org62 scans have read (what a request is checked against). */
  myDcs: z.array(MyDcRow).default([]),
});
export type DcRequestsPayload = z.infer<typeof DcRequestsPayload>;

/** An Opportunity's Org62 id: 006 plus 12 characters, 15 or 18 long. */
export const Org62OppId = z.string().trim().regex(/^006[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/, 'an Org62 Opportunity id (006…, 15 or 18 characters)');

/**
 * POST /deals/org62-opps: add opps the app doesn't track (and their accounts) from Org62, one read. The app tracks the
 * opps on my teams and the ones I hold a DC on; this brings in others (a DC to claim on a teammate's deal). Already
 * tracked ones are left as they are; ids Org62 doesn't return are listed as missing. Nothing is written to Org62.
 */
export const AddOrg62OppsRequest = z.object({ org62Ids: z.array(Org62OppId).min(1).max(100) });
export type AddOrg62OppsRequest = z.infer<typeof AddOrg62OppsRequest>;

export const AddedOrg62Opp = z.object({
  oppId: Id,
  org62OpportunityId: z.string(),
  name: z.string(),
  accountName: z.string().nullable(),
});
export type AddedOrg62Opp = z.infer<typeof AddedOrg62Opp>;

export const AddOrg62OppsResult = z.object({
  /** Read from Org62 and added now. */
  added: z.array(AddedOrg62Opp),
  /** Already in the app (left as they are). */
  tracked: z.array(AddedOrg62Opp),
  /** Ids Org62 didn't return (a typo, or a record you can't see). */
  missing: z.array(z.string()),
});
export type AddOrg62OppsResult = z.infer<typeof AddOrg62OppsResult>;

export const CreateDcRequestRequest = z.object({
  /** The app's opportunity id, or its Org62 id (006…, 15 or 18 characters). */
  opp: z.string().trim().min(3).max(200),
  /** Split_Percentage__c. */
  split: z.number().min(1).max(100),
  /** Comments__c: what I did on the opportunity (the evidence), as the DC should read. */
  comment: z.string().trim().min(3).max(1000),
  /** Opportunity_Role__c; default DEFAULT_DC_ROLE. */
  role: z.string().trim().min(2).max(80).optional(),
});
export type CreateDcRequestRequest = z.infer<typeof CreateDcRequestRequest>;

/** Edit a request that waits for a canvas: any of split, role, comment (re-checked against my DC on the opp). */
export const PatchDcRequestRequest = z
  .object({
    split: z.number().min(1).max(100).optional(),
    role: z.string().trim().min(2).max(80).optional(),
    comment: z.string().trim().min(3).max(1000).optional(),
  })
  .refine((b) => b.split !== undefined || b.role !== undefined || b.comment !== undefined, { message: 'change the split, the role or the comment' });
export type PatchDcRequestRequest = z.infer<typeof PatchDcRequestRequest>;

/** 2026-11-13 audit C7: withdraw several DC requests still waiting for a canvas in one change (one Undo). No ids: every waiting one. */
export const WithdrawDcRequestsRequest = z.object({ ids: z.array(Id).max(2000).optional() });
export type WithdrawDcRequestsRequest = z.infer<typeof WithdrawDcRequestsRequest>;

export const WithdrawDcRequestsResult = z.object({
  withdrawn: z.array(Id),
  /** Named but not withdrawn (on a canvas, confirmed, gone), each with why. */
  skipped: z.array(z.object({ id: Id, why: z.string() })),
});
export type WithdrawDcRequestsResult = z.infer<typeof WithdrawDcRequestsResult>;

/**
 * Missed ▸ Claim: a DC request on the finding's opp (the same rules as createDcRequest). Defaults: 100%, the role's DC
 * role, the finding's evidence as the comment. When the app doesn't know the opp, a task to add the DC instead.
 */
export const ClaimMissedRequest = z
  .object({
    split: z.number().min(1).max(100).optional(),
    role: z.string().trim().min(2).max(80).optional(),
    comment: z.string().trim().min(3).max(1000).optional(),
  })
  .default({});
export type ClaimMissedRequest = z.infer<typeof ClaimMissedRequest>;

// ---------------------------------------------------------------------------
// VDP use cases → Org62 Use_Case__c (D-67)
// ---------------------------------------------------------------------------

/**
 * Where one use case stands across VDP and Org62 (src/engines/activity/use-cases.ts planUseCases):
 * create (rides the next logging canvas) · update (a Stage / Go-Live change rides it) · in_canvas (on a canvas waiting
 * for your Apply) · handed_off (on a canvas you applied, waiting for Slackbot and the read-back) · in_org62 (linked,
 * the same on both sides) · drift (the two disagree: `drift` has both values and how each is fixed) · org62_only (a
 * Use_Case__c no VDP use case is: an item in Time ▸ VDP adds it there) · duplicate (a second record of the same use
 * case in Org62: delete it there) · others (Org62 has it, owned by someone else: never touched) · gone (deleted in
 * Org62: Add it again or Leave it) · left (you chose to leave it as it is) · skipped (why says what it needs).
 */
export const UseCaseState = z.enum(['create', 'update', 'in_canvas', 'handed_off', 'in_org62', 'drift', 'org62_only', 'duplicate', 'others', 'gone', 'left', 'skipped']);
export type UseCaseState = z.infer<typeof UseCaseState>;

export const UseCaseDrift = z.object({
  field: z.enum(['Stage__c', 'Go_Live_Date__c', 'Use_Case_Name__c', 'Product__c', 'Opportunity__c', 'Account__c']),
  /** VDP's value (in VDP's terms: the execution phase for Stage__c) and Org62's. */
  vdp: z.string(),
  org62: z.string(),
  /** canvas: Org62 follows on the next logging canvas · vdp: an item in Time ▸ VDP · org62_by_hand · choose (both changed). */
  fix: z.enum(['canvas', 'vdp', 'org62_by_hand', 'choose']),
});
export type UseCaseDrift = z.infer<typeof UseCaseDrift>;

export const UseCaseSyncItem = z.object({
  /** `uc:<VDP use case id>`, or `rec:<Use_Case__c id>` for one only Org62 has: the subject of a decision (decideNeed rule `use_case` / `use_case_readd`). */
  key: z.string(),
  vdpSlug: z.string().nullable(),
  vdpUrl: z.string().nullable(),
  companyName: z.string(),
  vdpUseCaseId: z.string().nullable(),
  title: z.string(),
  track: z.string(),
  oppName: z.string().nullable(),
  org62OpportunityId: z.string().nullable(),
  state: UseCaseState,
  why: z.string(),
  org62UseCaseId: z.string().nullable(),
  /** The Use_Case__c in Org62, once known. */
  org62Url: z.string().nullable(),
  canvasDraftId: Id.nullable(),
  /** Field fixes on their way to Org62: Stage / Go-Live as VDP changes them (D-67); any of the four on your pick (D-70). */
  updates: z.array(z.object({ field: z.enum(['Stage__c', 'Go_Live_Date__c', 'Use_Case_Name__c', 'Product__c']), from: z.string(), to: z.string() })).default([]),
  drift: z.array(UseCaseDrift).default([]),
  /** What you can decide on it: leave it as it is (decideNeed rule `use_case`), add a deleted one again (`use_case_readd`). */
  options: z.array(z.enum(['leave', 'readd'])).default([]),
  decided: z.enum(['leave', 'readd']).nullable().default(null),
  /** D-70: what only you can answer before it goes to Org62 (Needs you), with the opps it may go on. */
  question: z.object({ code: z.enum(['pick_opp', 'no_title', 'no_account', 'waiting_dc']), opps: z.array(z.object({ org62Id: z.string(), name: z.string() })) }).nullable().default(null),
});
export type UseCaseSyncItem = z.infer<typeof UseCaseSyncItem>;

const N = z.number().int().min(0);

export const UseCaseSyncPayload = z.object({
  /** When the Org62 read-back last read my opps' use cases (null: never; creates wait for the first read). */
  readAt: IsoDateTime.nullable(),
  items: z.array(UseCaseSyncItem),
  counts: z.object({ create: N, update: N, in_canvas: N, handed_off: N, in_org62: N, drift: N, org62_only: N, duplicate: N, others: N, gone: N, left: N, skipped: N }),
});
export type UseCaseSyncPayload = z.infer<typeof UseCaseSyncPayload>;
