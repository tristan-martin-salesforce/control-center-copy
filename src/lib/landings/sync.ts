/**
 * D-70: the landing sync, pure, the same on both DataSources (docs/design/landings.md).
 *
 * The world (the Outbox drafts, the Time rows, the DC requests, the D-67 use-case plan over the Org62 read-back and the
 * VDP mirror, the asset candidates) says where every record stands now; the stored rows keep the history. One pass:
 *
 *   use cases   one app id per use case (use_cases): a plan item finds its row by its VDP id, else its Org62 id; a
 *               row that gains the other id keeps its landings (an Org62-only use case added to VDP stays one).
 *   writes      every row a logging canvas carries, and every VDP use-case / asset item, is one write, keyed by its
 *               draft and row key. Its state follows the item: staged (waiting for Apply), failed, sent (applied),
 *               verified (the landing read back after it), rejected (the item rejected), removed (taken off before
 *               Apply, left out at Apply, or the batch undone). A write first seen on an item already past Apply is
 *               history from before D-70: reason and origin `backfill`. A proposed or approved Event update the batch
 *               put on a canvas is that same write (it moves onto the canvas); one taken off goes back to approved
 *               as a new write, so the removed one stays readable.
 *   landings    the read-backs decide (verified · differs · missing); without one, the newest write does (staged ·
 *               sent · not_sent once it was removed or rejected). Use cases always land in both systems, so both of
 *               their landings exist; the other kinds get one once something was written or read.
 *
 * Deterministic: the same store and world give the same changes; ids come from `newId`.
 */
import type { ActivityEntry, DcRequest, Draft, DraftStatus, LandingDestination, LandingState, RecordKind, WriteOrigin, WriteState } from '@/contract';
import { adminSurfaceOf } from '@/contract';
import { org62CheckOf } from '@/engines/activity/org62-check';
import { phaseOfStage, ucGoLive, ucProduct, type UseCaseItem, type UseCasePlan, type UseCasePlanInput } from '@/engines/activity/use-cases';
import { canvasInputOf } from '@/lib/canvas/payload';
import { canvasRowsOf } from '@/lib/canvas/preflight';
import { hasObjectRows } from '@/lib/canvas/tables';
import type { VdpSnapshot } from '@/lib/vdp/types';
import type { CandidateRecord } from '@/server/vdp/detail';

import { id15, keyOfLanding, landingKey, OPEN_WRITE, PENDING_WRITE, sameRow, updateWriteKey, type LandingRow, type LandingStore, type StoreChanges, type UseCaseRow, type Values, type WriteRow } from './model';

export interface LandingWorld {
  now: string;
  drafts: readonly Draft[];
  activity: readonly ActivityEntry[];
  /** An activity row's Org62 Event id, when the store knows it (the db; the mock has none). */
  eventIds?: ReadonlyMap<string, string>;
  dcRequests: readonly DcRequest[];
  /** D-67's plan and its input (null: the persona has no VDP feature, so no use cases or assets). */
  useCases: { plan: UseCasePlan; input: UseCasePlanInput } | null;
  candidates: readonly CandidateRecord[];
}

