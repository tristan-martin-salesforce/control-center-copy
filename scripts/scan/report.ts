/**
 * Scanner report per scope: run counts, failures by code, coverage holes up to each cursor, spend (by budget, purpose,
 * model and skill, with tokens and unattributed calls), triage verdicts and how much of it the trace covers. Then the
 * ledger's Spend & decisions (D0) for the same days: by model, skill, trigger and why-that-model, with cache tokens,
 * hit rate, identical repeats and untokenized dollars, and every decision not to call (or to escalate) by reason. Runs booked
 * whole on one model before SPEND-1 are split by their pass trace rows (the line says how many and how much).
 *
 *   npm run scan:report -- [--since 24h | 90m | 7d | <ISO>] [--json]
 *
 * `--yield` (holistic review 04 §4.5) prints what each skill's dollars bought instead (and the spend governor's holds:
 * asked, approved, denied, median overrun): per skill and source, $, calls,
 * runs, $/run, % empty runs, cache hit %, % of model requests past the long-prompt tier (0027 measurement), $/item
 * found (proposed + linked) and $/item closed (work_item transitions to likely_done / done whose reason cites the
 * run, or whose evidence the run recorded), the escalation's changed verdicts, and the first scan's $/source/day. Then
 * one line per scan mode (fetch-then-interpret vs agentic: src/scanner/interpret/yield-mode.ts) with $ per item found.
 *
 *   npm run scan:report -- --yield [--since 7d] [--json]
 */
import { sql } from 'drizzle-orm';

import { decisionLabel, type SpendAuditPayload, type SpendSlice as AuditSlice } from '../../src/contract/spend-audit';
import { scanReport, type SpendSlice } from '../../src/scanner/trace/queries';
import { loadSpendAudit } from '../../src/server/datasource/db/store/spend-audit';
import { aggregateYield, firstScanPerSourceDay, renderYield, type FirstScanSpend, type YieldCall, type YieldRun } from '../../src/engines/spend-audit/yield';
import { DbSpendStore, holdsLine, spendHoldsPayload } from '../../src/server/datasource/db/spend';
import { resolutionYield } from '../../src/server/datasource/db/resolution';
import { resolutionYieldLine } from '../../src/engines/resolution/explain';
import { renderModeYield, yieldByMode } from '../../src/scanner/interpret/yield-mode';
import type { Db } from '../../src/db/client';

import { arg, has, main, open, sinceOf, usd } from './lib';

const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** One breakdown line: largest first, `name $x (n calls, in/out tokens)`. */
function slices(m: Record<string, SpendSlice>): string {
  const xs = Object.entries(m).sort((a, b) => b[1].usd - a[1].usd);
  if (!xs.length) return '-';
  return xs.map(([k, v]) => `${k} ${usd(v.usd)} (${v.calls} call${v.calls === 1 ? '' : 's'}${v.inputTokens || v.outputTokens ? `, ${tok(v.inputTokens)} in / ${tok(v.outputTokens)} out` : ''})`).join(' · ');
}

/** D0: one Spend & decisions breakdown line, largest first: `name $x (n calls, in/out, cache r/w, hit %)`. */
function auditLine(xs: AuditSlice[]): string {
  if (!xs.length) return '-';
  return xs.map((v) => `${v.key} ${usd(v.usd)} (${v.calls} call${v.calls === 1 ? '' : 's'}, ${tok(v.inputTokens)} in / ${tok(v.outputTokens)} out, cache ${tok(v.cacheReadTokens)} r / ${tok(v.cacheWriteTokens)} w${v.cacheHitPct == null ? '' : `, hit ${Math.round(v.cacheHitPct)}%`})`).join(' · ');
}

