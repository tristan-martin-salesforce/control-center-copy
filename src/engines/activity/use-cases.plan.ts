// planUseCases: which use cases to create, update, hold or ask about. Split from use-cases.ts (max-lines); use-cases.ts re-exports every public name.
import { rankUseCaseOpps } from '@/lib/canvas/prefill';
import type { VdpGap } from '@/contract';
import { sameUseCaseTitle } from '@/engines/vdp/gaps';
import { NO_ROW_OVERRIDES, ucRowKey, updateOverrideOf, type RowOverride } from '@/lib/canvas/overrides';
import { oppIdsOf, type VdpUseCase } from '@/lib/vdp/types';
import {
  type UcVdp, type UcOpp, id15, ucInScope, type UseCaseCreate, genStr, ucProduct, ucAgentTypes, ucEntitlement,
  ucStage, ucGoLive, clip, UC_TEXT_MAX, type UseCaseState, USE_CASE_STATES, type Org62UseCase, type UseCaseLink,
  type UcPick, type UcDrift, type UcDriftField, type UcDriftFix, ucPickKey, phaseKey, phaseOfStage, ucNameKey,
  type UseCasePlanInput, type UseCasePlan, ucNormalizeVdp, ucPicksOf, type UseCaseUpdate, type UseCaseItem,
  NO_UC_DECISIONS, ucTrack, type UcUpdateField, ucUpdateKey, USE_CASE_OBJECT, type UcQuestion, ucCreateKey,
  trackOfProduct,
} from './use-cases.model';

