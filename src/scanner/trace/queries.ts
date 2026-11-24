/**
 * Read side of the scan audit trail (AUDIT): the ordered trace of a run, "why is / why isn't this here?" for one source
 * item, a per-scope report, and the provenance chain of a work item. Shared by `scripts/scan/*` and the web (Details).
 *
 * Inputs: scan_run_events (the decision trail), scan_runs, scan_ledger_entries (coverage), source_items, evidence,
 * reconcile_findings (unlinked) and llm_calls (spend). Outputs carry ids, codes, counts, links and short reasons only.
 */
import { sql } from 'drizzle-orm';

import type { DbOrTx } from '../../db/client';
import { sourceItemUrl } from '../../projections/links';
import { DEFAULT_TRIAGE } from '../triage/slack-triage';

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunSummary {
  id: string;
  connector: string;
  scope: string | null;
  trigger: string;
  mode: string;
  status: string;
  windowStart: string | null;
  windowEnd: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  skillVersion: string | null;
  model: string | null;
  jobId: number | null;
  costUsd: number;
  itemsSeen: number;
  itemsNew: number;
  links: number;
  proposals: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface TraceRow {
  seq: number;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
  sourceItemId: string | null;
  workItemId: string | null;
}

const RUN_COLS = sql.raw(`r.id, c.name as connector, r.scope, r.trigger::text as trigger, r.mode::text as mode, r.status::text as status,
  r.window_start, r.window_end, r.started_at, r.finished_at, r.skill_version, r.model_tier::text as model, r.job_id, r.cost_usd,
  r.items_seen, r.items_new, r.links_created, r.candidates_created, r.error_code, r.error_message`);

type RunRow = {
  id: string; connector: string; scope: string | null; trigger: string; mode: string; status: string; window_start: unknown; window_end: unknown;
  started_at: unknown; finished_at: unknown; skill_version: string | null; model: string | null; job_id: string | number | null; cost_usd: string | number;
  items_seen: number; items_new: number; links_created: number; candidates_created: number; error_code: string | null; error_message: string | null;
};

function runOf(r: RunRow): RunSummary {
  return {
    id: r.id,
    connector: r.connector,
    scope: r.scope,
    trigger: r.trigger,
    mode: r.mode,
    status: r.status,
    windowStart: iso(r.window_start),
    windowEnd: iso(r.window_end),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    skillVersion: r.skill_version,
    model: r.model === 'none' ? null : r.model,
    jobId: r.job_id == null ? null : Number(r.job_id),
    costUsd: Number(r.cost_usd) || 0,
    itemsSeen: r.items_seen,
    itemsNew: r.items_new,
    links: r.links_created,
    proposals: r.candidates_created,
    errorCode: r.error_code,
    errorMessage: r.error_message,
  };
}

export async function loadRun(db: DbOrTx, runId: string, userId?: string): Promise<RunSummary | null> {
  if (!UUID.test(runId)) return null;
  const r = await db.execute<RunRow>(sql`
    select ${RUN_COLS} from scan_runs r join connectors c on c.id = r.connector_id
     where r.id = ${runId} ${userId ? sql`and r.owner_user_id = ${userId}` : sql``}`);
  return r.rows[0] ? runOf(r.rows[0]) : null;
}

/** A run's ordered trace. */
export async function loadRunTrace(db: DbOrTx, runId: string, userId?: string): Promise<{ run: RunSummary | null; events: TraceRow[]; spend: { calls: number; costUsd: number; budgets: string[] } }> {
  const run = await loadRun(db, runId, userId);
  if (!run) return { run: null, events: [], spend: { calls: 0, costUsd: 0, budgets: [] } };
  const ev = await db.execute<{ seq: number; ts: unknown; kind: string; payload: Record<string, unknown>; source_item_id: string | null; work_item_id: string | null }>(sql`
    select seq, ts, kind, payload, source_item_id, work_item_id from scan_run_events where run_id = ${runId} order by seq`);
  const sp = await db.execute<{ n: number; usd: string | number | null; budgets: string[] | null }>(sql`
    select count(*)::int as n, sum(cost_usd) as usd, array_agg(distinct budget) as budgets from llm_calls where scan_run_id = ${runId}`);
  return {
    run,
    events: ev.rows.map((e) => ({ seq: e.seq, ts: iso(e.ts)!, kind: e.kind, payload: e.payload, sourceItemId: e.source_item_id, workItemId: e.work_item_id })),
    spend: { calls: sp.rows[0]?.n ?? 0, costUsd: Number(sp.rows[0]?.usd ?? 0), budgets: (sp.rows[0]?.budgets ?? []).filter(Boolean) },
  };
}

// ---------------------------------------------------------------------------------------------
// "Why is / why isn't this here?" for one source item
// ---------------------------------------------------------------------------------------------

/** A Slack permalink (`…/archives/<C>/p<ts16>`) → `slack:<C>:<ts>`; a Lightning record URL → its record id. */
export function keyFromUrl(url: string): { dedupeKey?: string; externalLike?: string; channelId?: string; ts?: string } {
  const u = url.trim();
  const slack = /\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(u);
  if (slack) {
    const ts = `${slack[2]}.${slack[3]}`;
    const thread = /[?&]thread_ts=(\d+\.\d+)/.exec(u);
    return { dedupeKey: `slack:${slack[1]}:${ts}`, channelId: slack[1], ts, ...(thread ? { externalLike: `${slack[1]}:${thread[1]}` } : {}) };
  }
  const sf = /\/lightning\/r\/(?:[A-Za-z0-9_]+\/)?([A-Za-z0-9]{15,18})\/view/.exec(u);
  if (sf) return { externalLike: sf[1] };
  const gmail = /#(?:inbox|all|sent)\/([A-Za-z0-9]+)/.exec(u);
  if (gmail) return { externalLike: gmail[1] };
  const doc = /\/d\/([A-Za-z0-9_-]{15,})/.exec(u);
  if (doc) return { externalLike: doc[1] };
  const sess = /[?&]session=([^&]+)/.exec(u);
  if (sess) return { externalLike: decodeURIComponent(sess[1]!).replace(/^local_/, '') };
  return {};
}

export interface Explanation {
  query: { sourceItemId?: string; url?: string };
  found: boolean;
  item: null | {
    id: string;
    source: string;
    kind: string;
    externalId: string;
    occurredAt: string;
    url: string | null;
    fromMe: boolean;
    addressedToMe: boolean;
    firstSeenAt: string;
    lastSeenAt: string;
    revision: number;
  };
  /** Runs that recorded it (first, last, and every run whose trace lists it). */
  fetched: Array<{ runId: string; at: string | null; scope: string | null; status: string; isNew: boolean; via: 'first' | 'last' | 'trace' }>;
  /** Committed coverage that spans its time (the scope's runs that looked at that moment). */
  coverage: Array<{ runId: string; scope: string; kind: string; ref: string | null; from: string | null; to: string | null; outcome: string }>;
  triage: Array<{ runId: string; pass: string; decision: string; why: string | null; at: string }>;
  outcomes: Array<{ runId: string | null; kind: 'proposal' | 'link' | 'unlinked'; workItemId: string | null; role?: string; confidence?: string | number | null; reason: string | null; at: string }>;
  evidence: Array<{ workItemId: string; role: string; confidence: number; createdAt: string; rationale: string | null; itemStatus: string | null }>;
  /** One plain sentence: what happened to it, or where to look next. */
  verdict: string;
}

/**
 * Was it fetched, recorded, triaged (verdict and why), linked to an item? By source item id or by its permalink. For a
 * permalink that was never recorded, the coverage of that moment says whether a run looked at it.
 */
export async function explainSourceItem(db: DbOrTx, userId: string, q: { sourceItemId?: string; url?: string }): Promise<Explanation> {
  const out: Explanation = { query: q, found: false, item: null, fetched: [], coverage: [], triage: [], outcomes: [], evidence: [], verdict: '' };
  type SiRow = { id: string; source: string; kind: string; external_id: string; occurred_at: unknown; url: string | null; meta: Record<string, unknown>; from_me: boolean; addressed_to_me: boolean; first_seen_at: unknown; last_seen_at: unknown; revision: number; first_scan_run_id: string | null; last_scan_run_id: string | null; external_container_id: string | null };
  const cols = sql.raw(`id, source::text as source, kind::text as kind, external_id, occurred_at, url, meta, from_me, addressed_to_me, first_seen_at, last_seen_at, revision, first_scan_run_id, last_scan_run_id, external_container_id`);
  let si: SiRow | undefined;
  const key = q.url ? keyFromUrl(q.url) : {};
  if (q.sourceItemId && UUID.test(q.sourceItemId)) {
    si = (await db.execute<SiRow>(sql`select ${cols} from source_items where owner_user_id = ${userId} and id = ${q.sourceItemId}`)).rows[0];
  } else if (q.url) {
    si = (await db.execute<SiRow>(sql`
      select ${cols} from source_items where owner_user_id = ${userId}
         and (url = ${q.url} ${key.dedupeKey ? sql`or dedupe_key = ${key.dedupeKey}` : sql``}
              ${key.externalLike ? sql`or external_id = ${key.externalLike} or external_id like ${`%:${key.externalLike}@%`} or external_id like ${`%:${key.externalLike}`} or external_id like ${`${key.externalLike}@%`}` : sql``})
       order by (url = ${q.url}) desc, occurred_at desc limit 1`)).rows[0];
  }
  if (!si) {
    // Never recorded: did any run look at that moment? (Slack permalinks carry their ts.)
    if (key.ts) {
      const at = new Date(Number(key.ts) * 1000).toISOString();
      const cov = await db.execute<{ run_id: string; scope: string; kind: string; ref: string | null; f: unknown; t: unknown; outcome: string }>(sql`
        select l.scan_run_id as run_id, l.scope, l.object_kind::text as kind, l.object_external_id as ref, l.covered_from as f, l.covered_to as t, l.outcome::text as outcome
          from scan_ledger_entries l join scan_runs r on r.id = l.scan_run_id
         where r.owner_user_id = ${userId} and l.scope like 'slack:%' and l.covered @> ${at}::timestamptz
         order by l.covered_from desc limit 20`);
      out.coverage = cov.rows.map((c) => ({ runId: c.run_id, scope: c.scope, kind: c.kind, ref: c.ref, from: iso(c.f), to: iso(c.t), outcome: c.outcome }));
      const inChannel = out.coverage.some((c) => c.ref?.includes(key.channelId ?? '∅'));
      out.verdict = !out.coverage.length
        ? `Never recorded, and no Slack scan covered ${at} yet: the window is a coverage hole (a backfill or reconcile will plan it).`
        : `Never recorded, although ${out.coverage.length} run(s) covered ${at}${inChannel ? ' in its channel' : ''}: the searches did not return it (not to me, from me, or in a watched channel?). See npm run scan:trace -- ${out.coverage[0]!.runId}.`;
    } else out.verdict = 'Not recorded: no source item matches this id or link.';
    return out;
  }
  out.found = true;
  out.item = {
    id: si.id,
    source: si.source,
    kind: si.kind,
    externalId: si.external_id,
    occurredAt: iso(si.occurred_at)!,
    url: sourceItemUrl({ source: si.source, externalId: si.external_id, url: si.url, meta: si.meta }),
    fromMe: si.from_me,
    addressedToMe: si.addressed_to_me,
    firstSeenAt: iso(si.first_seen_at)!,
    lastSeenAt: iso(si.last_seen_at)!,
    revision: si.revision,
  };
  // fetched: first / last run, plus every run whose `recorded` event lists it
  const runs = await db.execute<{ id: string; scope: string | null; status: string; started_at: unknown; via: string; is_new: boolean }>(sql`
    with t as (
      select e.run_id, bool_or(coalesce(e.payload->'newIds', '[]'::jsonb) @> to_jsonb(${si.id}::text)) as is_new
        from scan_run_events e where e.kind = 'recorded' and e.payload->'ids' @> to_jsonb(${si.id}::text) group by e.run_id)
    select r.id, r.scope, r.status::text as status, r.started_at,
           case when r.id = ${si.first_scan_run_id ?? null}::uuid then 'first' when r.id = ${si.last_scan_run_id ?? null}::uuid then 'last' else 'trace' end as via,
           coalesce(t.is_new, r.id = ${si.first_scan_run_id ?? null}::uuid) as is_new
      from scan_runs r left join t on t.run_id = r.id
     where r.owner_user_id = ${userId} and (r.id in (select run_id from t) or r.id = ${si.first_scan_run_id ?? null}::uuid or r.id = ${si.last_scan_run_id ?? null}::uuid)
     order by r.started_at nulls last limit 50`);
  out.fetched = runs.rows.map((r) => ({ runId: r.id, at: iso(r.started_at), scope: r.scope, status: r.status, isNew: r.is_new, via: r.via as 'first' | 'last' | 'trace' }));
  // triage: selection decisions and verdicts that name it
  const tri = await db.execute<{ run_id: string; ts: unknown; kind: string; payload: Record<string, unknown> }>(sql`
    select run_id, ts, kind, payload from scan_run_events
     where (kind = 'verdict' and source_item_id = ${si.id})
        or (kind = 'triage_select' and (payload->'trivialIds' @> to_jsonb(${si.id}::text) or payload->'handledIds' @> to_jsonb(${si.id}::text)
                                        or payload->'skippedIds' @> to_jsonb(${si.id}::text) or payload->'droppedIds' @> to_jsonb(${si.id}::text)))
     order by ts, seq`);
  for (const t of tri.rows) {
    const p = t.payload;
    if (t.kind === 'verdict') out.triage.push({ runId: t.run_id, pass: String(p.pass ?? 'triage'), decision: String(p.v ?? '?'), why: (p.why as string | null) ?? null, at: iso(t.ts)! });
    else {
      const has = (k: string) => Array.isArray(p[k]) && (p[k] as string[]).includes(si!.id);
      const decision = has('trivialIds') ? 'skipped: trivial (an acknowledgement or emoji)' : has('handledIds') ? 'skipped: the traversal already proposed or linked it' : has('droppedIds') ? 'skipped: over the batch cap' : 'not triaged: not to me, from me, or in a DM or thread I am in';
      out.triage.push({ runId: t.run_id, pass: 'select', decision, why: null, at: iso(t.ts)! });
    }
  }
  // outcomes in the trace (proposals, links, unlinked flags), then the evidence and findings as stored
  const oc = await db.execute<{ run_id: string; ts: unknown; kind: string; payload: Record<string, unknown>; work_item_id: string | null }>(sql`
    select run_id, ts, kind, payload, work_item_id from scan_run_events
     where source_item_id = ${si.id} and kind in ('proposal', 'link', 'unlinked')
        or (kind = 'proposal' and payload->'evidence' @> ${JSON.stringify([{ sourceItemId: si.id }])}::jsonb)
     order by ts, seq`);
  out.outcomes = oc.rows.map((o) => ({ runId: o.run_id, kind: o.kind as 'proposal' | 'link' | 'unlinked', workItemId: o.work_item_id, role: (o.payload.role as string | undefined) ?? undefined, confidence: (o.payload.confidence as string | undefined) ?? null, reason: (o.payload.reason as string | null) ?? (o.kind === 'proposal' ? `${o.payload.kind ?? 'item'} landed ${o.payload.landedAs ?? '?'}` : null), at: iso(o.ts)! }));
  const ev = await db.execute<{ work_item_id: string; role: string; confidence: number; created_at: unknown; rationale: string | null; status: string | null }>(sql`
    select e.work_item_id, e.role::text as role, e.confidence, e.created_at, e.rationale, w.status::text as status
      from work_item_evidence e join work_items w on w.id = e.work_item_id
     where e.source_item_id = ${si.id} and w.owner_user_id = ${userId} order by e.created_at`);
  out.evidence = ev.rows.map((e) => ({ workItemId: e.work_item_id, role: e.role, confidence: Number(e.confidence), createdAt: iso(e.created_at)!, rationale: e.rationale ? e.rationale.slice(0, 160) : null, itemStatus: e.status }));
  const fl = await db.execute<{ scan_run_id: string | null; detail: string | null; status: string; created_at: unknown }>(sql`
    select scan_run_id, detail, status::text as status, created_at from reconcile_findings
     where owner_user_id = ${userId} and source_item_id = ${si.id} and kind = 'unlinked_item' order by created_at`);
  for (const f of fl.rows) {
    if (out.outcomes.some((o) => o.kind === 'unlinked' && o.runId === f.scan_run_id)) continue;
    let reason: string | null = null;
    try {
      reason = (JSON.parse(f.detail ?? '{}') as { reason?: string }).reason ?? null;
    } catch {
      reason = null;
    }
    out.outcomes.push({ runId: f.scan_run_id, kind: 'unlinked', workItemId: null, reason: reason ? `${reason.slice(0, 140)} (${f.status})` : f.status, at: iso(f.created_at)! });
  }
  // coverage of its moment in its own scope (deterministic sources: its file / mailbox / calendar objects)
  const cov = await db.execute<{ run_id: string; scope: string; kind: string; ref: string | null; f: unknown; t: unknown; outcome: string }>(sql`
    select l.scan_run_id as run_id, l.scope, l.object_kind::text as kind, l.object_external_id as ref, l.covered_from as f, l.covered_to as t, l.outcome::text as outcome
      from scan_ledger_entries l join scan_runs r on r.id = l.scan_run_id
     where r.owner_user_id = ${userId} and l.scope like ${`${si.source === 'claude' ? 'claude_sessions' : si.source}:%`}
       and (l.covered @> ${iso(si.occurred_at)}::timestamptz or l.object_external_id = ${si.external_id})
     order by l.covered_from desc nulls last limit 10`);
  out.coverage = cov.rows.map((c) => ({ runId: c.run_id, scope: c.scope, kind: c.kind, ref: c.ref, from: iso(c.f), to: iso(c.t), outcome: c.outcome }));
  out.verdict = verdictOf(out);
  return out;
}

function verdictOf(x: Explanation): string {
  const linked = x.evidence.filter((e) => e.role !== 'context');
  if (linked.length) {
    const e = linked[0]!;
    return `Recorded and linked: ${e.role} evidence of work item ${e.workItemId} (${e.itemStatus ?? '?'})${linked.length > 1 ? ` and ${linked.length - 1} more` : ''}.`;
  }
  const last = x.triage[x.triage.length - 1];
  if (last?.pass === 'escalate') return `Recorded and triaged; the escalation said ${last.decision}${last.why ? `: ${last.why}` : ''}.`;
  if (last && last.pass !== 'select') return `Recorded and triaged: ${last.decision}${last.why ? ` (${last.why})` : ''}${last.decision === 'unsure' ? '; no escalation verdict yet' : ''}.`;
  if (last) return `Recorded, ${last.decision}.`;
  const flag = x.outcomes.find((o) => o.kind === 'unlinked');
  if (flag) return `Recorded and flagged unlinked: ${flag.reason ?? 'no reason'} (reconcile retries it).`;
  if (x.evidence.length) return `Recorded and linked as context only (work item ${x.evidence[0]!.workItemId}).`;
  if (!x.fetched.some((f) => f.via === 'trace')) return 'Recorded before the scan trace existed: no decision trail for it (the first and last run ids are listed).';
  return 'Recorded, but no run proposed, linked or flagged it, and no triage pass gave it a verdict.';
}

// ---------------------------------------------------------------------------------------------
// Spend by pass (SPEND-1): a scan run's `pass` trace rows say which model spent what
// ---------------------------------------------------------------------------------------------

/** One `pass` trace row's spend: a traversal, triage or escalation query, each on its own model. */
export interface PassSpend {
  seq: number;
  pass: string;
  model: string | null;
  costUsd: number;
  /** Uncached input (D0); rows traced before D0 carried cache folded in. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** D0: ledgerHash of the pass's prompt and input (null on older trace rows). */
  contentHash: string | null;
  ok: boolean;
  errorClass: string | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : 0);

export function passSpendOf(seq: number, p: Record<string, unknown>): PassSpend {
  return {
    seq: Number(seq),
    pass: typeof p.pass === 'string' ? p.pass : 'traversal',
    model: typeof p.model === 'string' && p.model ? p.model : null,
    costUsd: Math.max(0, num(p.costUsd)),
    inputTokens: Math.max(0, Math.round(num(p.inputTokens))),
    outputTokens: Math.max(0, Math.round(num(p.outputTokens))),
    cacheReadTokens: Math.max(0, Math.round(num(p.cacheReadTokens))),
    cacheWriteTokens: Math.max(0, Math.round(num(p.cacheWriteTokens))),
    contentHash: typeof p.contentHash === 'string' && p.contentHash ? p.contentHash : null,
    ok: p.ok !== false,
    errorClass: typeof p.errorClass === 'string' ? p.errorClass : null,
  };
}

/** The triage skill (`triage-slack`): what a run's triage and escalation passes run. */
export const TRIAGE_SKILL_KEY = DEFAULT_TRIAGE.skillPath.replace(/^.*\//, '').replace(/\.md$/, '');

/**
 * The skill a pass ran: triage and escalation passes run the triage skill, the traversal its connector's own. A
 * fetch-then-interpret pass names its skill key after the first colon (`classify:classify-items`,
 * `fetch:relay:slack:slack_search_public_and_private`), so its row books on that skill (src/scanner/interpret/runner.ts).
 */
export function passSkill(pass: string, connectorSkill: string | null): string | null {
  if (pass === 'triage' || pass === 'escalate') return TRIAGE_SKILL_KEY;
  const named = pass.indexOf(':');
  return named > 0 ? pass.slice(named + 1) : connectorSkill;
}

/** How far a pass's cost may run past what is left of the total and still be that pass (six-decimal rounding, D0). */
export const SPLIT_TOLERANCE_USD = 1e-5;

/**
 * Split `totalUsd` (booked on one model) over a run's pass rows, in order, while they fit. What is left (the trace is
 * best effort: a dropped pass row) is `restUsd`, for the booked model. A rounding remainder (pass costs carry six
 * decimals) goes to the last pass, so the parts always add up to the total.
 *
 * D0: the fit allows SPLIT_TOLERANCE_USD. At 1e-6 a last pass one rounding step over what was left (a $0.126972
 * escalation against $0.126971 left) fell through to the rest path: a Sonnet call booked as Haiku with 0 tokens.
 */
export function splitByPasses(totalUsd: number, passes: PassSpend[]): { parts: PassSpend[]; restUsd: number } {
  const parts: PassSpend[] = [];
  let left = Math.max(0, totalUsd);
  for (const p of passes) {
    if (!(p.costUsd > 0)) continue;
    if (p.costUsd > left + SPLIT_TOLERANCE_USD) break;
    parts.push({ ...p });
    left -= p.costUsd;
  }
  if (parts.length && Math.abs(left) < SPLIT_TOLERANCE_USD) {
    parts[parts.length - 1]!.costUsd += left;
    left = 0;
  }
  return { parts, restUsd: left > 0 ? left : 0 };
}

// ---------------------------------------------------------------------------------------------
// Report: per scope, coverage holes, failures by code, spend and run counts
// ---------------------------------------------------------------------------------------------

export interface ScopeReport {
  scope: string;
  runs: number;
  ok: number;
  failed: number;
  cancelled: number;
  running: number;
  costUsd: number;
  failures: Record<string, number>;
  /** Uncovered windows in [since, cursor) (minutes), the scope's committed coverage merged. */
  holes: Array<{ from: string; to: string; minutes: number }>;
  cursorAt: string | null;
  lastOkAt: string | null;
}

/** Spend of one model or skill in the report window. */
export interface SpendSlice {
  usd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ScanReport {
  since: string;
  until: string;
  scopes: ScopeReport[];
  spend: {
    totalUsd: number;
    byBudget: Record<string, number>;
    byPurpose: Record<string, number>;
    /** SPEND-1: by the model that made the spend (a Sonnet escalation is Sonnet's), with its tokens. */
    byModel: Record<string, SpendSlice>;
    /** By skill (`scan-slack`, `triage-slack`, `settle-item`, …; `none` when a row names none). */
    bySkill: Record<string, SpendSlice>;
    /** Runs booked whole on one model before SPEND-1, split here by their `pass` trace rows (how many, how much). */
    fromTrace: { runs: number; usd: number };
    unattributed: number;
    calls: number;
  };
  triage: { messages: number; act: number; noise: number; unsure: number; missing: number; escalated: number };
  trace: { events: number; runs: number };
}

function failureKey(code: string | null, message: string | null): string {
  const m = (message ?? '').toLowerCase();
  const cause = m.includes('prefix tripwire') ? 'prefix_tripwire' : m.includes('cost cap') ? 'cost_cap' : m.includes('watchdog') || m.includes('timeout') ? 'timeout' : m.includes('max_turns') ? 'max_turns' : m.includes('without cc_finish') ? 'no_finish' : m.includes('coverage') ? 'coverage' : null;
  return cause ?? code ?? 'unknown';
}

export async function scanReport(db: DbOrTx, userId: string, since: Date, until: Date = new Date()): Promise<ScanReport> {
  const s = since.toISOString();
  const u = until.toISOString();
  const runs = await db.execute<{ scope: string | null; status: string; error_code: string | null; error_message: string | null; cost_usd: string | number; finished_at: unknown }>(sql`
    select coalesce(r.scope, c.name) as scope, r.status::text as status, r.error_code, r.error_message, r.cost_usd, r.finished_at
      from scan_runs r join connectors c on c.id = r.connector_id
     where r.owner_user_id = ${userId} and coalesce(r.started_at, r.created_at) >= ${s}::timestamptz and coalesce(r.started_at, r.created_at) < ${u}::timestamptz`);
  const by = new Map<string, ScopeReport>();
  const get = (scope: string) => {
    let r = by.get(scope);
    if (!r) by.set(scope, (r = { scope, runs: 0, ok: 0, failed: 0, cancelled: 0, running: 0, costUsd: 0, failures: {}, holes: [], cursorAt: null, lastOkAt: null }));
    return r;
  };
  for (const r of runs.rows) {
    const x = get(r.scope ?? 'unknown');
    x.runs += 1;
    x.costUsd += Number(r.cost_usd) || 0;
    if (r.status === 'succeeded') {
      x.ok += 1;
      const f = iso(r.finished_at);
      if (f && (!x.lastOkAt || f > x.lastOkAt)) x.lastOkAt = f;
    } else if (r.status === 'failed') {
      x.failed += 1;
      const k = failureKey(r.error_code, r.error_message);
      x.failures[k] = (x.failures[k] ?? 0) + 1;
    } else if (r.status === 'cancelled') x.cancelled += 1;
    else x.running += 1;
  }
  // coverage holes per scope with a cursor: [max(since, low watermark), min(cursor, until)) minus committed coverage
  const cur = await db.execute<{ scope: string; hi: unknown; lo: unknown }>(sql`
    select scope, high_watermark_at as hi, low_watermark_at as lo from scan_cursors where owner_user_id = ${userId}`);
  for (const c of cur.rows) {
    // Pass pseudo-scopes (completion checks, reconcile relinks) are zero-length runs, not a scanned span: no holes.
    if (/:(completion|reconcile)(:|$)/.test(c.scope)) continue;
    const x = get(c.scope);
    x.cursorAt = iso(c.hi);
    const hi = c.hi ? Math.min(Date.parse(iso(c.hi)!), until.getTime()) : NaN;
    const lo = Math.max(since.getTime(), c.lo ? Date.parse(iso(c.lo)!) : since.getTime());
    if (!Number.isFinite(hi) || hi <= lo) continue;
    const cov = await db.execute<{ l: unknown; u: unknown }>(sql`
      select lower(r) as l, upper(r) as u from (
        select unnest(range_agg(covered)) as r from scan_ledger_entries
         where scope = ${c.scope} and outcome = 'complete' and covered is not null
           and covered && tstzrange(${new Date(lo).toISOString()}::timestamptz, ${new Date(hi).toISOString()}::timestamptz)) x order by 1`);
    let at = lo;
    for (const r of cov.rows) {
      const a = Date.parse(iso(r.l)!);
      const b = Date.parse(iso(r.u)!);
      if (a > at + 60_000) x.holes.push({ from: new Date(at).toISOString(), to: new Date(Math.min(a, hi)).toISOString(), minutes: Math.round((Math.min(a, hi) - at) / 60_000) });
      at = Math.max(at, b);
      if (at >= hi) break;
    }
    if (hi > at + 60_000) x.holes.push({ from: new Date(at).toISOString(), to: new Date(hi).toISOString(), minutes: Math.round((hi - at) / 60_000) });
  }
  // A run booked whole on one model (before SPEND-1: one `spend:` row, no `pass:` rows) is split by its pass trace rows
  // for the model and skill breakdown; every other row counts as booked.
  const sp = await db.execute<{ budget: string; purpose: string; model: string; skill: string | null; run: string | null; usd: string | number; n: number; it: string | number | null; ot: string | number | null; unattributed: number }>(sql`
    with w as (
      select c.*, (c.purpose = 'scan_extract' and c.scan_run_id is not null and c.request_hash like 'spend:%'
                   and not exists (select 1 from llm_calls p where p.scan_run_id = c.scan_run_id and p.request_hash like 'pass:%')) as whole
        from llm_calls c where c.owner_user_id = ${userId} and c.started_at >= ${s}::timestamptz and c.started_at < ${u}::timestamptz)
    select budget, purpose::text as purpose, model, skill_key as skill, case when whole then scan_run_id::text end as run,
           sum(cost_usd) as usd, count(*)::int as n, sum(input_tokens) as it, sum(output_tokens) as ot,
           count(*) filter (where scan_run_id is null and job_id is null and chat_message_id is null)::int as unattributed
      from w group by 1, 2, 3, 4, 5`);
  const wholeRuns = [...new Set(sp.rows.map((r) => r.run).filter((r): r is string => !!r && UUID.test(r)))];
  const passesOf = new Map<string, PassSpend[]>();
  if (wholeRuns.length) {
    const pe = await db.execute<{ run: string; seq: number; payload: Record<string, unknown> }>(sql`
      select run_id::text as run, seq, payload from scan_run_events
       where kind = 'pass' and run_id = any(${sql`array[${sql.join(wholeRuns.map((r) => sql`${r}`), sql`, `)}]::uuid[]`}) order by run_id, seq`);
    for (const e of pe.rows) {
      const l = passesOf.get(e.run) ?? [];
      l.push(passSpendOf(e.seq, e.payload));
      passesOf.set(e.run, l);
    }
  }
  const spend: ScanReport['spend'] = { totalUsd: 0, byBudget: {}, byPurpose: {}, byModel: {}, bySkill: {}, fromTrace: { runs: 0, usd: 0 }, unattributed: 0, calls: 0 };
  const add = (into: Record<string, SpendSlice>, key: string, usd: number, calls: number, it: number, ot: number) => {
    const x = (into[key] ??= { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0 });
    x.usd += usd;
    x.calls += calls;
    x.inputTokens += it;
    x.outputTokens += ot;
  };
  for (const r of sp.rows) {
    const usd = Number(r.usd) || 0;
    spend.totalUsd += usd;
    spend.byBudget[r.budget] = (spend.byBudget[r.budget] ?? 0) + usd;
    spend.byPurpose[r.purpose] = (spend.byPurpose[r.purpose] ?? 0) + usd;
    spend.unattributed += r.unattributed;
    spend.calls += r.n;
    const it = Number(r.it) || 0;
    const ot = Number(r.ot) || 0;
    const split = r.run ? splitByPasses(usd, passesOf.get(r.run) ?? []) : { parts: [], restUsd: usd };
    for (const p of split.parts) {
      add(spend.byModel, p.model ?? r.model, p.costUsd, 1, p.inputTokens, p.outputTokens);
      add(spend.bySkill, passSkill(p.pass, r.skill) ?? 'none', p.costUsd, 1, p.inputTokens, p.outputTokens);
    }
    if (split.parts.length) {
      spend.fromTrace.runs += 1;
      spend.fromTrace.usd += usd - split.restUsd;
    }
    if (split.restUsd > 0 || !split.parts.length) {
      add(spend.byModel, r.model, split.restUsd, split.parts.length ? 0 : r.n, it, ot);
      add(spend.bySkill, r.skill ?? 'none', split.restUsd, split.parts.length ? 0 : r.n, it, ot);
    }
  }
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  for (const m of [spend.byModel, spend.bySkill]) for (const x of Object.values(m)) x.usd = round(x.usd);
  spend.fromTrace.usd = round(spend.fromTrace.usd);
  const tv = await db.execute<{ pass: string; v: string; n: number }>(sql`
    select e.payload->>'pass' as pass, e.payload->>'v' as v, count(*)::int as n
      from scan_run_events e join scan_runs r on r.id = e.run_id
     where r.owner_user_id = ${userId} and e.kind = 'verdict' and e.ts >= ${s}::timestamptz and e.ts < ${u}::timestamptz group by 1, 2`);
  const triage = { messages: 0, act: 0, noise: 0, unsure: 0, missing: 0, escalated: 0 };
  for (const r of tv.rows) {
    if (r.pass === 'escalate') {
      triage.escalated += r.n;
      continue;
    }
    triage.messages += r.n;
    if (r.v === 'act' || r.v === 'noise' || r.v === 'unsure' || r.v === 'missing') triage[r.v] += r.n;
  }
  const te = await db.execute<{ n: number; runs: number }>(sql`
    select count(*)::int as n, count(distinct e.run_id)::int as runs from scan_run_events e join scan_runs r on r.id = e.run_id
     where r.owner_user_id = ${userId} and e.ts >= ${s}::timestamptz and e.ts < ${u}::timestamptz`);
  return {
    since: s,
    until: u,
    scopes: [...by.values()].filter((x) => x.runs || x.holes.length).sort((a, b) => a.scope.localeCompare(b.scope)),
    spend: { ...spend, totalUsd: Math.round(spend.totalUsd * 1e4) / 1e4 },
    triage,
    trace: { events: te.rows[0]?.n ?? 0, runs: te.rows[0]?.runs ?? 0 },
  };
}

// ---------------------------------------------------------------------------------------------
// "Why is this here?": a work item's provenance chain (Details panel)
// ---------------------------------------------------------------------------------------------

export interface ChainStep {
  evidenceId: string;
  role: string;
  confidence: number;
  rationale: string | null;
  createdAt: string;
  sourceItemId: string | null;
  source: { kind: string; externalId: string | null; occurredAt: string | null; url: string | null; title: string | null } | null;
  /** The run that made this evidence (its trace), else the run that first recorded the source. */
  run: (RunSummary & { via: 'trace' | 'recorded' }) | null;
  verdict: { pass: string; v: string; why: string | null; escalated: boolean; final: { v: string; why: string | null } | null } | null;
  spend: { costUsd: number; calls: number; budget: string | null; model: string | null } | null;
}

export async function workItemChain(db: DbOrTx, userId: string, workItemId: string): Promise<{ steps: ChainStep[]; createdBy: { actor: string | null; at: string | null; reason: string | null } | null }> {
  if (!UUID.test(workItemId)) return { steps: [], createdBy: null };
  const ev = await db.execute<{ id: string; role: string; confidence: number; rationale: string | null; created_at: unknown; source_item_id: string | null; source: string | null; external_id: string | null; occurred_at: unknown; url: string | null; title: string | null; meta: Record<string, unknown> | null; first_scan_run_id: string | null; dedupe_key: string | null }>(sql`
    select e.id, e.role::text as role, e.confidence, e.rationale, e.created_at, e.source_item_id, si.source::text as source, si.external_id, si.occurred_at,
           si.url, si.title, si.meta, si.first_scan_run_id, si.dedupe_key
      from work_item_evidence e join work_items w on w.id = e.work_item_id left join source_items si on si.id = e.source_item_id
     where e.work_item_id = ${workItemId} and w.owner_user_id = ${userId}
     order by (e.role = 'origin') desc, e.created_at, e.id`);
  const steps: ChainStep[] = [];
  for (const e of ev.rows) {
    const app = e.dedupe_key?.startsWith('cc.evidence:');
    const step: ChainStep = {
      evidenceId: e.id,
      role: e.role,
      confidence: Number(e.confidence),
      rationale: e.rationale ? e.rationale.slice(0, 200) : null,
      createdAt: iso(e.created_at)!,
      sourceItemId: e.source_item_id,
      source: e.source_item_id && e.source ? { kind: e.source, externalId: e.external_id, occurredAt: iso(e.occurred_at), url: sourceItemUrl({ source: e.source, externalId: e.external_id ?? '', url: e.url, meta: e.meta ?? {} }), title: e.title } : null,
      run: null,
      verdict: null,
      spend: null,
    };
    if (e.source_item_id && !app) {
      // the run whose trace made this evidence (a proposal naming the source, or a link), else the run that recorded it
      const made = await db.execute<{ run_id: string }>(sql`
        select run_id from scan_run_events
         where work_item_id = ${workItemId} and ((kind = 'link' and source_item_id = ${e.source_item_id}) or (kind = 'proposal' and payload->'evidence' @> ${JSON.stringify([{ sourceItemId: e.source_item_id }])}::jsonb))
         order by ts limit 1`);
      const runId = made.rows[0]?.run_id ?? e.first_scan_run_id;
      if (runId) {
        const run = await loadRun(db, runId, userId);
        if (run) step.run = { ...run, via: made.rows[0] ? 'trace' : 'recorded' };
        const sp = await db.execute<{ usd: string | number | null; n: number; budget: string | null; model: string | null }>(sql`
          select sum(cost_usd) as usd, count(*)::int as n, max(budget) as budget, string_agg(distinct model, ' + ' order by model) as model from llm_calls where scan_run_id = ${runId}`);
        const r = sp.rows[0];
        if (r && r.n) step.spend = { costUsd: Number(r.usd ?? 0), calls: r.n, budget: r.budget, model: r.model };
      }
      const vs = await db.execute<{ payload: Record<string, unknown> }>(sql`
        select payload from scan_run_events where kind = 'verdict' and source_item_id = ${e.source_item_id} order by ts, seq`);
      const tri = vs.rows.map((x) => x.payload).filter((p) => p.pass !== 'escalate');
      const esc = vs.rows.map((x) => x.payload).filter((p) => p.pass === 'escalate');
      const first = tri[tri.length - 1];
      const fin = esc[esc.length - 1];
      if (first || fin) {
        const base = first ?? fin!;
        step.verdict = { pass: String(base.pass ?? 'triage'), v: String(base.v ?? '?'), why: (base.why as string | null) ?? null, escalated: !!fin || base.escalate === true, final: fin ? { v: String(fin.v ?? '?'), why: (fin.why as string | null) ?? null } : null };
      }
    }
    steps.push(step);
  }
  const cs = await db.execute<{ actor: string | null; at: unknown; reason: string | null }>(sql`
    select coalesce(c.actor_ref, c.actor_kind::text) as actor, c.created_at as at, c.summary as reason from change_sets c
     where c.entity_type = 'work_items' and c.entity_id = ${workItemId} order by c.created_at limit 1`);
  const c = cs.rows[0];
  return { steps, createdBy: c ? { actor: c.actor, at: iso(c.at), reason: c.reason ? c.reason.slice(0, 160) : null } : null };
}
