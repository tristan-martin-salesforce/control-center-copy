// The runner's options, result types, limits and trace helpers. Split from skill-runner.ts (max-lines); skill-runner.ts re-exports the public names.
import {
  BUILTIN_TOOL_NAMES, type EffortLevel, type Options, type SDKMessage, type SettingSource,
} from '@/llm/provider';
import type { CoverageObject, SkillRunInput, TimeWindow } from '../scanner/types';
import type { ScanSkillRunResult } from '../scanner/runtime/contract-ext';
import type { CcRunState } from './cc-tools';
import type { TriageConfig } from '../scanner/triage/slack-triage';
import { bareToolName } from './slack-rec';
import type { GatewayConfig } from './claude-env';
import type { ErrorClass } from './errors';
import { ORG62_ALL_TOOLS, SLACK_ALL_TOOLS } from './mcp-config';
import type { UsageTotals } from './usage';
import { safeLogText } from './redact';
import type { SpendGate } from './spend/scan-gate';

/**
 * Prefix tripwire (TRIP-2). The first call's prompt is what we send (common rules + skill + context pack + run block +
 * prefetched payload) plus what we do not see: the SDK system prompt and the tool schemas (cc tools + the restricted MCP
 * server's read tools). Measured on the first live day: Org62 events sent 75.7 K characters and the first call was
 * 43.0 K tokens; a Slack channel sent 68.4 K and was 41.9 K. So the hidden part is about 13-19 K tokens and our text
 * about 2.5-3 characters per token (prose about 3.5, JSON about 2.1). The limit is that allowance plus our prose at 2 and
 * our data at 1.8 characters per token, which leaves 15-20 K tokens of headroom on real prompts (a full 25-email Gmail
 * run was 78.6 K tokens live; its limit is now about 97 K) and still trips when the restricted config fails and every MCP tool loads
 * (tens of thousands of tokens of schemas). Before, a flat 40 K base (plus the payload, G-3) was calibrated on stress
 * databases: a real user's growing list and today's larger skills put Slack channels, Org62 events, Claude sessions and
 * Calendar over it on every run (CTX-1, TRIP-2).
 */
/** ORG-3: the windowed Org62 scopes (SystemModstamp windows paged by LIMIT). */
export const ORG62_WINDOWED = new Set(['opps', 'events', 'dcs']);
export const TOOL_OVERHEAD_TOKENS = 24_000;
/** Prose (common rules + skill) tokenizes at about 3.5 characters per token, JSON data (pack, payload) at about 2.1. */
const PROSE_CHARS_PER_TOKEN = 2;
const DATA_CHARS_PER_TOKEN = 1.8;
/**
 * COST-2: the prompt guard stops a run when its next request is estimated within this many tokens of the model's
 * long-prompt threshold (the estimate counts unsent tool output at 2.5 characters per token, so it errs early).
 */
