/**
 * The diagnose agent (D-56): ONE Agent SDK `query()` per report, on the read-in agent's pattern
 * (src/llm/readin/agent.ts, `SdkResearchAgent`), with code reading added:
 *
 *  - Built-ins: Read, Grep and Glob only (`tools`), so there is no shell, no write, no edit, no web. The repo folder
 *    is the working directory, and a path gate keeps every path inside it and out of private and secret folders
 *    (docs/research, .env*, .git, tools/, …). Grep and Glob search under an allowed root (default `src`).
 *  - One in-process server, `cc_feedback`: read-only views of the app state (event log, jobs, connector health, scan
 *    runs, the item trace, the page and entity payloads), each scrubbed before the model sees it, and `feedback_finish`.
 *  - Exact allowlist, checked in a PreToolUse hook (it runs for every call, built-ins included), the `canUseTool` gate,
 *    a scan of assistant `tool_use` blocks and the result's `permission_denials`. A disallowed tool aborts the run.
 *  - Budget: `maxTurns`, SDK `maxBudgetUsd` and a running estimate that aborts at the cap ($0.40, on the Assistant's
 *    spend line), plus a watchdog and the caller's AbortSignal. With a spend gate (caps audit 26 F-4: the governor's
 *    hold, src/llm/spend) the estimate is reported instead: past the hold the run raises a hand at the next tool call
 *    (Health ▸ Spend) and waits there for the answer, as the Assistant does (the query stays alive, nothing is paid
 *    twice): Allow continues, Stop or no answer ends it and the app's own reading is the report. The cap and turns are
 *    then the runaway guard; the day line left stays a line. Clean env (scannerEnv) and the user's gateway config.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  createSdkMcpServer,
  agentQuery as sdkQuery,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  tool,
  type CanUseTool,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
} from '@/llm/provider';
import { z } from 'zod';

import { FeedbackConfidence } from '@/contract';
import { claudeGatewayConfig, scannerEnv, type GatewayConfig } from '@/llm/claude-env';
import { defaultClaudeExecutable } from '@/llm/env';
import { classifyError, errorText } from '@/llm/errors';
import { assertReadOnly } from '@/llm/mcp-config';
import { estimateCallCostUsd } from '@/llm/models';
import { READIN_MODEL } from '@/llm/readin/prompt';
import { safeLogText } from '@/llm/redact';
import { isRealTool } from '@/llm/skill-runner';
import { PAUSED_FOR_SPEND, RUNAWAY_TURNS, waitForAnswer, type SpendGate } from '@/llm/spend';

import { capJson, type FeedbackReads } from './reads';

export const FEEDBACK_SKILL = 'skills/feedback-diagnose.md';
export const FEEDBACK_SERVER = 'cc_feedback';
export const FEEDBACK_MODEL = READIN_MODEL;
/** Per report, on the Assistant's spend line. */
export const FEEDBACK_CAP_USD = 0.4;
export const FEEDBACK_MAX_TURNS = 14;
export const FEEDBACK_TIMEOUT_MS = 150_000;
/** How long a diagnose run waits at its spend ask for the answer (the watchdog stops while it waits). */
export const FEEDBACK_ASK_WAIT_MS = 60_000;

/** The only built-ins the run loads. */
export const CODE_TOOLS = ['Read', 'Grep', 'Glob'] as const;
/** Built-ins named in `disallowedTools` as well (belt and braces: they are not loaded either). */
export const DENIED_BUILTINS = ['Bash', 'BashOutput', 'KillShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'ExitPlanMode', 'SlashCommand', 'Skill'] as const;

export const FEEDBACK_TOOL_NAMES = ['feedback_event_log', 'feedback_jobs', 'feedback_health', 'feedback_scans', 'feedback_trace', 'feedback_page', 'feedback_entity', 'feedback_finish'] as const;
type FeedbackToolName = (typeof FEEDBACK_TOOL_NAMES)[number];
export const feedbackToolName = (bare: string) => `mcp__${FEEDBACK_SERVER}__${bare}`;
export const FEEDBACK_ALLOWED_TOOLS: readonly string[] = Object.freeze([...CODE_TOOLS, ...FEEDBACK_TOOL_NAMES.map(feedbackToolName)]);

// ---------------------------------------------------------------------------
// The repo path gate
// ---------------------------------------------------------------------------

/** Where Grep and Glob may search, and what Read may open (repo-relative). */
export const CODE_ROOTS = ['src', 'app', 'tests', 'scripts', 'skills', 'config', 'docs'] as const;
export const CODE_ROOT_FILES = ['package.json', 'CLAUDE.md', 'README.md', 'CHANGELOG.md', 'tsconfig.json', 'next.config.ts', 'next.config.mjs', 'drizzle.config.ts', 'vitest.config.ts', 'eslint.config.mjs'] as const;
/** Never read or searched: private data (git-ignored), secrets, build output, other worktrees. */
export const DENIED_PATHS = ['docs/research', 'docs/q3-catchup', 'docs/dc-sweep', 'fixtures/private', 'tools', '.git', '.claude', '.next', 'node_modules', '.shots', 'coverage', 'test-results', 'playwright-report', 'public/fonts', 'public/icons'] as const;
const SECRET_FILE = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_[a-z0-9]+|\.npmrc|\.netrc)$/i;