export interface SyncOptions {
  newId: () => string;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A canvas cell back to its text (a ` ⏎ ` was a line break). */
const uncell = (s: string | null | undefined) => (s ?? '').replace(/ ⏎ /g, '\n').trim();
const orNull = (s: string | null | undefined) => (s === undefined || s === null || s.trim() === '' ? null : s.trim());
const str = (v: unknown): string | null => (v === null || v === undefined ? null : Array.isArray(v) ? v.join(';') : String(v));

/** The write state an item's status gives its rows. */
export function writeStateOf(s: DraftStatus): WriteState {
  if (s === 'failed') return 'failed';
  if (s === 'sent' || s === 'staged' || s === 'verified' || s === 'verify_failed') return 'sent';
  if (s === 'rejected' || s === 'discarded') return 'rejected';
  return 'staged';
}

/** The live Apply (the newest live attempt that did not fail); else when the item last moved. */
function sentAtOf(d: Draft): string {
  for (let i = d.attempts.length - 1; i >= 0; i--) {
    const a = d.attempts[i]!;
    if (!a.dryRun && a.outcome !== 'failed' && a.outcome !== 'rendered') return a.at;
  }
  return d.updatedAt;
}

// ---------------------------------------------------------------------------
// Use cases: one id each
// ---------------------------------------------------------------------------

interface UcResolution {
  rows: UseCaseRow[];
  insert: UseCaseRow[];
  update: UseCaseRow[];
  remove: string[];
  /** A removed row's id → the row it merged into. */
  merged: Map<string, string>;
  byVdp: Map<string, UseCaseRow>;
  byRec: Map<string, UseCaseRow>;
  byKey: Map<string, UseCaseRow>;
}

function resolveUseCases(stored: readonly UseCaseRow[], world: LandingWorld, now: string, newId: () => string, canvasUcs: ReadonlyArray<{ vdpUseCaseId?: string; org62UseCaseId?: string; title: string }>): UcResolution {
  const rows = new Map(stored.map((r) => [r.id, { ...r }] as const));
  const original = new Map(stored.map((r) => [r.id, r] as const));
  const insertIds = new Set<string>();
  const remove = new Set<string>();
  const merged = new Map<string, string>();
  const byVdp = new Map<string, UseCaseRow>();
  const byRec = new Map<string, UseCaseRow>();
  const index = () => {
    byVdp.clear();
    byRec.clear();
    for (const r of rows.values()) {
      if (r.vdpUseCaseId) byVdp.set(r.vdpUseCaseId, r);
      if (r.org62UseCaseId) byRec.set(r.org62UseCaseId, r);
    }
  };
  index();
  const oppBy15 = new Map((world.useCases?.input.opps ?? []).map((o) => [id15(o.org62Id), o] as const));
  const byKey = new Map<string, UseCaseRow>();
  const want: Array<{ key: string | null; vdp: string | null; rec: string | null; title: string; slug: string | null; opp: string | null }> = [
    ...[...(world.useCases?.plan.items ?? [])].sort((a, b) => a.key.localeCompare(b.key)).map((x: UseCaseItem) => ({ key: x.key, vdp: x.vdpUseCaseId, rec: x.org62UseCaseId ? id15(x.org62UseCaseId) : null, title: x.title, slug: x.vdpSlug, opp: x.org62OpportunityId })),
    ...canvasUcs.map((c) => ({ key: null, vdp: c.vdpUseCaseId ?? null, rec: c.org62UseCaseId ? id15(c.org62UseCaseId) : null, title: c.title, slug: null, opp: null })),
  ];
  for (const w of want) {
    let a = w.vdp ? byVdp.get(w.vdp) : undefined;
    let b = w.rec ? byRec.get(w.rec) : undefined;
    // the record now stands for another VDP use case (added again): the old row lets go of it
    if (b && w.vdp && b.vdpUseCaseId && b.vdpUseCaseId !== w.vdp) {
      b.org62UseCaseId = null;
      b = undefined;
      index();
    }
    if (a && b && a.id !== b.id) {
      // the same use case known twice (VDP first, Org62 first): the older row is it, the other merges into it
      const [keep, drop] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
      keep.vdpUseCaseId ??= drop.vdpUseCaseId;
      keep.org62UseCaseId ??= drop.org62UseCaseId;
      rows.delete(drop.id);
      if (insertIds.has(drop.id)) insertIds.delete(drop.id);
      else remove.add(drop.id);
      merged.set(drop.id, keep.id);
      a = keep;
      b = undefined;
      index();
    }
    let row = a ?? b;
    if (!row) {
      if (!w.vdp && !w.rec) continue;
      row = { id: newId(), vdpUseCaseId: w.vdp, org62UseCaseId: w.rec, vdpSlug: w.slug, title: w.title, accountId: null, opportunityId: null, org62OpportunityId: null, createdAt: now, updatedAt: now };
      rows.set(row.id, row);
      insertIds.add(row.id);
      index();
    }
    if (w.vdp && !row.vdpUseCaseId) row.vdpUseCaseId = w.vdp;
    if (w.rec && !row.org62UseCaseId && !byRec.has(w.rec)) row.org62UseCaseId = w.rec;
    if (w.key) {
      // the plan's view wins for what it is called and where it goes
      if (w.title && w.title !== '(untitled)') row.title = w.title;
      if (w.slug) row.vdpSlug = w.slug;
      const opp = w.opp ? oppBy15.get(id15(w.opp)) : undefined;
      if (w.opp) row.org62OpportunityId = w.opp;
      if (opp) {
        row.opportunityId = opp.id;
        row.accountId = opp.accountId;
      }
      byKey.set(w.key, row);
    } else if (!row.title && w.title) row.title = w.title;
    index();
  }
  const insert: UseCaseRow[] = [];
  const update: UseCaseRow[] = [];
  for (const r of rows.values()) {
    if (insertIds.has(r.id)) insert.push(r);
    else {
      const o = original.get(r.id)!;
      if (!sameRow(o, r)) update.push({ ...r, updatedAt: now });
    }
  }
  const final = [...rows.values()].map((r) => update.find((u) => u.id === r.id) ?? r);
  const res: UcResolution = { rows: final, insert, update, remove: [...remove], merged, byVdp: new Map(), byRec: new Map(), byKey: new Map() };
  for (const r of final) {
    if (r.vdpUseCaseId) res.byVdp.set(r.vdpUseCaseId, r);
    if (r.org62UseCaseId) res.byRec.set(r.org62UseCaseId, r);
  }
  for (const [k, r] of byKey) res.byKey.set(k, final.find((x) => x.id === r.id) ?? r);
  return res;
}

// ---------------------------------------------------------------------------
// What the read-backs say (signals) and what the items carry (writes)
// ---------------------------------------------------------------------------

export interface Signal {
  kind: RecordKind;
  recordId: string;
  dest: LandingDestination;
  externalId: string | null;
  /** What a read-back says (null: nothing read: the writes decide). */
  state: LandingState | null;
  remote: Values | null;
  readAt: string | null;
  /** The landing exists even with no write (a use case lands in both systems; a record read back). */
  ensure: boolean;
}

export interface ProjWrite {
  draftId: string;
  rowKey: string;
  kind: RecordKind;
  recordId: string;
  dest: LandingDestination;
  externalId: string | null;
  op: 'create' | 'update' | 'delete';
  before: Values | null;
  after: Values;
  state: WriteState;
  sentAt: string | null;
  origin: WriteOrigin;
  reason: string;
}

const COMPARED_DRIFT: ReadonlySet<string> = new Set(['Use_Case_Name__c', 'Product__c', 'Stage__c', 'Go_Live_Date__c']);

function signalsOfUseCases(world: LandingWorld, uc: UcResolution, out: Map<string, Signal>) {
  if (!world.useCases) return;
  const { plan, input } = world.useCases;
  const recs = new Map(input.org62.records.map((r) => [id15(r.id), r] as const));
  const live = new Map<string, { uc: VdpSnapshot['useCases'][number]; at: string | null }>();
  for (const v of input.vdps) if (!v.snapshot.archivedAt) for (const u of v.snapshot.useCases ?? []) live.set(u.id, { uc: u, at: v.snapshot.lastActivityAt ?? null });
  for (const item of plan.items) {
    const row = uc.byKey.get(item.key);
    if (!row) continue;
    const differs = item.drift.some((d) => COMPARED_DRIFT.has(d.field));
    const rec = row.org62UseCaseId ? recs.get(row.org62UseCaseId) : item.org62UseCaseId ? recs.get(id15(item.org62UseCaseId)) : undefined;
    const org: Signal = { kind: 'use_case', recordId: row.id, dest: 'org62', externalId: rec?.id ?? item.org62UseCaseId ?? null, state: null, remote: null, readAt: null, ensure: true };
    if (rec) {
      org.state = rec.goneAt ? 'missing' : differs ? 'differs' : 'verified';
      org.remote = { Use_Case_Name__c: rec.name, Product__c: rec.product, Stage__c: rec.stage, Go_Live_Date__c: rec.goLive, Opportunity__c: rec.opportunityId, Account__c: rec.accountId };
      org.readAt = input.org62.readAt;
    }
    const vu = row.vdpUseCaseId ? live.get(row.vdpUseCaseId) : undefined;
    const vdp: Signal = { kind: 'use_case', recordId: row.id, dest: 'vdp', externalId: row.vdpUseCaseId, state: null, remote: null, readAt: null, ensure: true };
    if (vu) {
      vdp.state = differs ? 'differs' : 'verified';
      vdp.remote = { title: vu.uc.title?.trim() || null, track: vu.uc.track, execution_phase: vu.uc.executionPhase, execution_target_date: ucGoLive(vu.uc.executionTargetDate) || null };
      vdp.readAt = vu.at;
    } else if (row.vdpUseCaseId && !item.vdpUseCaseId) vdp.state = 'missing'; // linked once, gone from VDP since
    out.set(landingKey('use_case', row.id, 'org62'), org);
    out.set(landingKey('use_case', row.id, 'vdp'), vdp);
  }
  // assets: what VDP holds, and the candidates added or in VDP (assets land in VDP only)
  const candUrls = new Set<string>();
  for (const c of world.candidates) {
    if (c.status !== 'in_vdp' && c.status !== 'added') continue;
    candUrls.add(normUrl(c.url));
    out.set(landingKey('asset', c.id, 'vdp'), { kind: 'asset', recordId: c.id, dest: 'vdp', externalId: null, state: c.status === 'in_vdp' ? 'verified' : 'sent', remote: { title: c.title, url: c.url, type: c.kind }, readAt: null, ensure: true });
  }
  for (const v of input.vdps) {
    if (v.snapshot.archivedAt) continue;
    for (const a of v.snapshot.assets ?? []) {
      if (candUrls.has(normUrl(a.url))) continue;
      out.set(landingKey('asset', assetRecordId(a.id), 'vdp'), { kind: 'asset', recordId: assetRecordId(a.id), dest: 'vdp', externalId: a.id, state: 'verified', remote: { title: a.title, url: a.url, type: a.type }, readAt: v.snapshot.lastActivityAt ?? null, ensure: true });
    }
  }
}

export const assetRecordId = (vdpAssetId: string) => `vdpasset:${vdpAssetId}`;
export const normUrl = (u: string) => u.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

function activitySignals(world: LandingWorld, out: Map<string, Signal>) {
  for (const e of world.activity) {
    const check = org62CheckOf(e);
    const state: LandingState | null =
      check === 'deleted' || check === 'not_in_org62' ? 'missing' : check === 'differs' ? 'differs' : e.fromOrg62 || e.status === 'verified' || e.status === 'logged' ? 'verified' : null;
    if (!state) continue;
    out.set(landingKey('activity_event', e.id, 'org62'), { kind: 'activity_event', recordId: e.id, dest: 'org62', externalId: world.eventIds?.get(e.id) ?? null, state, remote: null, readAt: e.verifiedAt ?? e.loggedAt ?? null, ensure: true });
  }
}

function dcSignals(world: LandingWorld, out: Map<string, Signal>) {
  for (const r of world.dcRequests) {
    const state: LandingState | null = r.stage === 'confirmed' ? 'verified' : r.stage === 'not_created' ? 'missing' : null;
    if (!state) continue;
    out.set(landingKey('deal_contribution', r.id, 'org62'), {
      kind: 'deal_contribution',
      recordId: r.id,
      dest: 'org62',
      externalId: r.dc?.org62DcId ?? null,
      state,
      remote: r.dc ? { Split_Percentage__c: str(r.dc.split), Opportunity_Role__c: r.dc.role } : null,
      readAt: r.dc?.lastSeenAt ?? null,
      ensure: true,
    });
  }
}

/** The DC request a canvas DC row stands for: one the item holds first, then any (the db's canvas review matches the same way). */
function dcRequestOf(world: LandingWorld, draftId: string, kind: 'add' | 'change', c: readonly string[]): DcRequest | null {
  const here = (r: DcRequest) => r.canvasDraftId === draftId;
  const match =
    kind === 'add'
      ? (r: DcRequest) => r.kind !== 'change' && (r.role || '').trim().toLowerCase() === (c[5] ?? '').toLowerCase() && (id15(r.org62OpportunityId) === id15(c[7]) || r.oppName === c[2])
      : (r: DcRequest) => r.kind === 'change' && id15(r.dc?.org62DcId) === id15(c[2]);
  return world.dcRequests.find((r) => here(r) && match(r)) ?? world.dcRequests.find(match) ?? null;
}

const UPDATE_REASON = (why: string) => why || 'Field fix';

/** Every write the items carry: the logging canvases' rows and the VDP use-case / asset items. */
export function projectWrites(world: LandingWorld, uc: Pick<UcResolution, 'byVdp' | 'byRec'>, eventToActivity: ReadonlyMap<string, string>): ProjWrite[] {
  const out: ProjWrite[] = [];
  for (const d of world.drafts) {
    if (d.destination.kind !== 'action') continue;
    const state = writeStateOf(d.status);
    const sentAt = state === 'sent' ? sentAtOf(d) : null;
    const base = { draftId: d.id, state, sentAt };
    if (d.destination.action === 'slack_canvas.create') {
      if (adminSurfaceOf(d) !== 'log') continue;
      let md: string;
      try {
        md = canvasInputOf(d.destination).markdown;
      } catch {
        continue;
      }
      for (const r of canvasRowsOf(md)) {
        const c = r.cells;
        if (r.section === 'add' && r.kind === 'event') {
          const ref = r.ref ?? `n${c[0]}`;
          out.push({ ...base, origin: 'canvas', rowKey: `event:${ref}`, kind: 'activity_event', recordId: ref, dest: 'org62', externalId: null, op: 'create', before: null, reason: 'A new Event from your row', after: { Subject: orNull(c[2]), StartDateTime: orNull(c[3]), EndDateTime: orNull(c[4]), SE_Task_Type__c: orNull(c[5]), Duration__c: orNull(c[6]), WhatId: orNull(c[7]), Meeting_Type__c: orNull(c[8]), Description: orNull(uncell(c[9])) } });
        } else if (r.section === 'add' && r.kind === 'dc') {
          const req = dcRequestOf(world, d.id, 'add', c);
          out.push({ ...base, origin: 'canvas', rowKey: `dc:${id15(c[7])}:${(c[5] ?? '').trim().toLowerCase()}`, kind: 'deal_contribution', recordId: req?.id ?? `dc:${id15(c[7])}:${(c[5] ?? '').trim().toLowerCase()}`, dest: 'org62', externalId: null, op: 'create', before: null, reason: orNull(uncell(c[9])) ?? 'Your DC request', after: { Opportunity__c: orNull(c[7]), Opportunity_Role__c: orNull(c[5]), Split_Percentage__c: orNull(c[6]), Comments__c: orNull(uncell(c[9])) } });
        } else if (r.section === 'use_cases') {
          const row = r.ref ? uc.byVdp.get(r.ref) : undefined;
          if (!row) continue;
          out.push({
            ...base,
            origin: 'canvas',
            rowKey: `uc:${r.ref}`,
            kind: 'use_case',
            recordId: row.id,
            dest: 'org62',
            externalId: null,
            op: 'create',
            before: null,
            reason: 'A new use case from VDP',
            after: { Use_Case_Name__c: orNull(c[2]), Opportunity__c: orNull(c[3]), Account__c: orNull(c[4]), Product__c: orNull(c[5]), Use_Case_Agent_Type__c: orNull(c[6]), Entitlement_Leveraged__c: orNull(c[7]), Stage__c: orNull(c[8]), Go_Live_Date__c: orNull(c[9]), Business_Problem_Solved__c: orNull(uncell(c[10])), Business_Problem_KPIs__c: orNull(uncell(c[11])), Notes__c: orNull(uncell(c[12])) },
          });
        } else if (r.section === 'update') {
          const object = c[1] ?? '';
          const rec = c[2] ?? '';
          const field = c[3] ?? '';
          if (!rec || !field) continue;
          const cur = c[5] ?? '';
          const before: Values = { [field]: cur === '(blank)' || cur === '(not read)' || cur === '' ? null : cur };
          const after: Values = { [field]: orNull(c[4]) };
          const reason = UPDATE_REASON(uncell(c[6]));
          const w = { ...base, origin: 'canvas' as const, rowKey: updateWriteKey(object, rec, field), dest: 'org62' as const, externalId: rec, op: 'update' as const, before, after, reason };
          if (object === 'Event') out.push({ ...w, kind: 'activity_event', recordId: eventToActivity.get(id15(rec)) ?? `org62:${id15(rec)}` });
          else if (object === 'Use_Case__c') {
            const row = uc.byRec.get(id15(rec));
            if (row) out.push({ ...w, kind: 'use_case', recordId: row.id, reason: reason.replace(/^[^:]*: /, '') || reason });
          } else if (object === 'Deal_Contribution__c') {
            const req = dcRequestOf(world, d.id, 'change', c);
            out.push({ ...w, kind: 'deal_contribution', recordId: req?.id ?? `dcrec:${id15(rec)}` });
          }
        }
      }
      continue;
    }
    // VDP items: a use case's field change or a new one, an asset added (assets land in VDP only)
    const input = d.destination.input as Record<string, unknown>;
    const action = d.destination.action;
    const vbase = { ...base, origin: 'vdp' as const, dest: 'vdp' as const, reason: `VDP: ${d.destination.target.label}` };
    const changes = Array.isArray(input.changes) ? (input.changes as Array<{ field?: unknown; before?: unknown; value?: unknown }>) : [];
    const fieldsOf = (): { before: Values; after: Values } => {
      const list = changes.length ? changes : [{ field: input.field, before: input.before, value: input.value }];
      const before: Values = {};
      const after: Values = {};
      for (const ch of list) {
        const f = str(ch.field);
        if (!f) continue;
        before[f] = str(ch.before);
        after[f] = str(ch.value);
      }
      return { before, after };
    };
    if (action === 'vdp.update_use_case') {
      const row = typeof input.useCaseId === 'string' ? uc.byVdp.get(input.useCaseId) : undefined;
      if (!row) continue;
      const f = fieldsOf();
      out.push({ ...vbase, rowKey: `vdp:${Object.keys(f.after).join(',')}`, kind: 'use_case', recordId: row.id, externalId: row.vdpUseCaseId, op: 'update', before: f.before, after: f.after });
    } else if (action === 'vdp.create_use_case') {
      const k15 = /:org62_use_case:([A-Za-z0-9]{15})$/.exec(String(input.itemKey ?? ''))?.[1];
      const row = k15 ? uc.byRec.get(k15) : undefined;
      if (!row) continue;
      out.push({ ...vbase, rowKey: 'vdp:create', kind: 'use_case', recordId: row.id, externalId: null, op: 'create', before: null, after: { title: str(input.useCaseTitle) ?? str(input.value), track: str(input.track) } });
    } else if (action === 'vdp.add_vdp_asset') {
      const cid = typeof input.candidateId === 'string' ? input.candidateId : null;
      if (!cid) continue;
      const f = fieldsOf();
      out.push({ ...vbase, rowKey: 'vdp:asset', kind: 'asset', recordId: cid, externalId: null, op: 'create', before: null, after: f.after });
    }
  }
  return out;
}

/** The VDP use cases and Org62 records the canvases name (a canvas may outlive its use case's plan item). */
function canvasUseCases(world: LandingWorld): Array<{ vdpUseCaseId?: string; org62UseCaseId?: string; title: string }> {
  const out: Array<{ vdpUseCaseId?: string; org62UseCaseId?: string; title: string }> = [];
  for (const d of world.drafts) {
    if (d.destination.kind !== 'action' || d.destination.action !== 'slack_canvas.create' || adminSurfaceOf(d) !== 'log') continue;
    let md: string;
    try {
      md = canvasInputOf(d.destination).markdown;
    } catch {
      continue;
    }
    if (!hasObjectRows(md, 'Use_Case__c')) continue;
    for (const r of canvasRowsOf(md)) {
      if (r.section === 'use_cases' && r.ref) out.push({ vdpUseCaseId: r.ref, title: r.cells[2] ?? '' });
      else if (r.section === 'update' && r.cells[1] === 'Use_Case__c' && r.cells[2]) out.push({ org62UseCaseId: r.cells[2], title: (r.cells[6] ?? '').split(':')[0]?.trim() ?? '' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

const DRAFT_PENDING: ReadonlySet<WriteState> = new Set(['staged', 'failed']);

export interface SyncResult {
  changes: StoreChanges;
  /** Use case app id per plan key (the views read them). */
  useCaseByKey: ReadonlyMap<string, string>;
}

export function syncLandings(store: LandingStore, world: LandingWorld, o: SyncOptions): SyncResult {
  const now = world.now;
  const uc = resolveUseCases(store.useCases, world, now, o.newId, canvasUseCases(world));

  // landings, keyed; a merged use case's landings move to the row it merged into
  const landings = new Map<string, LandingRow>();
  const original = new Map(store.landings.map((l) => [l.id, l] as const));
  const removeLandings = new Set<string>();
  const movedLanding = new Map<string, string>();
  const insertLandings = new Set<string>();
  for (const l0 of [...store.landings].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const l = { ...l0 };
    if (l.recordKind === 'use_case' && uc.merged.has(l.recordId)) l.recordId = uc.merged.get(l.recordId)!;
    const k = keyOfLanding(l);
    const had = landings.get(k);
    if (had) {
      removeLandings.add(l.id);
      movedLanding.set(l.id, had.id);
      continue;
    }
    landings.set(k, l);
  }
  const ensure = (kind: RecordKind, recordId: string, dest: LandingDestination): LandingRow => {
    const k = landingKey(kind, recordId, dest);
    const had = landings.get(k);
    if (had) return had;
    const l: LandingRow = { id: o.newId(), recordKind: kind, recordId, destination: dest, externalId: null, state: 'not_sent', remoteValues: null, verifiedAt: null, lastReadAt: null, createdAt: now, updatedAt: now };
    landings.set(k, l);
    insertLandings.add(l.id);
    return l;
  };

  // signals
  const signals = new Map<string, Signal>();
  activitySignals(world, signals);
  dcSignals(world, signals);
  signalsOfUseCases(world, uc, signals);

  // Event id → activity row: the store's own, then the landings that name one (a proposed update's)
  const eventToActivity = new Map<string, string>();
  for (const [a, ev] of world.eventIds ?? []) eventToActivity.set(id15(ev), a);
  for (const l of landings.values()) if (l.recordKind === 'activity_event' && l.externalId && !l.recordId.startsWith('org62:')) eventToActivity.set(id15(l.externalId), l.recordId);

  // writes
  const writes = new Map<string, WriteRow>(store.writes.map((w) => [w.id, { ...w, landingId: movedLanding.get(w.landingId) ?? w.landingId }] as const));
  const origW = new Map(store.writes.map((w) => [w.id, w] as const));
  const insertWrites = new Set<string>();
  const byDraftRow = new Map<string, WriteRow>();
  for (const w of writes.values()) if (w.draftId) byDraftRow.set(`${w.draftId}|${w.rowKey}`, w);
  const drafts = new Map(world.drafts.map((d) => [d.id, d] as const));
  const projected = projectWrites(world, uc, eventToActivity);
  const seen = new Set<string>();
  for (const p of projected) {
    const k = `${p.draftId}|${p.rowKey}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const landing = ensure(p.kind, p.recordId, p.dest);
    if (p.externalId && !landing.externalId) landing.externalId = p.externalId;
    const had = byDraftRow.get(k);
    if (had) {
      had.landingId = landing.id;
      if (DRAFT_PENDING.has(had.state) || had.state === 'removed' || had.state === 'rejected') {
        // waiting for Apply (or back on it after an Undo): its values follow the canvas's edits
        had.before = p.before;
        had.after = p.after;
        had.state = p.state;
      } else if (had.state === 'sent' && p.state !== 'sent' && p.state !== 'rejected') had.state = p.state; // an Apply undone
      if (p.state === 'sent' && !had.sentAt) had.sentAt = p.sentAt;
      continue;
    }
    // an approved (or proposed) update the batch took: the same write moves onto the canvas
    const open = [...writes.values()].find((w) => !w.draftId && OPEN_WRITE.has(w.state) && w.landingId === landing.id && w.rowKey === p.rowKey);
    if (open) {
      Object.assign(open, { draftId: p.draftId, state: p.state, sentAt: p.state === 'sent' ? p.sentAt : null, before: p.before ?? open.before, after: p.after });
      byDraftRow.set(k, open);
      continue;
    }
    const firstSeenLate = !DRAFT_PENDING.has(p.state);
    const w: WriteRow = {
      id: o.newId(),
      landingId: landing.id,
      draftId: p.draftId,
      rowKey: p.rowKey,
      op: p.op,
      before: p.before,
      after: p.after,
      state: p.state,
      origin: firstSeenLate ? 'backfill' : p.origin,
      reason: firstSeenLate ? 'backfill' : p.reason,
      sentAt: p.state === 'sent' ? p.sentAt : null,
      verifiedAt: null,
      createdAt: drafts.get(p.draftId)?.createdAt ?? now,
      updatedAt: now,
    };
    writes.set(w.id, w);
    insertWrites.add(w.id);
    byDraftRow.set(k, w);
  }
  // writes their item no longer carries: taken off before Apply, left out at Apply, rejected, or the batch undone
  for (const w of [...writes.values()]) {
    if (!w.draftId || seen.has(`${w.draftId}|${w.rowKey}`) || !PENDING_WRITE.has(w.state)) continue;
    const d = drafts.get(w.draftId);
    w.state = d && writeStateOf(d.status) === 'rejected' ? 'rejected' : 'removed';
    // a proposed Event update goes back to waiting for the next canvas, as a new write (this one stays as history)
    if (w.origin === 'proposed') {
      const again: WriteRow = { ...w, id: o.newId(), draftId: null, state: 'approved', sentAt: null, verifiedAt: null, createdAt: now, updatedAt: now };
      writes.set(again.id, again);
      insertWrites.add(again.id);
    }
  }

  // landing states: the read-back decides, else the newest write
  const byLanding = new Map<string, WriteRow[]>();
  for (const w of writes.values()) byLanding.set(w.landingId, [...(byLanding.get(w.landingId) ?? []), w]);
  for (const [k, s] of signals) if (s.ensure || landings.has(k)) ensure(s.kind, s.recordId, s.dest);
  for (const [k, l] of landings) {
    const s = signals.get(k);
    const ws = (byLanding.get(l.id) ?? []).filter((w) => !OPEN_WRITE.has(w.state) && w.state !== 'dismissed').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const last = ws.filter((w) => w.state !== 'removed' && w.state !== 'rejected').at(-1);
    let state: LandingState;
    if (s?.state) state = s.state;
    // nothing read and nothing on its way: a landing that was read once keeps what it read; else it was never sent
    else if (!last) state = !ws.length && (l.state === 'verified' || l.state === 'differs' || l.state === 'missing') ? l.state : 'not_sent';
    else if (DRAFT_PENDING.has(last.state)) state = 'staged';
    else state = last.state === 'verified' ? 'verified' : 'sent';
    l.state = state;
    if (s) {
      if (s.externalId) l.externalId = s.externalId;
      if (s.remote) l.remoteValues = s.remote;
      if (s.readAt) l.lastReadAt = s.readAt;
    }
    if (state === 'verified' && !l.verifiedAt) l.verifiedAt = s?.readAt ?? now;
    // a sent write is verified once its record reads back: a create once the record is there; an update once the field
    // reads its new value (where the read carries the field), else once the record was read back after it was sent
    for (const w of ws) {
      if (w.state !== 'sent' || (state !== 'verified' && state !== 'differs')) continue;
      const fields = Object.keys(w.after);
      const remote = l.remoteValues;
      const readSince = !!l.lastReadAt && !!w.sentAt && l.lastReadAt >= w.sentAt;
      const landed = w.op !== 'update' ? state === 'verified' : remote && fields.every((f) => f in remote) ? fields.every((f) => sameValue(remote[f], w.after[f])) : state === 'verified' && readSince;
      if (landed) {
        w.state = 'verified';
        w.verifiedAt = l.verifiedAt ?? now;
      }
    }
  }

  const changes: StoreChanges = {
    landings: { insert: [], update: [], remove: [...removeLandings] },
    writes: { insert: [], update: [] },
    useCases: { insert: uc.insert, update: uc.update, remove: uc.remove },
  };
  for (const l of landings.values()) {
    if (insertLandings.has(l.id)) changes.landings.insert.push(l);
    else {
      const o0 = original.get(l.id);
      if (o0 && !sameRow(o0, l)) changes.landings.update.push({ ...l, updatedAt: now });
    }
  }
  for (const w of writes.values()) {
    if (insertWrites.has(w.id)) changes.writes.insert.push(w);
    else {
      const o0 = origW.get(w.id);
      if (o0 && !sameRow(o0, w)) changes.writes.update.push({ ...w, updatedAt: now });
    }
  }
  return { changes, useCaseByKey: new Map([...uc.byKey].map(([k, r]) => [k, r.id] as const)) };
}

/** Org62's and the canvas's spelling of one value agree (a date, a number, a stage). */
function sameValue(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? '').trim();
  const y = (b ?? '').trim();
  if (x === y) return true;
  if (/^\d+(\.\d+)?$/.test(x) && /^\d+(\.\d+)?$/.test(y)) return Number(x) === Number(y);
  if (/^U0\d/.test(x) || /^U0\d/.test(y)) return phaseOfStage(x) === phaseOfStage(y) && x.slice(0, 3) === y.slice(0, 3);
  return x.slice(0, 10) === y.slice(0, 10) && /^\d{4}-\d{2}-\d{2}/.test(x);
}

/** Product__c of a VDP track (re-exported for the views). */
export const productOfTrack = ucProduct;
