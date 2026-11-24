/**
 * D-103 (b): the Specialist Forecasts a covered AE has on candidate opps (stamped on the opp's ext by discovery) and each
 * DC suggestion's context: the other Data & AI DCs, the team's specialists, the forecast owners. Split from
 * attribution.ts for the file-length rule; attribution.ts re-exports these.
 */
import { sql } from 'drizzle-orm';

import type { DcSuggestion } from '@/contract';
import type { DbOrTx } from '@/db/client';
import { dcContextOf, type OppSfrExt } from '@/engines/attribution/discover';
import { extKey } from './ext';
import type { ReadModel } from './model';
import type { WriteCtx } from './store/common';
import { mergeExt } from './store/projections';

/** The opp ext key the discovery's Specialist Forecast read writes (OppSfrExt) and `seenVia: 'sfr'`. */
export const OPP_SFR_EXT = 'specialistForecasts';

/** Stamp the Specialist Forecasts a covered AE has on these opps (ext; replaces what the last read saw). */
export async function markSpecialistForecasts(w: WriteCtx, rows: ReadonlyArray<{ oppId: string; sfr: OppSfrExt }>): Promise<number> {
  let n = 0;
  for (const r of rows) if (await mergeExt(w, 'opportunities', r.oppId, { [OPP_SFR_EXT]: r.sfr, seenVia: 'sfr' })) n++;
  return n;
}

/** An opp's Specialist Forecast ext (from the read model's kv), or null. */
export function oppSfrOf(kv: ReadonlyMap<string, unknown>, oppId: string): OppSfrExt | null {
  const e = kv.get(extKey('opportunities', oppId)) as Record<string, unknown> | undefined;
  const s = e?.[OPP_SFR_EXT] as OppSfrExt | undefined;
  return s && Array.isArray(s.ownerIds) ? s : null;
}

/**
 * The candidate's matcher inputs (chunk 1 reads `specialistForecastOwnerIds`; `seenVia` says why) and, R3-3, the
 * forecasts' product lines merged into the opp's products: discovery stores a forecast-only opp with no products, and
 * the DC gate (`sellsDcProduct`) reads only products and the name.
 */
export function sfrCandidateFields(kv: ReadonlyMap<string, unknown>, oppId: string, products?: readonly string[]): { specialistForecastOwnerIds?: string[]; seenVia?: 'sfr'; products?: string[] } {
  const s = oppSfrOf(kv, oppId);
  if (!s?.ownerIds.length) return {};
  const merged = [...(products ?? [])];
  for (const p of s.productLines ?? []) if (p && !merged.some((x) => x.toLowerCase() === p.toLowerCase())) merged.push(p);
  return { specialistForecastOwnerIds: [...s.ownerIds], seenVia: 'sfr', products: merged };
}

/** Every suggestion's context, per opp: the other DCs (deal_contributions, not mine), the team's specialists, the SFR owners. */
export async function loadDcContexts(db: DbOrTx, m: Pick<ReadModel, 'ctx'>, oppIds: readonly string[], coveredAes: ReadonlyArray<{ name: string; org62UserId?: string | null }>): Promise<Map<string, DcSuggestion['context']>> {
  const out = new Map<string, DcSuggestion['context']>();
  if (!oppIds.length) return out;
  const userId = m.ctx.userId;
  const ids = sql.join(oppIds.map((x) => sql`${x}::uuid`), sql`, `);
  const dcs = await db.execute<{ opportunity_id: string; name: string | null; role: string | null; split: number | string | null; is_mine: boolean }>(sql`
    select d.opportunity_id, p.display_name as name, d.role, d.split_percent as split, d.is_mine
      from deal_contributions d left join people p on p.id = d.contributor_person_id
     where d.owner_user_id = ${userId} and d.deleted_upstream_at is null and d.opportunity_id in (${ids})`);
  const team = await db.execute<{ opportunity_id: string; name: string | null; role: string; is_me: boolean; org62_user_id: string }>(sql`
    select t.opportunity_id, p.display_name as name, t.team_role as role, t.is_me, t.org62_user_id
      from opportunity_team_members t join opportunities o on o.id = t.opportunity_id left join people p on p.id = t.person_id
     where o.owner_user_id = ${userId} and t.removed_at is null and t.opportunity_id in (${ids})`);
  const covered = new Map(coveredAes.filter((a) => a.org62UserId).map((a) => [a.org62UserId!.slice(0, 15), a.name] as const));
  for (const id of oppIds) {
    const t = team.rows.filter((r) => r.opportunity_id === id);
    out.set(
      id,
      dcContextOf({
        dcs: dcs.rows.filter((r) => r.opportunity_id === id).map((r) => ({ ownerName: r.name, role: r.role, split: r.split === null ? null : Number(r.split), isMine: r.is_mine })),
        team: t.map((r) => ({ name: r.name, role: r.role, isMe: r.is_me })),
        sfr: oppSfrOf(m.ctx.kv, id),
        coveredOnTeam: t.map((r) => covered.get(r.org62_user_id.slice(0, 15))).find((x): x is string => !!x) ?? null,
      }),
    );
  }
  return out;
}
