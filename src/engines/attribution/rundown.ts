/**
 * The rundown of opps when unsure (lane 06 §4c): when the engine can't settle which opp a row (or a use case) goes
 * on, one card lists the likely ones with what I did on each lately, so a click picks it and nothing is typed.
 * Pure: candidates from `attribute()` (the top ones), plus every open opp on the candidates' accounts.
 */
import { coverageOf, coverageWhy } from './coverage';
import type { Attribution, CoveredAeRef, WorldOpp } from './types';
import type { OppTotals } from './engagement';

export interface RundownOpp {
  oppId: string;
  name: string;
  accountId: string | null;
  stage: string | null;
  closeDate: string | null;
  amount: number | null;
  isMine: boolean;
  myDc: boolean;
  coveredAe: string | null;
  /** The coverage row that matched, in words (D-103 (a)): "via Specialist Forecast owner: <AE>, you cover them since 3 Nov". */
  coverage: string | null;
  /** What I did on it in the last 4 weeks. */
  meetings4w: number;
  slack4w: number;
  hours4w: number;
  lastTouchAt: string | null;
  /** The engine's confidence for it (0 when it is only on the account). */
  confidence: number;
  /** The strongest reason, in words. */
  why: string | null;
}

export function oppRundown(a: Attribution | null, i: { opps: readonly WorldOpp[]; totals4w: ReadonlyMap<string, OppTotals>; coveredAes: readonly CoveredAeRef[]; asOf?: string; accountIds?: readonly string[]; limit?: number }): RundownOpp[] {
  const byId = new Map(i.opps.map((o) => [o.id, o] as const));
  const scored = new Map<string, { confidence: number; why: string | null }>();
  const accounts = new Set(i.accountIds ?? []);
  for (const c of a?.candidates ?? []) {
    if (c.kind === 'opp' && c.oppId) scored.set(c.oppId, { confidence: c.confidence, why: c.why.find((r) => r.weight > 0)?.text ?? null });
    if (c.accountId) accounts.add(c.accountId);
  }
  const ids = new Set<string>([...scored.keys()]);
  for (const o of i.opps) if (o.isOpen && o.accountId && accounts.has(o.accountId)) ids.add(o.id);
  const out: RundownOpp[] = [];
  for (const id of ids) {
    const o = byId.get(id);
    if (!o) continue;
    const t = i.totals4w.get(id);
    const s = scored.get(id);
    const cov = coverageOf(o, i.coveredAes, i.asOf);
    out.push({
      oppId: o.id,
      name: o.name,
      accountId: o.accountId,
      stage: o.stage ?? null,
      closeDate: o.closeDate ?? null,
      amount: o.amount ?? null,
      isMine: o.isMine,
      myDc: o.myDc,
      coveredAe: cov?.ae.name ?? null,
      coverage: cov ? coverageWhy(cov) : null,
      meetings4w: t?.meetings ?? 0,
      slack4w: Math.round(t?.slackLines ?? 0),
      hours4w: t?.hoursLogged ?? 0,
      lastTouchAt: t?.lastTouchAt ?? null,
      confidence: s?.confidence ?? 0,
      why: s?.why ?? (cov ? coverageWhy(cov) : null),
    });
  }
  out.sort((x, y) => y.confidence - x.confidence || Number(!!byId.get(y.oppId)?.isOpen) - Number(!!byId.get(x.oppId)?.isOpen) || (y.lastTouchAt ?? '').localeCompare(x.lastTouchAt ?? '') || Number(y.isMine || y.myDc) - Number(x.isMine || x.myDc) || (x.closeDate ?? '9999').localeCompare(y.closeDate ?? '9999') || x.name.localeCompare(y.name));
  return out.slice(0, i.limit ?? 6);
}
