/**
 * From mentions to candidates (lane 06 §4c): each use-case statement is attributed by the one attribution engine
 * (`attribute()`: the source's own opp, learned rules, the channel map, the attendees' domains, the words), deduped
 * against what exists (app use cases, Org62 records, VDP use cases and other candidates: same opp, or same account
 * when the opp is not settled; same title by VDP's rule, the problem key or pg_trgm similarity), and either becomes a
 * new candidate or adds its evidence to the one it matches. When the engine is unsure of the opp (under the settle
 * line, or a close second), the candidate carries the top 3 opps of the rundown for the picker; nothing is ever
 * guessed for you. Pure.
 */
import { attribute } from '@/engines/attribution/score';
import { oppRundown } from '@/engines/attribution/rundown';
import { weightsOf } from '@/engines/attribution/weights';
import type { OppTotals } from '@/engines/attribution/engagement';
import type { Signal, World } from '@/engines/attribution/types';

import { dedupeKeyOf, problemKey, sameUseCase } from './similar';
import type { UcCandidateRow, UcEvidence, UcExisting, UcMatchKind, UcMention, UcSource } from './types';

/** The most evidence links a candidate keeps (newest last). */
export const EVIDENCE_MAX = 12;

const SIGNAL_KIND: Record<UcSource['kind'], Signal['kind']> = { gemini_note: 'gemini', meeting: 'calendar', slack_burst: 'slack', mail_thread: 'gmail', manual: 'manual' };

/** The signal attribute() reads for a mention: its words, its source's people, channel, series and links. */
export function signalOf(src: UcSource, m: Pick<UcMention, 'title' | 'statement'>): Signal {
  return {
    kind: SIGNAL_KIND[src.kind],
    text: `${src.title} ${m.title} ${m.statement}`.slice(0, 600),
    at: src.at,
    domains: src.externalDomains,
    emails: src.externalEmails,
    channel: src.channel ?? null,
    seriesId: src.seriesId ?? null,
    explicit: src.explicit ?? null,
  };
}

export function evidenceOf(src: UcSource, m: Pick<UcMention, 'statement'> | null): UcEvidence {
  return { sourceKey: src.key, sourceItemId: src.sourceItemIds[0] ?? null, kind: src.kind, label: src.title.slice(0, 160), url: src.url, at: src.at, quote: m ? m.statement.slice(0, 200) : null };
}

/** Evidence added to a list (once per source, newest last, at most EVIDENCE_MAX). */
export function withEvidence(list: readonly UcEvidence[], e: UcEvidence): UcEvidence[] {
  if (list.some((x) => x.sourceKey === e.sourceKey)) return [...list];
  return [...list, e].sort((a, b) => a.at.localeCompare(b.at)).slice(-EVIDENCE_MAX);
}

export interface UcAttribution {
  oppId: string | null;
  accountId: string | null;
  confidence: number;
  why: UcCandidateRow['why'];
  needsPick: boolean;
  alternates: UcCandidateRow['alternates'];
}

/** The opp (and account) a mention is about, with why; the top 3 of the rundown when unsure. */
export function attributeMention(sig: Signal, world: World, totals4w: ReadonlyMap<string, OppTotals>): UcAttribution {
  const W = weightsOf(world.weights);
  const a = attribute(sig, world, { limit: 6 });
  const opps = new Map(world.opps.map((o) => [o.id, o] as const));
  const top = a.candidates.find((c) => c.kind === 'opp' && c.oppId && opps.get(c.oppId)?.isOpen) ?? null;
  const acct = top?.accountId ?? a.candidates.find((c) => c.kind === 'account')?.accountId ?? a.candidates.find((c) => c.accountId)?.accountId ?? null;
  const unsure = !top || a.needsAsk || top.confidence < W.settle || a.top?.kind !== 'opp';
  const alternates = unsure ? oppRundown(a, { opps: world.opps, totals4w, coveredAes: world.coveredAes ?? [], accountIds: acct ? [acct] : [], limit: 3 }) : [];
  return { oppId: top?.oppId ?? alternates[0]?.oppId ?? null, accountId: acct ?? (top?.oppId ? (opps.get(top.oppId)?.accountId ?? null) : null), confidence: top?.confidence ?? 0, why: (top ?? a.top)?.why.filter((r) => r.weight > 0).slice(0, 4) ?? [], needsPick: unsure, alternates };
}

