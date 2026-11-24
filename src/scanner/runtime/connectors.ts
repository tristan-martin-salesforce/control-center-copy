/**
 * Connector specs the runtime drives.
 *  - Traversal (Slack, Org62): the Haiku skill agent calls the source's READ tools itself.
 *  - Deterministic (Gmail, Calendar, Drive, Gemini notes, Claude sessions, trainings…): BE-2b's
 *    `DeterministicFetcher` fetches; the same skill-driven agent interprets and links the items.
 */
import { manifestOf, scanSkillPath } from '../../connectors/registry';
import { MCP_SERVER_NAME } from '../../llm/errors';
import { restrictedTools, traversalMcpServers } from '../../llm/mcp-config';
import { ESCALATION_MODEL, SCANNER_MODEL } from '../../llm/models';
import { DEFAULT_TRIAGE, type TriageConfig } from '../triage/slack-triage';
import { ALL_ORG62_SCOPES, type Org62Scope, type ResolvedPersona } from '../../personas/types';
import type { ConnectorId, CoverageObject, Cursor, DeterministicFetcher, ScanContext } from '../types';
import type { ScanJobMode } from './jobs';

const H = 3_600_000;
/** D-65 (TL-43): the catch-up floor of `org62:events` after downtime (a fiscal quarter plus a month). */
export const ORG62_EVENTS_CATCH_UP_MS = 120 * 24 * H;

interface SpecBase {
  connector: ConnectorId;
  skillPath: string;
  model: string;
  /** How far back a scope with no cursor starts. */
  initialLookbackMs: number;
  /** Backfill chunk (SCANNER.md §5: e.g. 6 h). */
  chunkMs: number;
  /** Per-scope override of `chunkMs` for planned catch-up backfill (Slack inbox: smaller, see slackSpec). */
  chunkMsFor?(scope: string): number;
  /**
   * D-65 (TL-43): how far back a catch-up after downtime reaches for this scope (the planner's default: 14 days).
   * Org62 `events` reaches a fiscal quarter and more, so Events logged or edited while the worker was down still reach
   * Time and the quarter totals.
   */
  maxBackfillMsFor?(scope: string): number | undefined;
  /** B-080: chunk of the first-scan backfill (default: chunkMsFor / chunkMs). Slack channels use a day. */
  firstScanChunkMsFor?(scope: string): number;
  /** FS-DEEP: chunk of a deeper per-scope lookback past the shared floor (default: firstScanChunkMsFor). */
  firstScanDeepChunkMsFor?(scope: string): number;
  /**
   * FS-ORDER: a scope that reads the current state, not changes (Org62 `book`, `missed_opps`). Its first scan keeps the
   * head run, because that run is the read (its backfill chunks make no call). Every other first scan has no head.
   */
  readsCurrentState?(scope: string): boolean;
  maxTurns(scope: string, mode: ScanJobMode | 'relink'): number;
  costCapUsd(scope: string, mode: ScanJobMode | 'relink'): number;
  /** The run's watchdog (ms); default the runner's 3 minutes (ORG-2). */
  timeoutMs?(scope: string, mode: ScanJobMode | 'relink'): number;
  /**
   * E3 (audit 2026-11-13, lane E): an auth pause outlives a restart. At startup the scopes of a connector whose stored
   * health says "needs re-auth" start paused, until Health ▸ Re-auth, a Rescan or a success, like a pause the running
   * worker set itself. `credentialsChangedSince(ms)` (no network): the stored sign-in was refreshed after the last
   * auth failure, so the first poll tries again (VDP: the refresh script ran in Terminal).
   */
  persistAuthPause?: { credentialsChangedSince?(sinceMs: number): boolean };
}

