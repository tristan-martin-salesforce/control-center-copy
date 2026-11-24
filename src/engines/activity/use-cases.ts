/**
 * Use cases in both VDP and Org62 `Use_Case__c` (D-67): the round trip, pure. The VDP mirror (src/lib/vdp/types.ts) and
 * the Org62 read-back (`Use_Case__c` on my opps, src/jobs/handlers/org62-readback.ts) are read; the logging canvases
 * the Outbox holds or sent say what is on its way to Org62; the VDP items this returns go in the VDP tree (D-63) as
 * Outbox items the user pushes. Nobody writes from here, and neither side is ever overwritten silently.
 *
 *   scope    D-63: an open opp where my DC split is 100%. A VDP use case goes on the VDP's first such opp, primary
 *            first (the account's only one when the VDP lists none); closed opps, 50% DCs and team-only opps create
 *            nothing (a VDP made before the DC exists waits for it).
 *   match    the link first (VDP use case id ↔ Use_Case__c id, kept across renames), else the opp (15-character id, any
 *            opp of the VDP) and the title (`sameUseCaseTitle`: equal once normalized, or nearly the same words).
 *            Two records of mine that match one use case: the oldest is it, the other a duplicate (never deleted).
 *   VDP → Org62   a titled use case with no record: a canvas row (OwnerId me) on the next logging canvas.
 *   Org62 → VDP   a record on my opps that no VDP use case is: a `create_use_case` item under that opp's VDP.
 *   drift    Stage (in VDP's phase terms), Go-Live, title, opp and account, against what the app last wrote or read
 *            (`synced*`). Only VDP changed: Org62 follows on the canvas for Stage / Go-Live on records the app created
 *            that I own (D-67), else "change it in Org62". Only Org62 changed (or VDP is empty): an `update_use_case`
 *            item. Both changed: both values, the user chooses. Never cleared, never deleted.
 *   deleted  a linked record gone from Org62: Add it again or Leave it (decisions); a linked VDP use case gone from VDP:
 *            the record is Org62-only again (re-add it to VDP, or Leave it). An archived or no-longer-mine VDP: quiet.
 *   holds    a canvas waiting for Apply holds its rows; a sent one handed them to Slackbot, offered again only when a
 *            read two days later still has no such record (Slackbot's duplicate rule skips any that did land).
 *   done     every state is derived from the reads: the next read after an Apply or a manual edit closes the item.
 */
import { sameUseCaseTitle } from '@/engines/vdp/gaps';
import { oppIdsOf, type VdpSnapshot } from '@/lib/vdp/types';
import { legacyShape, lineInTable, tableSpec, upsertTable } from '@/lib/canvas/tables';
import { cell } from './slackbot';
import {
  type UseCaseLink, type UseCasePlanInput, ucNormalizeVdp, NO_UC_DECISIONS, type Org62UseCase, id15, phaseKey,
  phaseOfStage, ucGoLive, ucNameKey, type UseCaseCreate, type UseCaseUpdate, type UcCanvasCreate, type UcCanvasUpdate,
  USE_CASE_OBJECT, CC_UC,
} from './use-cases.model';
import { ucItemKey, oldestFirst, ucOppFor } from './use-cases.plan';
export {
  USE_CASE_OBJECT, UC_STAGE_OF_PHASE, UC_AGENT_TYPES, UC_STAGES, UC_PRODUCTS, UC_ENTITLEMENTS, ucTrack, ucProduct,
  ucStage, ucGoLive, ucAgentTypes, ucEntitlement, UC_TEXT_MAX, ucClip, ucNameKey, ucMatchKey, ucCreateKey,
  ucUpdateKey, ucSameTitle, phaseOfStage, trackOfProduct, ucNormalizeVdp, ucInScope, NO_UC_HOLDS, NO_UC_DECISIONS,
  UC_LEAVE_RULE, UC_READD_RULE, ucPickKey, ucPickRowKey, ucPicksOf, USE_CASE_STATES, UC_QUIET,
} from './use-cases.model';
export type {
  UcTrack, UcOpp, UcVdp, Org62UseCase, UseCaseLink, UcCanvasCreate, UcCanvasUpdate, UseCaseHolds, UseCaseDecisions,
  UcPick, UseCasePlanInput, UseCaseCreate, UcUpdateField, UseCaseUpdate, UseCaseState, UcDriftField, UcDriftFix,
  UcDrift, UseCaseItem, UcQuestion, UseCasePlan,
} from './use-cases.model';
export {
  UC_REOFFER_AFTER_MS, ucOppFor, ucCreateRow, ucNotesText, UC_EDITABLE, withUcOverride, ucItemKey, ucDrift,
  ucFieldLabel, planUseCases,
} from './use-cases.plan';
export type { UcEditable } from './use-cases.plan';

