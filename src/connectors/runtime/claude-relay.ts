/**
 * `claude_relay`: how Slack and Org62 are read (decision H-3: MCP through Claude Code only; no SDK, no app tokens).
 * Each call is the smallest Claude run that calls exactly ONE MCP tool with OUR arguments and returns the tool's raw
 * output (src/llm/one-call.ts `runOneToolCall`): only that server loads (`strictMcpConfig`), exactly one tool is
 * allowed, a PreToolUse hook swaps our arguments in and stops anything else, the output is read from the tool result,
 * never from the model's words.
 *
 * Transport cost floor (08 R7, 04 F2):
 *  - the system prompt is the `read-lookup` skill (~0.6K chars, the smallest that still authenticates MCP) and the
 *    run loads no settings files (`settingSources: []`, COST-8, via `scannerSettingSources()`; the documented
 *    `CC_SCANNER_SETTING_SOURCES` fallback still applies if a machine's MCP OAuth needs it);
 *  - every call is recorded with `{prefix_tokens, turns, usd}` through the existing `llm_calls` measurement columns
 *    (first_prompt_tokens, turns, cost_usd: 0027) when a ledger is given;
 *  - `estimateUsd(tool)` is the p90 of that tool's recent calls (the skill's cap until there are any), so the spend
 *    governor can hold before calling (decision H-5).
 * When an SDK version exposes the zero-token `mcp_call`, only this file changes.
 */
import { sql } from 'drizzle-orm';

import type { DbOrTx } from '@/db/client';
import { insertLlmCall, ledgerHash, type CallMeasurement } from '@/db/ledger';
import type { GatewayConfig } from '@/llm/claude-env';
import { mcpToolName, restrictedTools, traversalMcpServers } from '@/llm/mcp-config';
import { SCANNER_MODEL } from '@/llm/models';
import { runOneToolCall, type OneCallResult } from '@/llm/one-call';
import { loadSkill, type LoadedSkill } from '@/llm/skill-loader';
import type { QueryFn } from '@/llm/skill-runner';
import type { ConnectorId } from '@/scanner/types';

import { guardTool, jsonOf, startTrace, traceCall } from './guard';
import { RuntimeCallError, type ConnectorRuntime, type RuntimeCallOptions, type RuntimeCallResult, type RuntimeUsage } from './types';

export const RELAY_SKILL = 'skills/read-lookup.md';
/** Recent calls per tool the estimate looks at. */
export const RELAY_HISTORY = 20;

/** `llm_calls.skill_key` of a relay call: one key per connector and tool, so the estimate reads its own history. */
export const relaySkillKey = (connector: ConnectorId, tool: string) => `relay:${connector}:${tool}`;

/** What one relay call cost and measured: the transport floor `{prefix_tokens, turns, usd}` and the rest of D0. */
export interface RelayCallRecord {
  connector: ConnectorId;
  tool: string;
  model: string;
  status: 'ok' | 'error' | 'timeout';
  code: string;
  usd: number;
  usage: RuntimeUsage;
  measure?: CallMeasurement;
  /** ledgerHash of model + tool + arguments (never the arguments themselves). */
  contentHash: string;
  startedAt: Date;
  finishedAt: Date;
}

export type RelayLedger = (r: RelayCallRecord) => Promise<void>;

/** Per-tool recent costs (in memory, newest last); seeded from `llm_calls` by `loadRelayHistory`. */
export class RelayCostHistory {
  private readonly by = new Map<string, number[]>();
  constructor(private readonly keep = RELAY_HISTORY) {}
  add(tool: string, usd: number): void {
    const xs = this.by.get(tool) ?? [];
    xs.push(Math.max(0, usd));
    if (xs.length > this.keep) xs.splice(0, xs.length - this.keep);
    this.by.set(tool, xs);
  }
  /** The p90 of the tool's recent costs, or null with no history. */
  p90(tool: string): number | null {
    const xs = [...(this.by.get(tool) ?? [])].sort((a, b) => a - b);
    if (!xs.length) return null;
    return xs[Math.min(xs.length - 1, Math.ceil(0.9 * xs.length) - 1)]!;
  }
}

export interface ClaudeRelayRuntimeOptions {
  connector: ConnectorId;
  readTools: readonly string[];
  /** Server declarations from the user's Claude config, non-secret fields only (default: src/llm/mcp-config.ts). */
  mcpServersFor?: (connector: ConnectorId) => Record<string, unknown>;
  skillPath?: string;
  repoRoot?: string;
  /** Test seam: the SDK's `query`. */
  queryFn?: QueryFn;
  gateway?: GatewayConfig;
  /** Default watchdog per call (ms). Default 90 s. */
  timeoutMs?: number;
  ledger?: RelayLedger;
  history?: RelayCostHistory;
  now?: () => Date;
}

const usageOf = (r: OneCallResult): RuntimeUsage => ({
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  cacheReadTokens: r.cacheReadTokens ?? 0,
  cacheWriteTokens: r.cacheWriteTokens ?? 0,
  turns: r.measure?.turns ?? 0,
  prefixTokens: r.measure?.firstPromptTokens ?? 0,
  model: r.model,
});

