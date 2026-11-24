// Use case vocabulary, keys and the plan's types. Split from use-cases.ts (max-lines); use-cases.ts re-exports every public name.
import type { EngagementSummary } from '@/engines/attribution/types';
import type { VdpGap } from '@/contract';
import { sameUseCaseTitle } from '@/engines/vdp/gaps';
import type { RowOverrides } from '@/lib/canvas/overrides';
import type { VdpSnapshot, VdpUseCase } from '@/lib/vdp/types';

export const USE_CASE_OBJECT = 'Use_Case__c';
// ---------------------------------------------------------------------------
// The Org62 picklists (Use_Case__c describe, read 2026-11-12) and VDP's mapping onto them
// ---------------------------------------------------------------------------

/** VDP execution phase → Stage__c (VDP's own export map; On Hold has no Org62 stage, so it stays as it is). */
export const UC_STAGE_OF_PHASE: Readonly<Record<string, string>> = {
  'Not Started': 'U01 - Not Started',
  Discovery: 'U03 - Scoping',
  Build: 'U05 - Implementation',
  Live: 'U06 - In Production',
  'On Hold': '',
};
export type UcTrack = 'd360' | 'agentforce';
/** Use_Case_Agent_Type__c (multi-select) values per track, in Org62's order; the first is the "… Custom" fallback. */
export const UC_AGENT_TYPES: Readonly<Record<UcTrack, readonly string[]>> = {
  d360: [
    'D360 Custom',
    'D360 for Agentforce',
    'D360 for Analytics (e.g. Tableau Next)',
    'D360 for Industry',
    'D360 for Marketing (aka traditional "CDP")',
    'D360 for Sales',
    'D360 for Service',
    'D360 Other Cloud (Commerce, Revenue)',
  ],
  agentforce: [
    'Agentforce Custom',
    'Agentforce Voice (Internal)',
    'Agentforce Voice (External)',
    'Agentforce for Analytics',
    'Agentforce for Commerce',
    'Agentforce for Field Service',
    'Agentforce for Industry',
    'Agentforce for Integration',
    'Agentforce for Marketing',
    'Agentforce for Platform',
    'Agentforce for Revenue Cloud',
    'Agentforce for Sales',
    'Agentforce for Service',
    'Agentforce for Slack',
    'help.salesforce',
    'Agentforce Operations',
    'Qualified',
  ],
};
/**
 * Org62's own picklists on Use_Case__c (its schema, read 2026-11-13), for the canvas review's edit forms: Stage__c,
 * Product__c, Entitlement_Leveraged__c. Use_Case_Agent_Type__c is UC_AGENT_TYPES.
 */