export interface TraversalConnectorSpec extends SpecBase {
  type: 'traversal';
  allowedTools: string[];
  /** Restricted single-server config, resolved lazily from the user's Claude config (no secrets). */
  mcpServers(): Record<string, unknown>;
  /** Scopes for this user, derived from the context pack (watch list, channel→account map). */
  scopes(ctx: ScanContext): string[];
  /** Run-block substitutions for a scope (channel id, thread ts…). */
  scopeVars(scope: string, ctx: ScanContext): Record<string, string>;
  /** REC-1: the runner records every message the read tools return (Slack); REC-2: every windowed Org62 row (ORG-5). */
  autoRecord?: 'slack' | 'org62';
  /** Post-traversal triage pass for a scope (Slack); undefined = none. */
  triage?(scope: string, mode: ScanJobMode | 'relink'): TriageConfig | undefined;
  /**
   * D5: a cheap check before a scheduled incremental poll. `empty` (positively nothing in the window) finishes the
   * run with the check's coverage and no traversal; `null` or not empty runs the traversal as before (fail open).
   */
  precheck?(input: PrecheckInput): Promise<PrecheckResult | null>;
}

export interface PrecheckInput {
  scope: string;
  window: { from: string; to: string };
  vars: Record<string, string>;
  ctx: ScanContext;
  signal: AbortSignal;
}

export interface PrecheckResult {
  empty: boolean;
  /** Coverage the check established (only used when empty): the same refs and kinds the skill reports. */
  coverage: CoverageObject[];
  /** The cursor at the window end (only used when empty). */
  cursor: Cursor;
  costUsd: number;
  calls: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contentHash?: string;
  /** Why it was not empty or could not tell (`found:search:dm`, `unclear`, `error:timeout`). */
  why: string;
}

const envOn = (name: string, env: Record<string, string | undefined> = process.env) => (env[name] ?? '1') !== '0';

/**
 * STRESS-2 Slack recall fixes, each on by default and switchable for A/B runs:
 *  CC_SLACK_REC=0 (REC-1 record from tool results) · CC_SLACK_TRIAGE=0 (triage pass) · CC_SLACK_ESCALATE=0 (unsure → Sonnet).
 */
export function slackRecallDefaults(env: Record<string, string | undefined> = process.env): Pick<TraversalConnectorSpec, 'autoRecord' | 'triage'> {
  const rec = envOn('CC_SLACK_REC', env);
  const triage = rec && envOn('CC_SLACK_TRIAGE', env);
  const escalate = triage && envOn('CC_SLACK_ESCALATE', env);
  return {
    ...(rec ? { autoRecord: 'slack' as const } : {}),
    ...(triage ? { triage: () => ({ ...DEFAULT_TRIAGE, model: SCANNER_MODEL, ...(escalate ? { escalateModel: ESCALATION_MODEL } : {}) }) } : {}),
  };
}

export interface DeterministicConnectorSpec extends SpecBase {
  type: 'deterministic';
  fetcher: DeterministicFetcher;
  /** Max items handed to one agent run (the rest is a continuation). */
  maxItemsPerRun: number;
  /**
   * Hybrid sources (scan-watch): the fetcher emits a plan and the agent also reads a traversal
   * server. Same restricted single-server rules as traversal specs.
   */
  allowedTools?: string[];
  mcpServers?(): Record<string, unknown>;
  /** Run the agent even when the fetch returned no items (never true for pure deterministic sources). */
  alwaysRunAgent?: boolean;
}

export type ConnectorSpec = TraversalConnectorSpec | DeterministicConnectorSpec;

