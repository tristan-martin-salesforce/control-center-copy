/**
 * The chat runner (Assistant v2, H-6): one Agent SDK `query()` per message, resuming the thread's SDK session.
 *
 * - Model: the router's tier (src/llm/chat/router.ts: Haiku for lookups and actions, Sonnet for drafts and
 *   explanations, Opus for research synthesis and multi-step plans), or the user's override; the route rides on the
 *   message header and the receipt.
 * - Session: `persistSession` with the thread's SDK session id; the next message `resume`s it, so earlier tool results
 *   stay in context and the thread is a cached prefix (lane 05 ASSIST-3). When a session can't be resumed (none yet, its
 *   transcript is gone, sessions off with `CC_CHAT_SESSIONS=0`), the thread is rebuilt from the stored history with
 *   older turns replaced by their compaction summary in `chat_memory` (prompt.ts `compactedHistory`); pinned notes and
 *   preferences ride on every turn. Transcripts stay in the chat cwd under the app's state folder.
 * - Tools: the eleven in-process tools (src/llm/chat/tools.ts) only (`tools: []`, `strictMcpConfig`), one stable list per
 *   persona. Live Slack / Org62 / VDP / Google reads go through the connector runtime inside `search` / `fetch`, read
 *   tools only. The exact allowlist is enforced three times: a PreToolUse hook, `canUseTool` and a scan of assistant
 *   `tool_use` blocks; a call to any other real tool aborts the turn. Nothing sends.
 * - Spend (H-5): the message holds its estimate (src/llm/spend); past it the turn raises a hand at its next tool call
 *   (SSE `spend-ask`) and waits, the query alive. A `plan` with a research-class run waits for Run / Edit / Skip the
 *   same way, and each `run` holds its own estimate. The SDK's `maxBudgetUsd` is the assistant's day line (the runaway
 *   guard). The running spend streams as `usage-delta`; the receipt is tier · steps · $.
 * - Watchdog: no progress (no message, no tool) for `timeoutMs` (default 180 s) stops the turn; paused while it waits
 *   on the user. Steps are a runaway guard only (200).
 * - Logs carry ids, tool names and codes only; no bodies, no secrets.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inStateDir } from '@/lib/state-folder';
import { agentQuery as sdkQuery, modelProvider, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type CanUseTool, type EffortLevel, type HookCallback, type Options, type SDKMessage, type SettingSource } from '@/llm/provider';
import type { ChatMessage, ChatModel, ChatPlan, ChatRoute } from '@/contract';
import { claudeGatewayConfig, scannerEnv, type GatewayConfig } from '../claude-env';
import { defaultClaudeExecutable } from '../env';
import { classifyError, errorText } from '../errors';
import { CHAT_MODEL_TIER, estimateCallCostUsd } from '../models';
import { defaultEstimate, MemorySpendStore, SpendGovernor, waitForAnswer, type Hold } from '../spend';
import { safeLogText } from '../redact';
import { isRealTool } from '../skill-runner';
import { connectorActive, type ResolvedPersona } from '@/personas';
import type { CompleteInput, CompleteResult } from '@/llm/provider/types';
import { waitForPlan, type PlanAnswer } from './plan-waiters';
import { buildChatPrompt, compactedHistory, loadChatSkill, renderHistory } from './prompt';
import { continuationOf, routeTurn, STEP_LIMIT_CODE, stepLimitMessage } from './router';
export { continuationOf, STEP_LIMIT_CODE, stepLimitMessage, stoppedAtStepLimit, stoppedForBudget } from './router';
import { buildChatMcpServer, chatAllowedToolsFor } from './server';
import { CHAT_SERVER_NAME, newToolState, scanProgress, type ChatToolCtx } from './tools';
import type { ChatHost, ChatRunStep, ChatTurnInput, ChatTurnRunner, ChatUsageRecord } from './types';

/** ChatModel → model id (src/llm/models.ts prices them). */
export const CHAT_MODEL_IDS: Record<ChatModel, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };

export type ChatQueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> & { close?: () => void };

export interface ChatRunnerLogEvent {
  messageId: string;
  event: 'start' | 'tool' | 'denied' | 'cost' | 'result' | 'error' | 'scan' | 'session' | 'compact';
  tool?: string;
  code?: string;
  costUsd?: number;
  detail?: string;
}