export const PROMPT_GUARD_MARGIN_TOKENS = 1_500;
/** Tool schemas in the context (getContextUsage rows), for `tool_schema_tokens`. */
export const TOOL_ROWS = new Set(['system_tools', 'mcp_tools']);
export function prefixTripwireLimit(sent: { proseChars: number; dataChars: number }, overheadTokens = TOOL_OVERHEAD_TOKENS): number {
  return overheadTokens + Math.ceil(sent.proseChars / PROSE_CHARS_PER_TOKEN + sent.dataChars / DATA_CHARS_PER_TOKEN);
}
/** SkillRunInput plus what the runtime knows about the step. All extra fields are optional. */
export interface ScanSkillRunInput extends SkillRunInput {
  window?: TimeWindow;
  /** incremental | head | backfill | continuation | reconcile | relink | targeted */
  mode?: string;
  /** Extra Run-block substitutions (channel id, thread ref, opp ids…). */
  vars?: Record<string, string | number | boolean | undefined>;
  /** Free-form step instruction appended to the user prompt (e.g. which unlinked items to relink). */
  instruction?: string;
  effort?: EffortLevel;
  /**
   * Deterministic sources: coverage the fetcher already established. The runner stages it on the run
   * (and in the cc state, so `cc_finish` validates against it); the agent does not report it again.
   */
  preReportedCoverage?: CoverageObject[];
  /** REC-1: record every message the Slack read tools return (src/llm/slack-rec.ts). */
  autoRecord?: 'slack' | 'org62';
  /** After a successful traversal: the Slack triage pass (+ escalation of unsure verdicts). */
  triage?: TriageConfig;
  /** Internal: this run is a post-traversal pass on the parent's run (no recording, no coverage, no cc_finish). */
  pass?: 'triage' | 'escalate';
  /** The spend governor's hold for this run (tick after every request, ask past it). Absent: the old hard cap. */
  spend?: SpendGate;
}
/** Per-pass accounting of one scan run (traversal, triage batches, escalation batches). */
export interface SkillPassStat {
  pass: 'traversal' | 'triage' | 'escalate';
  model: string;
  runs: number;
  costUsd: number;
  /** Messages that needed a verdict (triage) / were escalated (escalate). */
  messages?: number;
  verdicts?: { act: number; noise: number; unsure: number; missing: number };
  proposed?: number;
  linked?: number;
  /** REC-1 (traversal): messages recorded from tool results / parse failures. */
  autoRecorded?: number;
  recErrors?: number;
  errors?: string[];
}
export type ScanSkillRunResultWithPasses = ScanSkillRunResult & { passes?: SkillPassStat[] };
/** What `getContextUsage({detail:'summary'})` answers that the measurement reads (a fake may leave it out). */
export interface ContextUsageLike {
  categories?: Array<{ id?: string; name?: string; tokens?: number; kind?: string }>;
  totalTokens?: number;
}
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> & { close?: () => void; getContextUsage?: (o?: { detail?: 'summary' | 'full' }) => Promise<ContextUsageLike> };
export interface RunnerLogEvent {
  runId: string;
  event: 'start' | 'init' | 'tool' | 'denied' | 'cost' | 'result' | 'error';
  tool?: string;
  code?: string;
  detail?: string;
  costUsd?: number;
}
export interface AgentSdkSkillRunnerOptions {
  repoRoot?: string;
  queryFn?: QueryFn;
  pathToClaudeCodeExecutable?: string;
  cwd?: string;
  env?: Record<string, string>;
  effort?: EffortLevel;
  settingSources?: SettingSource[];
  /** Watchdog per run (ms). Default 180 s. */
  timeoutMs?: number;
  /** Tool-schema + SDK allowance of the prefix tripwire, added to the size of what is sent (TRIP-2). Default TOOL_OVERHEAD_TOKENS. */
  prefixTripwireTokens?: number;
  logger?: (e: RunnerLogEvent) => void;
  /** Gateway env + apiKeyHelper (default: read from ~/.claude/settings.json; see claude-env.ts). */
  gateway?: GatewayConfig;
  /** COST-2: hand the model a compact digest of recorded read results. Default on; `CC_TOOL_DIGEST=0` turns it off. */
  toolDigest?: boolean;
  /** COST-2: stop before a request passes the long-prompt tier. Default on; `CC_PROMPT_GUARD=0` turns it off. */
  promptGuard?: boolean;
}
export interface ErrorState {
  message: string;
  errorClass: ErrorClass;
  disallowedTool?: string;
  code: string;
}
/** What the run did with a message, for the trace (`proposed:<wi>:<kind>`, `origin:<wi>`, `flagged`; context links left out). */
export function actedOn(state: CcRunState, sourceItemId: string): string[] {
  return (state.outcomes.get(sourceItemId) ?? []).filter((d) => !d.startsWith('context:')).slice(0, 6);
}
/** A tool call's arguments for the trace: Slack and Org62 queries and ids; cc tools by their ids only (no titles or reasons). */
export function traceArgs(tool: string, input: unknown): Record<string, unknown> {
  const a = (input ?? {}) as Record<string, unknown>;
  const bare = bareToolName(tool);
  const out: Record<string, unknown> = {};
  if (bare.startsWith('cc_')) {
    for (const k of ['workItemId', 'sourceItemId', 'role', 'confidence', 'kind', 'initiativeId']) if (typeof a[k] === 'string') out[k] = a[k];
    for (const k of ['items', 'evidence', 'verdicts', 'windows', 'objects']) if (Array.isArray(a[k])) out[`${k}N`] = (a[k] as unknown[]).length;
    if (bare === 'cc_finish') out.complete = a.complete ?? null;
    return out;
  }
  for (const k of ['query', 'filters', 'keywords', 'channel_types', 'only_my_channels', 'q', 'channel_id', 'message_ts', 'limit', 'response_format', 'sort', 'oldest', 'latest', 'user_id', 'file_id', 'canvas_id']) if (a[k] !== undefined) out[k] = a[k];
  if (a.cursor !== undefined) out.page = a.cursor ? 'next' : 'first';
  return out;
}
/** Result size and, when the result is a JSON record list (SOQL), its row count and whether more pages remain. */
export function traceResult(content: unknown): { size: number; count?: number; more?: boolean } {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n');
  else if (content !== undefined) text = JSON.stringify(content) ?? '';
  const out: { size: number; count?: number; more?: boolean } = { size: text.length };
  const t = text.trim();
  if (t.startsWith('{') && t.length < 2_000_000) {
    try {
      const j = JSON.parse(t) as { records?: unknown[]; done?: boolean; messages?: unknown[] };
      if (Array.isArray(j.records)) out.count = j.records.length;
      else if (Array.isArray(j.messages)) out.count = j.messages.length;
      if (j.done === false) out.more = true;
    } catch {
      /* not JSON */
    }
  }
  return out;
}
/** A tool error for the trace: a code-sized, redacted head of the error text. */
export function traceError(content: unknown): string {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string })?.text ?? '').join(' ') : JSON.stringify(content ?? '');
  return safeLogText(text, 120);
}
const BUILTINS = new Set<string>(BUILTIN_TOOL_NAMES as readonly string[]);
const KNOWN_BARE = new Set<string>([...SLACK_ALL_TOOLS, ...ORG62_ALL_TOOLS]);
/** Any MCP tool, any Claude Code built-in, or a known server tool by its bare name. */
export function isRealTool(name: string): boolean {
  return name.startsWith('mcp__') || BUILTINS.has(name) || KNOWN_BARE.has(name);
}
export const EMPTY_ROW = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
/** D0: a run's tokens, split (uncached input / output / cache read / cache write) and per model. */
export function setUsage(r: ScanSkillRunResult, u: UsageTotals): void {
  r.inputTokens = u.inputTokens;
  r.outputTokens = u.outputTokens;
  r.cacheReadTokens = u.cacheReadTokens;
  r.cacheWriteTokens = u.cacheWriteTokens;
  r.usage = u.byModel;
}
/** The triage skill key (`skills/triage-slack.md` → `triage-slack`). */
export function triageSkillKeyOf(cfg: TriageConfig): string {
  return cfg.skillPath.replace(/^.*\//, '').replace(/\.md$/, '');
}
