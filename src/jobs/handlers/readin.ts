/**
 * `readin.generate` (queue `readin`, concurrency 1): research one work item or meeting with read-only tools and
 * write its read-in plus a suggested-reply draft in the Outbox (never sent). See src/llm/readin/ and
 * docs/reference/WORKER.md "Jobs".
 *
 * Flow: budget check → context pack (ledger, deterministic) → Sonnet agent with Slack (search + read thread), Org62
 * (SOQL), Gmail and Drive (devbar read tools) and the ledger search → validated `readin_finish` → one engine change
 * set (draft + stored read-in) fenced on the item's generation → spend in llm_calls → live event `readin`.
 *
 * Superseding: the planner (and every enqueue) cancels a running read-in when its item moves to a newer generation;
 * this handler also watches the generation while it researches and stops early, and its commit is fenced, so a
 * superseded run never writes. Soft failures (budget, cost cap, turns, unusable output) return `{skipped: code}`
 * so the job succeeds quietly and older content stays visible; a tool outside the allowlist or an auth failure
 * throws so the job is dead-lettered and Health shows it.
 *
 * Spend (caps audit 26 F-4): a read-in runs under one hold on the governor (it replaces D6's reservation): the one the
 * worker's start gate took before it started (LLM_JOB_KINDS prices it as this handler would: skill by entity type,
 * model by trigger), which `startJobSpend` finds by `readin.generate:<id>`; its own only when no gate ran (a direct
 * call) or a continuation's hold lapsed. The gate's is kept because it holds before the job starts (a full day defers
 * the read-in instead of skipping it) and settles with everything the job booked, even when it throws. Its
 * user budgets stay lines: the read-in day line and the hard cap. The $0.35 and 14 turns are no longer where it
 * stops: past the hold it raises a hand (Health ▸ Spend) and its continuation, carrying the hold, runs it again on
 * Allow; turns and the SDK budget are the runaway guard.
 */
import type { McpServerConfig } from '@/llm/provider';

import type { ReadIn, ReadInEntity, ReadInProgress, ReadInTrigger } from '@/contract';
import { READIN_DEFAULTS, readInModelFor } from '@/contract';
import { ledgerHash, recordDecision, reserveBudget } from '@/db/ledger';
import type { GoogleTools } from '@/connectors/google/client';
import { restrictedTools, traversalMcpServers } from '@/llm/mcp-config';
import { SdkResearchAgent, type ResearchAgent } from '@/llm/readin/agent';
import { buildReadInContext, contextUrls } from '@/llm/readin/context';
import { destinationFor, destinationLabel, docFromReplyText, previewOf, toReadIn } from '@/llm/readin/map';
import { readInsEnabled } from '@/llm/readin/planner';
import { readInEvidenceHash } from '@/llm/readin/evidence';
import { buildReadInPrompt, stepForTool } from '@/llm/readin/prompt';
import { renderPersonaBlock } from '@/personas';
import { loadPersona } from '@/server/datasource/db/store/persona';
import { errorFor, PLAN_STEPS, READIN_KIND, READIN_QUEUE } from '@/llm/readin/state';
import { createReadInTools, createToolState } from '@/llm/readin/tools';
import { commitReadIn, dbLedgerSearch, freshnessOf, loadStored, notifyReadIn, readInBudget, recordReadInSpend, setJobProgress } from '@/server/datasource/db/readin';
import { loadReadInRecords } from '@/server/datasource/db/readin-records';
import { finishJobSpend, gateOf, PAUSED_FOR_SPEND, startJobSpend, type JobSpendStart, type SpendGovernor } from '@/llm/spend';
import { dbSpendGovernor } from '@/server/datasource/db/spend';

import { spendPauseResult, spendStartResult } from '../spend-pause';
import { JobError, type JobContext, type JobHandler, type JobHandlerDef } from '../types';

/** The Slack and Org62 read tools a read-in may call: subsets of the scanner allowlists in mcp-config (never widened). */
export const READIN_SLACK_TOOLS = ['slack_search_public_and_private', 'slack_read_thread'] as const;
export const READIN_ORG62_TOOLS = ['soqlQuery'] as const;