/** The account an opp is on (for scope checks). */
const accountOfOpp = (world: Pick<World, 'opps'>, oppId: string | null) => (oppId ? (world.opps.find((o) => o.id === oppId)?.accountId ?? null) : null);

interface Scoped {
  oppId: string | null;
  accountId: string | null;
}

/** Two use cases are in the same place: the same opp when both are settled, else the same account. */
export function sameScope(world: Pick<World, 'opps'>, a: Scoped & { needsPick?: boolean }, b: Scoped & { needsPick?: boolean }): boolean {
  const ao = a.needsPick ? null : a.oppId;
  const bo = b.needsPick ? null : b.oppId;
  if (ao && bo) return ao === bo;
  const aa = a.accountId ?? accountOfOpp(world, a.oppId);
  const ba = b.accountId ?? accountOfOpp(world, b.oppId);
  return !!aa && aa === ba;
}

export type UcMatch = { kind: 'candidate'; row: UcCandidateRow; how: string } | { kind: Exclude<UcMatchKind, 'candidate'>; existing: UcExisting; how: string };

/**
 * What a new mention already is: an existing use case first (VDP, Org62, the app's), then a candidate (any status:
 * a rejected one keeps a mention out too), by the dedupe key or a same-scope title match.
 */
export function findMatch(world: Pick<World, 'opps'>, c: Scoped & { title: string; needsPick?: boolean; dedupeKey: string }, existing: readonly UcExisting[], candidates: readonly UcCandidateRow[]): UcMatch | null {
  for (const e of existing) {
    if (!sameScope(world, c, e)) continue;
    const s = sameUseCase(c.title, e.title);
    if (s.same) return { kind: e.kind, existing: e, how: s.how! };
  }
  const byKey = candidates.find((x) => x.dedupeKey === c.dedupeKey);
  if (byKey) return { kind: 'candidate', row: byKey, how: 'key' };
  for (const x of candidates) {
    if (!sameScope(world, c, x)) continue;
    const s = sameUseCase(c.title, x.title);
    if (s.same) return { kind: 'candidate', row: x, how: s.how! };
  }
  return null;
}

export interface UcPlanInput {
  sources: readonly UcSource[];
  /** The mentions per source key that count (sure ones, and unsure ones the model confirmed). */
  mentions: ReadonlyMap<string, readonly UcMention[]>;
  world: World;
  totals4w: ReadonlyMap<string, OppTotals>;
  existing: readonly UcExisting[];
  candidates: readonly UcCandidateRow[];
  now: string;
  newId: () => string;
  basis?: (m: UcMention) => 'rules' | 'ai';
}

export interface UcPlan {
  creates: UcCandidateRow[];
  /** Candidates that gained evidence (before → after). */
  updates: Array<{ before: UcCandidateRow; after: UcCandidateRow }>;
  counts: { mentions: number; created: number; attached: number; matchedExisting: number; unattributed: number };
}