/** A sent row is offered again only when a read this long after the canvas still has no such record. */
export const UC_REOFFER_AFTER_MS = 48 * 3_600_000;
/** Why a VDP has no opp a use case can go on (null: it has one). */
function noOppWhy(v: UcVdp, opps: readonly UcOpp[]): string {
  const by15 = new Map(opps.map((o) => [id15(o.org62Id), o] as const));
  const listed = oppIdsOf(v.snapshot).map((id) => by15.get(id15(id))).filter((o): o is UcOpp => !!o);
  const waiting = listed.find((o) => o.isOpen && o.dcSplit !== 100);
  if (waiting) return `Waiting for your 100% DC on ${waiting.name}: Claim DC (Deals), then it goes to Org62`;
  if (listed.length && listed.every((o) => !o.isOpen)) return 'Its opps are closed: no new use case goes to Org62 on a closed opp (D-63)';
  const acct = v.accountId ? opps.filter((o) => o.accountId === v.accountId && ucInScope(o)) : [];
  if (acct.length > 1) return 'The VDP lists no open opportunity with your 100% DC: add the opp to the VDP (Activity ▸ VDP)';
  return 'No open opportunity with your 100% DC on this VDP or its account (D-63)';
}
/** The opp a VDP's use cases go on: its first in-scope opp, primary first; else the linked account's only one. */
export function ucOppFor(v: UcVdp, opps: readonly UcOpp[]): { opp: UcOpp; why: string } | null {
  const by15 = new Map(opps.map((o) => [id15(o.org62Id), o] as const));
  for (const id of oppIdsOf(v.snapshot)) {
    const o = by15.get(id15(id));
    if (o && ucInScope(o)) return { opp: o, why: 'the VDP’s first open opp with your 100% DC' };
  }
  // only a VDP that lists no opp at all falls back to its account (one that lists opps waits for their DC)
  const acct = v.accountId;
  if (!acct || oppIdsOf(v.snapshot).length) return null;
  const mine = opps.filter((o) => o.accountId === acct && ucInScope(o));
  return mine.length === 1 ? { opp: mine[0]!, why: 'the account’s only open opp with your 100% DC' } : null;
}
/** The Use_Case__c a VDP use case becomes on an opp (VDP's export mapping, plus where it came from in Notes__c). */
export function ucCreateRow(v: UcVdp, uc: VdpUseCase, opp: UcOpp, accountOrg62Id: string, again = false): UseCaseCreate {
  const s = v.snapshot;
  const details = [uc.detailsInput?.trim(), genStr(uc, 'detailed_user_story')].filter((x): x is string => !!x).join('\n\n');
  const source = `Source: VDP ${s.url ?? s.slug} · CC-UC#${uc.id}`;
  return {
    vdpUseCaseId: uc.id,
    vdpSlug: s.slug,
    vdpUrl: s.url,
    companyName: s.company.name,
    displayOrder: uc.displayOrder,
    name: uc.title!.trim().slice(0, 255),
    opportunityId: opp.org62Id,
    accountId: accountOrg62Id,
    oppName: opp.name,
    oppCloseDate: opp.closeDate,
    product: ucProduct(uc.track),
    agentTypes: ucAgentTypes(uc),
    entitlement: ucEntitlement(s.entitlementLeveraged, uc.track),
    stage: ucStage(uc.executionPhase),
    goLive: ucGoLive(uc.executionTargetDate),
    businessProblem: clip(genStr(uc, 'business_challenge')),
    kpis: clip(genStr(uc, 'kpis_impacted')),
    notes: details ? `${clip(details, UC_TEXT_MAX - source.length - 2)}\n\n${source}` : source,
    again,
  };
}
/** Notes__c's last part: where the row came from, with the `CC-UC#` key the read-back links it by (never edited). */
const UC_SOURCE = /(?:^|\n\n)(Source: VDP [^\n]*CC-UC#[A-Za-z0-9-]+)\s*$/;
/** Notes__c without its source line: the part you can edit. */
export const ucNotesText = (notes: string): string => notes.replace(UC_SOURCE, '').trim();
/** The Org62 fields of a create you can edit before Apply (the canvas review). */
export const UC_EDITABLE = ['name', 'product', 'agentTypes', 'entitlement', 'stage', 'goLive', 'businessProblem', 'kpis', 'notes'] as const;
export type UcEditable = (typeof UC_EDITABLE)[number];
/**
 * A create with your edits (canvas review): each field you set replaces the app's, cut to the Org62 field's length;
 * Notes__c keeps its source line and `CC-UC#` key last, whatever you wrote.
 */
export function withUcOverride(c: UseCaseCreate, o: Pick<RowOverride, 'fields'> | null | undefined): UseCaseCreate {
  if (!o) return c;
  const f = o.fields;
  const str = (k: UcEditable) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
  const out: UseCaseCreate = { ...c };
  const name = str('name')?.trim();
  if (name) out.name = name.slice(0, 255);
  for (const k of ['product', 'entitlement', 'stage', 'goLive'] as const) {
    const v = str(k);
    if (v !== undefined) out[k] = v.trim();
  }
  if (Array.isArray(f.agentTypes)) out.agentTypes = (f.agentTypes as string[]).map((x) => x.trim()).filter(Boolean);
  for (const k of ['businessProblem', 'kpis'] as const) {
    const v = str(k);
    if (v !== undefined) out[k] = clip(v.trim());
  }
  const notes = str('notes');
  if (notes !== undefined) {
    const source = UC_SOURCE.exec(c.notes)?.[1] ?? '';
    const text = notes.trim();
    out.notes = source ? (text ? `${clip(text, UC_TEXT_MAX - source.length - 2)}\n\n${source}` : source) : clip(text);
  }
  return out;
}
const zeroCounts = (): Record<UseCaseState, number> => Object.fromEntries(USE_CASE_STATES.map((s) => [s, 0])) as Record<UseCaseState, number>;
/** Creates in the order a batch takes them: the soonest-closing opp first, then the VDP, then VDP's own order. */
const createOrder = (a: UseCaseCreate, b: UseCaseCreate) =>
  (a.oppCloseDate ?? '9999').localeCompare(b.oppCloseDate ?? '9999') || a.vdpSlug.localeCompare(b.vdpSlug) || a.displayOrder - b.displayOrder || a.vdpUseCaseId.localeCompare(b.vdpUseCaseId);
const readAfter = (readAt: string | null, at: string) => !!readAt && Date.parse(readAt) >= Date.parse(at) + UC_REOFFER_AFTER_MS;
export const oldestFirst = (a: Org62UseCase, b: Org62UseCase) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id);
export const ucItemKey = { vdp: (vdpUseCaseId: string) => `uc:${vdpUseCaseId}`, rec: (org62UseCaseId: string) => `rec:${id15(org62UseCaseId)}` };
/**
 * The differences between a VDP use case and its record, each with how it is fixed. `owned`: the app created the
 * record and I still own it (Org62 may follow on the canvas, Stage / Go-Live only).
 */