/** Slack scopes: `inbox` (DMs/MPIMs, @mentions, threads I'm in, my own messages) + `channel:<id>` (watched + customer). */
export function slackSpec(overrides: Partial<TraversalConnectorSpec> = {}): TraversalConnectorSpec {
  const m = manifestOf('slack');
  const tools = restrictedTools('slack', m.readTools);
  return {
    type: 'traversal',
    connector: 'slack',
    skillPath: scanSkillPath('slack'),
    model: SCANNER_MODEL,
    initialLookbackMs: m.windows.default,
    chunkMs: 6 * H,
    // The inbox (DMs, @mentions, my messages) backfills in 2 h chunks: a busy 6 h morning window held 33–47 messages
    // and Haiku proposed nothing from it, while ~9-message runs triaged fine (stress finding SLK-1).
    chunkMsFor: (scope) => (scope === 'inbox' ? 2 * H : 6 * H),
    // A 90-day first scan of 8 channels in 6 h chunks is 2,880 runs; most channel days are quiet, and a busy day
    // pages into continuations anyway.
    firstScanChunkMsFor: (scope) => (scope === 'inbox' ? 2 * H : 24 * H),
    // FS-DEEP: older inbox days are quieter, and since STRESS-2 the triage pass gives every message a verdict whatever the
    // window holds (up to 120 a run), so 6 h chunks there: 60 extra days are 240 runs, not 720.
    firstScanDeepChunkMsFor: (scope) => (scope === 'inbox' ? 6 * H : 24 * H),
    allowedTools: tools.allowedTools,
    mcpServers: () => traversalMcpServers('slack'),
    scopes(ctx) {
      const channels = new Set<string>();
      for (const w of ctx.watchList) if (w.kind === 'slack_channel' || w.kind === 'channel') channels.add(w.ref);
      for (const c of ctx.aliases.channels) if (c.accountId) channels.add(c.channelId);
      return ['inbox', ...[...channels].sort().map((c) => `channel:${c}`)];
    },
    scopeVars(scope, ctx): Record<string, string> {
      if (scope.startsWith('channel:')) {
        const id = scope.slice('channel:'.length);
        const alias = ctx.aliases.channels.find((c) => c.channelId === id);
        const watch = ctx.watchList.find((w) => w.ref === id);
        return {
          'channel.id': id,
          // The bare, searchable channel NAME (`in:#<name>`): the `in:<#ID>` form matches nothing in the Slack
          // MCP search (stress finding S-1). Empty when no usable name is known; the skill then reads the channel.
          'channel.label': slackChannelName(alias?.label ?? watch?.label),
          'channel.accountId': alias?.accountId ?? '',
          'channel.kind': alias?.accountId ? 'customer' : 'watched',
        };
      }
      if (scope.startsWith('thread:')) {
        const [, channel, ts] = scope.split(':');
        return { 'thread.channelId': channel ?? '', 'thread.ts': ts ?? '' };
      }
      return {};
    },
    maxTurns: (scope, mode) => (mode === 'relink' ? 12 : scope === 'inbox' ? (mode === 'backfill' || mode === 'head' ? 40 : 30) : 20),
    costCapUsd: (scope, mode) => (mode === 'backfill' || mode === 'head' ? 0.15 : scope === 'inbox' ? 0.08 : 0.05),
    ...slackRecallDefaults(),
    ...overrides,
  };
}

/**
 * Org62 scopes: `opps` (my accounts + opp teams), `events` (my Solutions Events), `dcs`, `book`, `missed_opps`
 * (R-UI-14), as the persona preconfigures them (`org62ScopesFor`: the AE has no `dcs` or `missed_opps` until those
 * features are activated). `book` and `missed_opps` are unwindowed (they read the current state; skill §6):
 *  - `book`: every open opp I'm on the team of plus my DCs on open opps, once a day and on the first run. It polls
 *    at the Org62 cadence, but the skill reads only when its cursor is not yet `book:<today>` (a no-op run makes no
 *    Org62 call, so quiet backoff stretches it to every 4 h);
 *  - `missed_opps`: the daily sweep (cadence ×48).
 * A catch-up plans each as one head run plus one backfill chunk, and the skill makes no Org62 call in the backfill.
 */
