/**
 * composeNeeds: every provider's rows → the one queue (01 R1, D-86). Pure.
 *
 *  - A provider whose persona feature is inactive contributes nothing (no VDP: no VDP rows).
 *  - A provider that throws contributes zero rows, its kind is listed in `partial`, and `onError` gets one call (the
 *    server logs one `BUG.NEEDS_PROVIDER` line): the queue and the page still render.
 *  - A verb whose persona feature is inactive is dropped; a row left without its primary verb is dropped (an AE never
 *    sees a "Claim a DC" row).
 *  - Dedupe: rows about the same thing (`subject`, e.g. `item:<id>`) keep one row, the more urgent one, with the other's
 *    verbs after its own and its kind in `also`; a repeated id keeps its first row.
 *  - Order: urgency (high first), then since (oldest first), then id. No cap: every row that waits on you is listed.
 */
import { NeedKind, type NeedRow, type NeedsPayload, type NeedVerb } from '@/contract';
import { NEED_PROVIDERS } from './registry';
import type { NeedProvider, NeedsContext } from './types';

export interface ComposeOptions {
  /** A provider threw (its rows are left out). */
  onError?: (kind: NeedKind, err: unknown) => void;
}

const allowed = (v: NeedVerb, ctx: NeedsContext) => !v.feature || ctx.features.has(v.feature);

/** The row with only the verbs this persona may use; null when its primary verb is gone. */
function gate(row: NeedRow, ctx: NeedsContext): NeedRow | null {
  const verbs = row.verbs.filter((v) => allowed(v, ctx));
  if (!verbs.some((v) => v.primary)) return null;
  return verbs.length === row.verbs.length ? row : { ...row, verbs };
}

function merge(keep: NeedRow, other: NeedRow): NeedRow {
  const ids = new Set(keep.verbs.map((v) => v.id));
  const extra = other.verbs.filter((v) => !ids.has(v.id)).map((v) => ({ ...v, primary: false }));
  const also = [...new Set([...keep.also, other.kind, ...other.also])].filter((k) => k !== keep.kind);
  const since = Date.parse(other.since) < Date.parse(keep.since) ? other.since : keep.since;
  return { ...keep, verbs: [...keep.verbs, ...extra], also, since, urgency: Math.max(keep.urgency, other.urgency), source: keep.source ?? other.source, who: keep.who ?? other.who, account: keep.account ?? other.account, opp: keep.opp ?? other.opp };
}

export function orderNeeds(a: NeedRow, b: NeedRow): number {
  return b.urgency - a.urgency || Date.parse(a.since) - Date.parse(b.since) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Merge rows that share an id or a subject (the more urgent one stays), in place of order. */
export function dedupeNeeds(rows: readonly NeedRow[]): NeedRow[] {
  const byId = new Map<string, number>();
  const bySubject = new Map<string, number>();
  const out: NeedRow[] = [];
  for (const r of [...rows].sort(orderNeeds)) {
    if (byId.has(r.id)) continue;
    const at = r.subject ? bySubject.get(r.subject) : undefined;
    if (at !== undefined) {
      out[at] = merge(out[at]!, r);
      byId.set(r.id, at);
      continue;
    }
    byId.set(r.id, out.length);
    if (r.subject) bySubject.set(r.subject, out.length);
    out.push(r);
  }
  return out.sort(orderNeeds);
}

export function emptyByKind(): Record<NeedKind, number> {
  return Object.fromEntries(NeedKind.options.map((k) => [k, 0])) as Record<NeedKind, number>;
}

export function composeNeeds(ctx: NeedsContext, providers: readonly NeedProvider[] = NEED_PROVIDERS, opts: ComposeOptions = {}): NeedsPayload {
  const partial: NeedKind[] = [];
  const all: NeedRow[] = [];
  for (const p of providers) {
    if (p.feature && !ctx.features.has(p.feature)) continue;
    let rows: NeedRow[];
    try {
      rows = p.run(ctx);
    } catch (err) {
      partial.push(p.kind);
      opts.onError?.(p.kind, err);
      continue;
    }
    for (const r of rows) {
      const g = gate(r, ctx);
      if (g) all.push(g);
    }
  }
  const rows = dedupeNeeds(all);
  const byKind = emptyByKind();
  for (const r of rows) byKind[r.kind] += 1;
  return { rows, total: rows.length, byKind, generatedAt: new Date(ctx.nowMs).toISOString(), partial };
}