export function ucDrift(
  uc: VdpUseCase,
  rec: Org62UseCase,
  link: Pick<UseCaseLink, 'syncedStage' | 'syncedGoLive' | 'syncedName'>,
  o: { owned: boolean; opp?: UcOpp | null; vdpOpps15?: ReadonlySet<string>; chosen?: UcOpp | null; mine?: boolean; picks?: ReadonlyMap<string, UcPick> },
): UcDrift[] {
  const out: UcDrift[] = [];
  const pick = (field: UcDriftField, vdp: string, org: string, synced: string | null, same: (a: string, b: string) => boolean, canvas: boolean) => {
    if (same(vdp, org)) return;
    let fix: UcDriftFix;
    // D-70: your pick, while both values still read as they did when you picked: the wrong side is corrected. VDP's
    // value goes to Org62 on the next canvas (any record you own); Org62's value is an item in the VDP tree.
    const chosen = o.picks?.get(ucPickKey(uc.id, field));
    if (chosen && chosen.vdp === vdp && chosen.org62 === org) fix = chosen.take === 'vdp' ? (o.mine ? 'canvas' : 'org62_by_hand') : 'vdp';
    else if (!vdp) fix = 'vdp';
    else if (!org) fix = canvas && o.owned ? 'canvas' : 'org62_by_hand';
    else {
      const vdpChanged = synced === null || !same(vdp, synced);
      const orgChanged = synced === null || !same(org, synced);
      fix = vdpChanged && !orgChanged ? (canvas && o.owned ? 'canvas' : 'org62_by_hand') : orgChanged && !vdpChanged ? 'vdp' : 'choose';
    }
    out.push({ field, vdp, org62: org, fix });
  };
  const ph = (a: string, b: string) => phaseKey(a) === phaseKey(b);
  pick('Stage__c', uc.executionPhase ?? '', phaseOfStage(rec.stage), link.syncedStage === null ? null : phaseOfStage(link.syncedStage), ph, true);
  pick('Go_Live_Date__c', ucGoLive(uc.executionTargetDate), rec.goLive ?? '', link.syncedGoLive, (a, b) => a === b, true);
  pick('Use_Case_Name__c', uc.title?.trim() ?? '', rec.name?.trim() ?? '', link.syncedName, (a, b) => ucNameKey(a) === ucNameKey(b), false);
  // D-70: Product__c against the track (no synced value: when both are set and differ, you pick)
  if (rec.product?.trim() && ucProduct(uc.track) !== rec.product.trim()) pick('Product__c', ucProduct(uc.track), rec.product.trim(), null, (a, b) => a === b, false);
  // the record sits on an opp the VDP no longer lists (primary changed, or the use case moved to another VDP)
  if (o.vdpOpps15 && rec.opportunityId && !o.vdpOpps15.has(id15(rec.opportunityId)) && o.chosen && id15(o.chosen.org62Id) !== id15(rec.opportunityId))
    out.push({ field: 'Opportunity__c', vdp: o.chosen.org62Id, org62: rec.opportunityId, fix: 'org62_by_hand' });
  // the opp moved to another account in Org62
  if (o.opp?.accountOrg62Id && rec.accountId && id15(o.opp.accountOrg62Id) !== id15(rec.accountId)) out.push({ field: 'Account__c', vdp: o.opp.accountOrg62Id, org62: rec.accountId, fix: 'org62_by_hand' });
  return out;
}
const DRIFT_LABEL: Record<UcDriftField, string> = { Stage__c: 'Stage', Go_Live_Date__c: 'Go-Live', Use_Case_Name__c: 'Title', Product__c: 'Product', Opportunity__c: 'Opportunity', Account__c: 'Account' };
/** The label of an Org62 Use_Case__c field the round trip compares or writes. */
export const ucFieldLabel = (f: UcDriftField) => DRIFT_LABEL[f];
const driftWords = (d: UcDrift) => `${DRIFT_LABEL[d.field]}: VDP ${d.vdp || '(empty)'} · Org62 ${d.org62 || '(empty)'}`;
const FIX_WORDS: Record<UcDriftFix, string> = { canvas: 'Org62 follows on your next logging canvas', vdp: 'VDP follows: push the item in Activity ▸ VDP', org62_by_hand: 'change it in Org62 (the app writes only Stage / Go-Live on records it created, or the value you pick on a record you own)', choose: 'both changed: pick the right one (Activity ▸ Org62 ▸ Use cases)' };
/** The VDP field and value a VDP-side drift fix sets (null when VDP has no such field). */
function vdpFieldOf(d: UcDrift): { field: string; value: string } | null {
  if (!d.org62) return null;
  if (d.field === 'Stage__c') return { field: 'execution_phase', value: d.org62 };
  if (d.field === 'Go_Live_Date__c') return { field: 'execution_target_date', value: d.org62 };
  if (d.field === 'Use_Case_Name__c') return { field: 'title', value: d.org62 };
  return null;
}
/**
 * What goes to Org62, what goes to VDP, and where every use case stands. Deterministic: the same mirror, read-back,
 * links, canvases and decisions give the same plan on both DataSources.
 */
