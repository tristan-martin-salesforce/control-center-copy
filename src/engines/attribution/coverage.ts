/**
 * Coverage as data (D-103 (a)): one matcher for "is this opp one of the people I cover?". Pure.
 *
 * A coverage row (Settings ▸ Time ▸ AEs I cover) matches an opp when its person is the opp's owner, an opportunity
 * team member, or a Specialist Forecast owner (`specialistForecastOwnerIds`, filled by the SFR read), and the row's
 * window holds on `asOf`. Precedence when several rows or roles match: kind `ae` over `ooo` over `sme`, then owner over
 * team over Specialist Forecast owner. dc.ts (DC suggestions), score.ts (the scorer) and rundown.ts (the "why") call it.
 */
import { sameOrg62Id } from '@/connectors/org62/ids';

import type { CoveredAeRef, WorldOpp } from './types';

export type CoverageKindName = 'ae' | 'ooo' | 'sme';
export type CoverageVia = 'owner' | 'team' | 'sfr';

export interface CoverageMatch {
  kind: CoverageKindName;
  creditShare: 100 | 50 | 25;
  via: CoverageVia;
  ae: CoveredAeRef;
}

export const COVERAGE_SHARE: Readonly<Record<CoverageKindName, 100 | 50 | 25>> = { ae: 100, ooo: 50, sme: 25 };

type Who = { name?: string | null; org62UserId?: string | null; email?: string | null } | null | undefined;

/** The same person: an Org62 user id (15/18), an email, or a name. */
export function samePerson(ae: Pick<CoveredAeRef, 'name' | 'org62UserId' | 'email'>, p: Who): boolean {
  if (!p) return false;
  if (sameOrg62Id(ae.org62UserId, p.org62UserId)) return true;
  if (ae.email && p.email && ae.email.toLowerCase() === p.email.toLowerCase()) return true;
  return !!p.name && ae.name.trim().toLowerCase() === p.name.trim().toLowerCase();
}

/** The row's window holds on `asOf` (no window: always; no `asOf`: windows are not checked). */
export function coverageActive(ae: Pick<CoveredAeRef, 'window'>, asOf?: string | null): boolean {
  const w = ae.window;
  if (!w || !asOf) return true;
  const d = asOf.slice(0, 10);
  return d >= w.from && (!w.to || d <= w.to);
}

const KIND_ORDER: Record<CoverageKindName, number> = { ae: 0, ooo: 1, sme: 2 };
const VIA_ORDER: Record<CoverageVia, number> = { owner: 0, team: 1, sfr: 2 };

type CoverageOpp = Pick<WorldOpp, 'owner' | 'team' | 'specialistForecastOwnerIds'>;

/** How `ae` is on the opp, or null. */
function viaOf(opp: CoverageOpp, ae: CoveredAeRef): CoverageVia | null {
  if (samePerson(ae, opp.owner)) return 'owner';
  if ((opp.team ?? []).some((m) => samePerson(ae, m))) return 'team';
  if (ae.org62UserId && (opp.specialistForecastOwnerIds ?? []).some((id) => sameOrg62Id(ae.org62UserId, id))) return 'sfr';
  return null;
}

/** The coverage row that matches the opp on `asOf` (YYYY-MM-DD), with its kind, credit share and how it matched; or null. */
export function coverageOf(opp: CoverageOpp, coverage: readonly CoveredAeRef[], asOf?: string | null): CoverageMatch | null {
  let best: CoverageMatch | null = null;
  for (const ae of coverage) {
    if (!coverageActive(ae, asOf)) continue;
    const via = viaOf(opp, ae);
    if (!via) continue;
    const kind = ae.kind ?? 'ae';
    const m: CoverageMatch = { kind, creditShare: ae.creditShare ?? COVERAGE_SHARE[kind], via, ae };
    if (!best || KIND_ORDER[kind] < KIND_ORDER[best.kind] || (kind === best.kind && VIA_ORDER[via] < VIA_ORDER[best.via])) best = m;
  }
  return best;
}

const VIA_WORDS: Record<CoverageVia, string> = { owner: 'opportunity owner', team: 'opportunity team', sfr: 'Specialist Forecast owner' };
const KIND_WORDS: Record<CoverageKindName, string> = { ae: 'you cover them', ooo: 'you cover them while they are out', sme: 'you assist as SME' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayWords = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''}`.trim();

/** "via Specialist Forecast owner: Avery Park, you cover them since 3 Nov" (the rundown's why). */
export function coverageWhy(m: CoverageMatch): string {
  const w = m.ae.window;
  const when = w ? (w.to ? ` ${dayWords(w.from)}–${dayWords(w.to)}` : ` since ${dayWords(w.from)}`) : '';
  return `via ${VIA_WORDS[m.via]}: ${m.ae.name}, ${KIND_WORDS[m.kind]}${when}`;
}

/**
 * The DC suggestion's coverage reason, who first, then the kind, then the split: "Morgan Hale's deal (AE you cover)",
 * "covering for Elena Cruz (OOO) · 50%", "assisting on Hooli's deal (SME) · 25%" (the account's name, else the
 * person's). The row's note stays on Settings ▸ Time; the reason is the app's own words.
 */
export function coverageReason(m: CoverageMatch, accountName?: string | null): string {
  if (m.kind === 'ae') return `${m.ae.name}'s deal (AE you cover)`;
  if (m.kind === 'ooo') return `covering for ${m.ae.name} (OOO) · ${m.creditShare}%`;
  return `assisting on ${accountName?.trim() || m.ae.name}'s deal (SME) · ${m.creditShare}%`;
}

/** Settings rows → the engine's refs (toggled-on rows only). */
export function coverageRefsOf(rows: ReadonlyArray<{ name: string; org62UserId?: string | null; email?: string | null; enabled?: boolean; kind?: CoverageKindName; window?: { from: string; to?: string }; creditShare?: 100 | 50 | 25; note?: string }>): CoveredAeRef[] {
  return rows
    .filter((a) => a.enabled !== false)
    .map((a) => ({ name: a.name, org62UserId: a.org62UserId ?? null, email: a.email ?? null, ...(a.kind ? { kind: a.kind } : {}), ...(a.window ? { window: a.window } : {}), ...(a.creditShare ? { creditShare: a.creditShare } : {}), ...(a.note ? { note: a.note } : {}) }));
}