export interface ReadInHandlerDeps {
  agent?: ResearchAgent;
  /** devbar google_workspace_readonly client (Gmail, Drive). null = unavailable this run. */
  google?: () => GoogleTools | null;
  /** External MCP servers + their allowed tools (default: Slack + Org62 from ~/.claude.json). */
  external?: () => { servers: Record<string, McpServerConfig>; tools: string[]; unavailable: string[] };
  enabled?: () => boolean;
  model?: string;
  /** Poll the item's generation while researching (ms). Default 10 s. */
  generationPollMs?: number;
  /** Per-read-in caps (defaults READIN_DEFAULTS.maxTurns / costCapUsd); the budget can only lower them. */
  maxTurns?: number;
  costCapUsd?: number;
  /** The spend governor (default: the database one; null: no hold, the caps above and D6's reservation apply). */
  spend?: SpendGovernor | null;
}

let deps: ReadInHandlerDeps = {};
let defaultGoogle: GoogleTools | null | undefined;

/** Tests and the worker can swap the agent, Google client or MCP servers. */
export function configureReadIn(d: ReadInHandlerDeps): void {
  deps = { ...deps, ...d };
}
export function resetReadInConfig(): void {
  deps = {};
}

function defaultExternal(): { servers: Record<string, McpServerConfig>; tools: string[]; unavailable: string[] } {
  const servers: Record<string, McpServerConfig> = {};
  const tools: string[] = [];
  const unavailable: string[] = [];
  for (const [connector, allow, label] of [
    ['slack', READIN_SLACK_TOOLS, 'Slack'],
    ['org62', READIN_ORG62_TOOLS, 'Org62'],
  ] as const) {
    try {
      Object.assign(servers, traversalMcpServers(connector) as Record<string, McpServerConfig>);
      tools.push(...restrictedTools(connector, allow).allowedTools);
    } catch {
      unavailable.push(label);
    }
  }
  return { servers, tools, unavailable };
}

async function defaultGoogleClient(): Promise<GoogleTools | null> {
  if (defaultGoogle !== undefined) return defaultGoogle;
  const live = process.env.CC_LIVE === '1' || (process.env.CC_LIVE === undefined && process.env.NODE_ENV === 'production');
  if (!live) return (defaultGoogle = null);
  const { GoogleWorkspaceClient } = await import('@/connectors/google/client');
  return (defaultGoogle = new GoogleWorkspaceClient());
}

function parsePayload(p: Record<string, unknown>): { entity: ReadInEntity; trigger: ReadInTrigger; force: boolean } {
  const type = p.entity_type === 'calendar_event' ? 'calendar_event' : p.entity_type === 'work_item' ? 'work_item' : null;
  const id = typeof p.entity_id === 'string' ? p.entity_id : null;
  if (!type || !id) throw new JobError('readin payload needs entity_type and entity_id', 'validation', { code: 'bad_payload' });
  const trigger = (['direct_ask', 'top_rank', 'meeting_prep', 'new_evidence', 'on_demand'] as const).find((t) => t === p.trigger) ?? 'on_demand';
  return { entity: { type, id }, trigger, force: p.force === true };
}

