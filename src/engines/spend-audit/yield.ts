/**
 * Yield (holistic review 2026-11-20, lane 04 §4.5): what each skill's dollars bought. Per skill (and the connector its
 * scan runs read): dollars, calls, runs, $/run, % empty runs, cache hit %, % of model requests in the long-prompt tier,
 * $/item found (proposed + linked) and $/item closed, plus the stronger model's changed-verdict rate (D4) where it
 * escalated, and the first scan's $/source/day. Pure: `scan:report --yield` reads the rows (scripts/scan/report.ts)
 * and this turns them into the table, so a test pins every ratio.
 *
 * The design target is $/useful item, not $/poll (04 §4.2): a skill whose runs are mostly empty, or whose requests
 * sit in the 5× tier, shows it here before and after a change.
 */

/** One llm_calls row in the period (ids, counts and codes only). */
export interface YieldCall {
  skill: string;
  /** The connector of the call's scan run (null: not a scan call). */
  connector: string | null;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outcome: string | null;
  runId: string | null;
  /** 0027 measurement (null on older rows and on calls that do not measure). */
  turns: number | null;
  longTierRequests: number | null;
  itemsOut: number | null;
  itemsIn: number | null;
  escalationChangedItems: number | null;
}

/** One scan run the calls belong to. */
export interface YieldRun {
  id: string;
  /** New or changed source items the run recorded. */
  changed: number;
  /** Work items it proposed plus links it made. */
  found: number;
  /** Closures attributed to it (work_item transitions to likely_done / done whose reason cites the run, or whose evidence it recorded). */
  closed: number;
}

export interface YieldRow {
  skill: string;
  connector: string | null;
  usd: number;
  calls: number;
  runs: number;
  usdPerRun: number | null;
  emptyRuns: number;
  emptyPct: number | null;
  cacheHitPct: number | null;
  /** Calls that carry the 0027 measurement, their model requests, and those past the long-prompt tier. */
  measuredCalls: number;
  turns: number;
  longTierRequests: number;
  longTierPct: number | null;
  found: number;
  usdPerFound: number | null;
  closed: number;
  usdPerClosed: number | null;
  /** Escalation calls only (D4): items escalated and how many verdicts the stronger model changed. */
  escalation: { items: number; changed: number; changedPct: number | null } | null;
}

/** A call outcome that means "nothing came of it" (runOutcome, the pre-check, read-ins). */
const EMPTY_OUTCOMES = new Set(['nothing_new', 'empty', 'unchanged']);

const pct = (num: number, den: number) => (den > 0 ? (100 * num) / den : null);
const per = (usd: number, n: number) => (n > 0 ? usd / n : null);

/**
 * Group the calls by (skill, connector). A scan run counts once per skill it booked on: its found and closed items
 * count for every skill that ran in it (the triage pass shares its traversal's yield). A call outside a scan run is its
 * own run; it found what it measured (`items_out`).
 */
