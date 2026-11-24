/**
 * DC suggestions (R5): which opps deserve a Deal Contribution claim, from what I did (opp_engagement) rather than
 * from hours already in Org62 (lane 06 TA-6). Deterministic; a daily batch (src/jobs/handlers/dc-suggest.ts) and
 * Refresh run it, and each result lands as a suggestion row the user accepts, edits or rejects (nothing is claimed
 * for you: Accept drafts a DC request that rides the next logging canvas, an Outbox item applied by you).
 *
 * The rule. An opp is suggested when it is open, worth more than the persona's threshold (amount > min), sells a
 * product that counts (`dcProducts`, Settings ▸ Time; empty = every product), has no DC of mine and no live DC
 * request, and one of these holds:
 *   team      I'm on its team;
 *   work      this quarter: ≥ 1 h logged on it, or ≥ 2 meetings with the customer, or credit ≥ 3 (meetings, Slack,
 *             mail, docs, sessions, partly from the engine's alternates);
 *   covered   a coverage row matches it (D-103 (a), `coverageOf`: the person is its owner, on its team or its
 *             Specialist Forecast owner, within the row's window). Kind `ae` is a reason on its own (suggested
 *             unticked, "<AE>'s deal (AE you cover)"); `ooo` and `sme` need my work on it this quarter and
 *             their `creditShare` (50, 25) is the default split ("covering for <TA> (OOO) · 50%");
 *   sweep     the missed-opp sweep claims it.
 * Pre-ticked: team or work, no split question, and ≥ 15% of its group's evidence (coverage alone is never pre-ticked).
 *
 * Several opps, one engagement: suggestions on one account in the quarter form a group; each carries its share of the
 * group's evidence (credit, %). The DC split itself defaults to 100% (`dcSplit: 'full'`: a lower split would keep a
 * use case off Org62, D-63), or to the evidence share (`dcSplit: 'evidence'`); either way it is editable, and when
 * another architect already holds a DC on the opp there is no default (a split question).
 *
 * Edge cases (docs/EDGE-CASES.md AT-*): a burst spanning two accounts credits both at their scores (engagement.ts);
 * internal-only meetings credit nothing; a covered (`ae`) AE's opp I never touched is suggested unticked, an `ooo` or
 * `sme` one only with my work on it (AT-09 as amended by D-103); a reassigned opp (moved account or AE) is re-grouped,
 * and one suggested only for its coverage goes stale when the AE changes or the row's window ends (AT-10); an
 * accepted DC is never changed by a coverage change (J-8);
 * closed (lost or won) opps stop being suggested and keep their history (state `closed`); a rejected suggestion
 * comes back only when 2 h more are logged on it, I join its team, or once, on a call on its account after the
 * Reject (D-103 (d): the one dismissal rule, resurface.ts; the reason leads its reasons, code `returned`).
 */
import { coverageOf, coverageReason, type CoverageMatch } from './coverage';
import type { CoveredAeRef, WorldOpp } from './types';
import type { OppTotals } from './engagement';
import { dismissalBaseline, resurfaced, RESURFACE_HOURS, type DismissalBaseline } from './resurface';

export type DcReasonCode = 'team' | 'hours' | 'meetings' | 'work' | 'covered_ae' | 'sweep' | 'alternate' | 'split_question' | 'returned';

export interface DcReason {
  code: DcReasonCode;
  text: string;
}

export interface DcCandidateOpp extends WorldOpp {
  accountName?: string | null;
  /** A live DC request of mine is on it (not withdrawn, not confirmed, not "not created"). */
  requested?: boolean;
  /** Another architect's DC is on it (Org62's read). */
  otherArchitectDc?: boolean;
  /** The missed-opp sweep claims it. */
  sweepClaim?: boolean;
}

export type DcSuggestionState = 'new' | 'accepted' | 'edited' | 'rejected' | 'closed' | 'stale' | 'resolved';

/** A suggestion row as stored (dc_suggestions). */
export interface DcSuggestionRow {
  id: string;
  oppId: string;
  quarter: string;
  groupKey: string;
  state: DcSuggestionState;
  sharePercent: number;
  splitPercent: number | null;
  preTicked: boolean;
  reasons: DcReason[];
  evidence: Array<{ label: string; url: string | null; at: string }>;
  coveredAe: string | null;
  /**
   * Hours, team and the account's last call at the decision, and when (a rejected one comes back on a material
   * change, resurface.ts). Rows from before D-103 have only hours and team: `lastCallAt` reads as null.
   */
  baseline: ({ hours: number; onTeam: boolean } & Omit<DismissalBaseline, 'hours' | 'onTeam'>) | null;
  /** When it was decided (the store's column; an old baseline's time). */
  decidedAt?: string | null;
  dcRequestId: string | null;
}