export type CodeAccess = { ok: true; input: Record<string, unknown> } | { ok: false; reason: string };

const realish = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Repo-relative, POSIX, or null when the path leaves the repo (symlinks resolved). */
export function repoRelative(repoRoot: string, p: string): string | null {
  const root = realish(repoRoot);
  const abs = realish(path.isAbsolute(p) ? p : path.join(root, p));
  const rel = path.relative(root, abs);
  if (rel === '') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

const under = (rel: string, dir: string) => rel === dir || rel.startsWith(`${dir}/`);

/** Read: one file inside an allowed root (or an allowed root file). Grep / Glob: a folder that holds nothing denied. */
export function checkCodeAccess(repoRoot: string, toolName: string, input: Record<string, unknown>): CodeAccess {
  const isSearch = toolName === 'Grep' || toolName === 'Glob';
  if (!isSearch && toolName !== 'Read') return { ok: false, reason: `${toolName} is not a code-reading tool` };
  const raw = toolName === 'Read' ? input.file_path : (input.path ?? 'src');
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: toolName === 'Read' ? 'Read needs file_path' : 'path must be a folder name' };
  const rel = repoRelative(repoRoot, raw.trim());
  if (rel === null) return { ok: false, reason: 'outside the repo folder' };
  if (SECRET_FILE.test(rel)) return { ok: false, reason: 'secret files are never read' };
  if (DENIED_PATHS.some((d) => under(rel, d))) return { ok: false, reason: 'private or generated folder' };
  const inRoot = CODE_ROOTS.some((r) => under(rel, r)) || (CODE_ROOT_FILES as readonly string[]).includes(rel);
  if (!inRoot) return { ok: false, reason: `search or read under ${CODE_ROOTS.join(', ')} (or a root config file)` };
  // A folder that contains a denied one (docs → docs/research) would be searched through: name a narrower folder.
  if (isSearch && DENIED_PATHS.some((d) => d.startsWith(`${rel}/`))) return { ok: false, reason: `${rel} holds private folders; search a folder inside it (docs/ui, a file)` };
  if (isSearch && typeof input.glob === 'string' && /(^|\/)\.\.(\/|$)/.test(input.glob)) return { ok: false, reason: 'glob may not climb out of the folder' };
  if (toolName === 'Glob' && typeof input.pattern === 'string' && (/(^|\/)\.\.(\/|$)/.test(input.pattern) || path.isAbsolute(input.pattern))) return { ok: false, reason: 'pattern must be relative to the folder' };
  const abs = path.join(realish(repoRoot), rel);
  return { ok: true, input: toolName === 'Read' ? { ...input, file_path: abs } : { ...input, path: abs } };
}

// ---------------------------------------------------------------------------
// The in-process tools
// ---------------------------------------------------------------------------

export const FINISH_SHAPE = {
  title: z.string().trim().min(3).max(120),
  summary: z.string().trim().min(10).max(2000),
  steps: z.array(z.string().trim().min(2).max(300)).max(12),
  expected: z.string().max(800),
  actual: z.string().max(800),
  diagnosis: z.object({
    cause: z.string().max(1200),
    files: z.array(z.string().trim().min(2).max(200)).max(8),
    confidence: FeedbackConfidence,
  }),
};
export const FinishOutput = z.object(FINISH_SHAPE);
export type FinishOutput = z.infer<typeof FinishOutput>;

export interface FeedbackAgentState {
  output: FinishOutput | null;
  calls: string[];
}

export type ToolResult = { text: string; isError?: boolean };

