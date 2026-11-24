/**
 * Decisions and staging (lane 06 §4c "Add to VDP + Org62"; D-67 / D-70 mechanics unchanged): Accept drafts both
 * writes, each through its existing path, each applied by the user (tenet: Nothing leaves without approval).
 *
 *   VDP     a `create_use_case` Outbox item under the VDP of the opp (or its account), the D-49 adapter's own
 *           validation and duplicate check (vdpActionFor); dry run as the user set it.
 *   Org62   a USE CASES row (Use_Case__c, OwnerId me) that rides the next logging canvas, like a VDP use case's
 *           (D-67): keyed `uc:cand-<id>`, its Notes carry `CC-UC#cand-<id>`, so a waiting canvas holds it and a sent
 *           one hands it off. H-9: it may go before my 100% DC (an open opp with an Org62 id is enough).
 *   status  both drafted: accepted · only Org62 (no VDP for the account): staged_org62 · only VDP (Org62 has it, or
 *           the opp has no Org62 id): staged_vdp · landed once the reads find it where it was staged.
 *   learn   an Accept on the shown opp strengthens the rules that pointed there; a pick of another opp (Accept with
 *           an opp, Edit, or Reject ▸ Wrong opp with the right one) is a correction; Reject ▸ Wrong opp alone decays
 *           the rules that pointed at it (the attribution engine's planLearning).
 * Pure.
 */
import { UC_AGENT_TYPES, ucEntitlement, ucProduct, ucStage, type UcCanvasCreate, type UseCaseCreate, type UseCaseHolds } from '@/engines/activity/use-cases';
import type { Chosen } from '@/engines/attribution/rules';

import { dedupeKeyOf, problemKey, sameUseCase } from './similar';
import { UC_STAGED, UC_WAITING, type UcCandidateRow, type UcCandidateStatus, type UcRejectReason } from './types';

/** The VDP use case id a candidate's canvas row carries (`CC-UC#cand-<id>`: letters, digits and hyphens). */
export const candidateUcKey = (id: string) => `cand-${id}`;
export const candidateOfUcKey = (vdpUseCaseId: string): string | null => (vdpUseCaseId.startsWith('cand-') ? vdpUseCaseId.slice(5) : null);
/** The row key a waiting canvas holds it by. */
export const candidateRowKey = (id: string) => `uc:${candidateUcKey(id)}`;

export interface DecideBody {
  decision: 'accept' | 'edit' | 'reject';
  oppId?: string | null;
  title?: string;
  problem?: string;
  products?: string[];
  outcome?: string;
  track?: 'd360' | 'agentforce' | null;
  reason?: UcRejectReason;
}

/** The opps a decision may name (open ones; the candidate's own account first in the picker). */
export interface DecideOpp {
  id: string;
  accountId: string | null;
  isOpen: boolean;
}

export class DecideError extends Error {
  override name = 'DecideError';
}

/** The learning a decision makes (null: nothing about the opp to learn). */
export interface DecisionLearning {
  outcome: 'accept' | 'edit' | 'reject';
  chosen: Chosen;
  shown: Chosen | null;
}

export interface Decided {
  next: UcCandidateRow;
  learning: DecisionLearning | null;
  /** Accept: stage it (the caller drafts the VDP item and lets the Org62 row ride the next canvas). */
  stage: boolean;
}

const shownOf = (r: UcCandidateRow): Chosen | null => (r.oppId ? { oppId: r.oppId, accountId: r.accountId } : null);