export async function runReadInJob(ctx: JobContext, d: ReadInHandlerDeps = deps): Promise<Record<string, unknown>> {
  const { db, userId } = ctx;
  const { entity, trigger, force } = parsePayload(ctx.job.payload);
  if (!(d.enabled ?? readInsEnabled)()) return { skipped: 'disabled' };
  const skillOf = entity.type === 'calendar_event' ? 'readin-meeting' : 'readin-ask';

  // ---- budget: its own daily line, inside the global hard cap. On-demand may pass the read-in line, never the hard cap.
  const b = await readInBudget(db, userId, ctx.clock());
  const decide = (kind: 'skip' | 'block', reason: string, detail: Record<string, unknown> = {}) =>
    recordDecision(db, userId, { skill: skillOf, kind, reason, trigger, subject: `${entity.type}:${entity.id}`, day: b.day, at: ctx.clock(), detail: { jobId: ctx.job.id, ...detail } });
  const hardLeft = b.hardUsd - b.totalUsd;
  const readinLeft = b.readinCapUsd - b.readinUsd;
  if (hardLeft <= 0.01) {
    await decide('block', 'hard_cap', { spentUsd: b.totalUsd, capUsd: b.hardUsd });
    return { skipped: 'hard_cap' };
  }
  if (trigger !== 'on_demand' && readinLeft <= 0.01) {
    await decide('block', 'readin_cap', { spentUsd: b.readinUsd, capUsd: b.readinCapUsd });
    return { skipped: 'budget' };
  }
  const costCap = Math.max(0.01, Math.min(d.costCapUsd ?? READIN_DEFAULTS.costCapUsd, hardLeft, trigger === 'on_demand' ? hardLeft : readinLeft));
  const maxTurns = d.maxTurns ?? READIN_DEFAULTS.maxTurns;

  // ---- context pack (deterministic)
  const startedAt = new Date();
  const records = await loadReadInRecords(db, userId, ctx.clock());
  const context = buildReadInContext(records, entity, { trigger });
  if (!context) return { skipped: 'gone' };
  const generation = Math.max(context.generation, ctx.job.generation ?? 0);
  // D2: an automatic read-in whose evidence is what the last ready one researched is not run again. The stored read-in
  // moves to this generation (it is still current), so the planner stops asking for it.
  const evidenceHash = readInEvidenceHash(context);
  if (trigger !== 'on_demand' && !force) {
    const stored = await loadStored(db, userId, entity);
    if (stored?.outcome === 'ready' && stored.readIn.evidenceHash && stored.readIn.evidenceHash === evidenceHash) {
      await decide('skip', 'evidence_unchanged', { generation, readGeneration: stored.readIn.generation });
      if (stored.readIn.generation < generation) await commitReadIn(db, userId, { entity, jobId: stored.jobId, readIn: { ...stored.readIn, generation }, outcome: 'ready', reply: null, fenceGeneration: generation }).catch(() => undefined);
      return { skipped: 'evidence_unchanged' };
    }
  }
  // F-4: the governor holds the read-in's estimate against today (asks past it); without one, D6's reservation of the cap
  const gov = d.spend === undefined ? dbSpendGovernor({ db, userId, clock: ctx.clock }) : d.spend;
  const envelope = await startJobSpend(gov, ctx.job, { scope: 'research', skill: context.skill, model: (d.model ? { model: d.model } : readInModelFor(trigger)).model });
  const early = await spendStartResult(ctx, envelope);
  if (early) return early;
  if (envelope.kind === 'day_budget') {
    await decide('block', 'hard_cap_reserve', { spentUsd: b.totalUsd, capUsd: b.hardUsd });
    return { skipped: 'hard_cap' };
  }
  if (envelope.kind === 'run') {
    const userLineUsd = Math.max(0.01, trigger === 'on_demand' ? hardLeft : Math.min(hardLeft, readinLeft));
    try {
      return await research(ctx, d, { entity, trigger, generation, context, costCap, maxTurns, startedAt, evidenceHash, envelope, userLineUsd });
    } finally {
      await finishJobSpend(gov, envelope);
    }
  }
  // D6: hold this read-in's cost cap against the daily hard cap while it runs, so parallel jobs can't overshoot it.
  const hold = await reserveBudget(db, userId, { day: b.day, usd: costCap, hardCapUsd: b.hardUsd });
  if (!hold.ok) {
    await decide('block', 'hard_cap_reserve', { spentUsd: hold.spentUsd, heldUsd: hold.reservedUsd, capUsd: hold.hardCapUsd, wantUsd: costCap });
    return { skipped: 'hard_cap' };
  }
  try {
    return await research(ctx, d, { entity, trigger, generation, context, costCap, maxTurns, startedAt, evidenceHash });
  } finally {
    await hold.release();
  }
}

