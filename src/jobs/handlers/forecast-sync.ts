/**
 * The Specialist Forecast jobs (queue `forecast`, concurrency 1; lane A, D-55 feature `specialistForecast`):
 *
 *   forecast.sync   one read of my SpecialistForecast__c records for this and next fiscal quarter plus their
 *                   ForecastNotes__c history (fixed SOQL, src/server/forecast/soql.ts), each query ONE `soqlQuery` call
 *                   through runOneReadLookup (the scanners' Org62 read allowlist, not widened), mirrored into
 *                   `specialist_forecasts` and linked to the app's opps and accounts. Not a scanner scope: the Org62
 *                   scanner spec is an LLM traversal; this is a fixed read with no model judgement. Daily at 07:15
 *                   (src/worker/schedules.ts), on "Sync now", and 30 minutes after an "I created it, check now".
 *                   With payload `scope: 'opp'` ("I created it, check now" on one opp with no record): ONE read of
 *                   my records on that opp (its Org62 id from the app's own opportunity, never from the payload),
 *                   upserted without marking anything gone.
 *   forecast.draft  one record's weekly note (src/server/forecast/draft.ts), $0.25 cap, recorded in llm_calls
 *                   (purpose draft_generate, skill forecast-notes). The fake model when not live.
 *
 * Both skip when the feature is not active for the user's persona (loadPersona), and do nothing live outside the
 * launchd worker (CC_LIVE / NODE_ENV=production) unless a test injects the lookup or the agent. jobs.result holds
 * counts and codes only, never names or note text.
 */
import { randomUUID } from 'node:crypto';

import type { McpServerConfig } from '@/llm/provider';
import { sql } from 'drizzle-orm';

import { budgetsForDay } from '@/contract';
import { insertLlmCall, ledgerHash, type CallAudit } from '@/db/ledger';
import type { GoogleTools } from '@/connectors/google/client';
import { localDay } from '@/engines/activity/time';
import { DRAFT_CAP_USD, forecastThresholds, id15, quarterPair } from '@/engines/forecast';
import { restrictedTools, traversalMcpServers } from '@/llm/mcp-config';
import type { ResearchAgent } from '@/llm/readin/agent';
import { featureActive, renderPersonaBlock, type ResolvedPersona } from '@/personas';
import { RESEARCH_SLACK_TOOLS } from '@/server/chat/research';
import { liveOrg62 } from '@/server/chat/record-type';
import { dbLedgerSearch } from '@/server/datasource/db/readin';
import { loadPersona } from '@/server/datasource/db/store/persona';
import { loadSettingsSections } from '@/server/datasource/db/store/settings';
import { PLACEHOLDER_MODEL, placeholderDraft, runForecastNoteDraft } from '@/server/forecast/draft';
import { ForecastParseError, OPP_ID, parseNotesHistory, parseSfrRecords, SFR_MAX_PAGES, SFR_PAGE, sfrNotesHistorySoql, sfrRecordsForOppSoql, sfrRecordsSoql, type Org62Sfr } from '@/server/forecast/soql';
import { FORECAST_CHECK_SCOPE, FORECAST_DRAFT_JOB, FORECAST_QUEUE, FORECAST_SYNC_JOB, loadForecastRecord, ownerOrg62Of, savePending, saveForecastMirror } from '@/server/forecast/store';
import { runOneReadLookup, type OneLookupResult } from '@/server/onboarding/identity';

import { JobError, type JobContext, type JobHandlerDef } from '../types';

export const FORECAST_LOOKUP_SKILL = 'skills/read-lookup.md';

export interface ForecastJobDeps {
  /** The one read-only Org62 call (tests inject a fake; it also turns live reads on). */
  lookup?: typeof runOneReadLookup;
  agent?: ResearchAgent;
  google?: () => GoogleTools | null;
  external?: () => { servers: Record<string, McpServerConfig>; tools: string[]; unavailable: string[] };
  /** Override the live gate (default: liveOrg62()). */
  live?: boolean;
  persona?: (ctx: JobContext) => Promise<ResolvedPersona>;
}

