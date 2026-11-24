/**
 * `vdp.assets.find` (queue `vdp`, concurrency 1): "Find assets" for one VDP or one account without a VDP. A read-only
 * research run over the account's history (src/llm/research/vdp-assets.ts) → asset candidates with provenance
 * (`vdp_asset_candidates`, origin `backfill`), deduped against what the VDP holds and what is already known.
 *
 * Budget: each run is capped at the research budget per run (Settings ▸ Budgets ▸ Assistant limits ▸ research) and by
 * what is left on the assistant's day line and under the global hard cap; spend is recorded in `llm_calls` on the
 * assistant's line (purpose `chat`, skill `vdp-assets`), like chat_research. A run with no budget left succeeds as
 * `{skipped: 'budget'}`. jobs.result holds counts and codes only.
 *
 * Spend (caps audit 26 F-4): the run is under one hold on the governor: the worker's start gate's (`vdp.assets.find:<id>`,
 * priced as skill `vdp-assets`, found by `startJobSpend`), or its own when no gate ran. Its user budgets stay lines (the research
 * budget per run, the assistant's day line, the hard cap, and a `cap_usd` the Assistant's approved plan set); the
 * $0.50 default is no longer where it stops: past the hold it raises a hand (Health ▸ Spend) and the continuation,
 * carrying the hold, runs the search again on Allow.
 */
import { randomUUID } from 'node:crypto';

import type { McpServerConfig } from '@/llm/provider';
import { sql } from 'drizzle-orm';
import { insertLlmCall, ledgerHash } from '@/db/ledger';

import { accountOfVdpKey, budgetsForDay, DEFAULT_CHAT_SETTINGS, type Settings } from '@/contract';
import type { GoogleTools } from '@/connectors/google/client';
import { localDay } from '@/engines/activity/time';
import { restrictedTools, traversalMcpServers } from '@/llm/mcp-config';
import type { ResearchAgent } from '@/llm/readin/agent';
import { runVdpAssetResearch } from '@/llm/research/vdp-assets';
import { searchNamesFor } from '@/lib/vdp/search-names';
import { featureActive, renderPersonaBlock } from '@/personas';
import { loadPersona } from '@/server/datasource/db/store/persona';
import { RESEARCH_SLACK_TOOLS } from '@/server/chat/research';
import { dbLedgerSearch } from '@/server/datasource/db/readin';
import { loadSettingsSections } from '@/server/datasource/db/store/settings';
import { loadAssetState } from '@/server/datasource/db/store/vdp-assets';
import { assistantDayLeft, loadCandidates, upsertCandidates, VDP_ASSETS_JOB, VDP_ASSETS_QUEUE } from '@/server/datasource/db/store/vdp-candidates';
import { effectiveSlug, slugByAccount } from '@/server/vdp/detail';
import { MIN_RUN_USD, targetForKey } from '@/server/vdp/find';

import { finishJobSpend, gateOf, PAUSED_FOR_SPEND, startJobSpend, type SpendGovernor } from '@/llm/spend';
import { dbSpendGovernor } from '@/server/datasource/db/spend';

import { spendPauseResult, spendStartResult } from '../spend-pause';
import { JobError, type JobContext, type JobHandlerDef } from '../types';

export interface VdpAssetsHandlerDeps {
  agent?: ResearchAgent;
  google?: () => GoogleTools | null;
  external?: () => { servers: Record<string, McpServerConfig>; tools: string[]; unavailable: string[] };
  /** The spend governor (default: the database one; null: no hold, the $0.50 default stops a run as before). */
  spend?: SpendGovernor | null;
}

let deps: VdpAssetsHandlerDeps = {};
/** Tests swap the agent, the Google client or the MCP servers. */
export function configureVdpAssets(d: VdpAssetsHandlerDeps): void {
  deps = { ...deps, ...d };
}
export function resetVdpAssetsConfig(): void {
  deps = {};
}

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
  const live = process.env.CC_LIVE === '1' || (process.env.CC_LIVE === undefined && process.env.NODE_ENV === 'production');
  if (!live) return (defaultGoogle = null);
  const { GoogleWorkspaceClient } = await import('@/connectors/google/client');
  return (defaultGoogle = new GoogleWorkspaceClient({ timeoutMs: 30_000, maxRetries: 0 }));
}

async function recordSpend(ctx: JobContext, day: string, r: { model: string; skill: string; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; ok: boolean; errorCode?: string; latencyMs: number; contentHash: string }) {
  if (!r.model) return;
  const finished = new Date();
  await insertLlmCall(ctx.db, {
    ownerUserId: ctx.userId,
    purpose: 'chat',
    model: r.model,
    skillKey: 'vdp-assets',
    promptVersion: r.skill,
    requestHash: `vdp-assets:${ctx.job.id}:${randomUUID()}`,
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
    // Find assets runs when the user asks for it (VDP ▸ Find assets).
    trigger: 'user_action',
    modelReason: 'default',
    contentHash: r.contentHash,
    outcome: r.ok ? 'ok' : (r.errorCode ?? 'error'),
  });
}

export async function runVdpAssetsJob(ctx: JobContext, d: VdpAssetsHandlerDeps = deps): Promise<Record<string, unknown>> {
  const key = typeof ctx.job.payload.key === 'string' ? ctx.job.payload.key : null;
  if (!key) throw new JobError('vdp.assets.find payload needs key', 'validation', { code: 'bad_payload' });
  // D-55: VDP is a persona feature. A Find-assets run queued while it was active (or by an old client) does nothing
  // once it is inactive: no model call, no spend.
  const persona = await loadPersona(ctx.db, ctx.userId);
  if (!featureActive(persona, 'vdp')) return { skipped: 'vdp_inactive' };
  const planCap = typeof ctx.job.payload.cap_usd === 'number' ? ctx.job.payload.cap_usd : null;
  const perRunCap = planCap ?? 0.5;
  const sections = await loadSettingsSections({ db: ctx.db, userId: ctx.userId });
  const tz = sections.profile?.timezone ?? 'America/Denver';
  const now = ctx.clock();
  const day = localDay(now.getTime(), tz);
  const settings = { chat: sections.chat ?? DEFAULT_CHAT_SETTINGS, budgets: sections.budgets ?? ({ version: 1, softUsd: 10, hardUsd: 15, alertPct: 80, readinUsdPerDay: 2, today: null } as Settings['budgets']) };
  const line = await assistantDayLeft(ctx.db, ctx.userId, settings, day);
  const hard = budgetsForDay(settings.budgets, day).hardUsd;
  const total = await ctx.db.execute<{ total: string | null }>(sql`select coalesce(sum(cost_usd), 0) as total from llm_calls where owner_user_id = ${ctx.userId} and budget_day = ${day}::date and budget = 'daily'`);
  const hardLeft = hard - Number(total.rows[0]?.total ?? 0);
  const cap = Math.min(perRunCap, line.perRunUsd, line.dayLeftUsd, hardLeft);
  if (cap < MIN_RUN_USD) return { skipped: 'budget', note: "The assistant's daily limit is used up; raise it in Settings ▸ Budgets or allow more today" };

  const st = await loadAssetState(ctx.db, ctx.userId);
  const target = targetForKey(key, st.cov, st.snaps, st.accounts);
  if (!target) return { skipped: 'gone', note: accountOfVdpKey(key) ? 'The account is no longer engaged' : 'The VDP is no longer in the mirror' };
  const byAccount = slugByAccount(st.cov.vdps);
  const known = (await loadCandidates(ctx.db, ctx.userId)).filter((c) => c.targetKey === target.key || effectiveSlug(c, byAccount) === target.vdpSlug).map((c) => ({ url: c.url, title: c.title }));
  const gov = d.spend === undefined ? dbSpendGovernor({ db: ctx.db, userId: ctx.userId, clock: ctx.clock }) : d.spend;
  const envelope = await startJobSpend(gov, ctx.job, { scope: 'research', skill: 'vdp-assets' });
  const early = await spendStartResult(ctx, envelope);
  if (early) return early;
  if (envelope.kind === 'day_budget') return { skipped: 'budget', note: "Today's spend cap has no room for this search; raise it in Settings ▸ Budgets or allow more today" };
  const gate = gateOf(envelope);
  // the user budgets left: the plan's cap, the research budget per run, the assistant's day line, the hard cap
  const userLineUsd = Math.min(planCap ?? Number.POSITIVE_INFINITY, line.perRunUsd, line.dayLeftUsd, hardLeft);
  const google = d.google ? d.google() : await defaultGoogleClient();
  const run = await runVdpAssetResearch(
    { key: target.key, vdpSlug: target.vdpSlug, accountId: target.accountId, companyName: target.companyName, names: searchNamesFor(target.names), known: [...target.inVdp, ...known], inVdp: target.inVdp },
    {
      now,
      timezone: tz,
      google,
      ledger: dbLedgerSearch(ctx.db, ctx.userId),
      costCapUsd: cap,
      signal: ctx.signal,
      external: d.external ?? defaultExternal,
      ...(d.agent ? { agent: d.agent } : {}),
      onTool: () => void ctx.heartbeat().catch(() => undefined),
      persona: renderPersonaBlock(persona),
      ...(gate ? { spend: gate, userLineUsd } : {}),
    },
  ).catch(async (err: unknown) => {
    await finishJobSpend(gov, envelope);
    throw err;
  });
  if (gate) gate.observe(run.costUsd);
  await finishJobSpend(gov, envelope);
  await recordSpend(ctx, day, { model: run.model, skill: run.skill, costUsd: run.costUsd, inputTokens: run.inputTokens, outputTokens: run.outputTokens, cacheReadTokens: run.cacheReadTokens ?? 0, cacheWriteTokens: run.cacheWriteTokens ?? 0, contentHash: ledgerHash(run.model, run.skill, target.key, target.vdpSlug, ...[...target.inVdp, ...known].map((k) => (typeof k === 'string' ? k : k.url))), ok: !!run.output, ...(run.error ? { errorCode: run.error.code } : {}), latencyMs: run.latencyMs }).catch(() => undefined);
  if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted');
  if (!run.output && run.error?.code === PAUSED_FOR_SPEND) {
    return { skipped: PAUSED_FOR_SPEND, note: 'Paused at its spend estimate: allow more in Health ▸ Spend to finish the search', costUsd: run.costUsd, ...(await spendPauseResult(ctx, envelope)) };
  }
  if (!run.output) {
    const code = run.error?.code ?? 'no_answer';
    if (code === 'disallowed_tool') throw new JobError('vdp assets research tried a tool outside the read-only allowlist', 'bug', { code });
    return { skipped: code, note: `The search did not finish (${code})`, costUsd: run.costUsd, unavailable: run.unavailable };
  }
  const res = await upsertCandidates(ctx.db, ctx.userId, run.drafts, { origin: 'backfill', now: ctx.clock() });
  return { added: res.added, updated: res.updated, assets: run.output.assets.length, searched: run.output.searched.length, costUsd: Math.round(run.costUsd * 10_000) / 10_000, unavailable: run.unavailable, ...(run.unavailable.length ? { note: `Not searched: ${run.unavailable.join(', ')}` } : {}) };
}

export function vdpAssetsJobDef(): JobHandlerDef {
  return { kind: VDP_ASSETS_JOB, queue: VDP_ASSETS_QUEUE, wired: true, spends: true, description: 'VDP "Find assets": read-only research over one account history → asset candidates', handler: (ctx) => runVdpAssetsJob(ctx) };
}