export function claudeRelayRuntime(o: ClaudeRelayRuntimeOptions): ConnectorRuntime {
  const history = o.history ?? new RelayCostHistory();
  const now = o.now ?? (() => new Date());
  let skill: LoadedSkill | null = null;
  const skillOf = () => (skill ??= loadSkill(o.skillPath ?? RELAY_SKILL, o.repoRoot));
  const capOf = (s: LoadedSkill) => (typeof s.frontmatter.budget_usd_per_run === 'number' ? s.frontmatter.budget_usd_per_run : 0.03);
  return {
    kind: 'claude_relay',
    connector: o.connector,
    readTools: o.readTools,
    estimateUsd(tool: string): number {
      const p = history.p90(tool);
      if (p !== null) return p;
      try {
        return capOf(skillOf());
      } catch {
        return 0.03;
      }
    },
    async call(tool: string, args: Record<string, unknown>, opts?: RuntimeCallOptions): Promise<RuntimeCallResult> {
      guardTool(o.connector, o.readTools, tool);
      const done = startTrace(o.connector, 'claude_relay', tool);
      const base = skillOf();
      // a caller's budget can only lower the skill's cap, never raise it
      const cap = opts?.budget ? Math.min(capOf(base), Math.max(0, opts.budget.usd)) : capOf(base);
      const s: LoadedSkill = cap === capOf(base) ? base : { ...base, frontmatter: { ...base.frontmatter, budget_usd_per_run: cap } };
      const model = typeof s.frontmatter.model === 'string' ? s.frontmatter.model : SCANNER_MODEL;
      let servers: Record<string, unknown>;
      let gate: ReturnType<typeof restrictedTools>;
      try {
        gate = restrictedTools(o.connector, [tool]);
        servers = (o.mcpServersFor ?? traversalMcpServers)(o.connector);
      } catch {
        traceCall(opts, done(false, { code: 'config' }));
        throw new RuntimeCallError(o.connector, tool, 'config', `${o.connector} is not set up in Claude Code.`, undefined, undefined, false);
      }
      const startedAt = now();
      const r = await runOneToolCall({
        servers,
        fullTool: mcpToolName(gate.serverName, tool),
        args,
        allowedTools: gate.allowedTools,
        disallowedTools: gate.disallowedTools,
        skill: s,
        ...(o.queryFn ? { queryFn: o.queryFn } : {}),
        ...(o.gateway ? { gateway: o.gateway } : {}),
        timeoutMs: opts?.timeoutMs ?? o.timeoutMs ?? 90_000,
      });
      const usage = usageOf(r);
      const ok = r.text !== null;
      history.add(tool, r.costUsd);
      if (o.ledger && (r.started || r.costUsd > 0)) {
        await o.ledger({ connector: o.connector, tool, model, status: ok ? 'ok' : r.code === 'timeout' ? 'timeout' : 'error', code: r.code, usd: r.costUsd, usage, ...(r.measure ? { measure: r.measure } : {}), contentHash: ledgerHash(model, tool, JSON.stringify(args)), startedAt, finishedAt: now() }).catch(() => undefined);
      }
      traceCall(opts, done(ok, { usd: r.costUsd, turns: usage.turns, ...(ok ? {} : { code: r.code }) }));
      if (!ok) throw new RuntimeCallError(o.connector, tool, r.code, r.message, usage, { usd: r.costUsd, estimated: false }, r.called !== false);
      return { text: r.text!, json: jsonOf(r.text!), usage, cost: { usd: r.costUsd, estimated: false } };
    },
  };
}

/**
 * A ledger that books each relay call as one `llm_calls` row: cost and tokens, the four D0 audit fields, and the
 * measurement (first_prompt_tokens = the prefix a relay pays, turns). `budgetDay` is the owner's local day.
 */
export function relayLedger(db: DbOrTx, userId: string, o: { budgetDay: () => string; trigger?: string; scanRunId?: string | null }): RelayLedger {
  return async (r) => {
    await insertLlmCall(db, {
      ownerUserId: userId,
      purpose: 'other',
      model: r.model,
      skillKey: relaySkillKey(r.connector, r.tool),
      status: r.status,
      errorCode: r.status === 'ok' ? null : r.code,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      cacheReadTokens: r.usage.cacheReadTokens,
      cacheWriteTokens: r.usage.cacheWriteTokens,
      costUsd: r.usd,
      budgetDay: o.budgetDay(),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      scanRunId: o.scanRunId ?? null,
      trigger: o.trigger ?? 'relay',
      modelReason: 'default',
      outcome: r.status === 'ok' ? 'relayed' : r.code,
      contentHash: r.contentHash,
      measure: { ...(r.measure ?? {}), turns: r.usage.turns || (r.measure?.turns ?? null), firstPromptTokens: r.usage.prefixTokens || (r.measure?.firstPromptTokens ?? null) },
    });
  };
}

/** Seed a history from the connector's recent relay rows in `llm_calls` (newest `keep` per tool). */
export async function loadRelayHistory(db: DbOrTx, userId: string, connector: ConnectorId, keep = RELAY_HISTORY): Promise<RelayCostHistory> {
  const h = new RelayCostHistory(keep);
  const prefix = `relay:${connector}:`;
  const res = await db.execute<{ skill_key: string; cost_usd: string | number }>(sql`
    select skill_key, cost_usd from (
      select skill_key, cost_usd, started_at, row_number() over (partition by skill_key order by started_at desc) as n
        from llm_calls where owner_user_id = ${userId} and skill_key like ${`${prefix}%`}
    ) t where n <= ${keep} order by started_at asc`);
  for (const row of res.rows) h.add(row.skill_key.slice(prefix.length), Number(row.cost_usd));
  return h;
}