export interface ChatRunnerOptions {
  queryFn?: ChatQueryFn;
  repoRoot?: string;
  skillPath?: string;
  pathToClaudeCodeExecutable?: string;
  cwd?: string;
  env?: Record<string, string>;
  gateway?: GatewayConfig;
  settingSources?: SettingSource[];
  effort?: EffortLevel;
  /** No-progress watchdog per turn (ms). Default 180 s. */
  timeoutMs?: number;
  scanPollMs?: number;
  scanFollowMs?: number;
  logger?: (e: ChatRunnerLogEvent) => void;
  /** How long a spend ask or a plan waits for the user (ms). Default `CC_SPEND_ASK_TIMEOUT_MS` or 10 min; 0 = asks off. */
  askTimeoutMs?: number;
  /** Headless runs (tests, scripted checks): answer every waiting plan with this instead of waiting. */
  planAnswer?: PlanAnswer['answer'];
  /** SDK sessions per thread (default on; `CC_CHAT_SESSIONS=0` turns them off). */
  sessions?: boolean;
  /** Is the stored session's transcript still on disk? Default: look under the Claude config's projects folder. */
  sessionExists?: (sessionId: string, cwd: string) => boolean;
  /** Compaction's summarizer (default: host.complete, else the active provider's `complete()` on the fast tier). */
  summarize?: (input: CompleteInput) => Promise<CompleteResult>;
  /** Compaction trigger override (tokens; default prompt.ts COMPACT_AT_TOKENS). */
  compactAtTokens?: number;
}

/** Fixed chat cwd under the app's state dir, so the Claude-sessions watcher can tell chat runs apart. */
export function defaultChatCwd(source: NodeJS.ProcessEnv = process.env): string {
  return source.CC_CHAT_CWD ?? inStateDir('chat-cwd');
}