export function org62Spec(overrides: Partial<TraversalConnectorSpec> = {}): TraversalConnectorSpec {
  const m = manifestOf('org62');
  const tools = restrictedTools('org62', m.readTools);
  const unwindowed = (scope: string) => scope === 'missed_opps' || scope === 'book';
  return {
    type: 'traversal',
    connector: 'org62',
    skillPath: scanSkillPath('org62'),
    model: SCANNER_MODEL,
    initialLookbackMs: m.windows.default,
    chunkMs: 7 * 24 * H, // one paged SystemModstamp query per week of backlog
    chunkMsFor: (scope) => (unwindowed(scope) ? 31 * 24 * H : 7 * 24 * H),
    // D-65 (TL-43): a worker down for more than 14 days still catches up every Event of this quarter and the last weeks of
    // the previous one (one 7-day chunk per run); the other scopes keep the planner's 14 days
    maxBackfillMsFor: (scope) => (scope === 'events' ? ORG62_EVENTS_CATCH_UP_MS : undefined),
    readsCurrentState: unwindowed,
    allowedTools: tools.allowedTools,
    mcpServers: () => traversalMcpServers('org62'),
    // D-55: the persona's scopes (SE: all five; AE: opps, events, book). A scope a persona drops pauses (runtime).
    scopes: (ctx) => org62ScopesFor(ctx.persona),
    scopeVars: (_scope, ctx) => ({ 'org62.accountIds': org62AccountIds(ctx), ...org62PersonaVars(ctx.persona) }),
    // a backfill chunk of an unwindowed scope makes no Org62 call; the book pages 50 opps / 100 DCs per page
    maxTurns: (scope, mode) => (unwindowed(scope) && mode === 'backfill' ? 6 : scope === 'missed_opps' ? 40 : 25),
    costCapUsd: (scope, mode) => (unwindowed(scope) && mode === 'backfill' ? 0.03 : scope === 'missed_opps' ? 0.25 : scope === 'book' ? 0.15 : 0.08),
    // ORG-2: the agent records each Org62 row itself (about 3.6 s per Event with its payload), and the skill pages two
    // pages of 50 per run. A bulk-logged week took longer than the runner's 3-minute watchdog on every retry, so that
    // window could never finish. Paged scopes get 8 minutes (the job timeout is 15).
    timeoutMs: (scope) => (scope === 'events' || scope === 'opps' || scope === 'dcs' || scope === 'book' ? 8 * 60_000 : 180_000),
    // REC-2 (ORG-5): the runner records every row of the windowed scopes' pages from the SOQL result (CC_ORG62_REC=0: off).
    ...(envOn('CC_ORG62_REC') ? { autoRecord: 'org62' as const } : {}),
    ...overrides,
  };
}

/** The Org62 scopes a persona scans, in the canonical order (no persona: the SE's five, as before personas). */
export function org62ScopesFor(persona: ResolvedPersona | undefined): Org62Scope[] {
  return persona ? ALL_ORG62_SCOPES.filter((sc) => persona.org62Scopes.includes(sc)) : [...ALL_ORG62_SCOPES];
}

/**
 * Run-block values the Org62 skill reads to follow the persona (D-55): whose opps are "my book" and whether my Deal
 * Contributions are read. No persona: the SE's (opp teams I'm on, DCs on). They live in the Run block (the dynamic
 * user prompt), never in the skill text, so the cached prefix is the same for every persona.
 */
export function org62PersonaVars(persona: ResolvedPersona | undefined): Record<string, string> {
  return { 'org62.book': persona?.org62Book ?? 'team_member', 'org62.dcs': !persona || persona.features.dealContributions ? 'on' : 'off' };
}