export interface DcRuleInput {
  opps: readonly DcCandidateOpp[];
  /** Engagement totals this quarter, by opp. */
  totals: ReadonlyMap<string, OppTotals>;
  coveredAes: readonly CoveredAeRef[];
  /** The day coverage windows are checked on (YYYY-MM-DD; absent: windows are not checked). */
  asOf?: string;
  /** Products that count (case-insensitive words of a product or the opp's name); empty = every product. */
  dcProducts: readonly string[];
  minAmount: number;
  dcSplit: 'full' | 'evidence';
  quarter: string;
  existing: readonly DcSuggestionRow[];
  newId: (oppId: string) => string;
  /** D-103 (d): the last call on each account (`lastCallsByAccount`; absent: calls never bring a rejected one back). */
  calls?: ReadonlyMap<string, string>;
  /** The user's time zone (the call's date in a reason). */
  timezone?: string;
}

export interface DcPlan {
  /** Rows to insert or update (state, share, split, reasons, evidence). */
  upserts: DcSuggestionRow[];
}

export const DC_MIN_HOURS = 1;
export const DC_MIN_EXTERNAL_MEETINGS = 2;
export const DC_MIN_CREDIT = 3;
export const DC_PRETICK_SHARE = 15;
export const DC_RESURFACE_HOURS = RESURFACE_HOURS;

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The products that count: a product (or, without products, the opp's name) that has a `dcProducts` term. */
export function sellsDcProduct(o: Pick<WorldOpp, 'name' | 'products'>, dcProducts: readonly string[]): boolean {
  if (!dcProducts.length) return true;
  const hay = [...(o.products ?? []), o.name].join(' | ').toLowerCase();
  return dcProducts.some((p) => {
    const t = p.trim().toLowerCase();
    return !!t && new RegExp(`(?<![a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]*')}(?![a-z0-9])`).test(hay);
  });
}

/** A covered AE who owns the opp (owner only; `coverageOf` in coverage.ts is the full matcher). */
export function coveredAeOf(o: Pick<WorldOpp, 'owner'>, covered: readonly CoveredAeRef[]): CoveredAeRef | null {
  const m = coverageOf({ owner: o.owner }, covered);
  return m?.via === 'owner' ? m.ae : null;
}

const fmtH = (h: number) => `${r1(h)} h`;

/** The suggestions the rule makes now, merged with what is stored (decisions kept, history never deleted). */
export function planDcSuggestions(i: DcRuleInput): DcPlan {
  const byOpp = new Map(i.existing.filter((x) => x.quarter === i.quarter).map((x) => [x.oppId, x] as const));
  const fresh: Array<{ o: DcCandidateOpp; reasons: DcReason[]; back?: DcReason; strong: boolean; credit: number; cov: CoverageMatch | null; t: OppTotals | undefined }> = [];
  const upserts: DcSuggestionRow[] = [];
  const oppIds = new Set(i.opps.map((o) => o.id));

  for (const o of i.opps) {
    const prev = byOpp.get(o.id);
    const t = i.totals.get(o.id);
    // closed (lost or won): stop suggesting, keep the row (history)
    if (!o.isOpen) {
      if (prev && prev.state === 'new') upserts.push({ ...prev, state: 'closed', preTicked: false });
      continue;
    }
    if (o.myDc || o.requested) {
      if (prev && prev.state === 'new') upserts.push({ ...prev, state: 'resolved', preTicked: false });
      continue;
    }
    const reasons: DcReason[] = [];
    const hours = t?.hoursLogged ?? 0;
    if (o.isMine) reasons.push({ code: 'team', text: 'You’re on its team' });
    if (hours >= DC_MIN_HOURS) reasons.push({ code: 'hours', text: `${fmtH(hours)} logged on it this quarter` });
    if ((t?.externalMeetings ?? 0) >= DC_MIN_EXTERNAL_MEETINGS) reasons.push({ code: 'meetings', text: `${r1(t!.externalMeetings)} meetings with the customer this quarter` });
    if ((t?.credit ?? 0) >= DC_MIN_CREDIT && !reasons.some((r) => r.code === 'hours' || r.code === 'meetings')) reasons.push({ code: 'work', text: workWords(t!) });
    const strong = reasons.length > 0;
    const cov = coverageOf(o, i.coveredAes, i.asOf);
    const touched = (t?.credit ?? 0) > 0 || hours > 0;
    // D-103 (a): an `ae` match is a reason on its own; `ooo` and `sme` need my work on it
    if (cov && (cov.kind === 'ae' || touched)) reasons.push({ code: 'covered_ae', text: coverageReason(cov, o.accountName) });
    if (o.sweepClaim) reasons.push({ code: 'sweep', text: 'The missed-opp sweep says it is yours' });
    const eligible = reasons.length > 0 && o.amount !== null && o.amount !== undefined && o.amount > i.minAmount && sellsDcProduct(o, i.dcProducts);
    if (!eligible) {
      // the rule no longer holds (reassigned to an AE I don't cover, products changed): stale, kept
      if (prev && prev.state === 'new') upserts.push({ ...prev, state: 'stale', preTicked: false });
      continue;
    }
    // a rejected one comes back only on a material change (D-103 (d): hours, team, or once, a call after the Reject)
    // once back, it keeps saying why until it is decided again
    let back: DcReason | undefined = prev?.state === 'new' ? prev.reasons.find((r) => r.code === 'returned') : undefined;
    if (prev && prev.state === 'rejected') {
      const r = prev.baseline ? resurfaced(prev.baseline, { hours, onTeam: o.isMine, lastCallAt: (o.accountId && i.calls?.get(o.accountId)) || null, accountName: o.accountName, timezone: i.timezone }, prev.decidedAt) : null;
      if (!r) continue;
      back = { code: 'returned', text: r.text };
    }
    if (prev && (prev.state === 'accepted' || prev.state === 'edited')) continue;
    fresh.push({ o, reasons, back, strong: strong || !!o.sweepClaim, credit: Math.max(t?.credit ?? 0, o.isMine ? 1 : 0), cov, t });
  }

  // groups: one account's suggestions in the quarter (one engagement, several opps)
  const groups = new Map<string, typeof fresh>();
  for (const f of fresh) {
    const g = `${i.quarter}|${f.o.accountId ?? f.o.id}`;
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  for (const [groupKey, list] of groups) {
    const total = list.reduce((s, f) => s + f.credit, 0);
    const shares = sharesOf(list.map((f) => (total > 0 ? f.credit / total : 1 / list.length)));
    list.forEach((f, idx) => {
      const prev = byOpp.get(f.o.id);
      const share = shares[idx]!;
      const reasons = f.back ? [f.back, ...f.reasons] : [...f.reasons];
      if (list.length > 1) reasons.push({ code: 'alternate', text: `${share}% of the work on ${f.o.accountName ?? 'this account'} this quarter (${list.length} opportunities)` });
      let split: number | null = i.dcSplit === 'evidence' ? Math.max(1, share) : 100;
      // an OOO cover or an SME assist: its credit share is the default split (D-103 (a); editable on the suggestion)
      if (f.cov && f.cov.kind !== 'ae') split = Math.min(split, f.cov.creditShare);
      if (f.o.otherArchitectDc) {
        reasons.push({ code: 'split_question', text: 'Another architect has a DC on it: agree the split first' });
        split = null;
      }
      const evidence = (f.t?.refs ?? []).slice(0, 3);
      upserts.push({
        id: prev?.id ?? i.newId(f.o.id),
        oppId: f.o.id,
        quarter: i.quarter,
        groupKey,
        state: 'new',
        sharePercent: share,
        splitPercent: split,
        preTicked: f.strong && split !== null && share >= DC_PRETICK_SHARE,
        reasons,
        evidence,
        coveredAe: f.cov?.ae.name ?? null,
        baseline: null,
        dcRequestId: null,
      });
    });
  }
  // a stored "new" suggestion whose opp is gone from the app: stale
  for (const x of i.existing) if (x.quarter === i.quarter && x.state === 'new' && !oppIds.has(x.oppId) && !upserts.some((u) => u.id === x.id)) upserts.push({ ...x, state: 'stale', preTicked: false });
  return { upserts };
}

function workWords(t: OppTotals): string {
  const parts = [
    t.meetings ? `${r1(t.meetings)} meetings` : null,
    t.slackLines ? `${Math.round(t.slackLines)} Slack lines` : null,
    t.mailThreads ? `${r1(t.mailThreads)} mail threads` : null,
    t.docsTouched ? `${r1(t.docsTouched)} docs` : null,
    t.sessions ? `${r1(t.sessions)} sessions` : null,
  ].filter(Boolean);
  return `Your work on it this quarter: ${parts.join(', ') || 'several touches'}`;
}

/** Whole percents that add up to 100 (largest remainder). */
export function sharesOf(fracs: readonly number[]): number[] {
  if (!fracs.length) return [];
  const raw = fracs.map((f) => f * 100);
  const out = raw.map((x) => Math.floor(x));
  let left = 100 - out.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => ({ i, rem: x - Math.floor(x) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

/** The decision on one suggestion: the new state, and the baseline a rejected one is compared against. */
export function decideDc(row: DcSuggestionRow, decision: 'accept' | 'edit' | 'reject', facts: { hours: number; onTeam: boolean; lastCallAt?: string | null; at?: string }, dcRequestId: string | null = null, split?: number): DcSuggestionRow {
  // D-103 (d): a Reject remembers the account's last call and when, so only a later call brings it back (once)
  if (decision === 'reject') return { ...row, state: 'rejected', preTicked: false, baseline: facts.at ? { ...dismissalBaseline({ ...facts, lastCallAt: facts.lastCallAt ?? null }, facts.at), hours: r1(facts.hours), onTeam: facts.onTeam } : { hours: r1(facts.hours), onTeam: facts.onTeam } };
  return { ...row, state: decision === 'accept' ? 'accepted' : 'edited', dcRequestId, splitPercent: split ?? row.splitPercent, baseline: { hours: r1(facts.hours), onTeam: facts.onTeam } };
}