// ---------------------------------------------------------------------------
// Links: what a read ties together
// ---------------------------------------------------------------------------

export interface UseCaseLinkChanges {
  /** New links (a record found for a VDP use case). */
  add: UseCaseLink[];
  /** Links whose synced values move to what VDP and Org62 now agree on. */
  synced: Array<Pick<UseCaseLink, 'vdpUseCaseId'> & Partial<Pick<UseCaseLink, 'syncedStage' | 'syncedGoLive' | 'syncedName'>>>;
}

/**
 * After a read: tie each VDP use case to its record. A create row a sent canvas carried links to my oldest record
 * with that opp and title (origin `app`, synced to what the canvas sent); a use case whose record was already there,
 * or one added to VDP from Org62, links as `adopted` (synced where the two agree, so a later change on one side has a
 * direction). A linked pair whose values now agree moves its synced values there (an update landed, or someone made
 * the two the same by hand), so it is never sent again.
 */
export function reconcileUseCaseLinks(i0: UseCasePlanInput): UseCaseLinkChanges {
  const i: UseCasePlanInput = { ...i0, vdps: i0.vdps.map((v) => ucNormalizeVdp(v)) };
  const add: UseCaseLink[] = [];
  const synced: UseCaseLinkChanges['synced'] = [];
  const dec = i.decisions ?? NO_UC_DECISIONS;
  const mine = (r: Org62UseCase) => !!i.me && id15(r.ownerId) === id15(i.me);
  const links = new Map(i.links.filter((l) => !dec.readd.has(ucItemKey.vdp(l.vdpUseCaseId))).map((l) => [l.vdpUseCaseId, l] as const));
  const taken = new Set([...links.values()].map((l) => id15(l.org62UseCaseId)));
  const byId = new Map(i.org62.records.map((r) => [id15(r.id), r] as const));
  const recsByOpp = new Map<string, Org62UseCase[]>();
  for (const r of [...i.org62.records].sort(oldestFirst)) if (!r.goneAt && r.opportunityId && mine(r)) recsByOpp.set(id15(r.opportunityId), [...(recsByOpp.get(id15(r.opportunityId)) ?? []), r]);
  for (const v of i.vdps) {
    if (v.snapshot.archivedAt) continue;
    const choice = ucOppFor(v, i.opps);
    const vdpOpps = oppIdsOf(v.snapshot).map(id15);
    for (const uc of v.snapshot.useCases) {
      const link = links.get(uc.id);
      if (link) {
        const rec = byId.get(id15(link.org62UseCaseId));
        if (!rec || rec.goneAt) continue;
        const ch: UseCaseLinkChanges['synced'][number] = { vdpUseCaseId: uc.id };
        if (uc.executionPhase && phaseKey(uc.executionPhase) === phaseKey(phaseOfStage(rec.stage)) && rec.stage && rec.stage !== link.syncedStage) ch.syncedStage = rec.stage;
        const goLive = ucGoLive(uc.executionTargetDate);
        if (goLive && goLive === rec.goLive && goLive !== link.syncedGoLive) ch.syncedGoLive = goLive;
        if (uc.title?.trim() && ucNameKey(uc.title) === ucNameKey(rec.name) && rec.name !== link.syncedName) ch.syncedName = rec.name;
        if (ch.syncedStage !== undefined || ch.syncedGoLive !== undefined || ch.syncedName !== undefined) synced.push(ch);
        continue;
      }
      const title = uc.title?.trim();
      if (!title) continue;
      const sent = i.holds.sentCreates.get(uc.id);
      const opps15 = [...new Set([...(sent ? [id15(sent.opportunityId)] : []), ...(choice ? [id15(choice.opp.org62Id)] : []), ...vdpOpps])];
      const names = [sent?.name, title].filter((x): x is string => !!x);
      const rec = opps15.flatMap((o) => recsByOpp.get(o) ?? []).find((r) => !taken.has(id15(r.id)) && names.some((n) => sameUseCaseTitle(n, r.name)));
      if (!rec) continue;
      // an `app` record was made by Slackbot after the canvas was sent (as me); anything older was already there
      const madeByCanvas = !!sent && (!rec.createdAt || Date.parse(rec.createdAt) >= Date.parse(sent.at) - 3_600_000);
      const agree = (a: string, b: string) => !!a && a === b;
      add.push(
        madeByCanvas
          ? { vdpUseCaseId: uc.id, org62UseCaseId: rec.id, origin: 'app', syncedStage: sent!.stage || rec.stage || null, syncedGoLive: sent!.goLive || rec.goLive || null, syncedName: sent!.name || rec.name }
          : {
              vdpUseCaseId: uc.id,
              org62UseCaseId: rec.id,
              origin: 'adopted',
              syncedStage: phaseKey(uc.executionPhase) === phaseKey(phaseOfStage(rec.stage)) ? rec.stage : null,
              syncedGoLive: agree(ucGoLive(uc.executionTargetDate), rec.goLive ?? '') ? rec.goLive : null,
              syncedName: ucNameKey(title) === ucNameKey(rec.name) ? rec.name : null,
            },
      );
      taken.add(id15(rec.id));
    }
  }
  return { add, synced };
}