/**
 * Wrap a BE-2b fetcher. Registry dispatch (08 R1): the per-source values come from the connector's manifest
 * (`scan`, `windows`; src/connectors/<id>/manifest.ts) instead of branches on the id:
 *  - skill `skills/<scan.skill>.md`; a new scope starts `windows.default` back; backfill in `scan.chunkMs` chunks
 *    (Drive: a day; VDP: a month);
 *  - `scan.firstScanChunkMs`: Calendar's first-scan history is one listing call per day and no agent run (FS-CAL-1);
 *  - `scan.readsCurrentState`: VDP is current state (the mirror, record-only), history windows make no call;
 *  - `scan.persistAuthPause` (E3): VDP's Okta cookie lives an hour, so its auth pause survives a restart and lifts at
 *    startup when the cookie was refreshed after the last refusal;
 *  - `scan.maxItemsPerRun`: every VDP of mine is recorded in the one live run (500), the rest hand 25 to the agent;
 *  - `scan.hybrid` (scan-watch): the agent also reads two Slack tools through Slack's server.
 */
export function deterministicSpec(fetcher: DeterministicFetcher, overrides: Partial<DeterministicConnectorSpec> = {}): DeterministicConnectorSpec {
  const m = manifestOf(fetcher.connector);
  const s = m.scan;
  const via = s.hybrid;
  const hybrid = via ? { allowedTools: restrictedTools(via.via, via.tools).allowedTools, mcpServers: () => traversalMcpServers(via.via) } : {};
  return {
    type: 'deterministic',
    connector: fetcher.connector,
    fetcher,
    ...hybrid,
    skillPath: scanSkillPath(fetcher.connector),
    model: SCANNER_MODEL,
    initialLookbackMs: m.windows.default,
    chunkMs: s.chunkMs ?? 12 * H,
    ...(s.firstScanChunkMs ? { firstScanChunkMsFor: () => s.firstScanChunkMs! } : {}),
    ...(s.readsCurrentState ? { readsCurrentState: () => true } : {}),
    ...(s.persistAuthPause
      ? {
          persistAuthPause: {
            credentialsChangedSince: (ms: number) => {
              const at = fetcher.credentialsIssuedAt?.() ?? null;
              return at !== null && at > ms;
            },
          },
        }
      : {}),
    maxItemsPerRun: s.maxItemsPerRun ?? 25,
    maxTurns: (_s, mode) => (mode === 'relink' ? 12 : 20),
    // MIN-25: a first-scan window of 25 long items (Gemini meeting notes at $0.063, old Gmail threads at $0.061) went
    // over the flat $0.05, so every busy window failed once before its 12-item retry. Backfill-type runs (head,
    // backfill, continuation, retry) of a deterministic source get $0.10, about $0.004 an item; the regular poll keeps
    // $0.05.
    costCapUsd: (_s, mode) => (mode === 'incremental' || mode === 'relink' ? 0.05 : 0.1),
    ...overrides,
  };
}

/** `#Team-Updates` / `team-updates` → `team-updates`; anything that is not a Slack channel name → ''. */
export function slackChannelName(label: string | undefined): string {
  const n = (label ?? '').trim().replace(/^#/, '').toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(n) ? n : '';
}

const ORG62_ACCOUNT_ID = /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/**
 * My Org62 Account Ids for SOQL `IN (…)`, from the account alias map: an `accountId` that is itself an
 * Org62 id, or an alias name of the form `org62:<001…>` (BE-1 seeds it that way). Quoted, comma-separated. Every id
 * (caps audit 2026-11-21: was the first 200 by id, so a bigger book lost opp coverage); the fetch splits the list
 * into IN clauses of ORG62_IN_CHUNK (src/scanner/fetch/org62.ts).
 */
export function org62AccountIds(ctx: ScanContext): string {
  const ids = new Set<string>();
  for (const a of ctx.aliases.accounts) {
    if (ORG62_ACCOUNT_ID.test(a.accountId)) ids.add(a.accountId);
    for (const n of a.names) {
      const m = /^org62:(001[A-Za-z0-9]{12,15})$/.exec(n);
      if (m) ids.add(m[1]!);
    }
  }
  return [...ids]
    .sort()
    .map((i) => `'${i}'`)
    .join(',');
}

export function isTraversal(s: ConnectorSpec): s is TraversalConnectorSpec {
  return s.type === 'traversal';
}

export { MCP_SERVER_NAME };