export function aggregateYield(calls: YieldCall[], runs: YieldRun[]): YieldRow[] {
  const byRun = new Map(runs.map((r) => [r.id, r]));
  const groups = new Map<string, { row: YieldRow; runIds: Set<string>; cacheIn: number; cacheRead: number; escItems: number; escChanged: number; escCalls: number }>();
  for (const c of calls) {
    const key = `${c.skill}\u0000${c.connector ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        row: { skill: c.skill, connector: c.connector, usd: 0, calls: 0, runs: 0, usdPerRun: null, emptyRuns: 0, emptyPct: null, cacheHitPct: null, measuredCalls: 0, turns: 0, longTierRequests: 0, longTierPct: null, found: 0, usdPerFound: null, closed: 0, usdPerClosed: null, escalation: null },
        runIds: new Set(),
        cacheIn: 0,
        cacheRead: 0,
        escItems: 0,
        escChanged: 0,
        escCalls: 0,
      };
      groups.set(key, g);
    }
    const r = g.row;
    r.usd += c.usd;
    r.calls += 1;
    g.cacheIn += c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens;
    g.cacheRead += c.cacheReadTokens;
    if (c.turns != null) {
      r.measuredCalls += 1;
      r.turns += c.turns;
      r.longTierRequests += c.longTierRequests ?? 0;
    }
    if (c.escalationChangedItems != null) {
      g.escCalls += 1;
      g.escItems += c.itemsIn ?? 0;
      g.escChanged += c.escalationChangedItems;
    }
    const run = c.runId ? byRun.get(c.runId) : undefined;
    if (c.runId && run) {
      if (g.runIds.has(c.runId)) continue;
      g.runIds.add(c.runId);
      r.runs += 1;
      r.found += run.found;
      r.closed += run.closed;
      if (run.changed + run.found + run.closed === 0) r.emptyRuns += 1;
    } else {
      r.runs += 1;
      r.found += c.itemsOut ?? 0;
      if (c.outcome && EMPTY_OUTCOMES.has(c.outcome)) r.emptyRuns += 1;
    }
  }
  const out = [...groups.values()].map((g) => {
    const r = g.row;
    r.usdPerRun = per(r.usd, r.runs);
    r.emptyPct = pct(r.emptyRuns, r.runs);
    r.cacheHitPct = pct(g.cacheRead, g.cacheIn);
    r.longTierPct = r.measuredCalls ? pct(r.longTierRequests, r.turns) : null;
    r.usdPerFound = per(r.usd, r.found);
    r.usdPerClosed = per(r.usd, r.closed);
    r.escalation = g.escCalls ? { items: g.escItems, changed: g.escChanged, changedPct: pct(g.escChanged, g.escItems) } : null;
    return r;
  });
  return out.sort((a, b) => b.usd - a.usd || a.skill.localeCompare(b.skill));
}

/** One connector's first-scan spend and the history its first-scan runs covered. */
export interface FirstScanSpend {
  connector: string | null;
  usd: number;
  /** Earliest window start and latest window end of its first-scan runs (ISO), null when no run had a window. */
  from: string | null;
  to: string | null;
}

export interface FirstScanYield {
  connector: string | null;
  usd: number;
  days: number | null;
  usdPerDay: number | null;
}

/** First scan: $ per source per day of history read. */
export function firstScanPerSourceDay(rows: FirstScanSpend[]): FirstScanYield[] {
  return rows
    .map((r) => {
      const span = r.from && r.to ? (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 : NaN;
      const days = Number.isFinite(span) && span > 0 ? Math.max(1, Math.round(span * 10) / 10) : null;
      return { connector: r.connector, usd: r.usd, days, usdPerDay: days ? r.usd / days : null };
    })
    .sort((a, b) => b.usd - a.usd);
}

const money = (n: number | null) => (n == null ? '-' : `$${n.toFixed(n < 0.1 ? 4 : 2)}`);
const pc = (n: number | null) => (n == null ? '-' : `${Math.round(n)}%`);

/** The `scan:report --yield` table, one line per (skill, connector), widest first. */
export function renderYield(rows: YieldRow[], first: FirstScanYield[], meta: { since: string; until: string; dbName: string }): string[] {
  const out: string[] = [];
  out.push(`yield · ${meta.dbName} · ${meta.since} → ${meta.until}`);
  const head = ['skill', 'source', '$', 'calls', 'runs', '$/run', 'empty', 'cache', 'long', 'found', '$/found', 'closed', '$/closed', 'esc chg'];
  const body = rows.map((r) => [
    r.skill,
    r.connector ?? '-',
    money(r.usd),
    String(r.calls),
    String(r.runs),
    money(r.usdPerRun),
    pc(r.emptyPct),
    pc(r.cacheHitPct),
    r.measuredCalls ? `${pc(r.longTierPct)} (${r.longTierRequests}/${r.turns})` : 'n/m',
    String(r.found),
    money(r.usdPerFound),
    String(r.closed),
    money(r.usdPerClosed),
    r.escalation ? `${r.escalation.changed}/${r.escalation.items}` : '-',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => `  ${cells.map((c, i) => (i < 2 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')}`;
  out.push(line(head));
  for (const b of body) out.push(line(b));
  if (!rows.length) out.push('  (no model calls in this period)');
  const total = rows.reduce((a, r) => ({ usd: a.usd + r.usd, calls: a.calls + r.calls, measured: a.measured + r.measuredCalls }), { usd: 0, calls: 0, measured: 0 });
  out.push(`  total ${money(total.usd)} in ${total.calls} call(s) · measured (0027) ${total.measured} of ${total.calls} · long = requests past the long-prompt tier / requests, n/m = not measured`);
  out.push('  first scan $/source/day:');
  if (!first.length) out.push('    (no first-scan spend)');
  for (const f of first) out.push(`    ${(f.connector ?? '(no source)').padEnd(16)} ${money(f.usd).padStart(9)} over ${f.days == null ? '-' : `${f.days} d`} = ${money(f.usdPerDay)}/day`);
  return out;
}