export const UC_STAGES: readonly string[] = ['U01 - Not Started', 'U02 - Ideation', 'U03 - Scoping', 'U04 - Validation', 'U05 - Implementation', 'U06 - In Production', 'U07 - Lost'];
export const UC_PRODUCTS: readonly string[] = ['Data Cloud', 'Agentforce'];
export const UC_ENTITLEMENTS: readonly string[] = ['Flex', 'Data Services', 'Conversations', 'Bundled Products'];
export const ucTrack = (t: string | null | undefined): UcTrack => (t === 'agentforce' ? 'agentforce' : 'd360');
/** Product__c of a track. */
export const ucProduct = (t: string | null | undefined): 'Data Cloud' | 'Agentforce' => (ucTrack(t) === 'agentforce' ? 'Agentforce' : 'Data Cloud');
/** Stage__c for a VDP execution phase: '' when VDP has none (Org62 then keeps its default, U01) or it is On Hold. */
export const ucStage = (phase: string | null | undefined): string => (phase ? (UC_STAGE_OF_PHASE[phase] ?? '') : '');
/** Go_Live_Date__c (YYYY-MM-DD) from VDP's target date, '' when none. */
export const ucGoLive = (d: string | null | undefined): string => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : '');
export const genStr = (uc: Pick<VdpUseCase, 'generatedFields'>, key: string): string => {
  const v = uc.generatedFields?.[key];
  return typeof v === 'string' ? v.trim() : '';
};
/** The agent types VDP inferred for a use case (on the track's list, in Org62's order), else the track's "… Custom". */
export function ucAgentTypes(uc: Pick<VdpUseCase, 'track' | 'generatedFields'>): string[] {
  const allowed = UC_AGENT_TYPES[ucTrack(uc.track)];
  const raw = uc.generatedFields?.consumption_use_cases;
  const vals = new Set((Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter((v): v is string => typeof v === 'string'));
  const picked = allowed.filter((a) => vals.has(a));
  return picked.length ? picked : [allowed[0]!];
}
/** Entitlement_Leveraged__c: Flex, unless the VDP header names the track's one other value (VDP's resolveEntitlementForTrack). */
export function ucEntitlement(override: string | null | undefined, track: string | null | undefined): string {
  const v = override?.trim();
  if (ucTrack(track) === 'agentforce') return v === 'Conversations' ? 'Conversations' : 'Flex';
  return v === 'Data Services' ? 'Data Services' : 'Flex';
}
/**
 * The longest text the Org62 field holds: Business_Problem_Solved__c, Business_Problem_KPIs__c and Notes__c are Long
 * Text Areas of 32,768 characters (Org62 Use_Case__c schema, read 2026-11-13). Only text past that stays in VDP,
 * linked from Notes; the canvas itself holds ~900 KB (CANVAS_MAX_BYTES), so it never forces a cut.
 */
export const UC_TEXT_MAX = 32_768;
const MORE = ' … (more in VDP)';
/** Text cut to what the field holds (a line break counts once in Org62: the canvas's ` ⏎ ` turns back into one). */
export const ucClip = (s: string, max = UC_TEXT_MAX): string => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - MORE.length)).trimEnd()}${MORE}`);
export const clip = (s: string, max = UC_TEXT_MAX) => ucClip(s, max);
/** How names compare: case, spacing and Unicode forms aside. */
export const ucNameKey = (s: string | null | undefined): string => (s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export const id15 = (s: string | null | undefined) => (s ?? '').slice(0, 15);
/** The opp + name key of a use case. */
export const ucMatchKey = (org62OppId: string | null | undefined, name: string | null | undefined) => `${id15(org62OppId)}|${ucNameKey(name)}`;
/** The key a use case's ADD row carries (`CC-UC#<VDP use case id>` at the end of Notes__c). */
export const ucCreateKey = (vdpUseCaseId: string) => `uc:${vdpUseCaseId}`;
/** The key of one field update on a record. */
export const ucUpdateKey = (recordId: string, field: string) => `ucu:${id15(recordId)}|${field}`;
export const CC_UC = /CC-UC#([A-Za-z0-9-]+)/;
/**
 * Two use-case titles that name the same use case. D-69 (VD-34): VDP's `sameUseCaseTitle` itself now requires the
 * numbers and other distinguishing tokens to match ("Phase 1" is never "Phase 2"), so this is that matcher; the name
 * stays for this lane's callers and tests.
 */
export const ucSameTitle = sameUseCaseTitle;
/** Stage__c → VDP's execution phase (the reverse of UC_STAGE_OF_PHASE; U02-U04 are all VDP's Discovery, U07 its On Hold). */
export function phaseOfStage(stage: string | null | undefined): string {
  const m = /^U0([1-7])\b/.exec(stage ?? '');
  if (!m) return '';
  return ({ '1': 'Not Started', '2': 'Discovery', '3': 'Discovery', '4': 'Discovery', '5': 'Build', '6': 'Live', '7': 'On Hold' } as Record<string, string>)[m[1]!] ?? '';
}
/** Phases as the drift check compares them: Not Started is the same as none (Org62's default stage is U01). */
export const phaseKey = (p: string | null | undefined) => (!p || p === 'Not Started' ? '' : p);
/** Product__c → VDP track. */
export const trackOfProduct = (p: string | null | undefined): UcTrack => (p === 'Agentforce' ? 'agentforce' : 'd360');
// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One opportunity as the plan reads it. */
export interface UcOpp {
  /** The app's opportunity id. */
  id: string;
  org62Id: string;
  name: string;
  /** The app's account id. */
  accountId: string | null;
  accountOrg62Id: string | null;
  isOpen: boolean;
  /** D-63: my DC split on it (100 makes it in scope); null when I hold none or it was not read. */
  dcSplit: number | null;
  closeDate: string | null;
}
/**
 * A mirror snapshot made safe to read: rows stored before a field existed (or by an older reader) may lack the company,
 * the slug, the flags or the use-case list. A bad VDP row must never stop a logging batch.
 */
export function ucNormalizeVdp(v: UcVdp, slug?: string | null): UcVdp {
  const s = (v.snapshot ?? {}) as Partial<VdpSnapshot>;
  const sl = s.slug || slug || s.id || 'vdp';
  return {
    accountId: v.accountId ?? null,
    snapshot: {
      ...(s as VdpSnapshot),
      id: s.id ?? sl,
      slug: sl,
      url: s.url ?? null,
      company: s.company?.name ? s.company : { id: s.company?.id ?? null, name: s.company?.name || sl, slug: s.company?.slug ?? null, industry: s.company?.industry ?? null, segment: s.company?.segment ?? null },
      salesforceAccountId: s.salesforceAccountId ?? null,
      salesforceOpportunityId: s.salesforceOpportunityId ?? null,
      isSeed: !!s.isSeed,
      archivedAt: s.archivedAt ?? null,
      useCases: (Array.isArray(s.useCases) ? s.useCases : []).filter((u): u is VdpUseCase => !!u && typeof u.id === 'string').map((u) => ({ ...u, displayOrder: typeof u.displayOrder === 'number' ? u.displayOrder : 0, track: u.track ?? 'd360' })),
    },
  };
}
/** D-63: an open opp with my 100% DC: the only kind a new use case goes on. */
export const ucInScope = (o: Pick<UcOpp, 'isOpen' | 'dcSplit'>) => o.isOpen && o.dcSplit === 100;
/** One VDP of mine (not gone) and the app account it links to (linkVdp). */
export interface UcVdp {
  snapshot: VdpSnapshot;
  accountId: string | null;
}
/** One Use_Case__c the read-back saw on my opps. */
export interface Org62UseCase {
  id: string;
  opportunityId: string | null;
  accountId: string | null;
  name: string | null;
  ownerId: string | null;
  createdById: string | null;
  stage: string | null;
  goLive: string | null;
  product: string | null;
  createdAt: string | null;
  /** A complete read of its opp no longer returned it (deleted, or moved to an opp the app doesn't read). */
  goneAt: string | null;
}
/** VDP use case ↔ Use_Case__c, and the values the app last wrote there or saw agree on both sides. */
export interface UseCaseLink {
  vdpUseCaseId: string;
  org62UseCaseId: string;
  /** `app`: a logging canvas the user applied created it; `adopted`: it was there already (never updated by the app). */
  origin: 'app' | 'adopted';
  syncedStage: string | null;
  syncedGoLive: string | null;
  syncedName: string | null;
}
/** A create row as a canvas carries it (read back from the markdown). */
export interface UcCanvasCreate {
  vdpUseCaseId: string;
  opportunityId: string;
  name: string;
  stage: string;
  goLive: string;
}
/** An update row as a canvas carries it. */
export interface UcCanvasUpdate {
  recordId: string;
  field: string;
  newValue: string;
}
/** What the logging canvases hold: pending ones (waiting for Apply) and sent ones (Slackbot has them). */
export interface UseCaseHolds {
  /** Row key → the canvas item waiting for Apply that holds it. */
  held: ReadonlyMap<string, string>;
  /** Row key → the sent canvas item and when it was sent. */
  sent: ReadonlyMap<string, { draftId: string; at: string }>;
  /** VDP use case id → the create row a sent canvas carried (the opp and name exactly as Slackbot got them). */
  sentCreates: ReadonlyMap<string, UcCanvasCreate & { draftId: string; at: string }>;
}
export const NO_UC_HOLDS: UseCaseHolds = { held: new Map(), sent: new Map(), sentCreates: new Map() };
/**
 * The user's choices on items with no right answer for the app (D-61 decisions, `use_case` / `use_case_readd`), by
 * item key (`uc:<VDP use case id>` or `rec:<Use_Case__c id, 15>`): leave it as it is, or add a deleted one again.
 */
export interface UseCaseDecisions {
  leave: ReadonlySet<string>;
  readd: ReadonlySet<string>;
}
export const NO_UC_DECISIONS: UseCaseDecisions = { leave: new Set(), readd: new Set() };
/** The decisions' rules (src/contract/needs.ts NeedRule). */
export const UC_LEAVE_RULE = 'use_case';
export const UC_READD_RULE = 'use_case_readd';
/**
 * D-70: your pick of the right value of one field that differs (Activity ▸ Org62 ▸ Use cases), with both values as they
 * were when you picked: it holds only while they still read that way (a new difference asks again).
 */
export interface UcPick {
  take: 'org62' | 'vdp';
  vdp: string;
  org62: string;
}
/** A pick's key: the VDP use case and the Org62 field. */
export const ucPickKey = (vdpUseCaseId: string, field: UcDriftField) => `${vdpUseCaseId}|${field}`;
/** Where a pick is kept: with your other canvas-row edits (src/lib/canvas/overrides.ts), under `pick:<ucPickKey>`. */
export const ucPickRowKey = (vdpUseCaseId: string, field: UcDriftField) => `pick:${ucPickKey(vdpUseCaseId, field)}`;
/** Your picks among your row edits (a cleared one has an empty `take`). */
export function ucPicksOf(overrides: RowOverrides | null | undefined): Map<string, UcPick> {
  const out = new Map<string, UcPick>();
  for (const [k, o] of Object.entries(overrides ?? {})) {
    if (!k.startsWith('pick:')) continue;
    const take = o.fields.take;
    if (take !== 'org62' && take !== 'vdp') continue;
    out.set(k.slice(5), { take, vdp: typeof o.fields.vdp === 'string' ? o.fields.vdp : '', org62: typeof o.fields.org62 === 'string' ? o.fields.org62 : '' });
  }
  return out;
}
export interface UseCasePlanInput {
  /** My live VDPs (not gone from my list). */
  vdps: readonly UcVdp[];
  /** VDPs no longer mine (gone from my list): their linked records stay quiet, never Org62-only. */
  goneVdps?: readonly UcVdp[];
  opps: readonly UcOpp[];
  /** The read-back: when it last read my opps' use cases (null: never), and the records it saw. */
  org62: { readAt: string | null; records: readonly Org62UseCase[] };
  links: readonly UseCaseLink[];
  holds: UseCaseHolds;
  /** My Org62 user id (OwnerId of the records the app creates; ownership checks). */
  me: string | null;
  decisions?: UseCaseDecisions;
  /** Your edits on canvas rows before Apply (src/lib/canvas/overrides.ts): a create's fields, a fix's new value. */
  overrides?: RowOverrides;
  /** D-70: your picks of the right value where the two systems differ, by ucPickKey. */
  picks?: ReadonlyMap<string, UcPick>;
  /** The attribution engine's extras for the use-case opp pre-fill (my engagement per opp); absent: words and account only. */
  attribution?: { engagement?: Record<string, EngagementSummary>; today?: string };
}
// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface UseCaseCreate {
  vdpUseCaseId: string;
  vdpSlug: string;
  vdpUrl: string | null;
  companyName: string;
  displayOrder: number;
  name: string;
  /** Org62 ids. */
  opportunityId: string;
  accountId: string;
  oppName: string;
  oppCloseDate: string | null;
  product: string;
  agentTypes: string[];
  entitlement: string;
  stage: string;
  goLive: string;
  businessProblem: string;
  kpis: string;
  notes: string;
  /** Offered again: a canvas carried it and a read two days later had no such record, or you chose Add it again. */
  again: boolean;
}
/** The Use_Case__c fields a canvas UPDATE row may set: Stage / Go-Live as VDP changes them (D-67), and any of these four on your pick (D-70). */
export type UcUpdateField = 'Stage__c' | 'Go_Live_Date__c' | 'Use_Case_Name__c' | 'Product__c';
export interface UseCaseUpdate {
  vdpUseCaseId: string;
  recordId: string;
  field: UcUpdateField;
  newValue: string;
  currentValue: string;
  name: string;
  why: string;
}
export type UseCaseState = 'create' | 'update' | 'in_canvas' | 'handed_off' | 'in_org62' | 'drift' | 'org62_only' | 'duplicate' | 'others' | 'gone' | 'left' | 'skipped';
export const USE_CASE_STATES: readonly UseCaseState[] = ['create', 'update', 'in_canvas', 'handed_off', 'in_org62', 'drift', 'org62_only', 'duplicate', 'others', 'gone', 'left', 'skipped'];
/** States that ask nothing of anyone (done, or set aside). */
export const UC_QUIET: ReadonlySet<UseCaseState> = new Set(['in_org62', 'others', 'left']);
export type UcDriftField = 'Stage__c' | 'Go_Live_Date__c' | 'Use_Case_Name__c' | 'Product__c' | 'Opportunity__c' | 'Account__c';
/**
 * How one difference gets fixed: `canvas` (Org62 follows on the next logging canvas), `vdp` (an item in the VDP tree),
 * `org62_by_hand` (change it in Org62: not a field or record the app writes), `choose` (both sides changed).
 */
export type UcDriftFix = 'canvas' | 'vdp' | 'org62_by_hand' | 'choose';
export interface UcDrift {
  field: UcDriftField;
  vdp: string;
  org62: string;
  fix: UcDriftFix;
}
/** One use case (in VDP, in Org62, or both) and where it stands (tenet: Legible). */
export interface UseCaseItem {
  /** `uc:<VDP use case id>`, or `rec:<Use_Case__c id, 15>` for one only Org62 has: the decision subject. */
  key: string;
  vdpSlug: string | null;
  vdpUrl: string | null;
  companyName: string;
  vdpUseCaseId: string | null;
  title: string;
  track: string;
  oppName: string | null;
  org62OpportunityId: string | null;
  state: UseCaseState;
  why: string;
  org62UseCaseId: string | null;
  canvasDraftId: string | null;
  /** Field fixes on their way to Org62 (state update, in_canvas or handed_off). */
  updates: Array<{ field: UcUpdateField; from: string; to: string }>;
  /** Every value the two sides disagree on, both values, and how each is fixed. */
  drift: UcDrift[];
  /** What the user can decide here: leave it as it is, or add a deleted one again (and undo either). */
  options: Array<'leave' | 'readd'>;
  decided: 'leave' | 'readd' | null;
  /**
   * D-70: what only you can answer before it can go to Org62 (Needs you): the opp it goes on (`pick_opp`, with the
   * choices), a name (`no_title`), an account (`no_account`), your 100% DC (`waiting_dc`). Null: none.
   */
  question?: UcQuestion | null;
}
export interface UcQuestion {
  code: 'pick_opp' | 'no_title' | 'no_account' | 'waiting_dc';
  /** pick_opp: the attribution engine's order (src/lib/canvas/prefill.ts), its best first. */
  opps: Array<{ org62Id: string; name: string }>;
  /** pick_opp: the pre-fill, when the engine prefers one opp (one click: it is never applied for you). */
  suggested?: { org62Id: string; confidence: number; why: string } | null;
}
export interface UseCasePlan {
  creates: UseCaseCreate[];
  updates: UseCaseUpdate[];
  items: UseCaseItem[];
  counts: Record<UseCaseState, number>;
  /** VDP-side items (Org62 → VDP): per VDP slug, the gaps the VDP tree turns into `use_cases` items. */
  vdpGaps: ReadonlyMap<string, VdpGap[]>;
}