/** One decision on a waiting candidate (accept · edit · reject), before staging. */
export function decideCandidate(row: UcCandidateRow, body: DecideBody, opps: readonly DecideOpp[], now: string): Decided {
  if (!UC_WAITING.has(row.status)) throw new DecideError(`This use case is ${row.status.replace('_', ' ')} already`);
  const opp = body.oppId ? opps.find((o) => o.id === body.oppId) : undefined;
  if (body.oppId && !opp) throw new DecideError('That opportunity is not one of yours');
  if (opp && !opp.isOpen) throw new DecideError('That opportunity is closed: a new use case goes on an open one');
  const retarget = (r: UcCandidateRow): UcCandidateRow => (opp ? { ...r, oppId: opp.id, accountId: opp.accountId ?? r.accountId, needsPick: false, alternates: [] } : r);
  const rekey = (r: UcCandidateRow): UcCandidateRow => ({ ...r, problemKey: problemKey(r.title), dedupeKey: dedupeKeyOf({ oppId: r.needsPick ? null : r.oppId, accountId: r.accountId, product: r.products[0] ?? null, title: r.title }) });
  const changedOpp = !!opp && opp.id !== row.oppId;
  if (body.decision === 'reject') {
    if (!body.reason) throw new DecideError('Say why: not a use case, wrong opp, a duplicate, or already in Org62');
    // a wrong opp with the right one picked is a correction, not a no: it stays to add, on that opp
    if (body.reason === 'wrong_opp' && opp) {
      const next = rekey({ ...retarget(row), status: 'edited', updatedAt: now });
      return { next, learning: { outcome: 'edit', chosen: { oppId: opp.id, accountId: opp.accountId }, shown: shownOf(row) }, stage: false };
    }
    const next: UcCandidateRow = { ...row, status: 'rejected', rejectReason: body.reason, decidedAt: now, updatedAt: now };
    return { next, learning: body.reason === 'wrong_opp' && row.oppId ? { outcome: 'reject', chosen: { oppId: null, accountId: null }, shown: shownOf(row) } : null, stage: false };
  }
  const edited: UcCandidateRow = {
    ...retarget(row),
    ...(body.title?.trim() ? { title: body.title.trim().slice(0, 120) } : {}),
    ...(body.problem !== undefined ? { problem: body.problem.trim().slice(0, 2000) } : {}),
    ...(body.products ? { products: [...new Set(body.products.map((p) => p.trim()).filter(Boolean))].slice(0, 6) } : {}),
    ...(body.outcome !== undefined ? { outcome: body.outcome.trim().slice(0, 1000) } : {}),
    ...(body.track !== undefined ? { track: body.track } : {}),
    updatedAt: now,
  };
  const next0 = rekey(edited);
  const learning: DecisionLearning | null = opp ? { outcome: changedOpp ? 'edit' : 'accept', chosen: { oppId: opp.id, accountId: opp.accountId }, shown: shownOf(row) } : null;
  if (body.decision === 'edit') return { next: { ...next0, status: 'edited' }, learning: changedOpp ? learning : null, stage: false };
  if (!next0.oppId || next0.needsPick) throw new DecideError('Pick the opportunity it goes on first');
  return { next: { ...next0, decidedAt: now }, learning: learning ?? { outcome: 'accept', chosen: { oppId: next0.oppId, accountId: next0.accountId }, shown: shownOf(row) }, stage: true };
}

/** What Accept can stage for a candidate's opp. */
export interface StageContext {
  /** The opp's Org62 id (null: not in Org62 yet, so no canvas row) and whether it is open. */
  org62OppId: string | null;
  oppOpen: boolean;
  /** The VDP it goes under (the mirror: one listing the opp, else the account's live one); null: none. */
  vdpSlug: string | null;
  /** Org62 / VDP already has it (dedupe found it there). */
  inOrg62: boolean;
  inVdp: boolean;
}

export interface StagePlan {
  status: Extract<UcCandidateStatus, 'accepted' | 'staged_org62' | 'staged_vdp'>;
  org62: boolean;
  vdp: { vdpSlug: string; title: string; track: 'd360' | 'agentforce' } | null;
  /** In words, for the toast ("VDP item drafted · Org62 row on your next canvas"). */
  words: string;
}

export function stagePlanOf(row: UcCandidateRow, c: StageContext): StagePlan {
  const org62 = !!c.org62OppId && c.oppOpen && !c.inOrg62;
  const vdp = c.vdpSlug && !c.inVdp ? { vdpSlug: c.vdpSlug, title: row.title, track: row.track ?? 'd360' } : null;
  if (!org62 && !vdp) throw new DecideError(c.inOrg62 && (c.inVdp || !c.vdpSlug) ? 'It is in Org62 and VDP already: reject it as already in Org62' : 'Nowhere to add it: the opp is not in Org62 yet and its account has no VDP');
  const status = org62 && vdp ? 'accepted' : org62 ? 'staged_org62' : 'staged_vdp';
  const words = [vdp ? `VDP item drafted (${vdp.vdpSlug})` : null, org62 ? 'Org62 row on your next logging canvas' : null].filter(Boolean).join(' · ');
  return { status, org62, vdp, words };
}

export interface CanvasOpp {
  org62Id: string;
  name: string;
  accountOrg62Id: string;
  closeDate: string | null;
}