let deps: ForecastJobDeps = {};
/** Tests swap the lookup, the agent, the Google client or the persona. */
export function configureForecastJobs(d: ForecastJobDeps): void {
  deps = { ...deps, ...d };
}
export function resetForecastJobsConfig(): void {
  deps = {};
}

const personaFor = (ctx: JobContext, d: ForecastJobDeps) => (d.persona ? d.persona(ctx) : loadPersona(ctx.db, ctx.userId));

/** One read-only lookup's spend in llm_calls (also used by `vdp.specialist_aes`, D-63). */
export async function recordSpend(
  ctx: JobContext,
  day: string,
  r: { purpose: 'other' | 'draft_generate'; skillKey: string; promptVersion: string; model: string; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; ok: boolean; errorCode?: string; latencyMs: number; contentHash: string } & Omit<CallAudit, 'contentHash'>,
) {
  if (!r.model || r.model === PLACEHOLDER_MODEL) return;
  const finished = new Date();
  await insertLlmCall(ctx.db, {
    ownerUserId: ctx.userId,
    purpose: r.purpose,
    model: r.model,
    skillKey: r.skillKey,
    promptVersion: r.promptVersion,
    requestHash: `${r.skillKey}:${ctx.job.id}:${randomUUID()}`,
    jobId: ctx.job.id,
    status: r.ok ? 'ok' : r.errorCode === 'timeout' ? 'timeout' : 'error',
    errorCode: r.errorCode ?? null,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens ?? 0,
    cacheWriteTokens: r.cacheWriteTokens ?? 0,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
    budgetDay: day,
    startedAt: new Date(finished.getTime() - r.latencyMs),
    finishedAt: finished,
    rollup: false,
    trigger: r.trigger ?? (typeof ctx.job.payload?.trigger === 'string' ? (ctx.job.payload.trigger as string) : 'schedule'),
    modelReason: r.modelReason ?? 'default',
    contentHash: r.contentHash,
    outcome: r.outcome ?? (r.ok ? 'ok' : (r.errorCode ?? 'error')),
  });
}

// ---------------------------------------------------------------------------
// forecast.sync
// ---------------------------------------------------------------------------

export async function runForecastSyncJob(ctx: JobContext, d: ForecastJobDeps = deps): Promise<Record<string, unknown>> {
  const persona = await personaFor(ctx, d);
  if (!featureActive(persona, 'specialistForecast')) return { skipped: 'inactive', note: 'Specialist Forecast is not active for your role' };
  const live = d.live ?? (!!d.lookup || liveOrg62());
  if (!live) return { skipped: 'not_live', note: 'Org62 reads run in the launchd worker only (CC_LIVE)' };
  const owner = await ownerOrg62Of(ctx.db, ctx.userId);
  if (!owner) return { skipped: 'no_owner', note: 'Your Org62 user id is not set (onboarding ▸ Sources)' };
  const sections = await loadSettingsSections({ db: ctx.db, userId: ctx.userId });
  const tz = sections.profile?.timezone ?? 'America/Denver';
  const now = ctx.clock();
  const day = localDay(now.getTime(), tz);
  const q = quarterPair(now.getTime(), tz);
  const quarters = [q.current, q.next];
  const lookup = d.lookup ?? runOneReadLookup;
  let costUsd = 0;
  const call = async (soql: string, what: string): Promise<OneLookupResult> => {
    const started = Date.now();
    const r = await lookup({ connector: 'org62', tool: 'soqlQuery', args: { q: soql } }, { skillPath: FORECAST_LOOKUP_SKILL, timeoutMs: 90_000 });
    costUsd += r.costUsd;
    await recordSpend(ctx, day, { purpose: 'other', skillKey: 'forecast-sync', promptVersion: what, model: r.model, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens ?? 0, cacheWriteTokens: r.cacheWriteTokens ?? 0, contentHash: ledgerHash(r.model, 'soqlQuery', soql), ok: r.text !== null, ...(r.text === null ? { errorCode: r.code } : {}), latencyMs: Date.now() - started }).catch(() => undefined);
    void ctx.heartbeat().catch(() => undefined);
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
    if (r.code === 'disallowed_tool') throw new JobError('the forecast read tried a tool outside the read-only allowlist', 'bug', { code: r.code });
    return r;
  };

  // "I created it, check now": one page of my records on one opp, nothing marked gone (it is not a full read)
  if (ctx.job.payload.scope === FORECAST_CHECK_SCOPE) {
    const oppId = typeof ctx.job.payload.opportunityId === 'string' && /^[0-9a-f-]{36}$/i.test(ctx.job.payload.opportunityId) ? ctx.job.payload.opportunityId : null;
    if (!oppId) throw new JobError('forecast.sync (opp) payload needs opportunityId', 'validation', { code: 'bad_payload' });
    const o = await ctx.db.execute<{ org62: string | null }>(sql`select org62_opportunity_id as org62 from opportunities where owner_user_id = ${ctx.userId} and id = ${oppId}::uuid limit 1`);
    const org62 = o.rows[0]?.org62 ?? null;
    if (!org62 || !OPP_ID.test(org62)) return { scope: FORECAST_CHECK_SCOPE, skipped: 'no_org62_id', note: 'This opportunity has no Org62 id in the app, so it cannot be looked up' };
    const r = await call(sfrRecordsForOppSoql(owner.org62Id, quarters, org62), 'records_opp');
    if (r.text === null) throw new JobError(`the Specialist Forecast check did not finish (${r.code})`, r.code === 'config' ? 'validation' : 'transient', { code: r.code });
    let found: Org62Sfr[];
    try {
      found = parseSfrRecords(r.text).filter((x) => !x.ownerOrg62Id || id15(x.ownerOrg62Id) === id15(owner.org62Id));
    } catch (e) {
      throw new JobError('Org62 answered in a way the app could not read', 'transient', { code: e instanceof ForecastParseError ? 'unreadable' : 'parse' });
    }
    const res = found.length ? await saveForecastMirror(ctx.db, ctx.userId, { rows: found, history: null, complete: false, readAt: now.toISOString() }) : { inserted: 0, linked: 0 };
    return { scope: FORECAST_CHECK_SCOPE, found: found.length, inserted: res.inserted, linked: res.linked, quarters, costUsd: Math.round(costUsd * 10_000) / 10_000 };
  }

  const rows: Org62Sfr[] = [];
  let after: string | null = null;
  let complete = false;
  let pages = 0;
  let partial: string | null = null;
  while (pages < SFR_MAX_PAGES) {
    const r = await call(sfrRecordsSoql(owner.org62Id, quarters, after), 'records');
    pages += 1;
    if (r.text === null) {
      if (pages === 1) throw new JobError(`the Specialist Forecast read did not finish (${r.code})`, r.code === 'config' ? 'validation' : 'transient', { code: r.code });
      partial = r.code;
      break;
    }
    let page: Org62Sfr[];
    try {
      page = parseSfrRecords(r.text);
    } catch (e) {
      if (pages === 1) throw new JobError('Org62 answered in a way the app could not read', 'transient', { code: e instanceof ForecastParseError ? 'unreadable' : 'parse' });
      partial = 'unreadable';
      break;
    }
    // the query filters on OwnerId; a row of anyone else's never reaches the mirror
    rows.push(...page.filter((x) => !x.ownerOrg62Id || id15(x.ownerOrg62Id) === id15(owner.org62Id)));
    if (page.length < SFR_PAGE) {
      complete = true;
      break;
    }
    const next = page[page.length - 1]!.org62Id;
    if (next === after) {
      partial = 'no_progress'; // safety: a page that does not move the cursor would loop
      break;
    }
    after = next;
  }
  if (!complete && !partial) partial = 'too_many';

  let history: Map<string, string> | null = null;
  const h = await call(sfrNotesHistorySoql(owner.org62Id, quarters), 'history');
  if (h.text !== null) {
    try {
      history = parseNotesHistory(h.text);
    } catch {
      history = null;
    }
  }
  const res = await saveForecastMirror(ctx.db, ctx.userId, { rows, history, complete, readAt: now.toISOString() });
  return {
    records: rows.length,
    inserted: res.inserted,
    updated: res.updated,
    gone: res.gone,
    linked: res.linked,
    pages,
    quarters,
    history: history ? history.size : null,
    costUsd: Math.round(costUsd * 10_000) / 10_000,
    ...(partial ? { partial: true, note: partial === 'too_many' ? `More than ${SFR_PAGE * SFR_MAX_PAGES} records: read the first ${rows.length}` : `Read ${rows.length} records before a page failed (${partial})` } : {}),
    ...(history ? {} : { note: 'Note history was not read this time: note ages are from the previous read' }),
  };
}

// ---------------------------------------------------------------------------
// forecast.draft
// ---------------------------------------------------------------------------

function defaultExternal(): { servers: Record<string, McpServerConfig>; tools: string[]; unavailable: string[] } {
  try {
    return { servers: traversalMcpServers('slack') as Record<string, McpServerConfig>, tools: restrictedTools('slack', RESEARCH_SLACK_TOOLS).allowedTools, unavailable: [] };
  } catch {
    return { servers: {}, tools: [], unavailable: ['Slack'] };
  }
}

let defaultGoogle: GoogleTools | null | undefined;
async function defaultGoogleClient(): Promise<GoogleTools | null> {
  if (defaultGoogle !== undefined) return defaultGoogle;
  if (!liveOrg62()) return (defaultGoogle = null);
  const { GoogleWorkspaceClient } = await import('@/connectors/google/client');
  return (defaultGoogle = new GoogleWorkspaceClient({ timeoutMs: 30_000, maxRetries: 0 }));
}

export async function runForecastDraftJob(ctx: JobContext, d: ForecastJobDeps = deps): Promise<Record<string, unknown>> {
  const recordId = typeof ctx.job.payload.recordId === 'string' ? ctx.job.payload.recordId : null;
  if (!recordId) throw new JobError('forecast.draft payload needs recordId', 'validation', { code: 'bad_payload' });
  const persona = await personaFor(ctx, d);
  if (!featureActive(persona, 'specialistForecast')) return { skipped: 'inactive', note: 'Specialist Forecast is not active for your role' };
  const rec = await loadForecastRecord(ctx.db, ctx.userId, recordId);
  if (!rec || rec.goneAt) return { skipped: 'gone', note: 'The record is no longer in the mirror' };
  const sections = await loadSettingsSections({ db: ctx.db, userId: ctx.userId });
  const tz = sections.profile?.timezone ?? 'America/Denver';
  const now = ctx.clock();
  const day = localDay(now.getTime(), tz);
  const t = forecastThresholds(persona);
  const since = rec.notesUpdatedAt ?? new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const meetings = rec.accountId
    ? (
        await ctx.db.execute<{ title: string; start: Date | string }>(sql`
          select coalesce(title, 'Meeting') as title, starts_at as start from calendar_events
           where owner_user_id = ${ctx.userId} and account_id = ${rec.accountId} and deleted_upstream_at is null
             and starts_at >= ${since}::timestamptz and starts_at <= ${now.toISOString()}::timestamptz
           order by starts_at desc -- every meeting since the notes changed (caps audit 2026-11-21: was 12)
        `)
      ).rows.map((m) => ({ title: m.title, start: new Date(m.start).toISOString() }))
    : [];
  const input = { record: rec, template: t.template, personaBlock: renderPersonaBlock(persona), meetingsSince: meetings, names: [rec.accountName, rec.opportunityName].filter((x): x is string => !!x), now, timezone: tz };
  const save = async (notes: string, o: { model: string; costUsd: number; sources: Array<{ source: 'slack' | 'gmail' | 'calendar' | 'drive' | 'gemini' | 'org62' | 'app' | 'other'; label: string; url: string | null; at: string | null }> }) => {
    const cur = (await loadForecastRecord(ctx.db, ctx.userId, recordId))!;
    await savePending(ctx.db, ctx.userId, recordId, { ...cur.pending, notes: { text: notes, state: 'drafted', origin: 'model', at: ctx.clock().toISOString(), basedOnNotesAt: cur.notesUpdatedAt, model: o.model, costUsd: Math.round(o.costUsd * 10_000) / 10_000, sources: o.sources }, draftError: null });
  };

  const live = d.live ?? (!!d.agent || liveOrg62());
  if (!live) {
    const p = placeholderDraft(input, quarterPair(now.getTime(), tz).current);
    await save(p.notes, { model: PLACEHOLDER_MODEL, costUsd: 0, sources: p.sources });
    return { drafted: true, model: PLACEHOLDER_MODEL, costUsd: 0 };
  }

  // the per-draft cap, and never past today's hard cap
  const budgets = sections.budgets ?? { version: 1, softUsd: 10, hardUsd: 15, alertPct: 80, readinUsdPerDay: 2, today: null };
  const hard = budgetsForDay(budgets as Parameters<typeof budgetsForDay>[0], day).hardUsd;
  const total = await ctx.db.execute<{ total: string | null }>(sql`select coalesce(sum(cost_usd), 0) as total from llm_calls where owner_user_id = ${ctx.userId} and budget_day = ${day}::date and budget = 'daily'`);
  const capArg = typeof ctx.job.payload.cap_usd === 'number' ? ctx.job.payload.cap_usd : DRAFT_CAP_USD;
  const cap = Math.min(DRAFT_CAP_USD, capArg, hard - Number(total.rows[0]?.total ?? 0));
  if (cap < 0.05) {
    await savePending(ctx.db, ctx.userId, recordId, { ...rec.pending, draftError: { code: 'budget', message: "Today's budget is used up", at: now.toISOString() } });
    return { skipped: 'budget', note: "Today's budget is used up; raise it in Settings ▸ Budgets" };
  }
  const google = d.google ? d.google() : await defaultGoogleClient();
  const run = await runForecastNoteDraft(input, { google, ledger: dbLedgerSearch(ctx.db, ctx.userId), costCapUsd: cap, signal: ctx.signal, external: d.external ?? defaultExternal, ...(d.agent ? { agent: d.agent } : {}), onTool: () => void ctx.heartbeat().catch(() => undefined) });
  await recordSpend(ctx, day, { purpose: 'draft_generate', skillKey: 'forecast-notes', promptVersion: run.skill, model: run.model, costUsd: run.costUsd, inputTokens: run.inputTokens, outputTokens: run.outputTokens, cacheReadTokens: run.cacheReadTokens ?? 0, cacheWriteTokens: run.cacheWriteTokens ?? 0, contentHash: ledgerHash(run.model, run.skill, JSON.stringify({ ...input, now: null })), trigger: 'user_action', ok: !!run.notes, ...(run.error ? { errorCode: run.error.code } : {}), latencyMs: run.latencyMs }).catch(() => undefined);
  if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
  if (!run.notes) {
    const code = run.error?.code ?? 'no_answer';
    if (code === 'disallowed_tool') throw new JobError('the forecast draft tried a tool outside the read-only allowlist', 'bug', { code });
    await savePending(ctx.db, ctx.userId, recordId, { ...rec.pending, draftError: { code: code.slice(0, 60), message: `The draft did not finish (${code})`, at: ctx.clock().toISOString() } });
    return { skipped: code, costUsd: run.costUsd, unavailable: run.unavailable };
  }
  await save(run.notes, { model: run.model, costUsd: run.costUsd, sources: run.sources });
  return { drafted: true, model: run.model, costUsd: Math.round(run.costUsd * 10_000) / 10_000, sources: run.sources.length, unavailable: run.unavailable };
}

export function forecastJobDefs(): JobHandlerDef[] {
  return [
    { kind: FORECAST_SYNC_JOB, queue: FORECAST_QUEUE, wired: true, spends: true, description: 'Specialist Forecast read: my records this and next quarter + note history (fixed SOQL, read-only) → specialist_forecasts', handler: (ctx) => runForecastSyncJob(ctx) },
    { kind: FORECAST_DRAFT_JOB, queue: FORECAST_QUEUE, wired: true, spends: true, description: "Draft one Specialist Forecast's weekly note: a read-only research run, $0.25 cap", handler: (ctx) => runForecastDraftJob(ctx) },
  ];
}