function printAudit(a: SpendAuditPayload) {
  const t = a.totals;
  console.log(`  ledger ${a.from} → ${a.to} (${a.timezone}): ${usd(t.usd)} in ${t.calls} call(s) · cache hit ${t.cacheHitPct == null ? '-' : `${Math.round(t.cacheHitPct)}%`} · identical repeats ${t.repeatCalls} (${usd(t.repeatUsd)}) · without tokens ${t.untokenizedCalls} (${usd(t.untokenizedUsd)}) · before D0 fields ${t.unattributedCalls}`);
  console.log(`    by model    ${auditLine(a.byModel)}`);
  console.log(`    by skill    ${auditLine(a.bySkill)}`);
  console.log(`    by trigger  ${auditLine(a.byTrigger)}`);
  const why = new Map<string, number>();
  for (const r of a.rows) why.set(`${r.skill}:${r.modelReason ?? 'unrecorded'}`, (why.get(`${r.skill}:${r.modelReason ?? 'unrecorded'}`) ?? 0) + r.usd);
  console.log(`    why model   ${[...why].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => `${k} ${usd(v)}`).join(' · ') || '-'}`);
  const dt = a.decisionTotals;
  console.log(`  decisions: ${dt.skips} skipped, ${dt.blocks} held by a budget, ${dt.escalations} escalated · about ${usd(dt.estSavedUsd)} not spent`);
  const g = new Map<string, { n: number; saved: number; usd: number }>();
  for (const d of a.decisions) {
    const k = `${d.skill} · ${d.kind} · ${d.reason}`;
    const x = g.get(k) ?? { n: 0, saved: 0, usd: 0 };
    x.n += d.count;
    x.saved += d.estSavedUsd;
    x.usd += d.usd;
    g.set(k, x);
  }
  for (const [k, x] of [...g].sort((p, q) => q[1].n - p[1].n)) console.log(`    ${k} ×${x.n}${x.saved ? ` (≈${usd(x.saved)} saved)` : ''}${x.usd ? ` (${usd(x.usd)} extra)` : ''}  ${decisionLabel(k.split(' · ')[2]!)}`);
  const se = a.settleEscalation;
  if (se.escalated) console.log(`  settle escalation: changed ${se.changed} of ${se.escalated} verdicts (${se.changedPct ?? 0}%), same ${se.same}, no usable answer ${se.invalid}, ${usd(se.extraUsd)} extra`);
}

const UUID_IN_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const num = (v: unknown) => (v == null ? 0 : Number(v));
const opt = (v: unknown) => (v == null ? null : Number(v));

/** The rows `--yield` needs, read-only: the period's calls, their scan runs (with found and closed items), first-scan spend. */
async function loadYield(db: Db, userId: string, since: Date) {
  const calls = await db.execute<Record<string, unknown>>(sql`
    select coalesce(l.skill_key, l.purpose::text) as skill, k.kind::text as connector, l.cost_usd, l.input_tokens, l.output_tokens,
           l.cache_read_tokens, l.cache_write_tokens, l.outcome, l.scan_run_id, l.turns, l.long_tier_requests, l.items_out, l.items_in,
           l.escalation_changed_items
      from llm_calls l
      left join scan_runs r on r.id = l.scan_run_id
      left join connectors k on k.id = r.connector_id
     where l.owner_user_id = ${userId} and l.started_at >= ${since.toISOString()}::timestamptz`);
  // Closures attributed to a run: the transition's reason cites the run id, or its evidence is a source item the run
  // recorded last. One closure per (run, work item); undone transitions do not count.
  const runs = await db.execute<Record<string, unknown>>(sql`
    with my as (
      select distinct l.scan_run_id as id from llm_calls l
       where l.owner_user_id = ${userId} and l.started_at >= ${since.toISOString()}::timestamptz and l.scan_run_id is not null
    ), closes as (
      select t.work_item_id, substring(t.reason from ${UUID_IN_TEXT})::uuid as by_reason, s.last_scan_run_id as by_evidence
        from work_item_transitions t
        join work_items w on w.id = t.work_item_id and w.owner_user_id = ${userId}
        left join work_item_evidence e on e.id = t.evidence_id
        left join source_items s on s.id = e.source_item_id
       where t.to_status in ('likely_done', 'done') and t.undone_at is null and t.occurred_at >= ${since.toISOString()}::timestamptz
    ), attributed as (
      select by_reason as run_id, work_item_id from closes where by_reason is not null
      union
      select by_evidence as run_id, work_item_id from closes where by_evidence is not null
    )
    select r.id, r.items_new + r.items_updated as changed, r.candidates_created + r.links_created as found,
           (select count(distinct a.work_item_id) from attributed a where a.run_id = r.id) as closed
      from scan_runs r join my on my.id = r.id`);
  const first = await db.execute<Record<string, unknown>>(sql`
    select k.kind::text as connector, sum(l.cost_usd) as usd, min(r.window_start) as w_from, max(r.window_end) as w_to
      from llm_calls l
      left join scan_runs r on r.id = l.scan_run_id
      left join connectors k on k.id = r.connector_id
     where l.owner_user_id = ${userId} and l.budget = 'first_scan'
     group by k.kind`);
  const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
  return {
    calls: calls.rows.map(
      (c): YieldCall => ({
        skill: String(c.skill),
        connector: c.connector == null ? null : String(c.connector),
        usd: num(c.cost_usd),
        inputTokens: num(c.input_tokens),
        outputTokens: num(c.output_tokens),
        cacheReadTokens: num(c.cache_read_tokens),
        cacheWriteTokens: num(c.cache_write_tokens),
        outcome: c.outcome == null ? null : String(c.outcome),
        runId: c.scan_run_id == null ? null : String(c.scan_run_id),
        turns: opt(c.turns),
        longTierRequests: opt(c.long_tier_requests),
        itemsOut: opt(c.items_out),
        itemsIn: opt(c.items_in),
        escalationChangedItems: opt(c.escalation_changed_items),
      }),
    ),
    runs: runs.rows.map((r): YieldRun => ({ id: String(r.id), changed: num(r.changed), found: num(r.found), closed: num(r.closed) })),
    first: first.rows.map((f): FirstScanSpend => ({ connector: f.connector == null ? null : String(f.connector), usd: num(f.usd), from: iso(f.w_from), to: iso(f.w_to) })),
  };
}