/** The handlers behind `cc_feedback`: reads (already scrubbed by `reads`) and the finish call. */
export function createFeedbackTools(reads: FeedbackReads, st: FeedbackAgentState, repoRoot: string, o: { codeTools?: boolean } = {}): Record<FeedbackToolName, (args: unknown) => Promise<ToolResult>> {
  const r = (fn: () => Promise<unknown>) => async () => ({ text: capJson(await fn()) });
  return {
    feedback_event_log: r(reads.eventLog),
    feedback_jobs: r(reads.jobs),
    feedback_health: r(reads.health),
    feedback_scans: r(reads.scans),
    feedback_trace: r(reads.trace),
    feedback_page: r(reads.page),
    feedback_entity: r(reads.entity),
    feedback_finish: async (args) => {
      const p = FinishOutput.safeParse(args);
      if (!p.success) return { text: `Invalid report; fix these and call feedback_finish again:\n${p.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`, isError: true };
      // PKG-8: a packaged build has no source tree, so there is no file to name
      if (o.codeTools === false) {
        st.output = { ...p.data, diagnosis: { ...p.data.diagnosis, files: [] } };
        return { text: 'Recorded. You are done; stop now.' };
      }
      const bad = p.data.diagnosis.files.filter((f) => {
        const a = checkCodeAccess(repoRoot, 'Read', { file_path: f.replace(/\/$/, '') });
        return !a.ok || !fs.existsSync(a.input.file_path as string);
      });
      if (bad.length) return { text: `These files are not in the repo (name only files a tool showed you, repo-relative):\n${bad.slice(0, 5).join('\n')}`, isError: true };
      st.output = p.data;
      return { text: 'Recorded. You are done; stop now.' };
    },
  };
}

const DESCRIPTIONS: Record<FeedbackToolName, string> = {
  feedback_event_log: "The app's recent warnings and errors (event log), newest first. Read-only.",
  feedback_jobs: 'Failed, dead and retrying background jobs, with their errors. Read-only.',
  feedback_health: 'Connector health (state, last success, last error), the worker, spend state and dry run. Read-only.',
  feedback_scans: 'The latest scan runs per connector (status, counts, errors). Read-only.',
  feedback_trace: '"Why is this here": the trace of the work item the user was looking at (evidence → source → scan run → verdict). Read-only.',
  feedback_page: 'The payload the current page rendered from (the same answer the page got). Read-only, capped.',
  feedback_entity: 'The entity the user was looking at (work item, draft, meeting, account…). Read-only, capped.',
  feedback_finish: 'Submit the report. Call exactly once, last. Files must be repo-relative paths a tool showed you.',
};

export async function callFeedbackTool(handlers: ReturnType<typeof createFeedbackTools>, st: FeedbackAgentState, name: string, args: unknown): Promise<ToolResult> {
  const h = handlers[name as FeedbackToolName];
  if (!h) return { text: `unknown tool ${name}`, isError: true };
  st.calls.push(name);
  try {
    return await h(args);
  } catch (err) {
    return { text: `error: ${safeLogText(errorText(err), 200)}`, isError: true };
  }
}