// ---------------------------------------------------------------------------
// Before proposing a new use case: does either system (or a staged item) have it already?
// ---------------------------------------------------------------------------

export interface UcExistingContext {
  /** Every VDP of the company the app knows (live, past and gone from my list). */
  vdps: readonly Pick<VdpSnapshot, 'slug' | 'useCases'>[];
  /** The account's Use_Case__c (any owner, any of its opps). */
  records: readonly Pick<Org62UseCase, 'id' | 'name' | 'goneAt'>[];
  /** Use cases on their way: staged or applied VDP creates, and canvas rows. */
  pending: ReadonlyArray<{ title: string; where: string }>;
  /** VDPs of the company I am not on (VDP's `get_company` vdp_count, when the mirror has it). */
  hiddenVdps?: number;
}

/**
 * The use case a proposed title already is, anywhere: a VDP use case (past VDPs too), a Use_Case__c, or something
 * staged. `exclude` leaves out the record an Org62 → VDP item comes from. Null: it is new (hidden VDPs aside).
 */
export function ucExisting(title: string, ctx: UcExistingContext, exclude: { org62UseCaseId?: string | null } = {}): { where: 'vdp' | 'org62' | 'pending'; label: string } | null {
  if (!title.trim()) return null;
  for (const v of ctx.vdps) {
    const u = v.useCases.find((x) => sameUseCaseTitle(x.title, title));
    if (u) return { where: 'vdp', label: `“${u.title?.trim()}” on VDP ${v.slug}` };
  }
  for (const r of ctx.records) {
    if (r.goneAt || (exclude.org62UseCaseId && id15(r.id) === id15(exclude.org62UseCaseId))) continue;
    if (sameUseCaseTitle(r.name, title)) return { where: 'org62', label: `“${r.name?.trim()}” in Org62 (${r.id})` };
  }
  for (const p of ctx.pending) if (sameUseCaseTitle(p.title, title)) return { where: 'pending', label: `“${p.title}” ${p.where}` };
  return null;
}

// ---------------------------------------------------------------------------
// The canvas rows
// ---------------------------------------------------------------------------

/** The legacy USE CASES heading (a canvas staged before WO-1); the per-object tables are in src/lib/canvas/tables.ts. */
export const UC_TITLE = '# USE CASES (';
/** The legacy USE CASES header (an Object cell second): what a canvas staged before WO-1 carries. */
export const UC_HEADER = '|#|Object|Use_Case_Name__c|Opportunity__c|Account__c|Product__c|Use_Case_Agent_Type__c|Entitlement_Leveraged__c|Stage__c|Go_Live_Date__c|Business_Problem_Solved__c|Business_Problem_KPIs__c|Notes__c|';

/** The USE CASES TO CREATE paragraph: create as me, skip any opp + name that exists, never edit or delete others. */
export function ucCreateRule(ownerOrg62Id: string): string {
  const who = ownerOrg62Id ? `\`${ownerOrg62Id}\`` : 'the owner';
  return `**USE CASES TO CREATE:** create one Use_Case__c per row with OwnerId ${who}. Each column is the Use_Case__c field of the same name: set Use_Case_Name__c, Opportunity__c, Account__c, Product__c, Use_Case_Agent_Type__c (a multi-select: its values are separated by \`;\`), Entitlement_Leveraged__c, Stage__c and Go_Live_Date__c (only when given), Business_Problem_Solved__c, Business_Problem_KPIs__c and Notes__c exactly as given, with every ⏎ replaced by a line break; set Is_Internal__c = \`Customer Facing\` and IsSlackbot__c = false. Skip a row ONLY if a Use_Case__c with the same Opportunity__c and Use_Case_Name__c already exists, whoever owns it, and report it as skipped. Never edit or delete an existing use case from this table.`;
}