void main(async (argv) => {
  const since = sinceOf(arg(argv, '--since') ?? (has(argv, '--yield') ? '7d' : undefined));
  const { handle, db, userId, dbName } = await open();
  try {
    if (has(argv, '--yield')) {
      const y = await loadYield(db, userId, since);
      const rows = aggregateYield(y.calls, y.runs);
      const first = firstScanPerSourceDay(y.first);
      // Spend governor (H-5): what the holds of the period did (asked, approved, denied, median overrun past the hold)
      const holds = spendHoldsPayload(await new DbSpendStore({ db, userId }).listHolds({ since: since.toISOString(), limit: 100_000 }).catch(() => []), []).summary;
      // H-7: what the resolution check's dollars bought (closure_checks)
      const rc = await resolutionYield(db, userId, since.toISOString());
      if (has(argv, '--json')) {
        console.log(JSON.stringify({ since: since.toISOString(), until: new Date().toISOString(), rows, firstScan: first, holds, resolutionChecks: rc, byMode: yieldByMode(y.calls, y.runs) }, null, 2));
        return 0;
      }
      for (const l of renderYield(rows, first, { since: since.toISOString(), until: new Date().toISOString(), dbName })) console.log(l);
      console.log(holdsLine(holds));
      console.log(resolutionYieldLine(rc));
      console.log(renderModeYield(yieldByMode(y.calls, y.runs)));
      return 0;
    }
    const r = await scanReport(db, userId, since);
    // D0: the ledger's Spend & decisions for the same days (whole local days from --since to today).
    const tz = (await db.execute<{ tz: string | null }>(sql`select timezone as tz from users where id = ${userId}`)).rows[0]?.tz ?? 'UTC';
    const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const audit = await loadSpendAudit(db, userId, { from: day(new Date(r.since)), to: day(new Date()) }, { now: new Date(), timezone: tz });
    if (has(argv, '--json')) {
      console.log(JSON.stringify({ ...r, audit }, null, 2));
      return 0;
    }
    console.log(`scan report · ${dbName} · ${r.since} → ${r.until}`);
    console.log(`  ${'scope'.padEnd(34)} ${'runs'.padStart(4)} ${'ok'.padStart(4)} ${'fail'.padStart(4)} ${'canc'.padStart(4)} ${'cost'.padStart(9)}  holes · failures`);
    for (const s of r.scopes) {
      const holeMin = s.holes.reduce((a, h) => a + h.minutes, 0);
      const holes = s.holes.length ? `${s.holes.length} hole(s) ${holeMin} min` : 'no holes';
      const fails = Object.entries(s.failures).map(([k, n]) => `${k}×${n}`).join(' ');
      console.log(`  ${s.scope.padEnd(34).slice(0, 34)} ${String(s.runs).padStart(4)} ${String(s.ok).padStart(4)} ${String(s.failed).padStart(4)} ${String(s.cancelled).padStart(4)} ${usd(s.costUsd).padStart(9)}  ${holes}${fails ? ` · ${fails}` : ''}${s.cursorAt ? ` · cursor ${s.cursorAt.slice(0, 16)}` : ''}`);
      for (const h of s.holes.slice(0, 3)) console.log(`      hole ${h.from} → ${h.to} (${h.minutes} min)`);
    }
    const sp = r.spend;
    console.log(`  spend ${usd(sp.totalUsd)} in ${sp.calls} call(s) · by budget ${Object.entries(sp.byBudget).map(([k, v]) => `${k} ${usd(v)}`).join(', ') || '-'} · by purpose ${Object.entries(sp.byPurpose).map(([k, v]) => `${k} ${usd(v)}`).join(', ') || '-'} · unattributed ${sp.unattributed}`);
    console.log(`  by model  ${slices(sp.byModel)}`);
    console.log(`  by skill  ${slices(sp.bySkill)}`);
    if (sp.fromTrace.runs) console.log(`  (${sp.fromTrace.runs} run(s) booked whole on one model before SPEND-1, ${usd(sp.fromTrace.usd)}, split by their pass trace rows)`);
    const t = r.triage;
    console.log(`  triage ${t.messages} verdict(s): act ${t.act} · noise ${t.noise} · unsure ${t.unsure} · missing ${t.missing} · escalated ${t.escalated}`);
    console.log(`  trace ${r.trace.events} event(s) over ${r.trace.runs} run(s)`);
    printAudit(audit);
    return 0;
  } finally {
    await handle.close();
  }
});
