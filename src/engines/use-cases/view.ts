/**
 * A candidate as the contract shows it (src/contract/use-cases.ts): names, why in words, where each half stands
 * (VDP: the Outbox item, then the mirror; Org62: the canvas row, then the read-back) and what Accept would stage.
 * Pure.
 */
import type { UseCaseCandidate, UseCaseCandidatesPayload, UseCaseHalf } from '@/contract/use-cases';
import type { UseCaseHolds } from '@/engines/activity/use-cases';

import { candidateRowKey } from './stage';
import { UC_STAGED, UC_WAITING, type UcCandidateRow } from './types';

export interface ViewContext {
  accountName: (id: string) => string | null;
  oppName: (id: string) => string | null;
  /** The opp's Org62 id (null: not in Org62, so no canvas row). */
  org62OppId: (oppId: string) => string | null;
  /** The VDP the candidate would go under (null: the account has none). */
  vdpFor: (row: UcCandidateRow) => string | null;
  holds: Pick<UseCaseHolds, 'held' | 'sent'>;
  /** The VDP Outbox item's state (null: gone). */
  vdpDraftStatus?: (draftId: string) => string | null;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Math.round(n * 1000) / 1000));

function org62Half(r: UcCandidateRow, c: ViewContext): UseCaseHalf {
  if (r.org62UseCaseId) return 'landed';
  if (r.status === 'staged_vdp') return 'not_needed';
  if (r.status !== 'accepted' && r.status !== 'staged_org62') return 'none';
  const key = candidateRowKey(r.id);
  if (c.holds.held.has(key)) return 'on_canvas';
  if (c.holds.sent.has(key)) return 'sent';
  return 'staged';
}

function vdpHalf(r: UcCandidateRow, c: ViewContext): UseCaseHalf {
  if (r.vdpUseCaseId) return 'landed';
  if (r.status === 'staged_org62') return 'not_needed';
  if (r.status !== 'accepted' && r.status !== 'staged_vdp') return 'none';
  const st = r.vdpDraftId ? (c.vdpDraftStatus?.(r.vdpDraftId) ?? 'ready') : null;
  return st === 'sent' || st === 'verified' ? 'sent' : 'staged';
}

/** What Accept would stage, in words (or why it can't), for a waiting candidate. */
function sendsOf(r: UcCandidateRow, c: ViewContext): string | null {
  if (!UC_WAITING.has(r.status)) return null;
  if (r.needsPick || !r.oppId) return 'Pick the opportunity it goes on';
  const org62 = !!c.org62OppId(r.oppId);
  const vdp = c.vdpFor(r);
  if (org62 && vdp) return `A VDP item under ${vdp} and an Org62 row on your next logging canvas`;
  if (org62) return 'An Org62 row on your next logging canvas (the account has no VDP)';
  if (vdp) return `A VDP item under ${vdp} (the opp is not in Org62 yet)`;
  return 'Nowhere to add it yet: the opp is not in Org62 and the account has no VDP';
}

export function candidateView(r: UcCandidateRow, c: ViewContext): UseCaseCandidate {
  return {
    id: r.id,
    source: r.source,
    title: r.title,
    problem: r.problem,
    products: r.products,
    outcome: r.outcome,
    track: r.track,
    stageHint: r.stageHint,
    status: r.status,
    rejectReason: r.rejectReason,
    accountId: r.accountId,
    accountName: r.accountId ? c.accountName(r.accountId) : null,
    oppId: r.oppId,
    oppName: r.oppId ? c.oppName(r.oppId) : null,
    confidence: clamp01(r.confidence),
    why: r.why.map((x) => x.text).filter(Boolean),
    needsPick: r.needsPick,
    alternates: r.needsPick ? r.alternates.slice(0, 3).map((o) => ({ ...o, accountName: (o as { accountName?: string | null }).accountName ?? (o.accountId ? c.accountName(o.accountId) : null), confidence: clamp01(o.confidence) })) : [],
    basis: r.basis,
    evidence: r.evidence.map((e) => ({ sourceItemId: e.sourceItemId, kind: e.kind, label: e.label, url: e.url, at: e.at, quote: e.quote })),
    vdpSlug: r.vdpSlug ?? (UC_WAITING.has(r.status) ? c.vdpFor(r) : null),
    vdpDraftId: r.vdpDraftId,
    org62UseCaseId: r.org62UseCaseId,
    vdpUseCaseId: r.vdpUseCaseId,
    org62: org62Half(r, c),
    vdp: vdpHalf(r, c),
    sends: sendsOf(r, c),
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  };
}

const latest = (r: UcCandidateRow) => r.evidence.at(-1)?.at ?? r.createdAt;

/** The payload: waiting ones (newest evidence first), the last 30 days' decided ones, the counts. */
export function candidatesPayload(rows: readonly UcCandidateRow[], c: ViewContext, o: { enabled: boolean; now: string; generatedAt: string | null }): UseCaseCandidatesPayload {
  if (!o.enabled) return { enabled: false, candidates: [], decided: [], counts: { toAdd: 0, needsPick: 0, staged: 0, landed: 0 }, generatedAt: o.generatedAt };
  const since = new Date(Date.parse(o.now) - 30 * 86_400_000).toISOString();
  const own = rows.filter((r) => r.matchedKind === null);
  const waiting = own.filter((r) => UC_WAITING.has(r.status)).sort((a, b) => latest(b).localeCompare(latest(a)) || a.title.localeCompare(b.title));
  const decided = own.filter((r) => !UC_WAITING.has(r.status) && (r.decidedAt ?? r.updatedAt) >= since).sort((a, b) => (b.decidedAt ?? b.updatedAt).localeCompare(a.decidedAt ?? a.updatedAt));
  return {
    enabled: true,
    candidates: waiting.map((r) => candidateView(r, c)),
    // every decision of the 30-day window (caps audit 2026-11-21: was the newest 50, with no count or way to the rest)
    decided: decided.map((r) => candidateView(r, c)),
    counts: { toAdd: waiting.length, needsPick: waiting.filter((r) => r.needsPick).length, staged: own.filter((r) => UC_STAGED.has(r.status)).length, landed: own.filter((r) => r.status === 'landed').length },
    generatedAt: o.generatedAt,
  };
}