/** The USE CASES TO UPDATE paragraph: only my own use case, only that field. */
export function ucUpdateRule(ownerOrg62Id: string): string {
  const who = ownerOrg62Id ? `\`${ownerOrg62Id}\`` : 'the owner';
  return `**USE CASES TO UPDATE:** each row changes one field on an existing Use_Case__c: on the record whose Id is in Record Id, and only if ${who} owns it, set the field named in Field (Stage__c or Go_Live_Date__c) to New value, nothing else. Current value (what Org62 held when this was written) and Why are for you to read: never write them anywhere.`;
}

/** A create / a fix in the legacy cell layout the table helpers take. */
const ucCreateCells = (n: number, c: UseCaseCreate) => [String(n), 'Use_Case__c', cell(c.name), cell(c.opportunityId), cell(c.accountId), cell(c.product), cell(c.agentTypes.join(';')), cell(c.entitlement), cell(c.stage), cell(c.goLive), cell(c.businessProblem), cell(c.kpis), cell(c.notes)];
const ucUpdateCells = (n: number, u: UseCaseUpdate) => [String(n), 'Use_Case__c', cell(u.recordId), u.field, cell(u.newValue), cell(u.currentValue), cell(`${u.name}: ${u.why}`)];

/** One USE CASES TO CREATE row (numbered `n`): what Slackbot creates. */
export const ucCreateLine = (n: number, c: UseCaseCreate) => lineInTable(tableSpec('ucs_create'), ucCreateCells(n, c));
/** One USE CASES TO UPDATE row (a Stage / Go-Live fix). */
export const ucUpdateLine = (n: number, u: UseCaseUpdate) => lineInTable(tableSpec('ucs_update'), ucUpdateCells(n, u));

/**
 * A rendered work order with use-case rows added (WO-1): creates in USE CASES TO CREATE, Stage / Go-Live fixes in USE
 * CASES TO UPDATE, each table in its place with its paragraph and counts. Unchanged when there is nothing to add.
 */
export function withUseCaseRows(markdown: string, creates: readonly UseCaseCreate[], ups: readonly UseCaseUpdate[], ownerOrg62Id: string): string {
  if (!creates.length && !ups.length) return markdown;
  const md = upsertTable(markdown, 'ucs_create', ucCreateRule(ownerOrg62Id), creates.map((c, k) => ucCreateCells(k + 1, c)));
  return upsertTable(md, 'ucs_update', ucUpdateRule(ownerOrg62Id), ups.map((u, k) => ucUpdateCells(k + 1, u)));
}

/** The use-case rows a work order carries: creates (USE CASES table) and Stage / Go-Live fixes (UPDATE table). */
export function ucRowsIn(markdown: string): { creates: UcCanvasCreate[]; updates: UcCanvasUpdate[] } {
  const creates: UcCanvasCreate[] = [];
  const updates: UcCanvasUpdate[] = [];
  let section: 'uc' | 'update' | null = null;
  for (const ln of legacyShape(markdown).split('\n')) {
    if (ln.startsWith('# ')) section = ln.startsWith(UC_TITLE) ? 'uc' : ln.startsWith('# UPDATE') ? 'update' : null;
    if (!section || !ln.startsWith('|')) continue;
    const c = ln.split('|');
    if (c[2] !== USE_CASE_OBJECT) continue;
    if (section === 'uc') {
      // ['', n, obj, name, opp, account, product, agent, entitlement, stage, goLive, bp, kpis, notes, '']
      const key = CC_UC.exec(c[13] ?? '')?.[1];
      if (key) creates.push({ vdpUseCaseId: key, opportunityId: c[4] ?? '', name: (c[3] ?? '').trim(), stage: (c[9] ?? '').trim(), goLive: (c[10] ?? '').trim() });
    } else if (c[3] && c[4]) updates.push({ recordId: c[3].trim(), field: c[4].trim(), newValue: (c[5] ?? '').trim() });
  }
  return { creates, updates };
}