/** Where the CLI keeps a session's transcript: `<config>/projects/<cwd with non-alphanumerics as ->/<id>.jsonl`. */
export function sessionTranscriptPath(sessionId: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const config = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

const defaultSessionExists = (id: string, cwd: string) => {
  try {
    return fs.existsSync(sessionTranscriptPath(id, cwd));
  } catch {
    return false;
  }
};

/** A tiny async queue: producers push steps, the turn generator drains them in order. */
class StepQueue {
  private items: ChatRunStep[] = [];
  private waiters: Array<(r: IteratorResult<ChatRunStep>) => void> = [];
  private closed = false;
  push(s: ChatRunStep) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: s, done: false });
    else this.items.push(s);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  next(): Promise<IteratorResult<ChatRunStep>> {
    const s = this.items.shift();
    if (s) return Promise.resolve({ value: s, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((r) => this.waiters.push(r));
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

type ErrorStep = Extract<ChatRunStep, { type: 'error' }>;

export function createAgentSdkChatRunner(opts: ChatRunnerOptions = {}): ChatTurnRunner {
  return (input, host) => runChatTurn(input, host, opts);
}

/** The live sources this persona's turn can reach (search / fetch). */
function liveSources(host: ChatHost, persona: ResolvedPersona | null): string[] {
  if (!host.liveReads) return [];
  const out: string[] = ['ledger'];
  for (const c of ['slack', 'gmail', 'drive', 'calendar', 'org62', 'vdp'] as const) if (persona === null || connectorActive(persona, c)) out.push(c);
  return out;
}

const SUMMARY_SYSTEM = 'You compact a conversation between a seller and their work assistant. Write a faithful summary for the assistant to continue from: decisions, facts, ids (work items, opps, accounts, proposals, drafts), numbers, what is pending or was applied, and what the user asked to remember. Bullets, no preamble, nothing invented.';

export async function* runChatTurn(input: ChatTurnInput, host: ChatHost, o: ChatRunnerOptions = {}): AsyncGenerator<ChatRunStep> {
  const log = (e: Omit<ChatRunnerLogEvent, 'messageId'>) => o.logger?.({ messageId: input.messageId, ...e });
  const started = Date.now();
  const route: ChatRoute = input.route ?? routeTurn({ text: input.text, choice: input.model });
  const model: ChatModel = route.model;
  const modelId = CHAT_MODEL_IDS[model] ?? CHAT_MODEL_IDS.sonnet;

  // ---- budget gate (before any model call): chat has its own day line (D-43)
  const budget = await host.budget(model);
  const extra = Math.max(0, input.allowExtraUsd ?? 0);
  const dayLeft = budget.chatDailyUsd - budget.chatTodayUsd + extra;
  const offer = (scope: 'message' | 'day') => ({ allowMore: { usd: Math.round(Math.max(0.05, budget.perMessageUsd) * 100) / 100, scope } });
  if (dayLeft <= 0) {
    yield { type: 'error', code: 'budget_exceeded', message: `The assistant's daily limit ($${budget.chatDailyUsd.toFixed(2)}) is used up for today. Allow more for this message, or raise it in Settings > Budgets.`, retryable: false, details: offer('day') };
    return;
  }

  // ---- session + prompt
  const cwd = o.cwd ?? defaultChatCwd();
  const sessionsOn = o.sessions ?? process.env.CC_CHAT_SESSIONS !== '0';
  let resumeId: string | null = null;
  let sessionId: string | null = null;
  let systemPrompt: string[];
  let prompt: string;
  let skillTag = 'chat-assistant';
  let persona: ResolvedPersona | null = null;
  let personaForTools: ResolvedPersona | null | undefined;
  let continued: ChatMessage | null = null;
  let compactCost = 0;
  let summarizedTurns = 0;
  try {
    const [pack, thread, tz, p, memory, stored] = await Promise.all([
      host.contextPack(),
      host.history(input.threadId, [input.userMessageId, input.messageId]),
      host.timezone(),
      host.persona ? host.persona().catch(() => null) : Promise.resolve(undefined),
      host.memory ? host.memory.list(input.threadId).catch(() => []) : Promise.resolve([]),
      sessionsOn && host.memory ? host.memory.sessionOf(input.threadId).catch(() => null) : Promise.resolve(null),
    ]);
    persona = p ?? null;
    personaForTools = p;
    continued = continuationOf(thread, input);
    const history = continued ? thread.filter((m) => m.id !== continued!.id) : thread;
    if (stored && (o.sessionExists ?? (o.queryFn ? () => true : defaultSessionExists))(stored, cwd)) resumeId = stored;
    else if (stored) log({ event: 'session', code: 'transcript_missing' });
    if (sessionsOn) sessionId = resumeId ?? randomUUID();
    let rebuilt: string | null = null;
    if (!resumeId && history.length) {
      let c = compactedHistory(history, memory, o.compactAtTokens !== undefined ? { compactAt: o.compactAtTokens } : {});
      if (c.needs && host.memory) {
        // estimate → summarize the older turns once (fast tier), keep it; on failure keep the whole thread (never drop)
        const summarize = o.summarize ?? host.complete ?? ((i: CompleteInput) => modelProvider().complete(i));
        const t0 = Date.now();
        const c0Turns = c.needs.messages.length;
        const r = await summarize({ model: 'fast', system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: renderHistory(c.needs.messages) }], maxTokens: 4000 }).catch((err: unknown) => ({ ok: false, text: '', usage: null, error: errorText(err) }) as unknown as CompleteResult);
        if (r.ok && r.text.trim()) {
          const prior = memory.find((e) => e.id === c.summaryId);
          const text = prior ? `${prior.text}\n${r.text.trim()}` : r.text.trim();
          const entry = await host.memory.add({ threadId: input.threadId, kind: 'summary', text, coversThroughSeq: c.needs.to });
          // the summary stands in for the turns it covers; what is left rides whole (one summary per rebuild)
          c = compactedHistory(history, [...memory, entry], { compactAt: Number.POSITIVE_INFINITY });
          summarizedTurns = c0Turns;
          log({ event: 'compact', code: 'summarized', detail: `through=${entry.coversThroughSeq} turns=${summarizedTurns}` });
        } else log({ event: 'compact', code: 'summary_failed' });
        if (r.usage) {
          compactCost = r.usage.costUsd;
          await host.recordUsage({ threadId: input.threadId, messageId: input.messageId, model: r.usage.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheReadTokens: r.usage.cacheReadTokens, cacheWriteTokens: r.usage.cacheWriteTokens, costUsd: r.usage.costUsd, estimated: r.usage.costEstimated, status: r.ok ? 'ok' : 'error', latencyMs: Date.now() - t0, skill: 'chat-compact@1' }).catch(() => undefined);
        }
      }
      rebuilt = c.text;
    }
    const skill = loadChatSkill(o.repoRoot, o.skillPath);
    skillTag = skill.versionTag;
    ({ systemPrompt, prompt } = buildChatPrompt(
      { skillBody: skill.body, pack, context: input.context, text: input.text, now: host.now(), timezone: tz, persona, reads: { live: host.liveReads, sources: liveSources(host, persona) }, remembered: memory, history: rebuilt, route, continuation: continued },
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    ));
  } catch (err) {
    log({ event: 'error', code: 'prompt', detail: safeLogText(errorText(err), 200) });
    yield { type: 'error', code: 'internal', message: `Chat could not build its context: ${safeLogText(errorText(err), 200)}`, retryable: true };
    return;
  }
  const msgCapUsd = continued ? (extra > 0 ? extra : budget.perMessageUsd) : budget.perMessageUsd + extra;
  const capUsd = Math.max(0.0001, Math.min(msgCapUsd, dayLeft));
  const continuedFromUsd = continued?.usage?.costUsd;

  // ---- spend governor (H-5)
  const envAsk = Number(process.env.CC_SPEND_ASK_TIMEOUT_MS);
  const askTimeoutMs = o.askTimeoutMs ?? (Number.isFinite(envAsk) && process.env.CC_SPEND_ASK_TIMEOUT_MS !== '' ? envAsk : 10 * 60_000);
  const asks = askTimeoutMs > 0;
  const gov = host.spend?.() ?? new SpendGovernor(new MemorySpendStore({ now: () => host.now() }));
  const spendJob = { scope: 'chat_message' as const, jobKey: input.messageId, skill: model === 'sonnet' ? 'chat-assistant' : `chat-assistant@${model}`, model: modelId };
  const est = await gov.estimate(spendJob).catch(() => defaultEstimate('chat_message', spendJob.skill));
  let hold: Hold | null = null;
  try {
    const h = await gov.hold(spendJob, est, { budgetUsd: capUsd, skipDayCheck: true });
    if (h.ok) hold = h.hold;
  } catch (err) {
    log({ event: 'error', code: 'spend_hold', detail: safeLogText(errorText(err), 160) });
  }
  let askState: 'none' | 'pending' | 'waiting' | 'today' | 'wrap' = 'none';
  let planWaiting = false;

  // ---- run state
  const queue = new StepQueue();
  const state = newToolState();
  const ac = new AbortController();
  let stop: ErrorStep | null = null;
  const fail = (e: ErrorStep) => {
    if (!stop) stop = e;
    if (!ac.signal.aborted) ac.abort();
  };
  const onUserAbort = () => {
    if (!ac.signal.aborted) ac.abort();
  };
  if (input.signal.aborted) onUserAbort();
  input.signal.addEventListener('abort', onUserAbort, { once: true });

  // the no-progress watchdog: any message or tool pushes it out; a long tool may push it further
  const baseMs = o.timeoutMs ?? 180_000;
  const t0 = Date.now();
  let deadline = t0 + baseMs;
  const progress = (ms = baseMs) => {
    deadline = Math.max(deadline, Date.now() + ms);
  };
  let subCost = compactCost;
  const usageCost = () => [...usageByMsg.values()].reduce((a, u) => a + u.cost, 0);
  let metered = -1;
  const holdView = () => (hold ? { hold: { p50: hold.estimate.p50, p90: hold.estimate.p90, spent: Math.round(usageCost() * 1e6) / 1e6, held: hold.heldUsd, state: hold.state } } : {});
  const meter = (force = false) => {
    const spent = usageCost() + subCost;
    if (!force && Math.abs(spent - metered) < 0.0001) return;
    metered = spent;
    queue.push({ type: 'usage-delta', spentUsd: Math.round(spent * 1e6) / 1e6, model: modelId, ...(subCost > 0 ? { subRunUsd: Math.round(subCost * 1e6) / 1e6 } : {}), ...holdView() });
  };
  const overCap = (what: string) => {
    const m = usageCost();
    if (asks && hold && m + subCost <= dayLeft) {
      if (askState === 'none' && gov.observe(hold, m) === 'ask') {
        askState = 'pending';
        log({ event: 'cost', code: 'spend_over_hold', costUsd: m, detail: what });
      }
      return;
    }
    const scope = m > capUsd ? (capUsd < msgCapUsd ? 'day' : 'message') : m + subCost > dayLeft ? 'day' : null;
    if (!scope) return;
    log({ event: 'cost', code: 'cost_cap', costUsd: m + subCost, detail: what });
    errorCode = 'cost_cap';
    fail({ type: 'error', code: 'budget_exceeded', message: scope === 'message' ? `Stopped at this message's cost limit ($${capUsd.toFixed(2)}) before it finished.` : `Stopped at the assistant's limit for today before it finished.`, retryable: false, details: offer(scope) });
  };
  const waitPlan = async (plan: ChatPlan): Promise<PlanAnswer | null> => {
    if (o.planAnswer) return { answer: o.planAnswer };
    if (!asks) return null;
    planWaiting = true;
    const tw = Date.now();
    try {
      return await waitForPlan(plan.id, { timeoutMs: askTimeoutMs, signal: ac.signal });
    } finally {
      planWaiting = false;
      deadline += Date.now() - tw;
    }
  };
  const toolCtx: ChatToolCtx = {
    host,
    input: { ...input, model },
    emit: (s) => queue.push(s),
    state,
    signal: ac.signal,
    extend: (ms) => progress(ms),
    persona,
    route,
    gov,
    waitPlan,
    budgetLeft: () => capUsd - usageCost(),
    dayLeft: () => dayLeft - usageCost() - subCost,
    spend: (usd, what) => {
      if (!(usd > 0)) return;
      subCost += usd;
      meter();
      overCap(what);
    },
  };
  const server = buildChatMcpServer(toolCtx, personaForTools);
  const allowedTools = chatAllowedToolsFor(personaForTools);
  const allow = new Set(allowedTools);
  const guard = (tool: string, where: string): 'allow' | 'abort' | 'unknown' => {
    if (allow.has(tool)) return 'allow';
    if (isRealTool(tool)) {
      log({ event: 'denied', tool, code: where });
      fail({ type: 'error', code: 'internal', message: `Stopped: the assistant tried a tool outside the chat allowlist (${tool}). Nothing was changed.`, retryable: false });
      return 'abort';
    }
    log({ event: 'denied', tool, code: `unknown_tool_name:${where}` });
    return 'unknown';
  };
  const WRAP_UP = 'The user asked you to stop here: answer from what you have and say what is left.';
  const raiseHand = async (): Promise<'go' | 'wrap' | 'stop'> => {
    if (!hold) return 'go';
    askState = 'waiting';
    const asked = await gov.ask(hold, { pctDone: null });
    queue.push({ type: 'spend-ask', holdId: hold.id, question: asked.question, spentUsd: Math.round(usageCost() * 1e6) / 1e6, heldUsd: hold.heldUsd, moreUsd: asked.moreUsd });
    meter(true);
    log({ event: 'cost', code: 'spend_ask', costUsd: usageCost() });
    const tw = Date.now();
    const a = await waitForAnswer(hold.id, { timeoutMs: askTimeoutMs, signal: ac.signal });
    deadline += Date.now() - tw;
    const fresh = await gov.store.getHold(hold.id).catch(() => null);
    if (fresh) Object.assign(hold, { heldUsd: fresh.heldUsd, state: fresh.state, answerUsd: fresh.answerUsd, answeredAt: fresh.answeredAt });
    if (a?.kind === 'approve') {
      if (!fresh) hold.heldUsd = Math.round((hold.heldUsd + a.usd) * 1e6) / 1e6;
      askState = 'none';
      meter(true);
      return 'go';
    }
    if (a?.kind === 'today') {
      askState = 'today';
      meter(true);
      return 'go';
    }
    if (a?.kind === 'deny') {
      askState = 'wrap';
      meter(true);
      return 'wrap';
    }
    errorCode = 'cost_cap';
    fail({ type: 'error', code: 'budget_exceeded', message: `Stopped at this message's cost limit ($${hold.heldUsd.toFixed(2)}) before it finished.`, retryable: false, details: offer('message') });
    return 'stop';
  };
  const preToolUse: HookCallback = async (h) => {
    if (h.hook_event_name !== 'PreToolUse') return {};
    progress();
    const g = guard(h.tool_name, 'pre_tool_use');
    if (g === 'allow' && (askState === 'pending' || askState === 'wrap')) {
      const d = askState === 'wrap' ? 'wrap' : await raiseHand();
      if (d === 'wrap') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: WRAP_UP } };
      if (d === 'stop') return { continue: false, stopReason: 'spend ask unanswered', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'stopped at the cost limit' } };
    }
    if (g === 'allow') {
      log({ event: 'tool', tool: h.tool_name });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
    }
    const deny = { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'not on the chat allowlist' };
    return g === 'abort' ? { continue: false, stopReason: 'disallowed tool', hookSpecificOutput: deny } : { hookSpecificOutput: deny };
  };
  const canUseTool: CanUseTool = async (name) => {
    const g = guard(name, 'can_use_tool');
    if (g !== 'allow') return { behavior: 'deny', message: 'not on the chat allowlist', interrupt: g === 'abort' };
    return { behavior: 'allow' };
  };

  const gateway = o.gateway ?? (o.queryFn ? { env: {} } : claudeGatewayConfig());
  if (!o.queryFn) fs.mkdirSync(cwd, { recursive: true });
  let stderrTail = '';
  const options: Options = {
    model: modelId,
    effort: o.effort ?? (route.intent === 'research' ? 'medium' : 'low'),
    tools: [],
    mcpServers: { [CHAT_SERVER_NAME]: server },
    strictMcpConfig: true,
    allowedTools,
    permissionMode: 'dontAsk',
    canUseTool,
    // the PreToolUse hook may wait for a spend answer: its timeout covers the ask's wait
    hooks: { PreToolUse: [{ hooks: [preToolUse], ...(asks ? { timeout: Math.ceil(askTimeoutMs / 1000) + 60 } : {}) }] },
    settingSources: o.settingSources ?? ['user'],
    skills: [],
    persistSession: sessionsOn,
    ...(resumeId ? { resume: resumeId } : sessionId ? { sessionId } : {}),
    includePartialMessages: true,
    maxTurns: budget.maxTurns,
    maxBudgetUsd: asks && hold ? Math.max(capUsd, dayLeft) : capUsd,
    systemPrompt,
    env: o.env ?? scannerEnv(gateway.env, process.env, { CLAUDE_AGENT_SDK_CLIENT_APP: 'command-center-chat/2' }),
    ...(gateway.apiKeyHelper ? { settings: { apiKeyHelper: gateway.apiKeyHelper } } : {}),
    cwd,
    pathToClaudeCodeExecutable: o.pathToClaudeCodeExecutable ?? defaultClaudeExecutable(),
    abortController: ac,
    stderr: (d: string) => {
      stderrTail = (stderrTail + d).slice(-4000);
    },
  };

  // ---- usage accounting
  const usageByMsg = new Map<string, { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }>();
  const final = { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, turns: 0, fromResult: false };
  const estimate = () => [...usageByMsg.values()].reduce((a, u) => ({ cost: a.cost + u.cost, input: a.input + u.input, output: a.output + u.output, cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite }), { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

  const streamed = new Set<string>();
  let curStreamMsg: string | null = null;
  let lastTextMsg: string | null = null;
  let textSoFar = '';
  let seenSession: string | null = null;
  const pushText = (msgId: string, t: string) => {
    if (!t) return;
    if (lastTextMsg && lastTextMsg !== msgId && textSoFar && !textSoFar.endsWith('\n')) {
      queue.push({ type: 'text', text: '\n\n' });
      textSoFar += '\n\n';
    }
    lastTextMsg = msgId;
    textSoFar += t;
    queue.push({ type: 'text', text: t });
  };

  let modelDone = false;
  const followScans = async () => {
    const seen = new Map<string, string>();
    let until = Number.POSITIVE_INFINITY;
    for (;;) {
      if (ac.signal.aborted && stop) return;
      if (input.signal.aborted) return;
      const pending = [...state.scans.values()].filter((s) => !s.done);
      if (modelDone) {
        if (!pending.length) return;
        if (until === Number.POSITIVE_INFINITY) until = Date.now() + (o.scanFollowMs ?? 15_000);
        if (Date.now() >= until) return;
      }
      for (const s of pending) {
        try {
          const cur = await host.scanStatus(s.id);
          if (!cur) continue;
          const key = `${cur.status}|${cur.itemsSeen}|${cur.itemsNew}|${cur.itemsChanged}`;
          if (seen.get(s.id) !== key) {
            seen.set(s.id, key);
            if (key !== `${s.status}|${s.itemsSeen}|${s.itemsNew}|${s.itemsChanged}`) {
              state.scans.set(cur.id, cur);
              const row = state.scanRows.get(cur.id);
              if (row) {
                queue.push({ type: 'tool-progress', id: row, ...scanProgress(cur) });
                if (cur.done) {
                  queue.push({ type: 'tool-result', id: row, summary: cur.summary, ok: cur.status === 'ok' || cur.status === 'partial', result: JSON.stringify({ scanId: cur.id, status: cur.status, itemsSeen: cur.itemsSeen, itemsNew: cur.itemsNew, itemsChanged: cur.itemsChanged }) });
                  state.scanRows.delete(cur.id);
                }
              }
              log({ event: 'scan', code: cur.status });
            }
          }
        } catch {
          /* a failed poll is retried next tick */
        }
      }
      await sleep(o.scanPollMs ?? 1500, modelDone ? input.signal : undefined);
    }
  };

  const watchdog = setInterval(() => {
    if (askState === 'waiting' || planWaiting) return; // paused while the user decides
    if (Date.now() > deadline) fail({ type: 'error', code: 'upstream_unavailable', message: `The assistant made no progress for ${Math.round(baseMs / 1000)} s and was stopped.`, retryable: true });
  }, Math.min(1000, Math.max(10, Math.floor(baseMs / 4))));
  log({ event: 'start', detail: `model=${modelId} tier=${route.tier} intent=${route.intent} resume=${resumeId ? 'yes' : 'no'} cap=$${capUsd.toFixed(4)}` });
  const q = (o.queryFn ?? (sdkQuery as unknown as ChatQueryFn))({ prompt, options });
  let errorCode: string | undefined;

  const pump = (async () => {
    const follower = followScans();
    try {
      for await (const msg of q) {
        progress();
        const sid = (msg as { session_id?: string }).session_id;
        if (sid) seenSession = sid;
        if (msg.type === 'stream_event') {
          const ev = msg.event as { type: string; message?: { id?: string }; delta?: { type: string; text?: string } };
          if (ev.type === 'message_start') curStreamMsg = ev.message?.id ?? `stream-${streamed.size}`;
          else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text && msg.parent_tool_use_id == null) {
            const id = curStreamMsg ?? 'stream';
            streamed.add(id);
            pushText(id, ev.delta.text);
          }
        } else if (msg.type === 'assistant') {
          const m = msg.message as unknown as { id?: string; model?: string; content?: Array<{ type: string; name?: string; text?: string }>; usage?: Record<string, number | null> };
          const mid = m.id ?? `anon-${usageByMsg.size}`;
          for (const b of m.content ?? []) {
            if (b.type === 'tool_use' && b.name) guard(b.name, 'assistant_tool_use');
            else if (b.type === 'text' && b.text && !streamed.has(mid) && msg.parent_tool_use_id == null) pushText(mid, b.text);
          }
          const errCode = (msg as { error?: string }).error;
          if (errCode) fail({ type: 'error', code: 'upstream_unavailable', message: errCode === 'authentication_failed' ? 'The LLM gateway rejected the key (re-auth the gateway)' : `The model returned an error (${errCode})`, retryable: errCode !== 'authentication_failed' });
          if (m.usage) {
            const u = m.usage;
            usageByMsg.set(mid, { cost: estimateCallCostUsd(m.model ?? modelId, u), input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 });
            meter();
            overCap('model');
          }
        } else if (msg.type === 'result') {
          final.fromResult = true;
          final.costUsd = msg.total_cost_usd ?? 0;
          final.turns = msg.num_turns ?? 0;
          const mu = Object.values(msg.modelUsage ?? {});
          if (mu.length) {
            final.inputTokens = mu.reduce((a, u) => a + u.inputTokens, 0);
            final.outputTokens = mu.reduce((a, u) => a + u.outputTokens, 0);
            final.cacheRead = mu.reduce((a, u) => a + u.cacheReadInputTokens, 0);
            final.cacheWrite = mu.reduce((a, u) => a + u.cacheCreationInputTokens, 0);
          } else {
            const u = msg.usage as unknown as Record<string, number | undefined>;
            final.inputTokens = u?.input_tokens ?? 0;
            final.outputTokens = u?.output_tokens ?? 0;
            final.cacheRead = u?.cache_read_input_tokens ?? 0;
            final.cacheWrite = u?.cache_creation_input_tokens ?? 0;
          }
          for (const d of msg.permission_denials ?? []) guard(d.tool_name, 'permission_denial');
          if (msg.subtype === 'success') {
            if (msg.is_error) {
              const c = classifyError(msg.result);
              errorCode = c.code;
              fail({ type: 'error', code: 'upstream_unavailable', message: c.errorClass === 'auth' ? 'The LLM gateway rejected the request (auth). Check the gateway / apiKeyHelper.' : `The model call failed (${c.code}).`, retryable: c.errorClass !== 'auth' });
            }
          } else if (msg.subtype === 'error_max_budget_usd') {
            errorCode = 'cost_cap';
            fail({ type: 'error', code: 'budget_exceeded', message: `Stopped at the assistant's limit for today before it finished.`, retryable: false, details: offer(capUsd < msgCapUsd ? 'day' : 'message') });
          } else if (msg.subtype === 'error_max_turns') {
            errorCode = 'max_turns';
            fail({ type: 'error', code: 'internal', message: stepLimitMessage(budget.maxTurns), retryable: true, details: { catalogCode: STEP_LIMIT_CODE } });
          } else {
            const text = (msg.errors ?? []).join(' | ') || stderrTail;
            const c = classifyError(text);
            errorCode = c.code;
            fail({ type: 'error', code: 'upstream_unavailable', message: `The assistant failed (${c.code}).`, retryable: true });
          }
          log({ event: 'result', code: msg.subtype, costUsd: final.costUsd });
        }
      }
    } catch (err) {
      if (!stop && !input.signal.aborted) {
        const c = classifyError(`${errorText(err)} ${stderrTail}`);
        errorCode = c.code;
        const message = c.code === 'executable_missing' ? 'The Claude CLI was not found (set CC_CLAUDE_BIN).' : c.errorClass === 'auth' ? 'The LLM gateway rejected the request (auth).' : `The assistant is unavailable (${c.code}).`;
        fail({ type: 'error', code: 'upstream_unavailable', message, retryable: c.errorClass !== 'auth' && c.errorClass !== 'config' });
      }
    } finally {
      modelDone = true;
      clearInterval(watchdog);
      try {
        q.close?.();
      } catch {
        /* already closed */
      }
      await follower.catch(() => undefined);
      if (!input.signal.aborted) {
        for (const [scanId, row] of state.scanRows) {
          const s = state.scans.get(scanId);
          queue.push({ type: 'tool-result', id: row, summary: `${s?.summary ?? 'Scan queued'}; it continues in the background (Health)`, ok: true, result: JSON.stringify({ scanId, status: s?.status ?? 'queued' }) });
        }
        state.scanRows.clear();
      }
      // the session: kept for the next message; a resume that failed before any answer is dropped (the next one rebuilds)
      if (sessionsOn && host.memory) {
        const failedResume = !!resumeId && !!stop && !textSoFar && (stop as ErrorStep).code !== 'budget_exceeded';
        const keep = failedResume ? null : (seenSession ?? sessionId);
        await host.memory.setSession(input.threadId, keep).catch(() => undefined);
        log({ event: 'session', code: failedResume ? 'dropped' : resumeId ? 'resumed' : 'started' });
      }
      const e = estimate();
      const usage: ChatUsageRecord = {
        threadId: input.threadId,
        messageId: input.messageId,
        model: modelId,
        inputTokens: final.fromResult ? final.inputTokens : e.input,
        outputTokens: final.fromResult ? final.outputTokens : e.output,
        cacheReadTokens: final.fromResult ? final.cacheRead : e.cacheRead,
        cacheWriteTokens: final.fromResult ? final.cacheWrite : e.cacheWrite,
        costUsd: final.fromResult && final.costUsd > 0 ? final.costUsd : e.cost,
        estimated: !(final.fromResult && final.costUsd > 0),
        status: stop ? ((stop as ErrorStep).code === 'budget_exceeded' ? 'budget_blocked' : 'error') : input.signal.aborted ? 'error' : 'ok',
        ...(errorCode ? { errorCode } : input.signal.aborted ? { errorCode: 'aborted' } : {}),
        latencyMs: Date.now() - started,
        skill: skillTag,
      };
      try {
        await host.recordUsage(usage);
      } catch (err) {
        log({ event: 'error', code: 'record_usage', detail: safeLogText(errorText(err), 160) });
      }
      if (hold) {
        if (!hold.callIds.includes(input.messageId)) hold.callIds.push(input.messageId);
        await gov.settle(hold, usage.costUsd).catch((err: unknown) => log({ event: 'error', code: 'spend_settle', detail: safeLogText(errorText(err), 160) }));
      }
      if (!input.signal.aborted) {
        queue.push({
          type: 'usage',
          usage: {
            model: modelId,
            inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
            outputTokens: usage.outputTokens,
            costUsd: Math.round((usage.costUsd + subCost) * 1e6) / 1e6,
            turns: final.turns,
            tier: CHAT_MODEL_TIER[model],
            steps: state.steps,
            resumed: !!resumeId,
            ...(summarizedTurns > 0 ? { summarizedTurns } : {}),
            ...(subCost > 0 ? { subRunUsd: Math.round(subCost * 1e6) / 1e6 } : {}),
            ...(continuedFromUsd !== undefined ? { continuedFromUsd } : {}),
          },
        });
        if (stop) queue.push(stop);
      }
      input.signal.removeEventListener('abort', onUserAbort);
      queue.close();
    }
  })();

  try {
    for (;;) {
      const r = await queue.next();
      if (r.done) break;
      yield r.value;
    }
  } finally {
    if (!ac.signal.aborted) ac.abort();
    await pump.catch(() => undefined);
  }
}
