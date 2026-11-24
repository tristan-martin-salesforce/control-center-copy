// The scanner runtime's deps, scope state and status types, and its timing constants. Split from scanner-runtime.ts (max-lines); scanner-runtime.ts re-exports the public names.
import type {
  ConnectorId, ReevaluateEnqueuer, ScannerStore, ScanTrigger, ScopeKey, SkillRunner, TimeWindow,
} from '../types';
import type { CadenceConfig } from './cadence';
import type { Clock } from './clock';
import { isTraversal, type ConnectorSpec } from './connectors';
import type { JobQueue } from './jobs';
import type { FirstScan } from './first-scan';
import type { ReconcileFinding } from '../reconcile/reconciler';
import type { Hold, SpendGovernor } from '../../llm/spend';

export const MIN = 60_000;
/** Rounds a first-scan scope re-plans its holes before it is done anyway (FS-2). */
export const FIRST_SCAN_REPLANS = 3;
/** Longest header cursor handed to the agent verbatim (cc_finish caps cursor.value at 200 chars). */
export const HEADER_CURSOR_MAX = 180;
/**
 * Next poll after a scope gave up on a window. The poll re-plans the same window from the unmoved cursor, so a
 * window that always fails was re-run (and re-billed) every 30 minutes forever; now 30 min doubling per ~4 failures,
 * capped at 6 h, until a success resets the count (stress finding LOOP-1).
 */
export function stuckDelayMs(consecutiveFailures: number): number {
  return Math.min(6 * 60 * MIN, 30 * MIN * 2 ** Math.floor(Math.max(0, consecutiveFailures - 1) / 4));
}
/** An answered day-cap ask that said Allow for today (`answerUsd` null), still live or already settled by the runtime. */
export function allowedForToday(h: Hold): boolean {
  return !!h.answeredAt && h.answerUsd === null && (h.state === 'approved' || h.state === 'settled');
}
export interface RuntimeLogEvent {
  event: 'plan' | 'run_start' | 'run_ok' | 'run_fail' | 'paused' | 'resumed' | 'budget' | 'reconcile' | 'skip';
  connector?: ConnectorId;
  scope?: string;
  runId?: string;
  mode?: string;
  code?: string;
  detail?: string;
  costUsd?: number;
}
export interface ScannerRuntimeDeps {
  store: ScannerStore;
  runner: SkillRunner;
  specs: ConnectorSpec[];
  reevaluate: ReevaluateEnqueuer;
  clock?: Clock;
  /** Where `start()` puts planned jobs and follow-ups. Defaults to an InMemoryJobQueue. */
  queue?: JobQueue;
  cadence?: Partial<CadenceConfig>;
  /** Re-read watch list / channel map for new scopes this often. Default 10 min. */
  scopeRefreshMs?: number;
  /** A planned job not executed within this time is considered lost and re-planned. Default 15 min. */
  leaseMs?: number;
  /** Local hour for the nightly reconcile. Default 2 (02:00). */
  nightlyReconcileHour?: number;
  /** Max concurrent Claude processes across connectors (brief 09 §5.9). Default 3. */
  maxConcurrentLlm?: number;
  /** Re-link window for skill upgrades (SCANNER.md §6.4). Default 3 days. */
  skillUpgradeRelinkMs?: number;
  /** Persist reconcile findings (BE-1: reconcile_findings / app_events). */
  onFinding?: (f: ReconcileFinding) => Promise<void>;
  /** W0-1: each run's outcome with its catalog code (the worker watches Slack/Org62 sign-ins; src/ops/scanner-auth.ts). Never awaited for the run. */
  onScanOutcome?: (e: { connector: ConnectorId; ok: boolean; code?: string }) => void | Promise<void>;
  log?: (e: RuntimeLogEvent) => void;
  repoRoot?: string;
  /** B-080 first-scan lookback + one-time backfill budget. Default: from CC_FIRST_SCAN_* / --lookback-days, else `firstScanDefaultDays`. */
  firstScan?: FirstScan | null;
  /** First-scan lookback when nothing is configured: the worker passes DEFAULT_FIRST_SCAN_DAYS (30); unset = off. */
  firstScanDefaultDays?: number;
  /**
   * The spend governor (src/llm/spend, H-5). With it, a run holds its estimate (p90 of its skill's runs) instead of its
   * worst-case cap, reports its spend after every request, and past the hold stops to ask (paused, re-queued with the
   * answer) instead of failing `cost_cap` and retrying smaller. Without it: the D6 reservation of the cap, as before.
   */
  spend?: SpendGovernor | null;
  /** Signal-driven cadence: a scope's backoff level from before a restart (`scan-cadence.json`), by scope id. */
  cadenceSeed?: (scopeId: string) => number | undefined;
}
/** A scan paused for spend waits this long for its answer before it looks again (the answer runs it at once). */
export const SPEND_ASK_RECHECK_MS = 6 * 60 * 60_000;
export interface ScopeState {
  key: ScopeKey;
  nextDueAt: number;
  quietLevel: number;
  failures: number;
  transientStreak: number;
  /** `persona` (D-55): the persona dropped this scope or its source; it resumes from its cursor when they come back. */
  /** `stopped` (11 R5): a failure the catalog says not to retry (parse drift, an unknown error N times); until a Rescan or re-auth. */
  paused?: 'auth' | 'budget' | 'config' | 'persona' | 'prompt_cap' | 'stopped';
  /**
   * W0-7: prompt-cap failures of a window that cannot be split (same scope, same window start). 2 → one run with
   * half-size pages; 3 → the scope pauses (`prompt_cap`) with a Health line and a DATA.PROMPT_CAP event, until a
   * manual Rescan or a success. Never retried identically forever.
   */
  promptCap?: { from: string; count: number };
  pending: Map<string, number>; // jobId → plannedAt
  /**
   * The catch-up plan being executed: its windows, and which of its jobs (plus their continuations / splits) are
   * still outstanding. Released only when every plan job is done AND the cursor reached now. Tracking the plan
   * (not just the cursor) matters on a cold start, where the head run initializes the cursor at "now" while the
   * lookback backfill still runs behind it (stress finding B-1).
   */
  catchUp?: { planned: TimeWindow[]; jobs: Map<string, TimeWindow>; done: Set<string>; at: number };
  lastOkAt?: number;
  /** Last failure (HEALTH-1: only recent failures of other scopes hold a connector Degraded). */
  lastFailAt?: number;
  /** When the connector was auth-paused. */
  authPausedAt?: number;
  /** The interval the live loop chose at the last planning (a regular poll after it is not a catch-up). */
  lastIntervalMs?: number;
  /** B-080: outstanding first-scan jobs of this scope (plan + follow-ups); empty → the scope's first scan is done. */
  firstScanJobs?: Set<string>;
  /** FS-ORDER: where the first-scan plan ends (its `now`). Live polls during the first scan cover only what came after. */
  firstScanTo?: number;
}
/** W0-7: the step a prompt-capped window gets on its second try: every page at half its usual size. */
export const SMALL_PAGES_STEP =
  'This window was over the prompt size limit twice. Use half the usual page sizes for every read tool in this run (search `limit: 10`, thread reads `limit: 15`, channel reads `limit: 50`) and page with the cursor as usual.';