/** The Use_Case__c row a candidate becomes on a logging canvas (the D-67 table, CC-UC#cand-<id> in Notes). */
export function canvasCreateOf(row: UcCandidateRow, opp: CanvasOpp): UseCaseCreate {
  const track = row.track ?? 'd360';
  const quotes = row.evidence.map((e) => e.quote).filter((q): q is string => !!q).slice(0, 3);
  const source = `Source: VDP ${row.vdpSlug ?? '(not in VDP yet)'} · Command Center use case from ${row.evidence[0]?.label ?? row.source} · CC-UC#${candidateUcKey(row.id)}`;
  const notes = quotes.length ? `${quotes.map((q) => `“${q}”`).join('\n')}\n\n${source}` : source;
  return {
    vdpUseCaseId: candidateUcKey(row.id),
    vdpSlug: row.vdpSlug ?? '',
    vdpUrl: null,
    companyName: '',
    displayOrder: 0,
    name: row.title.slice(0, 255),
    opportunityId: opp.org62Id,
    accountId: opp.accountOrg62Id,
    oppName: opp.name,
    oppCloseDate: opp.closeDate,
    product: ucProduct(track),
    agentTypes: [UC_AGENT_TYPES[track][0]!],
    entitlement: ucEntitlement(null, track),
    stage: ucStage(row.stageHint),
    goLive: '',
    businessProblem: row.problem.slice(0, 32_000),
    kpis: row.outcome.slice(0, 32_000),
    notes,
    again: false,
  };
}

const id15 = (s: string | null | undefined) => (s ?? '').slice(0, 15);

/**
 * The candidate rows the next logging canvas carries: accepted ones with an Org62 part not read back yet, not held
 * by a waiting canvas and not handed off on a sent one.
 */
export function pendingCandidateCreates(rows: readonly UcCandidateRow[], holds: Pick<UseCaseHolds, 'held' | 'sent'>, oppOf: (oppId: string) => CanvasOpp | null): UseCaseCreate[] {
  const out: UseCaseCreate[] = [];
  for (const r of rows) {
    if (r.status !== 'accepted' && r.status !== 'staged_org62') continue;
    if (r.org62UseCaseId || !r.oppId) continue;
    const key = candidateRowKey(r.id);
    if (holds.held.has(key) || holds.sent.has(key)) continue;
    const opp = oppOf(r.oppId);
    if (opp) out.push(canvasCreateOf(r, opp));
  }
  return out;
}

/**
 * The plan's VDP → Org62 creates a staged candidate already covers (the VDP item landed and VDP read it before the
 * Org62 read-back saw the candidate's record): the candidate's row wins, so Slackbot never gets the same use case twice.
 */
export function withoutCandidateDuplicates(planCreates: readonly UseCaseCreate[], rows: readonly UcCandidateRow[], org62OppOf: (oppId: string) => string | null): UseCaseCreate[] {
  const staged = rows.filter((r) => (UC_STAGED.has(r.status) || r.status === 'landed') && r.matchedKind === null && r.oppId && !r.org62UseCaseId);
  if (!staged.length) return [...planCreates];
  return planCreates.filter((c) => !staged.some((r) => id15(org62OppOf(r.oppId!)) === id15(c.opportunityId) && sameUseCase(r.title, c.name).same));
}

/** A staged candidate's landing: the Org62 record and VDP use case the reads found for it. */
export interface LandingFacts {
  /** Use_Case__c records on the opp (live ones): id, name. */
  org62: ReadonlyArray<{ id: string; name: string | null; opportunityId: string | null }>;
  /** VDP use cases on the candidate's VDP: id, title. */
  vdp: ReadonlyArray<{ id: string; title: string | null; vdpSlug: string }>;
  /** A sent canvas carried its row (sentCreates by `cand-<id>`). */
  sentCreate?: (key: string) => UcCanvasCreate | undefined;
}

/** What the reads say about a staged candidate (null: nothing new). */
export function landingOf(row: UcCandidateRow, org62OppId: string | null, f: LandingFacts): Partial<Pick<UcCandidateRow, 'org62UseCaseId' | 'vdpUseCaseId' | 'status'>> | null {
  if (!UC_STAGED.has(row.status)) return null;
  const sent = f.sentCreate?.(candidateUcKey(row.id));
  const names = [row.title, sent?.name].filter((x): x is string => !!x);
  const rec = !row.org62UseCaseId && org62OppId ? f.org62.find((r) => id15(r.opportunityId) === id15(org62OppId) && names.some((n) => sameUseCase(n, r.name ?? '').same)) : undefined;
  const uc = !row.vdpUseCaseId && row.vdpSlug ? f.vdp.find((u) => u.vdpSlug === row.vdpSlug && sameUseCase(row.title, u.title ?? '').same) : undefined;
  if (!rec && !uc) return null;
  const org62Id = row.org62UseCaseId ?? rec?.id ?? null;
  const vdpId = row.vdpUseCaseId ?? uc?.id ?? null;
  const needOrg62 = row.status === 'accepted' || row.status === 'staged_org62';
  const needVdp = row.status === 'accepted' || row.status === 'staged_vdp';
  const done = (!needOrg62 || !!org62Id) && (!needVdp || !!vdpId);
  return { ...(rec ? { org62UseCaseId: rec.id } : {}), ...(uc ? { vdpUseCaseId: uc.id } : {}), ...(done ? { status: 'landed' as const } : {}) };
}