async function research(
  ctx: JobContext,
  d: ReadInHandlerDeps,
  a: { entity: ReadInEntity; trigger: ReadInTrigger; generation: number; context: NonNullable<ReturnType<typeof buildReadInContext>>; costCap: number; maxTurns: number; startedAt: Date; evidenceHash: string; envelope?: JobSpendStart; userLineUsd?: number },
): Promise<Record<string, unknown>> {
  const { db, userId } = ctx;
  const { entity, trigger, generation, context, costCap, maxTurns, startedAt, evidenceHash } = a;
  const gate = a.envelope ? gateOf(a.envelope) : null;
  const progress = async (p: ReadInProgress) => setJobProgress(db, ctx.job.id, p).catch(() => undefined);
  await progress({ step: 'ledger', label: 'Checking what you said before', done: 0, total: PLAN_STEPS });
  await notifyReadIn(db, entity, 'readin.researching').catch(() => undefined);

  // ---- research
  const ext = (d.external ?? defaultExternal)();
  const google = d.google ? d.google() : await defaultGoogleClient();
  const unavailable = [...ext.unavailable, ...(google ? [] : ['Gmail', 'Drive'])];
  const state = createToolState(contextUrls(context));
  const ac = new AbortController();
  const onParentAbort = () => ac.abort(ctx.signal.reason);
  if (ctx.signal.aborted) onParentAbort();
  ctx.signal.addEventListener('abort', onParentAbort, { once: true });
  let superseded = false;
  const poll = setInterval(() => {
    void freshnessOf(db, userId, entity)
      .then((f) => {
        if (f && f.generation > generation && !ac.signal.aborted) {
          superseded = true;
          ac.abort();
        }
      })
      .catch(() => undefined);
  }, d.generationPollMs ?? 10_000);
  poll.unref?.();
  const handlers = createReadInTools({ google, ledger: dbLedgerSearch(db, userId), signal: ac.signal }, state);
  const persona = renderPersonaBlock(await loadPersona(db, userId));
  const built = buildReadInPrompt(context, { runId: `readin-${ctx.job.id}`, maxTurns, costCapUsd: costCap, externalTools: ext.tools, unavailable, persona });
  const steps = new Set<string>();
  let lastProgressAt = 0;
  // D2: automatic read-ins run on the light model, the user's own ask on the strong one (READIN_MODEL_BY_TRIGGER).
  const pick = d.model ? { model: d.model, reason: 'override' } : readInModelFor(trigger);
  const model = pick.model;
  const agent = d.agent ?? new SdkResearchAgent({ logger: (e) => ctx.log(`agent ${e.event}`, { ...(e.tool ? { tool: e.tool } : {}), ...(e.code ? { code: e.code } : {}) }) });
  let run;
  try {
    run = await agent.run({
      runId: `readin-${ctx.job.id}`,
      model,
      systemPrompt: built.systemPrompt,
      prompt: built.prompt,
      mcpServers: ext.servers,
      externalTools: ext.tools,
      handlers,
      state,
      maxTurns,
      costCapUsd: costCap,
      ...(gate ? { spend: gate, ...(a.userLineUsd != null ? { userLineUsd: a.userLineUsd } : {}) } : {}),
      signal: ac.signal,
      onTool: (name) => {
        const s = stepForTool(name);
        if (!s) return;
        steps.add(s.step);
        const now = Date.now();
        if (now - lastProgressAt < 1500 && s.step !== 'writing') return;
        lastProgressAt = now;
        void progress({ step: s.step, label: s.label, done: Math.min(steps.size, PLAN_STEPS), total: PLAN_STEPS });
        void notifyReadIn(db, entity, 'readin.progress').catch(() => undefined);
        void ctx.heartbeat().catch(() => undefined);
      },
    });
  } finally {
    clearInterval(poll);
    ctx.signal.removeEventListener('abort', onParentAbort);
  }

  await recordReadInSpend(db, userId, {
    model,
    skillKey: context.skill,
    skillVersion: built.skillVersion,
    jobId: ctx.job.id,
    costUsd: run.costUsd,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    cacheReadTokens: run.cacheReadTokens ?? 0,
    cacheWriteTokens: run.cacheWriteTokens ?? 0,
    status: run.ok ? 'ok' : run.error?.code === 'timeout' ? 'timeout' : run.error?.code === 'cost_cap' ? 'budget_blocked' : 'error',
    ...(run.error ? { errorCode: run.error.code } : {}),
    startedAt,
    trigger,
    modelReason: pick.reason,
    contentHash: ledgerHash(model, built.skillVersion, ...built.systemPrompt, built.prompt),
    outcome: superseded ? 'superseded' : run.ok && run.output ? 'ready' : (run.error?.code ?? 'invalid_output'),
  });
  const counts = { costUsd: run.costUsd, turns: run.turns, toolCalls: run.toolCalls.length, background: run.output?.background.length ?? 0 };

  if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('aborted'); // cancel / shutdown / timeout: the runtime settles it
  if (superseded) return { superseded: true, ...counts };
  if (gate) gate.observe(run.costUsd);
  if (run.error?.code === PAUSED_FOR_SPEND && a.envelope) {
    // asked: older content stays; the continuation carries the hold and runs the read-in again on Allow
    return { skipped: PAUSED_FOR_SPEND, ...counts, ...(await spendPauseResult(ctx, a.envelope)) };
  }
  if (!run.ok || !run.output) {
    const code = run.error?.code ?? 'invalid_output';
    if (code === 'disallowed_tool') {
      await commitFailure(ctx, entity, trigger, code, run.costUsd, generation, built.skillVersion, model);
      throw new JobError(`read-in aborted: ${run.error?.disallowedTool ?? 'tool'} is not on the read-only allowlist`, 'bug', { code: 'disallowed_tool' });
    }
    if (run.error?.errorClass === 'auth') throw new JobError('read-in source needs re-auth', 'auth', { code: run.error.code });
    if (run.error?.errorClass === 'transient' || run.error?.errorClass === 'rate_limited') throw new JobError(`read-in: ${code}`, run.error.errorClass, { code });
    return { skipped: code, ...counts };
  }

  // ---- commit: the Outbox draft + the stored read-in, fenced on the generation it researched
  const generatedAt = new Date().toISOString();
  let reply: Parameters<typeof commitReadIn>[2]['reply'] = null;
  if (run.output.suggestedReply && context.reply) {
    // The draft always goes where the ask came from (the context's reply target); the agent's channel only shapes style.
    const destination = destinationFor(context.reply, run.output.suggestedReply.subject);
    reply = { destination, doc: docFromReplyText(run.output.suggestedReply.text), label: destinationLabel(destination), preview: previewOf(run.output.suggestedReply.text) };
  }
  const readIn: ReadIn = { ...toReadIn(run.output, { ...context, generation }, { trigger, generatedAt, costUsd: run.costUsd, model, skillVersion: built.skillVersion, seenUrls: state.seenUrls, suggestedReply: null }), evidenceHash };
  const c = await commitReadIn(db, userId, { entity, jobId: ctx.job.id, readIn, outcome: 'ready', reply, fenceGeneration: generation });
  if (!c.committed) return { superseded: c.reason === 'superseded', skipped: c.reason ?? null, ...counts };
  return { draftId: c.draftId, ...counts };
}

async function commitFailure(ctx: JobContext, entity: ReadInEntity, trigger: ReadInTrigger, code: string, costUsd: number, generation: number, skillVersion: string, model: string) {
  const at = new Date().toISOString();
  const readIn: ReadIn = {
    entity,
    state: 'failed',
    tldr: '',
    background: [],
    history: [],
    openQuestions: [],
    suggestedReply: null,
    confidence: null,
    generatedAt: null,
    generation,
    costUsd,
    sources: [],
    trigger,
    model,
    skillVersion,
    evidenceHash: null,
    progress: null,
    error: errorFor(code),
    staleReason: null,
    updatedAt: at,
  };
  await commitReadIn(ctx.db, ctx.userId, { entity, jobId: ctx.job.id, readIn, outcome: 'failed' }).catch(() => undefined);
}

export const readInHandler: JobHandler = (ctx) => runReadInJob(ctx);

/** The registry entry (src/jobs/index.ts registers it; queue `readin` gets its own pool, concurrency 1). */
export function readInJobDef(): JobHandlerDef {
  return { kind: READIN_KIND, queue: READIN_QUEUE, wired: true, spends: true, description: 'read-ins: background research + suggested reply draft (read-only tools)', handler: readInHandler };
}