/** A paused non-poll window (backfill, continuation) is retried this long after an auth pause. */
export const AUTH_PROBE_MS = 30 * MIN;
/** ORG-7: a held first-scan job checks again after this long; holds end after these bounds whatever happens. */
export const HOLD_RETRY_MS = MIN;
export const HOLD_ACCOUNTS_MS = 5 * MIN;
export const HOLD_MAX_MS = 30 * MIN;
export interface ScopeStatus {
  connector: ConnectorId;
  scope: string;
  nextDueAt: string;
  quietLevel: number;
  failures: number;
  paused?: string;
  catchingUp: boolean;
  catchUpPct?: number;
  /** The interval the loop chose at the last planning (ms). */
  intervalMs?: number;
}
/** Extended reason passed to the ReevaluateEnqueuer (extra fields are optional for BE-3). */
export interface ReevaluateReason {
  runId: string;
  connector: ConnectorId;
  catchingUp?: boolean;
  trigger?: ScanTrigger;
}
/** Traversal and hybrid (watch) specs need the LLM to read the source: they pause at the hard cap. */
export function usesTraversalLlm(spec: ConnectorSpec): boolean {
  return isTraversal(spec) || !!spec.allowedTools?.length;
}
/** The skill key a spec runs (`skills/scan-slack.md` → `scan-slack`): llm_calls / llm_decisions `skill_key`. */
export function skillKeyOf(spec: Pick<ConnectorSpec, 'skillPath'>): string {
  return spec.skillPath.replace(/^.*\//, '').replace(/\.md$/, '');
}