export function buildFeedbackServer(handlers: ReturnType<typeof createFeedbackTools>, st: FeedbackAgentState): McpSdkServerConfigWithInstance {
  const tools = FEEDBACK_TOOL_NAMES.map((name) =>
    tool(name, DESCRIPTIONS[name], name === 'feedback_finish' ? FINISH_SHAPE : {}, async (args: unknown) => {
      const r = await callFeedbackTool(handlers, st, name, args);
      return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
    }),
  );
  return createSdkMcpServer({ name: FEEDBACK_SERVER, version: '1.0.0', tools, alwaysLoad: true, timeout: 30_000 });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface FeedbackRunInput {
  runId: string;
  model?: string;
  /** [skill body, BOUNDARY, run block]. */
  systemPrompt: string[];
  prompt: string;
  reads: FeedbackReads;
  repoRoot: string;
  costCapUsd: number;
  /** F-4: the report's spend hold (`costCapUsd` and the turns are then the runaway guard's floor). */
  spend?: SpendGate | null;
  /** With a hold: the user budget left (the Assistant's day line, the hard cap); the run never passes it. */
  userLineUsd?: number;
  signal: AbortSignal;
  /**
   * PKG-8: false when the source tree is not on this machine (a packaged build): the run loads no Read/Grep/Glob and
   * diagnoses from the feedback_* reads only. Default true.
   */
  codeTools?: boolean;
}

export interface FeedbackRunResult {
  ok: boolean;
  output: FinishOutput | null;
  model: string;
  costUsd: number;
  /** Uncached input only (D1): cache reads and writes are their own fields. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  toolCalls: string[];
  latencyMs: number;
  error?: { code: string; message: string; disallowedTool?: string };
}

export type FeedbackQueryFn = (params: { prompt: string; options: Options; state: FeedbackAgentState; handlers: ReturnType<typeof createFeedbackTools> }) => AsyncIterable<SDKMessage> & { close?: () => void };

export interface DiagnoseAgent {
  run(input: FeedbackRunInput): Promise<FeedbackRunResult>;
}

export interface SdkFeedbackAgentOptions {
  queryFn?: FeedbackQueryFn;
  gateway?: GatewayConfig;
  pathToClaudeCodeExecutable?: string;
  timeoutMs?: number;
  logger?: (e: { runId: string; event: string; tool?: string; code?: string; costUsd?: number }) => void;
}

const realQuery: FeedbackQueryFn = ({ prompt, options }) => sdkQuery({ prompt, options }) as ReturnType<FeedbackQueryFn>;

/** The run's SDK options (exported for the guard tests). */
export function feedbackAgentOptions(i: { model: string; systemPrompt: string[]; repoRoot: string; server: McpSdkServerConfigWithInstance; maxTurns: number; costCapUsd: number; canUseTool: CanUseTool; preToolUse: HookCallback; gateway: GatewayConfig; executable: string; abortController: AbortController; stderr?: (d: string) => void; codeTools?: boolean }): Options {
  const code = i.codeTools !== false;
  return {
    model: i.model,
    effort: 'medium',
    tools: code ? [...CODE_TOOLS] : [],
    mcpServers: { [FEEDBACK_SERVER]: i.server },
    strictMcpConfig: true,
    // No bare allowedTools / dontAsk: they would decide before the canUseTool gate (READIN-1).
    disallowedTools: code ? [...DENIED_BUILTINS] : [...DENIED_BUILTINS, ...CODE_TOOLS],
    permissionMode: 'default',
    canUseTool: i.canUseTool,
    hooks: { PreToolUse: [{ hooks: [i.preToolUse] }] },
    settingSources: ['user'],
    skills: [],
    persistSession: false,
    maxTurns: i.maxTurns,
    maxBudgetUsd: i.costCapUsd,
    systemPrompt: i.systemPrompt,
    env: scannerEnv(i.gateway.env),
    ...(i.gateway.apiKeyHelper ? { settings: { apiKeyHelper: i.gateway.apiKeyHelper } } : {}),
    cwd: i.repoRoot,
    additionalDirectories: [],
    pathToClaudeCodeExecutable: i.executable,
    abortController: i.abortController,
    ...(i.stderr ? { stderr: i.stderr } : {}),
  };
}

export class SdkFeedbackAgent implements DiagnoseAgent {
  constructor(private readonly o: SdkFeedbackAgentOptions = {}) {}

  async run(input: FeedbackRunInput): Promise<FeedbackRunResult> {
    const t0 = Date.now();
    const model = input.model ?? FEEDBACK_MODEL;
    const log = (e: { event: string; tool?: string; code?: string; costUsd?: number }) => this.o.logger?.({ runId: input.runId, ...e });
    const st: FeedbackAgentState = { output: null, calls: [] };
    const result: FeedbackRunResult = { ok: false, output: null, model, costUsd: 0, inputTokens: 0, outputTokens: 0, toolCalls: [], latencyMs: 0 };
    assertReadOnly(FEEDBACK_ALLOWED_TOOLS);
    const codeTools = input.codeTools !== false;
    const allow = new Set(codeTools ? FEEDBACK_ALLOWED_TOOLS : FEEDBACK_ALLOWED_TOOLS.filter((t) => !(CODE_TOOLS as readonly string[]).includes(t)));
    const ac = new AbortController();
    let error: FeedbackRunResult['error'];
    const fail = (e: NonNullable<FeedbackRunResult['error']>) => {
      if (!error) error = e;
      if (!ac.signal.aborted) ac.abort();
    };
    const guard = (toolName: string, where: string): 'allow' | 'abort' | 'unknown' => {
      if (allow.has(toolName)) return 'allow';
      if (isRealTool(toolName) || (DENIED_BUILTINS as readonly string[]).includes(toolName)) {
        log({ event: 'denied', tool: toolName, code: where });
        fail({ code: 'disallowed_tool', message: `disallowed tool call: ${toolName}`, disallowedTool: toolName });
        return 'abort';
      }
      return 'unknown';
    };
    const handlers = createFeedbackTools(input.reads, st, input.repoRoot, { codeTools });

    // F-4: past the hold, the next tool call waits for the user's answer (Allow continues; Stop or no answer ends it)
    let overHold = false;
    let extraMs = 0;
    const raiseHand = async (): Promise<boolean> => {
      const gate = input.spend!;
      overHold = false;
      await gate.ask({ pctDone: null }).catch(() => undefined);
      log({ event: 'paused', code: PAUSED_FOR_SPEND });
      const t = Date.now();
      const a = await waitForAnswer(gate.hold.id, { timeoutMs: FEEDBACK_ASK_WAIT_MS, signal: ac.signal });
      extraMs += Date.now() - t;
      if (a?.kind === 'approve' || a?.kind === 'today') {
        if (a.kind === 'approve') gate.hold.heldUsd = Math.round((gate.hold.heldUsd + a.usd) * 1e6) / 1e6;
        gate.hold.state = 'approved';
        gate.hold.answerUsd = a.kind === 'approve' ? a.usd : null;
        return true;
      }
      fail({ code: PAUSED_FOR_SPEND, message: a?.kind === 'deny' ? 'stopped from the spend ask' : 'paused for spend: no answer in time' });
      return false;
    };
    const preToolUse: HookCallback = async (h) => {
      if (h.hook_event_name !== 'PreToolUse') return {};
      const g = guard(h.tool_name, 'pre_tool_use');
      const deny = (reason: string) => ({ hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason });
      if (g === 'abort') return { continue: false, stopReason: 'disallowed tool', hookSpecificOutput: deny('not on the feedback allowlist') };
      if (g === 'unknown') return { hookSpecificOutput: deny('not on the feedback allowlist') };
      if (overHold && input.spend && !(await raiseHand())) return { continue: false, stopReason: 'spend ask', hookSpecificOutput: deny('stopped at the spend estimate') };
      if ((CODE_TOOLS as readonly string[]).includes(h.tool_name)) {
        const a = checkCodeAccess(input.repoRoot, h.tool_name, (h.tool_input ?? {}) as Record<string, unknown>);
        if (!a.ok) {
          log({ event: 'path_denied', tool: h.tool_name });
          return { hookSpecificOutput: deny(a.reason) };
        }
        result.toolCalls.push(h.tool_name);
        return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, updatedInput: a.input } };
      }
      result.toolCalls.push(h.tool_name);
      return {};
    };
    const canUseTool: CanUseTool = async (toolName, toolInput) => {
      const g = guard(toolName, 'can_use_tool');
      if (g !== 'allow') return { behavior: 'deny', message: 'not on the feedback allowlist', interrupt: g === 'abort' };
      if ((CODE_TOOLS as readonly string[]).includes(toolName)) {
        const a = checkCodeAccess(input.repoRoot, toolName, (toolInput ?? {}) as Record<string, unknown>);
        return a.ok ? { behavior: 'allow', updatedInput: a.input } : { behavior: 'deny', message: a.reason };
      }
      return { behavior: 'allow', updatedInput: (toolInput ?? {}) as Record<string, unknown> };
    };

    const onExternalAbort = () => fail({ code: 'cancelled', message: 'aborted by caller' });
    if (input.signal.aborted) onExternalAbort();
    input.signal.addEventListener('abort', onExternalAbort, { once: true });
    const timeoutMs = this.o.timeoutMs ?? FEEDBACK_TIMEOUT_MS;
    // the watchdog does not count the time a spend ask waits for its answer
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) =>
      (watchdog = setTimeout(() => {
        if (extraMs > 0) {
          const more = extraMs;
          extraMs = 0;
          arm(more);
        } else fail({ code: 'timeout', message: `watchdog: diagnose exceeded ${timeoutMs} ms` });
      }, ms));
    arm(timeoutMs);
    let stderrTail = '';
    const options = feedbackAgentOptions({
      model,
      systemPrompt: input.systemPrompt,
      repoRoot: input.repoRoot,
      codeTools,
      server: buildFeedbackServer(handlers, st),
      maxTurns: input.spend ? Math.max(FEEDBACK_MAX_TURNS, RUNAWAY_TURNS) : FEEDBACK_MAX_TURNS,
      costCapUsd: input.spend ? Math.min(input.userLineUsd ?? Number.POSITIVE_INFINITY, Math.max(input.costCapUsd, input.spend.ceilingUsd())) : input.costCapUsd,
      canUseTool,
      preToolUse,
      gateway: this.o.gateway ?? (this.o.queryFn ? { env: {} } : claudeGatewayConfig()),
      executable: this.o.pathToClaudeCodeExecutable ?? defaultClaudeExecutable(),
      abortController: ac,
      stderr: (d) => {
        stderrTail = (stderrTail + d).slice(-4000);
      },
    });

    const usage = new Map<string, number>();
    let sawResult = false;
    log({ event: 'start' });
    const q = (this.o.queryFn ?? realQuery)({ prompt: input.prompt, options, state: st, handlers });
    try {
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          const m = msg.message as unknown as { id?: string; model?: string; content?: Array<{ type: string; name?: string }>; usage?: Record<string, number | null> };
          for (const b of m.content ?? []) if (b.type === 'tool_use' && b.name) guard(b.name, 'assistant_tool_use');
          if (m.usage) {
            usage.set(m.id ?? `anon-${usage.size}`, estimateCallCostUsd(m.model ?? model, m.usage));
            const est = [...usage.values()].reduce((a, c) => a + c, 0);
            if (input.spend) {
              if (input.userLineUsd != null && est > input.userLineUsd) fail({ code: 'cost_cap', message: `the day's budget is reached: est $${est.toFixed(4)} > $${input.userLineUsd.toFixed(4)}` });
              else if (input.spend.observe(est) === 'ask') overHold = true;
            } else if (est > input.costCapUsd) fail({ code: 'cost_cap', message: `cost cap exceeded: est $${est.toFixed(4)} > $${input.costCapUsd}` });
          }
        } else if (msg.type === 'result') {
          sawResult = true;
          result.costUsd = msg.total_cost_usd ?? 0;
          const mu = Object.values(msg.modelUsage ?? {});
          // D1: cache reads and writes are booked apart from uncached input.
          result.inputTokens = mu.reduce((a, u) => a + u.inputTokens, 0);
          result.cacheReadTokens = mu.reduce((a, u) => a + u.cacheReadInputTokens, 0);
          result.cacheWriteTokens = mu.reduce((a, u) => a + u.cacheCreationInputTokens, 0);
          result.outputTokens = mu.reduce((a, u) => a + u.outputTokens, 0);
          for (const d of msg.permission_denials ?? []) if (!(CODE_TOOLS as readonly string[]).includes(d.tool_name)) guard(d.tool_name, 'permission_denial');
          if (msg.subtype === 'error_max_budget_usd') fail({ code: 'cost_cap', message: 'cost cap exceeded (SDK maxBudgetUsd)' });
          else if (msg.subtype === 'error_max_turns' && !st.output) fail({ code: 'max_turns', message: `max_turns (${FEEDBACK_MAX_TURNS}) reached before feedback_finish` });
          else if (msg.subtype === 'success' && msg.is_error) fail({ code: classifyError(msg.result).code, message: safeLogText(msg.result, 300) });
          else if (msg.subtype !== 'success' && msg.subtype !== 'error_max_turns') {
            const text = (msg.errors ?? []).join(' | ') || stderrTail;
            fail({ code: classifyError(text).code, message: safeLogText(text || msg.subtype, 300) });
          }
        }
      }
    } catch (err) {
      if (!error) fail({ code: classifyError(`${errorText(err)} ${stderrTail}`).code, message: safeLogText(errorText(err), 300) });
    } finally {
      clearTimeout(watchdog);
      input.signal.removeEventListener('abort', onExternalAbort);
      try {
        q.close?.();
      } catch {
        /* closed */
      }
    }
    if (!sawResult && !result.costUsd) result.costUsd = [...usage.values()].reduce((a, c) => a + c, 0);
    result.output = st.output;
    result.latencyMs = Date.now() - t0;
    if (error) {
      log({ event: 'error', code: error.code, tool: error.disallowedTool });
      result.error = error;
      return result;
    }
    if (!st.output) {
      result.error = { code: 'invalid_output', message: 'run ended without feedback_finish' };
      return result;
    }
    result.ok = true;
    return result;
  }
}

export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY };
