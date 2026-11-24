/**
 * Deal Contribution requests (D-58): "claim a DC on this opp" in the app, handed to Slackbot on the next logging
 * canvas. Pure, shared by both DataSources (the same rules on the mock and on Postgres).
 *
 * - A request is checked against my DC on the opp (`planDcRequest`), never only by the prompt: the same split as my
 *   DC is refused; a different split is an explicit **change** (`kind: 'change'`, `fromSplit`), an UPDATE row on that
 *   Deal_Contribution__c ("Change your DC 50% → 100%"); no DC is an **add**, a create row. One live request per opp.
 * - A request is created `approved` (the user's Apply of a chat card, or their own click, is the approval). Nothing is
 *   sent: it waits for the next logging canvas that has rows (Time ▸ Log, or the Assistant's `chat_log_batch` with
 *   stage). It never makes a canvas of its own unless the user asks for one (Log DCs now: `dcOnly`).
 * - Holding works like the Time rows' (src/lib/canvas/payload.ts canvasHolds): a canvas item waiting for Apply holds
 *   the DC rows it carries, so staging twice never puts the same DC on two canvases; a rejected item lets them go; a
 *   sent one handed them to Slackbot. The DC rows are read back from the canvas markdown itself (an ADD row's
 *   Opportunity__c id and role cells, a change row's Record Id), so no other payload field is needed.
 * - The rows go into the slackbot.ts work order after it is rendered (`withDcAdds`): adds in their own
 *   DEAL CONTRIBUTIONS TO CREATE table, changes in DEAL CONTRIBUTIONS TO UPDATE (WO-1: one table per object and verb).
 * - An Org62 scan that reads my DC on the opp confirms the request (`reconcileDcRequests`, D-68): an add whatever
 *   split Org62 shows (Org62 wins, DC-03), a change once the split is the requested one; status `verified`, linked to
 *   that DC. A change still waiting whose DC someone changed in Org62 (or removed) is withdrawn, never sent (DC-04); a
 *   request a canvas handed off that a complete read later shows was not created is `not_created` (DC-06): the opp is
 *   a gap again, and "Ask again" makes a new request.
 * - A canvas row is re-checked before Apply (`dcRowStillNeeded`, DC-05: the Outbox preflight registers it).
 */
import { DEFAULT_DC_ROLE, type AccountDc, type DcRequest, type DcRequestKind, type DcRequestOutcome, type DcRequestStatus, type Draft, type MyDc, type MyDcRow, type Opportunity } from '@/contract';
import { CANVAS_HOLDING, canvasInputOf } from '@/lib/canvas/payload';
import { cell } from '@/engines/activity/slackbot';
import { legacyShape, lineInTable, tableSpec, upsertTable } from '@/lib/canvas/tables';
import { AppError } from '@/server/errors';

/** What both DataSources store per request (the mock's collection, the db table's columns). */
export interface DcRequestRecord {
  id: string;
  oppId: string;
  kind: DcRequestKind;
  role: string;
  splitPercent: number;
  /** A change: my DC's split when it was requested. */
  fromSplit: number | null;
  comment: string | null;
  status: DcRequestStatus;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The Deal_Contribution__c a change targets, or the one that confirmed the request. */
  org62DcId: string | null;
  /** Why the app closed it by itself (status `dismissed` with an outcome; D-68). Absent / null: it didn't. */
  outcome?: DcRequestOutcome | null;
}

/** One DC row for Slackbot: an ADD row (create), or a change of my existing DC (UPDATE rows on its Record Id). */
export interface DcAdd {
  requestId: string;
  /** Default `add`. */
  kind?: DcRequestKind;
  org62OpportunityId: string;
  oppName: string;
  role: string;
  split: number;
  comment: string;
  /** A change: the split and role my DC has now, and its Deal_Contribution__c id. */
  fromSplit?: number | null;
  fromRole?: string | null;
  org62DcId?: string | null;
}

/** An Org62 opportunity id: 006 + 12 (15-char) or 15 (18-char) characters. */
export const ORG62_OPP_ID = /^006[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** The 006… id in an opportunity's Org62 link (null when the app has no link). */
export function org62OppIdOf(o: Pick<Opportunity, 'org62Url'>): string | null {
  return o.org62Url?.match(/\/(006[A-Za-z0-9]{12,15})(?:\/|$|\?)/)?.[1] ?? null;
}

/** The app opportunity a request names: its app id, or its Org62 id (15 or 18 characters, case-sensitive prefix match). */
export function resolveDcOpp<T extends Pick<Opportunity, 'id' | 'org62Url'>>(opps: readonly T[], opp: string, org62IdOf: (o: T) => string | null = org62OppIdOf): T | null {
  const want = opp.trim();
  const byId = opps.find((o) => o.id === want);
  if (byId) return byId;
  if (!ORG62_OPP_ID.test(want)) return null;
  const k = want.slice(0, 15);
  return opps.find((o) => (org62IdOf(o) ?? '').slice(0, 15) === k) ?? null;
}

// ---------------------------------------------------------------------------
// My DC on an opp: one, or several summed (DC-14)
// ---------------------------------------------------------------------------

/**
 * DC-14: my DCs on one opp as one `MyDc`, newest first in: the split is their sum (null when none carries one), the
 * role, Org62 id and last read are the newest one's, `dcCount` how many (absent for one). Two of mine on one opp (a
 * Flex 50/50, both mine) are 100%, never "the newest 50%".
 */
export function sumMyDcs(dcs: ReadonlyArray<Pick<MyDc, 'split' | 'role' | 'org62DcId' | 'lastSeenAt'>>): MyDc | null {
  const first = dcs[0];
  if (!first) return null;
  const splits = dcs.map((d) => d.split).filter((x): x is number => x !== null && x !== undefined);
  const split = splits.length ? Math.round(splits.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  return { split, role: first.role, org62DcId: first.org62DcId, lastSeenAt: first.lastSeenAt ?? null, ...(dcs.length > 1 ? { dcCount: dcs.length } : {}) };
}

/** Per opp, my DCs (each list newest first, as given) summed: `sumMyDcs`. */
export function myDcsByOpp<D extends Pick<MyDc, 'split' | 'role' | 'org62DcId' | 'lastSeenAt'>>(rows: ReadonlyArray<D & { oppId: string | null }>): Map<string, MyDc> {
  const lists = new Map<string, D[]>();
  for (const r of rows) if (r.oppId) lists.set(r.oppId, [...(lists.get(r.oppId) ?? []), r]);
  return new Map([...lists].map(([k, v]) => [k, sumMyDcs(v)!] as const));
}

// ---------------------------------------------------------------------------
// The rules: what a request becomes, given my DC on the opp
// ---------------------------------------------------------------------------

/** What a request for `split` on an opp is: an add, a change of my DC, or (thrown) nothing to do. */
export interface DcPlan {
  kind: DcRequestKind;
  fromSplit: number | null;
  org62DcId: string | null;
}

const pct = (n: number | null) => (n === null ? '?' : `${n}%`);

/**
 * The one rule both DataSources apply before storing a request (create or edit):
 * - my DC on the opp has this split → refused (409), nothing is created;
 * - my DC has another split → a change ("Change your DC 50% → 100%"), targeting that Deal_Contribution__c;
 * - Org62 says I hold a DC but the app hasn't read it yet → refused until the next scan reads its split;
 * - no DC → an add.
 */
export function planDcRequest(opp: { name: string; dcAssigned: boolean; myDc: Pick<MyDc, 'split' | 'role' | 'org62DcId' | 'dcCount'> | null }, split: number): DcPlan {
  const dc = opp.myDc;
  if (dc) {
    if (dc.split !== null && dc.split === split) throw new AppError('conflict', `You already hold a ${split}% DC on ${opp.name}${dc.role ? ` (${dc.role})` : ''}: nothing to request`, { dc });
    // DC-14: a change row moves ONE Deal_Contribution__c; with two of mine it would leave the other one as it is
    if ((dc.dcCount ?? 1) > 1) throw new AppError('conflict', `You hold ${dc.dcCount} DCs on ${opp.name} (${pct(dc.split)} together): a change request moves only one of them, so change their splits on the opp in Org62`, { dc });
    if (!dc.org62DcId) throw new AppError('conflict', `You already hold a DC on ${opp.name}, but the app hasn't read its Org62 id yet: the next Org62 scan does. Ask again after it`, { dc });
    return { kind: 'change', fromSplit: dc.split, org62DcId: dc.org62DcId };
  }
  if (opp.dcAssigned) throw new AppError('conflict', `Org62 shows you already hold a DC on ${opp.name}, but the app hasn't read its split yet: the next Org62 scan does. Ask again after it`);
  return { kind: 'add', fromSplit: null, org62DcId: null };
}

/** A request still in flight (not withdrawn, not confirmed): one per opp. */
export const liveDcRequest = (r: Pick<DcRequestRecord, 'status'>) => r.status !== 'dismissed' && r.status !== 'verified';

/** The conflict for a second live request on the same opp. */
export const dcLiveConflict = (oppName: string, live: Pick<DcRequest, 'stage' | 'kind' | 'splitPercent'> & Partial<DcRequest>) =>
  new AppError('conflict', `A DC request for ${oppName} already exists (${live.kind === 'change' ? 'a change to' : ''}${live.splitPercent}%, ${live.stage.replace('_', ' ')}): edit or withdraw it in Deals ▸ DCs`, { current: live });

/** "Change your DC 50% → 100%" / "Claim a 100% DC" (the chat card, the canvas row, the DC list). */
export function dcRequestWords(r: { kind?: DcRequestKind; fromSplit?: number | null; split: number }): string {
  return r.kind === 'change' ? `Change your DC ${pct(r.fromSplit ?? null)} → ${r.split}%` : `Claim a ${r.split}% DC`;
}

// ---------------------------------------------------------------------------
// Holding: which canvas items carry which DC rows
// ---------------------------------------------------------------------------

const holdKey = (org62OppId: string, role: string) => `${org62OppId.slice(0, 15)}|${role.trim().toLowerCase()}`;
const changeKey = (org62DcId: string) => `dc:${org62DcId.slice(0, 15)}`;

/** The DC rows a work order carries: `Opportunity__c|role` keys (ADD rows) and `dc:<Record Id>` keys (change rows). */
export function dcRowsIn(markdown: string): string[] {
  const out: string[] = [];
  let section: 'add' | 'update' | null = null;
  for (const ln of legacyShape(markdown).split('\n')) {
    if (ln.startsWith('# ADD')) section = 'add';
    else if (ln.startsWith('# UPDATE')) section = 'update';
    if (!ln.startsWith('|')) continue;
    const c = ln.split('|');
    if (c[2] !== 'Deal_Contribution__c') continue;
    // ADD: ['', '#', 'Deal_Contribution__c', name, start, end, role, split, oppId, meeting, comment, '']
    // UPDATE: ['', '#', 'Deal_Contribution__c', recordId, field, new, current, why, '']
    if (section === 'update' || c.length === 9) {
      if (c[3]) out.push(changeKey(c[3]));
    } else if (c[8]) out.push(holdKey(c[8], c[6] ?? ''));
  }
  return [...new Set(out)];
}

export interface DcHolds {
  /** Key → the canvas item waiting for Apply (or retrying) that holds it. */
  held: ReadonlyMap<string, string>;
  /** Key → the canvas item that was sent (Slackbot has the row). */
  sent: ReadonlyMap<string, string>;
  /** Canvas item → where the canvas lives once applied (the draft's result link). */
  urls: ReadonlyMap<string, string | null>;
  /**
   * `<canvas item>|<key>` pairs a `not_created` request already spent (DC-06): that canvas didn't create the DC, so a
   * new request for the same opp and role (Ask again) is waiting, not "handed off" on the old canvas.
   */
  spent?: ReadonlySet<string>;
}

/** Canvas items whose rows go back to waiting: never Applied, rejected or discarded. Anything else was sent. */
const RELEASED: ReadonlySet<string> = new Set(['drafting', 'rejected', 'discarded']);

/** Which DC rows the canvas items carry: held by a pending one, or handed off by a sent one. */
export function dcHolds(drafts: ReadonlyArray<Pick<Draft, 'id' | 'status' | 'destination'> & { resultUrl?: string | null }>): DcHolds {
  const held = new Map<string, string>();
  const sent = new Map<string, string>();
  const urls = new Map<string, string | null>();
  for (const d of drafts) {
    if (d.destination.kind !== 'action' || d.destination.action !== 'slack_canvas.create') continue;
    const into = CANVAS_HOLDING.has(d.status) ? held : RELEASED.has(d.status) ? null : sent;
    if (!into) continue;
    urls.set(d.id, d.resultUrl ?? null);
    for (const k of dcRowsIn(canvasInputOf(d.destination).markdown)) into.set(k, d.id);
  }
  return { held, sent, urls };
}

/** The key a request's canvas row carries: a change's Record Id, an add's Opportunity__c and role. */
export function keyOf(r: Pick<DcRequestRecord, 'kind' | 'role' | 'org62DcId'>, org62OppId: string | null): string | null {
  if (r.kind === 'change') return r.org62DcId ? changeKey(r.org62DcId) : null;
  return org62OppId ? holdKey(org62OppId, r.role) : null;
}

/**
 * The holds with every `not_created` request's canvas spent for its key (DC-06), so Ask again on the same opp and role
 * waits for the next canvas instead of reading as handed off on the canvas that didn't create it.
 */
export function spendNotCreated(holds: DcHolds, requests: ReadonlyArray<{ r: Pick<DcRequestRecord, 'status' | 'role' | 'kind' | 'org62DcId'> & Pick<Partial<DcRequestRecord>, 'outcome'>; org62OppId: string | null }>): DcHolds {
  const spent = new Set(holds.spent ?? []);
  for (const { r, org62OppId } of requests) {
    if (r.status !== 'dismissed' || r.outcome !== 'not_created') continue;
    const k = keyOf(r, org62OppId);
    const c = k ? holds.sent.get(k) : undefined;
    if (k && c) spent.add(`${c}|${k}`);
  }
  return spent.size ? { ...holds, spent } : holds;
}

/** Where a request is now (DcRequest.stage) and the canvas item behind it. */
export function dcStageOf(r: Pick<DcRequestRecord, 'status' | 'role' | 'kind' | 'org62DcId'> & Pick<Partial<DcRequestRecord>, 'outcome'>, org62OppId: string | null, holds: DcHolds): Pick<DcRequest, 'stage' | 'canvasDraftId'> {
  const k = keyOf(r, org62OppId);
  const held = k ? holds.held.get(k) : undefined;
  const sentAny = k ? holds.sent.get(k) : undefined;
  if (r.status === 'dismissed') return r.outcome === 'not_created' ? { stage: 'not_created', canvasDraftId: sentAny ?? null } : { stage: 'dismissed', canvasDraftId: null };
  const sent = sentAny && k && holds.spent?.has(`${sentAny}|${k}`) ? undefined : sentAny;
  if (r.status === 'verified') return { stage: 'confirmed', canvasDraftId: sent ?? held ?? null };
  if (held) return { stage: 'in_canvas', canvasDraftId: held };
  if (sent || r.status === 'synced_to_canvas' || r.status === 'logged') return { stage: 'handed_off', canvasDraftId: sent ?? null };
  return { stage: 'waiting', canvasDraftId: null };
}

/** Why a request can't be edited or withdrawn at this stage (null: it can). */
export function dcLockedReason(stage: DcRequest['stage']): string | null {
  switch (stage) {
    case 'waiting':
      return null;
    case 'in_canvas':
      return "It's on a logging canvas waiting for your Apply on Activity: reject that canvas there to change or withdraw it";
    case 'handed_off':
      return 'It went to Slackbot on a canvas you applied, so it can no longer change here. Once an Org62 scan reads the DC, ask for a change if the split is wrong';
    case 'confirmed':
      return 'Org62 already has this DC: ask for a change instead';
    case 'not_created':
      return "Slackbot didn't create it: Ask again makes a new request for your next canvas";
    case 'dismissed':
      return 'It was withdrawn';
  }
}

/** The app's words for why it closed a request by itself (DcRequest.note), from what Org62 shows now. */
export function dcOutcomeNote(r: Pick<DcRequestRecord, 'kind' | 'fromSplit'> & { outcome?: DcRequestOutcome | null }, dc: Pick<MyDc, 'split'> | null): string | null {
  switch (r.outcome) {
    case 'not_created':
      return r.kind === 'change'
        ? `Not changed: a complete Org62 read after the canvas still shows your DC at ${pct(dc?.split ?? r.fromSplit)}. Ask again to put the change on your next canvas`
        : 'Not created: a complete Org62 read after the canvas shows no DC of yours on it. Ask again to put it on your next canvas, or set the opp aside on Deals';
    case 'changed_in_org62':
      return `Withdrawn by the app: Org62 now shows your DC at ${pct(dc?.split ?? null)} (changed there, not the ${pct(r.fromSplit)} you asked to change), so it never overwrites it. Ask again for a change from ${pct(dc?.split ?? null)} if you still need one`;
    case 'dc_removed':
      return 'Withdrawn by the app: your DC on it was removed in Org62, so there is nothing to change. Claim a DC instead if it is yours';
    case 'opp_deleted':
      return 'Withdrawn by the app: the opportunity was deleted in Org62';
    default:
      return null;
  }
}

/** A stored request as the contract shows it, with my DC on its opp now (`dc`). */
export function dcRequestView(
  r: DcRequestRecord,
  opp: { name: string; accountId: string | null; accountName: string | null; org62OpportunityId: string | null } | null,
  holds: DcHolds,
  rowId: string | null = opp?.org62OpportunityId ?? null,
  dc: MyDc | null = null,
): DcRequest {
  // A key the app made up for an opp it never read from Org62 (`cc:…`) is not an Org62 id: the row waits for one.
  const org62 = opp?.org62OpportunityId && ORG62_OPP_ID.test(opp.org62OpportunityId) ? opp.org62OpportunityId : null;
  // `rowId`: the id the canvas row carries (the mock's placeholder for an opp with no Org62 link)
  const stage = dcStageOf(r, rowId && ORG62_OPP_ID.test(rowId) ? rowId : org62, holds);
  const outcome = r.status === 'dismissed' ? (r.outcome ?? null) : null;
  return {
    id: r.id,
    kind: r.kind,
    oppId: r.oppId,
    oppName: opp?.name ?? r.oppId,
    accountId: opp?.accountId ?? null,
    accountName: opp?.accountName ?? null,
    org62OpportunityId: org62,
    role: r.role,
    splitPercent: r.splitPercent,
    fromSplit: r.kind === 'change' ? r.fromSplit : null,
    comment: r.comment,
    status: r.status,
    ...stage,
    canvasUrl: stage.canvasDraftId ? (holds.urls.get(stage.canvasDraftId) ?? null) : null,
    dc,
    outcome,
    note: dcOutcomeNote({ ...r, outcome }, dc),
    lockedReason: dcLockedReason(stage.stage),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The DC list's order, the same on both DataSources: newest first, then by opp name, then id. */
export const dcRequestOrder = (a: Pick<DcRequest, 'createdAt' | 'oppName' | 'id'>, b: Pick<DcRequest, 'createdAt' | 'oppName' | 'id'>) =>
  b.createdAt.localeCompare(a.createdAt) || a.oppName.localeCompare(b.oppName) || a.id.localeCompare(b.id);

/** Refuse an edit or withdraw of a request that is past waiting (409, with why). */
export function assertDcEditable(v: Pick<DcRequest, 'lockedReason' | 'oppName'>, verb: 'edit' | 'withdraw'): void {
  if (v.lockedReason) throw new AppError('conflict', `Can't ${verb} the DC request for ${v.oppName}: ${v.lockedReason}`, { lockedReason: v.lockedReason });
}

/**
 * 2026-11-13 audit C7: "Withdraw all waiting" (or the ids asked for): the ones you can still withdraw, and the others
 * with why (one on a canvas, confirmed, already withdrawn, not found). One change set withdraws them all.
 */
export function planWithdrawDcs(requests: readonly DcRequest[], ids?: readonly string[]): { withdraw: DcRequest[]; skipped: Array<{ id: string; why: string }> } {
  const byId = new Map(requests.map((r) => [r.id, r] as const));
  const asked = ids ? [...new Set(ids)] : requests.filter((r) => r.status === 'approved' && r.stage === 'waiting').map((r) => r.id);
  const withdraw: DcRequest[] = [];
  const skipped: Array<{ id: string; why: string }> = [];
  for (const id of asked) {
    const r = byId.get(id);
    if (!r) skipped.push({ id, why: 'No such DC request' });
    else if (r.lockedReason) skipped.push({ id, why: r.lockedReason });
    else withdraw.push(r);
  }
  return { withdraw, skipped };
}

/**
 * Whether a waiting request still goes on a canvas as asked (the batch's own check, the same rule as the reconcile):
 * an add only while Org62 shows no DC of mine on the opp (DC-03: one made by hand, at any split, is the answer); a
 * change only while my DC still has the split it was asked from (DC-04: a value someone set in Org62 is never
 * overwritten), and never with two DCs of mine on the opp (DC-14).
 */
export function dcRowWanted(r: Pick<DcRequest, 'kind' | 'dc' | 'fromSplit' | 'splitPercent' | 'org62OpportunityId'>): boolean {
  if (r.kind !== 'change') return !!r.org62OpportunityId && !r.dc;
  const dc = r.dc;
  if (!dc?.org62DcId || (dc.dcCount ?? 1) > 1) return false;
  if (dc.split !== null && dc.split === r.splitPercent) return false;
  return r.fromSplit === null || dc.split === null || dc.split === r.fromSplit;
}

/**
 * Requests the next logging batch takes: approved, waiting, with what the row needs (an add: the opp's Org62 id; a
 * change: my DC's Deal_Contribution__c id), and still wanted (`dcRowWanted`). Oldest first. A change's "current"
 * cell is the split it was asked from (what Slackbot must find there), never a newer value read since.
 */
export function pendingDcAdds(requests: readonly DcRequest[]): DcAdd[] {
  return requests
    .filter((r) => r.status === 'approved' && r.stage === 'waiting' && dcRowWanted(r))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(dcAddOf);
}

/** A request's canvas rows (an add, or a change of my DC), as the batch writes them. */
export function dcAddOf(r: DcRequest): DcAdd {
  return {
    requestId: r.id,
    kind: r.kind,
    org62OpportunityId: r.org62OpportunityId ?? '',
    oppName: r.oppName,
    role: r.role || DEFAULT_DC_ROLE,
    split: r.splitPercent,
    comment: r.comment ?? '',
    ...(r.kind === 'change' ? { fromSplit: r.fromSplit ?? r.dc?.split ?? null, fromRole: r.dc?.role ?? null, org62DcId: r.dc?.org62DcId ?? null } : {}),
  };
}

// ---------------------------------------------------------------------------
// The canvas rows
// ---------------------------------------------------------------------------

/**
 * The paragraphs Slackbot follows for DC rows (WO-1: one table per verb, under its heading). A create row never
 * touches a DC that exists: only an update row (DEAL CONTRIBUTIONS TO UPDATE, by Record Id) changes a split.
 */
export function dcCreateRule(ownerOrg62Id: string): string {
  const who = ownerOrg62Id ? `\`${ownerOrg62Id}\`` : 'the owner';
  return `**DEAL CONTRIBUTIONS TO CREATE:** create one Deal Contribution (Deal_Contribution__c, record type Unlocked) per row with SE_Name__c ${ownerOrg62Id ? `\`${ownerOrg62Id}\`` : '(the owner)'}. Opportunity is the opportunity's name, for you to read; Opportunity__c is its Id; set Opportunity_Role__c and Split_Percentage__c as given, and Comments__c exactly as given, with every ⏎ replaced by a line break. If ${who} already has a DC on that opportunity, don't create a second one and don't change it: skip the row and report it as skipped (an existing DC changes only through DEAL CONTRIBUTIONS TO UPDATE).`;
}

export const DC_UPDATE_RULE =
  '**DEAL CONTRIBUTIONS TO UPDATE:** each row changes one field on an existing Deal Contribution (Deal_Contribution__c): on the record whose Id is in Record Id, set the field named in Field (Split_Percentage__c or Opportunity_Role__c) to New value, nothing else. Current value (what Org62 held when this was written) and Why are for you to read: never write them anywhere.';

/** A DC add in the legacy cell layout the table helpers take (src/lib/canvas/tables.ts). */
const dcAddCells = (n: number, d: DcAdd) => [String(n), 'Deal_Contribution__c', cell(d.oppName), '', '', cell(d.role), String(d.split), cell(d.org62OpportunityId), '', cell(d.comment)];

/** One DEAL CONTRIBUTIONS TO CREATE row (numbered `n`). */
export const dcAddRow = (n: number, d: DcAdd) => lineInTable(tableSpec('dcs_create'), dcAddCells(n, d));

/** A change's rows in the legacy cell layout: the split (always), and the role when the request names another one. */
function dcChangeCells(d: DcAdd): string[][] {
  const why = cell(`${dcRequestWords({ kind: 'change', fromSplit: d.fromSplit ?? null, split: d.split })} on ${d.oppName}${d.comment ? ` · ${d.comment}` : ''}`);
  const rows = [['', 'Deal_Contribution__c', cell(d.org62DcId), 'Split_Percentage__c', String(d.split), String(d.fromSplit ?? '(not read)'), why]];
  if (d.fromRole && d.role && d.fromRole.trim().toLowerCase() !== d.role.trim().toLowerCase()) rows.push(['', 'Deal_Contribution__c', cell(d.org62DcId), 'Opportunity_Role__c', cell(d.role), cell(d.fromRole), why]);
  return rows;
}

/** A change's DEAL CONTRIBUTIONS TO UPDATE rows: the split (always), and the role when the request names another one. */
export function dcChangeRows(d: DcAdd): Array<(n: number) => string> {
  const spec = tableSpec('dcs_update');
  return dcChangeCells(d).map((c) => (n: number) => lineInTable(spec, [String(n), ...c.slice(1)]));
}

/**
 * A rendered work order with DC rows added (WO-1): adds in DEAL CONTRIBUTIONS TO CREATE, changes in DEAL CONTRIBUTIONS
 * TO UPDATE, each table in its place with its paragraph and counts, numbered on when it is there already. Unchanged
 * when `adds` is empty.
 */
export function withDcAdds(markdown: string, adds: readonly DcAdd[], ownerOrg62Id: string): string {
  if (!adds.length) return markdown;
  const creates = adds.filter((d) => d.kind !== 'change');
  const changes = adds.filter((d) => d.kind === 'change');
  let md = upsertTable(markdown, 'dcs_create', dcCreateRule(ownerOrg62Id), creates.map((d, k) => dcAddCells(k + 1, d)));
  md = upsertTable(md, 'dcs_update', DC_UPDATE_RULE, changes.flatMap(dcChangeCells));
  return md;
}

/** The canvases of a logging batch, as both DataSources build them. */
export interface BatchCanvas {
  part: number;
  parts: number;
  title: string;
  markdown: string;
  eventIds: string[];
  hours: number;
  updates: number;
  updateIds?: string[];
}

// ---------------------------------------------------------------------------
// Confirmation: the next Org62 scan reads the DC
// ---------------------------------------------------------------------------

/**
 * The requests an Org62 read confirms: in flight (not withdrawn, not confirmed yet) and my DC on the opp now answers
 * it: an add whatever split Org62 shows (DC-03: Org62 wins, the user made it by hand), a change once the split is the
 * requested one. Each comes back with the DC that confirmed it.
 */
export function dcConfirmations<R extends Pick<DcRequestRecord, 'id' | 'oppId' | 'status' | 'splitPercent'> & Partial<Pick<DcRequestRecord, 'kind'>>, D extends Pick<MyDc, 'split'>>(requests: readonly R[], dcByOpp: ReadonlyMap<string, D>): Array<{ request: R; dc: D }> {
  const out: Array<{ request: R; dc: D }> = [];
  for (const r of requests) {
    if (!liveDcRequest(r)) continue;
    const dc = dcByOpp.get(r.oppId);
    if (!dc) continue;
    if (r.kind !== 'change' || (dc.split !== null && dc.split === r.splitPercent)) out.push({ request: r, dc });
  }
  return out;
}

/** A complete Org62 read must be this long after the canvas reached Slack before "not created" (Slackbot runs it by hand). */
export const DC_NOT_CREATED_GRACE_MS = 12 * 3_600_000;

/** The newest complete read of my DCs on open opps (the daily book read: `BookRun` complete, every row recorded). */
export interface DcRead {
  at: string;
  complete: boolean;
}

export interface DcReconcileInput {
  /** The requests as the contract shows them (stage, and `dc`: my DC on the opp now, summed). */
  requests: readonly DcRequest[];
  /** The newest complete read of my DCs (null: none yet, so nothing is "not created"). */
  read?: DcRead | null;
  /** When each canvas item reached Slack (its sent time); a request handed off without one uses its own update time. */
  deliveredAt?: ReadonlyMap<string, string | null>;
  /** Open opps (app ids): a complete read lists my DCs on open opps only. */
  openOppIds?: ReadonlySet<string>;
}

export interface DcReconcile {
  /** Verified, linked to the DC Org62 shows. */
  confirm: DcRequest[];
  /** Closed by the app with why (status dismissed + outcome), never silently. */
  close: Array<{ request: DcRequest; outcome: DcRequestOutcome }>;
}

/**
 * What one Org62 read does to the requests in flight (D-68; both DataSources, every DC sync and the hygiene sweep):
 *  - DC-03 an add confirms once Org62 shows my DC on the opp, whatever its split (Org62 wins);
 *  - a change confirms at the requested split; one handed off confirms once the split moved off `fromSplit` (HYG-1);
 *  - DC-04 a change still waiting whose DC now has another split than it was asked from is withdrawn
 *    (`changed_in_org62`), and one whose DC is gone too (`dc_removed`): a value someone set in Org62 is never
 *    overwritten;
 *  - DC-06 a request handed off, where a complete read at least `DC_NOT_CREATED_GRACE_MS` after the canvas reached
 *    Slack shows no such DC (an add: no DC of mine on the open opp; a change: still `fromSplit`), is `not_created`.
 */
export function reconcileDcRequests(input: DcReconcileInput): DcReconcile {
  const out: DcReconcile = { confirm: [], close: [] };
  const read = input.read?.complete ? Date.parse(input.read.at) : null;
  const notCreated = (r: DcRequest) => {
    if (read === null || r.stage !== 'handed_off' || !input.openOppIds?.has(r.oppId)) return false;
    const at = (r.canvasDraftId ? input.deliveredAt?.get(r.canvasDraftId) : null) ?? r.updatedAt;
    return read - Date.parse(at) >= DC_NOT_CREATED_GRACE_MS;
  };
  for (const r of input.requests) {
    if (!liveDcRequest(r) || r.stage === 'not_created' || r.stage === 'dismissed') continue;
    const dc = r.dc;
    if (r.kind !== 'change') {
      if (dc) out.confirm.push(r);
      else if (notCreated(r)) out.close.push({ request: r, outcome: 'not_created' });
      continue;
    }
    if (dc && dc.split !== null && dc.split === r.splitPercent) {
      out.confirm.push(r);
      continue;
    }
    const moved = !!dc && dc.split !== null && r.fromSplit !== null && dc.split !== r.fromSplit;
    if (r.stage === 'waiting') {
      if (!dc) out.close.push({ request: r, outcome: 'dc_removed' });
      else if (moved) out.close.push({ request: r, outcome: 'changed_in_org62' });
    } else if (r.stage === 'handed_off') {
      if (moved) out.confirm.push(r);
      else if (notCreated(r)) out.close.push({ request: r, outcome: dc ? 'not_created' : 'dc_removed' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DC-05: a canvas row re-checked before Apply (the Outbox preflight's per-row-kind check)
// ---------------------------------------------------------------------------

/** One DC row of a work order: an ADD row (create) or an UPDATE row (a change of my existing DC's field). */
export interface DcCanvasRow {
  kind: 'add' | 'change';
  /** The row's hold key (`dcRowsIn`). */
  key: string;
  /** The row number in its table. */
  n: number;
  oppName: string | null;
  /** add: Opportunity__c. */
  org62OpportunityId: string | null;
  /** change: the Record Id. */
  org62DcId: string | null;
  role: string | null;
  /** change: the field (Split_Percentage__c, Opportunity_Role__c). */
  field: string | null;
  /** add: the split; change of the split: the new value. */
  split: number | null;
  /** change: the value the row says is there now (what it was asked from). */
  current: string | null;
}

/** Every DC row in a work order's markdown (`withDcAdds`' rows), in order. */
export function dcCanvasRows(markdown: string): DcCanvasRow[] {
  const out: DcCanvasRow[] = [];
  let section: 'add' | 'update' | null = null;
  const num = (v: string | undefined) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  for (const ln of legacyShape(markdown).split('\n')) {
    if (ln.startsWith('# ADD')) section = 'add';
    else if (ln.startsWith('# UPDATE')) section = 'update';
    if (!ln.startsWith('|')) continue;
    const c = ln.split('|');
    if (c[2] !== 'Deal_Contribution__c') continue;
    if (section === 'update' || c.length === 9) {
      // ['', n, 'Deal_Contribution__c', recordId, field, new, current, why, '']
      if (!c[3]) continue;
      out.push({ kind: 'change', key: changeKey(c[3]), n: Number(c[1]) || 0, oppName: null, org62OpportunityId: null, org62DcId: c[3], role: c[4] === 'Opportunity_Role__c' ? (c[5] ?? null) : null, field: c[4] ?? null, split: c[4] === 'Split_Percentage__c' ? num(c[5]) : null, current: c[6] ?? null });
    } else if (c[8]) {
      // ['', n, 'Deal_Contribution__c', name, start, end, role, split, oppId, meeting, comment, '']
      out.push({ kind: 'add', key: holdKey(c[8], c[6] ?? ''), n: Number(c[1]) || 0, oppName: c[3] || null, org62OpportunityId: c[8], org62DcId: null, role: c[6] ?? null, field: null, split: num(c[7]), current: null });
    }
  }
  return out;
}

/** What the preflight knows right before Apply: my DCs as the scans read them, and the requests. */
export interface DcLiveState {
  myDcs: ReadonlyArray<Pick<MyDcRow, 'org62DcId' | 'org62OpportunityId' | 'split'>>;
  /** The requests (views): a row whose request was withdrawn or closed by the app is dropped too. */
  requests?: ReadonlyArray<Pick<DcRequest, 'kind' | 'role' | 'org62OpportunityId' | 'dc' | 'stage'>>;
}

/** Keep the row, or drop it with why; `conflict` when Org62 holds another value than the row expects (refuse, never overwrite). */
export type DcRowVerdict = { keep: true } | { keep: false; reason: string; conflict: boolean };

/**
 * DC-05, the per-row check the canvas Apply preflight registers for `Deal_Contribution__c` rows (pure):
 *  - an ADD row is dropped once Org62 shows my DC on that opp, at any split (it landed before Apply), or when its
 *    request is no longer in flight (withdrawn, confirmed, closed by the app);
 *  - an UPDATE row is dropped when its DC is gone, or already has the new value; and dropped as a conflict when the
 *    DC's split is no longer the "current" value the row was written against (someone changed it in Org62).
 */
export function dcRowStillNeeded(row: DcCanvasRow, live: DcLiveState): DcRowVerdict {
  const k15 = (v: string | null | undefined) => (v ? v.slice(0, 15) : null);
  if (row.kind === 'add') {
    const mine = live.myDcs.filter((d) => d.org62OpportunityId && k15(d.org62OpportunityId) === k15(row.org62OpportunityId));
    if (mine.length) {
      const split = mine.map((d) => d.split).filter((x): x is number => x !== null).reduce((a, b) => a + b, 0);
      return { keep: false, reason: `Org62 already has your DC on ${row.oppName ?? row.org62OpportunityId} (${mine.some((d) => d.split !== null) ? `${split}%` : 'split not read'}): no second one`, conflict: false };
    }
    const req = live.requests?.find((r) => r.kind !== 'change' && r.org62OpportunityId && holdKey(r.org62OpportunityId, r.role) === row.key);
    if (req && req.stage !== 'in_canvas' && req.stage !== 'waiting') return { keep: false, reason: `The DC request for ${row.oppName ?? row.org62OpportunityId} is ${req.stage.replace('_', ' ')}: nothing to create`, conflict: false };
    return { keep: true };
  }
  const dc = live.myDcs.find((d) => d.org62DcId && k15(d.org62DcId) === k15(row.org62DcId));
  if (!dc) return { keep: false, reason: 'Your DC was removed in Org62: nothing to change', conflict: false };
  if (row.field === 'Split_Percentage__c') {
    if (dc.split !== null && row.split !== null && dc.split === row.split) return { keep: false, reason: `Org62 already shows your DC at ${dc.split}%`, conflict: false };
    const cur = row.current !== null && row.current.trim() !== '' && Number.isFinite(Number(row.current)) ? Number(row.current) : null;
    if (cur !== null && dc.split !== null && dc.split !== cur) return { keep: false, reason: `Org62 now shows your DC at ${dc.split}%, not the ${cur}% this change was written against: never overwritten`, conflict: true };
  }
  return { keep: true };
}

/** Every DC row of a work order that the preflight drops, with why (empty: all still needed). */
export function dcCanvasPreflight(markdown: string, live: DcLiveState): Array<{ row: DcCanvasRow; reason: string; conflict: boolean }> {
  const out: Array<{ row: DcCanvasRow; reason: string; conflict: boolean }> = [];
  for (const row of dcCanvasRows(markdown)) {
    const v = dcRowStillNeeded(row, live);
    if (!v.keep) out.push({ row, reason: v.reason, conflict: v.conflict });
  }
  return out;
}

/** My DCs on an account's open opps (AccountRow.myDcs), as both DataSources list them. */
export function accountDcsOf(opps: ReadonlyArray<Pick<Opportunity, 'id' | 'name' | 'accountId' | 'isOpen' | 'myDc'>>, accountId: string): AccountDc[] {
  return opps.filter((o) => o.accountId === accountId && o.isOpen && o.myDc).map((o) => ({ oppId: o.id, oppName: o.name, split: o.myDc!.split, role: o.myDc!.role }));
}

/** My DCs as Deals ▸ DCs lists them, from the opps (the mock; the db reads deal_contributions). */
export function myDcRowsOf(opps: ReadonlyArray<Opportunity>, accountName: (id: string) => string | null): MyDcRow[] {
  return opps
    .filter((o) => o.myDc)
    .map((o) => ({ ...o.myDc!, oppId: o.id, oppName: o.name, org62OpportunityId: org62OppIdOf(o), accountId: o.accountId || null, accountName: o.accountId ? accountName(o.accountId) : null, isOpen: o.isOpen }))
    .sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '') || (a.org62DcId ?? '').localeCompare(b.org62DcId ?? ''));
}

export { claimComment } from '@/contract/deals';

/** Why a DC can't be requested while the feature is off (an available, not active, feature for the role). */
export const DC_INACTIVE = "Deal contributions aren't active for your role: activate them in Settings ▸ Role & rules";

export const dcOppNotFound = (opp: string) =>
  `No opportunity "${opp}" in the app: pass the app's opportunity id (chat_app_read getDeals / getAccount) or its Org62 id (006…); an Org62 id the app doesn't track is read from Org62 and added`;

/** An Org62 id the app doesn't track that Org62 doesn't return either (a typo, or a record I can't see). */
export const dcOppNotInOrg62 = (opp: string) => `Org62 has no Opportunity "${opp}" that you can see: check the id (the 006… in the opp's Org62 link)`;