/** A new candidate row. */
export function newCandidate(i: { id: string; now: string; src: UcSource; m: UcMention; at: UcAttribution; sig: Signal; basis: 'rules' | 'ai'; status?: UcCandidateRow['status']; match?: UcExisting | null }): UcCandidateRow {
  const product = i.m.products[0] ?? (i.m.track === 'agentforce' ? 'Agentforce' : i.m.track === 'd360' ? 'Data 360' : null);
  const e = i.match;
  return {
    id: i.id,
    source: i.src.kind,
    sourceKey: i.src.key,
    title: i.m.title,
    problem: i.m.problem,
    products: i.m.products,
    outcome: i.m.outcome,
    track: i.m.track,
    stageHint: i.m.stageHint,
    status: i.status ?? 'suggested',
    rejectReason: null,
    accountId: i.at.accountId,
    oppId: i.at.oppId,
    confidence: i.at.confidence,
    why: i.at.why,
    needsPick: i.at.needsPick,
    alternates: i.at.alternates,
    basis: i.basis,
    dedupeKey: dedupeKeyOf({ oppId: i.at.needsPick ? null : i.at.oppId, accountId: i.at.accountId, product, title: i.m.title }),
    problemKey: problemKey(i.m.title),
    evidence: [evidenceOf(i.src, i.m)],
    signal: i.sig,
    matchedKind: e ? e.kind : null,
    useCaseId: e?.useCaseId ?? (e?.kind === 'use_case' ? e.id : null),
    org62UseCaseId: e?.org62UseCaseId ?? (e?.kind === 'org62' ? e.id : null),
    vdpUseCaseId: e?.vdpUseCaseId ?? (e?.kind === 'vdp' ? e.id : null),
    vdpSlug: e?.vdpSlug ?? null,
    vdpDraftId: null,
    createdAt: i.now,
    decidedAt: e ? i.now : null,
    updatedAt: i.now,
  };
}

/** The candidates the mentions make, and the evidence they add to what exists. */
export function planCandidates(i: UcPlanInput): UcPlan {
  const creates: UcCandidateRow[] = [];
  const updated = new Map<string, { before: UcCandidateRow; after: UcCandidateRow }>();
  const counts = { mentions: 0, created: 0, attached: 0, matchedExisting: 0, unattributed: 0 };
  const current = (r: UcCandidateRow) => updated.get(r.id)?.after ?? creates.find((x) => x.id === r.id) ?? r;
  const pool = () => [...i.candidates.map(current), ...creates.filter((c) => !i.candidates.some((x) => x.id === c.id))];
  const attach = (row: UcCandidateRow, e: UcEvidence) => {
    const cur = current(row);
    const evidence = withEvidence(cur.evidence, e);
    if (evidence.length === cur.evidence.length) return;
    const after = { ...cur, evidence, updatedAt: i.now };
    const created = creates.findIndex((x) => x.id === row.id);
    if (created >= 0) creates[created] = after;
    else updated.set(row.id, { before: updated.get(row.id)?.before ?? row, after });
    counts.attached += 1;
  };
  for (const src of i.sources) {
    for (const m of i.mentions.get(src.key) ?? []) {
      counts.mentions += 1;
      const sig = signalOf(src, m);
      const at = attributeMention(sig, i.world, i.totals4w);
      if (!at.oppId && !at.accountId) {
        counts.unattributed += 1;
        continue;
      }
      const product = m.products[0] ?? null;
      const key = dedupeKeyOf({ oppId: at.needsPick ? null : at.oppId, accountId: at.accountId, product, title: m.title });
      const match = findMatch(i.world, { ...at, title: m.title, dedupeKey: key }, i.existing, pool());
      const ev = evidenceOf(src, m);
      if (match?.kind === 'candidate') {
        attach(match.row, ev);
        continue;
      }
      if (match) {
        counts.matchedExisting += 1;
        // the evidence ledger of a use case that exists: one landed row per existing use case
        const ledger = pool().find((x) => x.matchedKind === match.kind && (x.useCaseId === match.existing.id || x.org62UseCaseId === match.existing.id || x.vdpUseCaseId === match.existing.id));
        if (ledger) attach(ledger, ev);
        else creates.push(newCandidate({ id: i.newId(), now: i.now, src, m: { ...m, title: match.existing.title || m.title }, at: { ...at, oppId: match.existing.oppId ?? at.oppId, accountId: match.existing.accountId ?? at.accountId, needsPick: false, alternates: [] }, sig, basis: i.basis?.(m) ?? 'rules', status: 'landed', match: match.existing }));
        continue;
      }
      creates.push(newCandidate({ id: i.newId(), now: i.now, src, m, at, sig, basis: i.basis?.(m) ?? 'rules' }));
      counts.created += 1;
    }
  }
  return { creates, updates: [...updated.values()], counts };
}