export function planUseCases(i0: UseCasePlanInput): UseCasePlan {
  const i: UseCasePlanInput = { ...i0, vdps: i0.vdps.map((v) => ucNormalizeVdp(v)), goneVdps: (i0.goneVdps ?? []).map((v) => ucNormalizeVdp(v)), picks: i0.picks ?? ucPicksOf(i0.overrides) };
  const creates: UseCaseCreate[] = [];
  const updates: UseCaseUpdate[] = [];
  const items: UseCaseItem[] = [];
  const counts = zeroCounts();
  const vdpGaps = new Map<string, VdpGap[]>();
  const dec = i.decisions ?? NO_UC_DECISIONS;
  const records = i.org62.records;
  const byId = new Map(records.map((r) => [id15(r.id), r] as const));
  const recsByOpp = new Map<string, Org62UseCase[]>();
  for (const r of records) if (!r.goneAt && r.opportunityId) recsByOpp.set(id15(r.opportunityId), [...(recsByOpp.get(id15(r.opportunityId)) ?? []), r]);
  for (const list of recsByOpp.values()) list.sort(oldestFirst);
  const oppBy15 = new Map(i.opps.map((o) => [id15(o.org62Id), o] as const));
  // a link whose record was deleted and the user chose Add it again no longer counts
  const links = new Map(i.links.filter((l) => !dec.readd.has(ucItemKey.vdp(l.vdpUseCaseId))).map((l) => [l.vdpUseCaseId, l] as const));
  const linkedRec = new Map(i.links.map((l) => [id15(l.org62UseCaseId), l] as const));
  /** Record ids a VDP use case of this plan stands for (linked or matched), and their duplicates. */
  const claimed = new Set<string>();
  const dupOf = new Map<string, Org62UseCase>();
  const claimedTitle = new Map<string, string>(); // `${opp15}|${title}` → VDP use case id
  const mine = (r: Org62UseCase) => !!i.me && id15(r.ownerId) === id15(i.me);
  const live = new Set(i.vdps.flatMap((v) => (v.snapshot.archivedAt ? [] : v.snapshot.useCases.map((u) => u.id))));
  const addGap = (slug: string, g: VdpGap) => vdpGaps.set(slug, [...(vdpGaps.get(slug) ?? []), g]);

  const push = (item: UseCaseItem, state: UseCaseState, why: string, extra: Partial<UseCaseItem> = {}) => {
    const decided = dec.leave.has(item.key) ? 'leave' : dec.readd.has(item.key) ? 'readd' : null;
    // D-70: a use case waiting to go to Org62 (or asking you something) can be left out of it too
    const settable = state === 'drift' || state === 'gone' || state === 'org62_only' || state === 'duplicate' || state === 'create' || state === 'skipped';
    const s: UseCaseState = decided === 'leave' && settable ? 'left' : state;
    Object.assign(item, { state: s, why: s === 'left' ? `Left as it is (your choice): ${why}` : why, decided }, extra);
    counts[s] += 1;
    items.push(item);
  };
  /** Records of mine that match a title on these opps (oldest first), and the rest of them as duplicates. */
  const matchOn = (opps15: readonly string[], names: readonly string[], skip: ReadonlySet<string>) => {
    const found = [...new Set(opps15)].flatMap((o) => recsByOpp.get(o) ?? []).filter((r) => !skip.has(id15(r.id)) && names.some((n) => sameUseCaseTitle(n, r.name)));
    return found.sort(oldestFirst);
  };

  for (const v of [...i.vdps, ...(i.goneVdps ?? []).map((g) => ({ ...g, gone: true }))] as Array<UcVdp & { gone?: boolean }>) {
    const s = v.snapshot;
    if (s.isSeed && !v.gone) continue;
    const vdpChoice = ucOppFor(v, i.opps);
    const vdpOpps15 = new Set(oppIdsOf(s).map(id15));
    // D-70: the opps a use case of this VDP may go on (open, my 100% DC; listed on the VDP or on its account), for Needs you
    const pickable = i.opps.filter((o) => ucInScope(o) && (vdpOpps15.has(id15(o.org62Id)) || (!!v.accountId && o.accountId === v.accountId)));
    const ucs = [...s.useCases].sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id));
    for (const uc0 of ucs) {
      // D-70: your answers (Needs you): a name while VDP has none, the opp it goes on
      const ov = (i.overrides ?? NO_ROW_OVERRIDES)[ucRowKey(uc0.id)];
      const ovName = typeof ov?.fields.name === 'string' ? ov.fields.name.trim() : '';
      const ovOpp = typeof ov?.fields.opportunityId === 'string' ? pickable.find((o) => id15(o.org62Id) === id15(ov.fields.opportunityId as string)) : undefined;
      const choice = ovOpp ? { opp: ovOpp, why: 'the opp you picked' } : vdpChoice;
      const uc = !uc0.title?.trim() && ovName ? { ...uc0, title: ovName } : uc0;
      const title = uc.title?.trim() ?? '';
      const link = links.get(uc.id);
      const rec = link ? byId.get(id15(link.org62UseCaseId)) : undefined;
      const item: UseCaseItem = {
        key: ucItemKey.vdp(uc.id),
        vdpSlug: s.slug,
        vdpUrl: s.url,
        companyName: s.company.name,
        vdpUseCaseId: uc.id,
        title: title || '(untitled)',
        track: ucTrack(uc.track),
        oppName: choice?.opp.name ?? null,
        org62OpportunityId: choice?.opp.org62Id ?? null,
        state: 'skipped',
        why: '',
        org62UseCaseId: link?.org62UseCaseId ?? null,
        canvasDraftId: null,
        updates: [],
        drift: [],
        options: [],
        decided: null,
      };
      // a VDP that is archived or no longer mine: its linked record stays as it is, nothing new goes anywhere
      if (s.archivedAt || v.gone) {
        if (link) {
          claimed.add(id15(link.org62UseCaseId));
          push(item, 'in_org62', s.archivedAt ? 'Its VDP is archived: the app leaves the Org62 record as it is' : 'Its VDP is no longer one of yours: the app leaves the Org62 record as it is');
        }
        continue;
      }

      // Linked: the record is the use case, whatever the names say now.
      if (link) {
        claimed.add(id15(link.org62UseCaseId));
        const recOpp = rec?.opportunityId ? (oppBy15.get(id15(rec.opportunityId)) ?? null) : null;
        if (recOpp) {
          item.oppName = recOpp.name;
          item.org62OpportunityId = rec!.opportunityId;
        }
        if (!rec || rec.goneAt) {
          push(item, 'gone', 'Deleted in Org62 (or moved off your opps): Add it again (it goes on your next logging canvas), Leave it, or delete it in VDP too (the app never deletes)', { options: ['readd', 'leave'] });
          continue;
        }
        // its duplicates (a double export): records of mine with the same title on the same opp
        for (const d of matchOn([id15(rec.opportunityId ?? '')], [rec.name ?? '', title], new Set([id15(rec.id), ...linkedRec.keys()])).filter(mine)) dupOf.set(id15(d.id), rec);
        const owned = link.origin === 'app' && mine(rec);
        const drift = ucDrift(uc, rec, link, { owned, opp: recOpp, vdpOpps15, chosen: choice?.opp ?? null, mine: mine(rec), picks: i.picks });
        // Org62 follows VDP (canvas): Stage / Go-Live on records the app created that I own; any of the four on your pick
        const picked = (f: UcDriftField) => !!i.picks?.get(ucPickKey(uc.id, f));
        const ups: UseCaseUpdate[] = drift
          .filter((d) => d.fix === 'canvas' && d.field !== 'Opportunity__c' && d.field !== 'Account__c')
          .flatMap((d): UseCaseUpdate[] => {
            const field = d.field as UcUpdateField;
            const newValue = field === 'Stage__c' ? ucStage(uc.executionPhase) : d.vdp;
            const currentValue = (field === 'Stage__c' ? rec.stage : field === 'Go_Live_Date__c' ? rec.goLive : field === 'Use_Case_Name__c' ? rec.name : rec.product) ?? '(blank)';
            const why = picked(field) ? `your pick: VDP's ${DRIFT_LABEL[field]} ${d.vdp}` : field === 'Stage__c' ? `VDP execution phase is ${uc.executionPhase}` : `VDP target date is ${d.vdp}`;
            return newValue ? [{ vdpUseCaseId: uc.id, recordId: rec.id, field, newValue, currentValue, name: title || rec.name || '', why }] : [];
          });
        // VDP follows Org62 (or the user picks): one update_use_case item under the VDP
        for (const d of dec.leave.has(item.key) ? [] : drift.filter((x) => x.fix === 'vdp' || x.fix === 'choose')) {
          const f = vdpFieldOf(d);
          if (!f) continue;
          addGap(s.slug, {
            id: `${s.slug}:use_case_drift:${uc.id}:${f.field}`,
            code: 'use_case_drift',
            severity: 'medium',
            title: `${title || 'Use case'}: ${driftWords(d)}`,
            vdpSlug: s.slug,
            vdpUrl: s.url,
            useCaseId: uc.id,
            useCaseTitle: title || null,
            accountId: v.accountId,
            opportunityId: recOpp?.id ?? null,
            fix: { kind: 'app', op: 'update_use_case', field: f.field, current: (f.field === 'execution_phase' ? uc.executionPhase : f.field === 'execution_target_date' ? ucGoLive(uc.executionTargetDate) || null : uc.title) ?? null, suggested: f.value, options: [], values: {}, known: false, unsupported: null },
            check: 'wrong',
            why: d.fix === 'choose' ? `Both changed since they last agreed: push this to take Org62's value, or change Org62 to VDP's (${d.vdp}) by hand` : `Org62 changed it to ${d.org62}${d.vdp ? ` (VDP: ${d.vdp})` : ''}: push this to bring VDP along`,
          });
        }
        const diff = ups.map((u) => ({ field: u.field, from: u.currentValue, to: u.newValue }));
        const heldBy = ups.map((u) => i.holds.held.get(ucUpdateKey(u.recordId, u.field))).find(Boolean) ?? null;
        const take = ups.filter((u) => {
          const k = ucUpdateKey(u.recordId, u.field);
          if (i.holds.held.has(k)) return false;
          const sent = i.holds.sent.get(k);
          return !sent || readAfter(i.org62.readAt, sent.at);
        });
        const rest = drift.filter((d) => d.fix !== 'canvas');
        const restWhy = rest.length ? ` · ${rest.map((d) => `${driftWords(d)}: ${FIX_WORDS[d.fix]}`).join(' · ')}` : '';
        if (take.length) {
          updates.push(...take.map((u) => ({ ...u, newValue: updateOverrideOf(i.overrides ?? NO_ROW_OVERRIDES, USE_CASE_OBJECT, u.recordId, u.field) ?? u.newValue })));
          push(item, 'update', `${take.some((u) => picked(u.field)) ? 'Your pick' : 'VDP changed'}: ${take.map((u) => `${DRIFT_LABEL[u.field]} ${u.currentValue} → ${u.newValue}`).join(', ')} on your next logging canvas${restWhy}`, { updates: diff, drift });
        } else if (heldBy) push(item, 'in_canvas', `Its field fix is on a logging canvas waiting for your Apply on Activity${restWhy}`, { updates: diff, drift, canvasDraftId: heldBy });
        else if (ups.length) push(item, 'handed_off', `Its field fix is on a canvas you applied: waiting for Slackbot and the next Org62 read${restWhy}`, { updates: diff, drift, canvasDraftId: ups.map((u) => i.holds.sent.get(ucUpdateKey(u.recordId, u.field))?.draftId).find(Boolean) ?? null });
        else if (rest.length) push(item, 'drift', rest.map((d) => `${driftWords(d)}: ${FIX_WORDS[d.fix]}`).join(' · '), { drift, options: ['leave'] });
        else push(item, 'in_org62', link.origin === 'app' ? (mine(rec) ? 'In Org62 and the same in VDP' : 'In Org62, now owned by someone else: the app never changes it') : 'In Org62 (it was there before the app logged it) and the same in VDP');
        continue;
      }

      if (!title) {
        push(item, 'skipped', 'No title in VDP yet: a use case needs a name before it goes to Org62', { question: { code: 'no_title', opps: [] }, options: ['leave'] });
        continue;
      }
      // what Org62 has under this title on any opp of the VDP (or under the name and opp a sent canvas gave it)
      const sent = i.holds.sentCreates.get(uc.id);
      const opps15 = [...vdpOpps15, ...(choice ? [id15(choice.opp.org62Id)] : []), ...(sent ? [id15(sent.opportunityId)] : [])];
      const names = [title, sent?.name].filter((x): x is string => !!x);
      const found = matchOn(opps15, names, new Set(linkedRec.keys()));
      const free = found.filter((r) => !claimed.has(id15(r.id)));
      if (found.length) {
        const own = free.find(mine);
        if (own) {
          claimed.add(id15(own.id));
          for (const d of free.filter((r) => r !== own && mine(r))) dupOf.set(id15(d.id), own);
          push(item, 'in_org62', 'Already in Org62 (yours): linked on the next Org62 read', { org62UseCaseId: own.id });
        } else if (free.length) {
          claimed.add(id15(free[0]!.id));
          push(item, 'others', `Org62 already has it on ${oppBy15.get(id15(free[0]!.opportunityId ?? ''))?.name ?? 'the opp'}, owned by someone else: the app never touches it`, { org62UseCaseId: free[0]!.id });
        } else push(item, 'skipped', 'Another VDP use case already has this title on the opp: rename one of them in VDP');
        continue;
      }
      if (!choice) {
        const why = noOppWhy(v, i.opps);
        // the canvas pre-fill (src/lib/canvas/prefill.ts): the engine's order of the opps it can go on, its best first
        const pre = rankUseCaseOpps({ title, companyName: s.company.name, accountId: v.accountId }, pickable, i.attribution ?? {});
        const opps = pre.ordered.map((o) => ({ org62Id: o.org62Id, name: o.name }));
        const question: UcQuestion | null = why.startsWith('Waiting for your 100% DC') && !opps.length ? { code: 'waiting_dc', opps: [] } : opps.length ? { code: 'pick_opp', opps, suggested: pre.suggested } : null;
        push(item, 'skipped', why, { question, options: ['leave'] });
        continue;
      }
      const opp = choice.opp;
      // Account__c: the opp's account in Org62 (an opp that moved takes its new account); the VDP header's otherwise
      const account = opp.accountOrg62Id || s.salesforceAccountId?.trim() || null;
      if (!account) {
        push(item, 'skipped', 'No Org62 account id (the opp’s account or the VDP header): Account__c is required', { question: { code: 'no_account', opps: pickable.filter((o) => o.accountOrg62Id && id15(o.org62Id) !== id15(opp.org62Id)).map((o) => ({ org62Id: o.org62Id, name: o.name })) }, options: ['leave'] });
        continue;
      }
      const tk = `${id15(opp.org62Id)}|${ucNameKey(title)}`;
      const dup = [...claimedTitle.entries()].find(([k]) => k.startsWith(`${id15(opp.org62Id)}|`) && sameUseCaseTitle(k.slice(16), title));
      if (dup && dup[1] !== uc.id) {
        push(item, 'skipped', 'Another VDP use case has (nearly) the same title on this opp: rename one of them in VDP');
        continue;
      }
      claimedTitle.set(tk, uc.id);
      const held = i.holds.held.get(ucCreateKey(uc.id));
      if (held) {
        push(item, 'in_canvas', 'On a logging canvas waiting for your Apply on Activity', { canvasDraftId: held });
        continue;
      }
      const again = dec.readd.has(item.key);
      if (sent && !readAfter(i.org62.readAt, sent.at) && !again) {
        push(item, 'handed_off', 'On a canvas you applied: waiting for Slackbot and the next Org62 read', { canvasDraftId: sent.draftId });
        continue;
      }
      if (!i.org62.readAt) {
        push(item, 'skipped', 'Waiting for the first Org62 read of your use cases (Health ▸ Org62 ▸ Re-check Org62 records)');
        continue;
      }
      const createWhy = again ? 'You chose Add it again: it goes on your next logging canvas' : sent ? 'Not in Org62 two days after the canvas you applied: offered again (Slackbot skips it if it did land)' : `Goes on ${opp.name} (${choice.why})`;
      // D-70: left out of Org62 by you: nothing goes (Undo brings it back)
      if (dec.leave.has(item.key)) {
        push(item, 'create', createWhy, { options: ['leave'] });
        continue;
      }
      creates.push(withUcOverride(ucCreateRow(v, uc, opp, account, !!sent || again), (i.overrides ?? NO_ROW_OVERRIDES)[ucRowKey(uc.id)]));
      push(item, 'create', createWhy, { options: ['leave'] });
    }
  }

  // Org62 → VDP: the records on my opps no VDP use case stands for
  const vdpForOpp = (opp15: string) => {
    const on = i.vdps.filter((v) => !v.snapshot.archivedAt && !v.snapshot.isSeed && oppIdsOf(v.snapshot).some((x) => id15(x) === opp15));
    if (on.length) return on[0]!;
    const opp = oppBy15.get(opp15);
    const acct = opp?.accountId ? i.vdps.filter((v) => !v.snapshot.archivedAt && !v.snapshot.isSeed && v.accountId === opp.accountId) : [];
    return acct.length === 1 ? acct[0]! : null;
  };
  for (const r of [...records].sort(oldestFirst)) {
    const k15 = id15(r.id);
    if (r.goneAt || claimed.has(k15) || !r.opportunityId) continue;
    const opp = oppBy15.get(id15(r.opportunityId)) ?? null;
    const was = linkedRec.get(k15);
    const v = vdpForOpp(id15(r.opportunityId));
    const item: UseCaseItem = {
      key: ucItemKey.rec(r.id),
      vdpSlug: v?.snapshot.slug ?? null,
      vdpUrl: v?.snapshot.url ?? null,
      companyName: v?.snapshot.company.name ?? opp?.name ?? '',
      vdpUseCaseId: null,
      title: r.name?.trim() || '(untitled)',
      track: trackOfProduct(r.product),
      oppName: opp?.name ?? null,
      org62OpportunityId: r.opportunityId,
      state: 'org62_only',
      why: '',
      org62UseCaseId: r.id,
      canvasDraftId: null,
      updates: [],
      drift: [],
      options: ['leave'],
      decided: null,
    };
    const dupe = dupOf.get(k15);
    if (dupe) {
      push(item, 'duplicate', `Duplicate in Org62 of ${dupe.id} (same opp and title): delete the extra one in Org62 (the app never deletes)`);
      continue;
    }
    // a record linked to a VDP use case VDP no longer has (deleted in VDP)
    const vdpGone = was && !live.has(was.vdpUseCaseId);
    if (!v) {
      push(item, 'org62_only', `Org62 has it; ${opp ? `no VDP of yours lists ${opp.name} yet` : 'its opp is not one the app knows'}: once the VDP exists, adding it there is an item in Activity ▸ VDP`);
      continue;
    }
    const slug = v.snapshot.slug;
    if (!dec.leave.has(item.key))
      addGap(slug, {
        id: `${slug}:org62_use_case:${k15}`,
        code: 'org62_use_case',
        severity: 'medium',
        title: `Add “${r.name?.trim() || 'Use case'}” from Org62`,
        vdpSlug: slug,
        vdpUrl: v.snapshot.url,
        useCaseId: null,
        useCaseTitle: r.name?.trim() || null,
        accountId: v.accountId,
        opportunityId: opp?.id ?? null,
        fix: { kind: 'app', op: 'create_use_case', field: 'title', current: null, suggested: r.name?.trim() || null, options: [], values: { track: trackOfProduct(r.product), org62_use_case_id: r.id }, known: false, unsupported: null },
        check: 'missing',
        why: vdpGone ? `Org62 still has it on ${opp?.name ?? 'the opp'}, but VDP no longer does (deleted in VDP?): add it back, or Leave it` : `Org62 has it on ${opp?.name ?? 'the opp'}${mine(r) ? '' : ' (someone else’s record)'}; this VDP doesn’t`,
      });
    push(item, 'org62_only', vdpGone ? 'Deleted in VDP, still in Org62: add it back to VDP (an item in Activity ▸ VDP), Leave it, or delete it in Org62 (the app never deletes)' : 'Org62 has it, VDP doesn’t: adding it to VDP is an item in Activity ▸ VDP', { vdpSlug: slug });
  }
  return { creates: creates.sort(createOrder), updates, items, counts, vdpGaps };
}
