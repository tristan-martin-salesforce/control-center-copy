/**
 * Claude sessions fetcher (local files only, no LLM). Scope `all`.
 *
 * Sources (brief 10 §1.1): A = ~/.claude/sessions/<pid>.json (live registry; authority for running/waiting/idle),
 * B = desktop index local_<uuid>.json (title, archived, error, fork parent, branches), C = transcript JSONL (history).
 * Cursor = per-file byte offsets (+ the hash of the last emitted item so a killed run re-emits identically).
 * Derived per-transcript parse state is a sidecar (it is re-derivable: on any offset mismatch the file is re-read from 0).
 *
 * Emits one `claude_session` item per session whose observable state changed. The `[cc:<id>]` tag in the first human prompt
 * links app-launched sessions. Both ids are emitted: payload.sessionId (CLI UUID) and payload.hostSessionId (`local_…`),
 * because the desktop deep link accepts only the `local_…` id.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { inStateDir } from '@/lib/state-folder';
import type { ConnectorHealthProbe, CoverageObject, Cursor, DeterministicFetcher, FetchResult, NormalizedSourceItem, TimeWindow } from '@/scanner/types';
import { redact, redactExcerpt } from '../redact';
import { localFilesPort, localFilesRuntime, type LocalFilesPort } from '../runtime/local-files';
import { decodeCursor, encodeCursor, h16, systemClock, throwIfAborted, type Clock } from '../util';
import { deriveStatus, FRESH_MS, type DesktopMeta, type Derived, type RegistryEntry } from './status';
import { applyChunk, emptyTranscriptState, findCcTag, TURNS_V, type TranscriptState } from './transcript';

// ------------------------------------------------------------------ state store

export interface SessionStateStore {
  get(key: string): Promise<TranscriptState | null>;
  put(key: string, s: TranscriptState): Promise<void>;
}

export class MemorySessionStateStore implements SessionStateStore {
  private m = new Map<string, TranscriptState>();
  async get(k: string) {
    const v = this.m.get(k);
    return v ? (JSON.parse(JSON.stringify(v)) as TranscriptState) : null;
  }
  async put(k: string, s: TranscriptState) {
    this.m.set(k, JSON.parse(JSON.stringify(s)) as TranscriptState);
  }
}

export const defaultSessionStateDir = () => inStateDir('claude-session-state');

export class FileSessionStateStore implements SessionStateStore {
  constructor(private dir = defaultSessionStateDir()) {}
  private p(key: string) {
    return join(this.dir, createHash('sha1').update(key).digest('hex').slice(0, 24) + '.json');
  }
  async get(key: string) {
    try {
      return JSON.parse(await readFile(this.p(key), 'utf8')) as TranscriptState;
    } catch {
      return null;
    }
  }
  async put(key: string, s: TranscriptState) {
    await mkdir(this.dir, { recursive: true });
    const tmp = this.p(key) + '.tmp';
    await writeFile(tmp, JSON.stringify(s));
    await rename(tmp, this.p(key));
  }
}

// ------------------------------------------------------------------ options

export interface ClaudeSessionsOptions {
  /** Defaults to ~/.claude/sessions */
  sessionsDir?: string;
  /** Defaults to ~/.claude/projects */
  projectsDir?: string;
  /** Defaults to ~/Library/Application Support/Claude/claude-code-sessions (optional source B). Pass null to disable. */
  desktopDir?: string | null;
  stateStore?: SessionStateStore;
  clock?: Clock;
  /** Sessions whose cwd starts with one of these are skipped (the scanner's own fixed cwd, brief 09 finding 8). */
  excludeCwdPrefixes?: string[];
  /** Map pid -> process start string (`ps lstart`). Default shells out to `ps` once per fetch. */
  listProcesses?: () => Promise<Map<number, string>>;
  /** Branch fallback when the transcript says HEAD. Default: none (returns undefined). */
  resolveBranch?: (cwd: string) => Promise<string | undefined>;
  /** Ignore transcripts that have not been touched for this many days (unless live). */
  recentDays?: number;
  maxSessionsPerRun?: number;
  /** Max bytes read from one transcript per run. */
  maxBytesPerFile?: number;
  /**
   * D3: CLI session ids whose recorded item is evidence on an open work item. New content in one of these goes to the
   * model; elsewhere only a new session or a move to waiting / done / errored does. Default: none.
   */
  linkedSessions?: () => Promise<Set<string>>;
  /** D3: at most one model look per session per this long (default 5 min); a change in between waits for it. */
  modelMinIntervalMs?: number;
  /**
   * 2026-11-14: transcripts the cursor knows, touched within this many days, are re-read once for their human turns
   * (`humanTurns`, the time engine's prompts) and recorded without the model. Default 60.
   */
  turnsBackfillDays?: number;
  /**
   * The files the fetcher reads (the sessions registry, transcripts, the desktop index): a `local_files` connector
   * runtime's port. Default: one confined to this fetcher's three folders (src/connectors/runtime/local-files.ts).
   */
  files?: LocalFilesPort;
}

export interface FileCursor {
  o: number; // offset consumed
  i: number; // inode
  eh?: string; // emitted content hash
  /** D3: the state the model last accounted for: meaning hash, status, when it last ran on it, and a change waiting. */
  mh?: string;
  ms?: string;
  m?: number;
  p?: 1;
  /** The `humanTurns` version this transcript's item was last recorded with (TURNS_V; absent: before them). */
  tv?: number;
}

/** Statuses that need the model's eyes (blocked on me, finished, failed). busy and idle are live state only. */
export const ATTENTION_STATUSES: ReadonlySet<string> = new Set(['waiting', 'done', 'errored']);
export const MODEL_MIN_INTERVAL_MS = 5 * 60_000;
/** R15 (SCN-12): an idle, unlinked session whose content changed reaches the model once it has been quiet this long. */
export const IDLE_QUIET_MS = 30 * 60_000;

export type SessionModelReason = 'new_session' | 'status_attention' | 'linked_content' | 'idle_quiet';
export type SessionSkipReason = 'status_only' | 'unlinked_content' | 'min_interval' | 'turns_backfill';

/**
 * D3 (audit 2026-11-13): does this session go to the model this run? Pure.
 *  - a session the cursor has never seen: yes (new_session);
 *  - only live state moved (busy ↔ idle, the status age, background agents): no, recorded as it is (status_only);
 *  - what the model reads changed (status bucket, title, summary, branch, tag): yes when the session is now waiting,
 *    done or errored and it was not before (status_attention), or when it is linked to an open item (linked_content);
 *    otherwise it is recorded without the model (unlinked_content);
 *  - R15: an idle session (a live session that ended its turn: "PR is ready, please review") that is not linked is held
 *    as a pending change while it is busy-quiet, and goes to the model once it has been quiet `IDLE_QUIET_MS` (idle_quiet);
 *    before, it was recorded without the model and never looked at until the terminal closed;
 *  - a yes within `minIntervalMs` of the model's last look waits (min_interval), and is looked at once the interval passed.
 */
export function sessionModelDecision(i: { prev?: FileCursor; contentHash: string; meaning: string; status: string; linked: boolean; nowMs: number; minIntervalMs: number; quietMs?: number }): {
  to: 'model' | 'quiet' | 'none';
  reason?: SessionModelReason | SessionSkipReason;
  next: Omit<FileCursor, 'o' | 'i'>;
} {
  const p = i.prev;
  const changed = p?.eh !== i.contentHash;
  if (!p) return { to: 'model', reason: 'new_session', next: { eh: i.contentHash, mh: i.meaning, ms: i.status, m: i.nowMs } };
  const accounted = { mh: p.mh, ms: p.ms, m: p.m };
  // A cursor from before D3 has no accounted state: it starts accounting here, and only a change counts.
  if (p.mh === undefined && !changed) return { to: 'none', next: { eh: i.contentHash, mh: i.meaning, ms: i.status, ...(p.m ? { m: p.m } : {}) } };
  const meaningChanged = p.mh === undefined || p.mh !== i.meaning;
  if (!meaningChanged && !p.p) return { to: changed ? 'quiet' : 'none', ...(changed ? { reason: 'status_only' as const } : {}), next: { eh: i.contentHash, ...accounted } };
  const idleQuiet = i.status === 'idle' && !i.linked && (i.quietMs ?? 0) >= IDLE_QUIET_MS;
  const qualifies: SessionModelReason | null = ATTENTION_STATUSES.has(i.status) && p.ms !== i.status ? 'status_attention' : i.linked ? 'linked_content' : idleQuiet ? 'idle_quiet' : null;
  // R15: an idle unlinked change not quiet long enough yet stays pending (its meaning not accounted), so a later poll sends it.
  if (!qualifies && i.status === 'idle' && !i.linked) return { to: changed ? 'quiet' : 'none', ...(changed ? { reason: 'unlinked_content' as const } : {}), next: { eh: i.contentHash, ...accounted, p: 1 } };
  if (!qualifies) return { to: changed ? 'quiet' : 'none', ...(changed ? { reason: 'unlinked_content' as const } : {}), next: { eh: i.contentHash, mh: i.meaning, ms: i.status, ...(p.m ? { m: p.m } : {}) } };
  if (p.m && i.nowMs - p.m < i.minIntervalMs) return { to: changed ? 'quiet' : 'none', ...(changed ? { reason: 'min_interval' as const } : {}), next: { eh: i.contentHash, ...accounted, p: 1 } };
  return { to: 'model', reason: qualifies, next: { eh: i.contentHash, mh: i.meaning, ms: i.status, m: i.nowMs } };
}

/** What the model reads of a session (busy and idle are one state: `active`). Live-only fields are left out. */
export function sessionMeaningHash(item: NormalizedSourceItem): string {
  const pl = (item.payload ?? {}) as Record<string, unknown>;
  const status = String(pl.status ?? '');
  const bucket = ATTENTION_STATUSES.has(status) ? status : 'active';
  const tag = (pl.ccTag as { id?: string } | undefined)?.id;
  return h16(item.externalId, bucket, pl.waitingFor as string | undefined, pl.errorKind as string | undefined, item.title, pl.branch as string | undefined, pl.cwd as string | undefined, pl.summary as string | undefined, tag, pl.archived ? 'a' : '', pl.humanPromptCount as number | undefined);
}
interface ClaudeCursor {
  files: Record<string, FileCursor>;
}

const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export async function psListProcesses(): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,lstart='], { timeout: 5000, maxBuffer: 4_000_000 }, (err, out) => {
      const m = new Map<number, string>();
      if (err) return resolve(m);
      for (const line of out.split('\n')) {
        const mm = line.match(/^\s*(\d+)\s+(.*)$/);
        if (mm) m.set(Number(mm[1]), norm(mm[2]));
      }
      resolve(m);
    });
  });
}

/** Repo label: the segment before `/.claude/worktrees/`, else the cwd basename. */
export function repoOfCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const w = cwd.split('/.claude/worktrees/')[0];
  return basename(w || cwd) || undefined;
}

export class ClaudeSessionsFetcher implements DeterministicFetcher {
  readonly connector = 'claude_sessions' as const;
  private readonly o: Required<Omit<ClaudeSessionsOptions, 'resolveBranch' | 'desktopDir' | 'stateStore' | 'clock' | 'files'>> & { resolveBranch?: ClaudeSessionsOptions['resolveBranch']; desktopDir: string | null; stateStore: SessionStateStore; clock: Clock };
  private desktopCache = new Map<string, { mtime: number; size: number; meta: DesktopMeta | null }>();
  /** Injected read transport (local_files runtime). */
  private readonly files: LocalFilesPort;

  constructor(opts: ClaudeSessionsOptions = {}) {
    const home = homedir();
    this.o = {
      sessionsDir: opts.sessionsDir ?? join(home, '.claude', 'sessions'),
      projectsDir: opts.projectsDir ?? join(home, '.claude', 'projects'),
      desktopDir: opts.desktopDir === undefined ? join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions') : opts.desktopDir,
      stateStore: opts.stateStore ?? new FileSessionStateStore(),
      clock: opts.clock ?? systemClock,
      excludeCwdPrefixes: opts.excludeCwdPrefixes ?? [],
      listProcesses: opts.listProcesses ?? psListProcesses,
      resolveBranch: opts.resolveBranch,
      recentDays: opts.recentDays ?? 7,
      maxSessionsPerRun: opts.maxSessionsPerRun ?? 60,
      maxBytesPerFile: opts.maxBytesPerFile ?? 8_000_000,
      linkedSessions: opts.linkedSessions ?? (async () => new Set<string>()),
      modelMinIntervalMs: opts.modelMinIntervalMs ?? MODEL_MIN_INTERVAL_MS,
      turnsBackfillDays: opts.turnsBackfillDays ?? 60,
    };
    this.files = opts.files ?? localFilesPort(localFilesRuntime({ connector: 'claude_sessions', roots: [this.o.sessionsDir, this.o.projectsDir, this.o.desktopDir] }));
  }

  async scopes(): Promise<string[]> {
    return ['all'];
  }

  async health(): Promise<ConnectorHealthProbe> {
    const checkedAt = this.o.clock().toISOString();
    try {
      await this.files.stat(this.o.projectsDir);
      return { state: 'ok', checkedAt };
    } catch (e) {
      return { state: 'degraded', errorClass: 'config', detail: `cannot read ${basename(this.o.projectsDir)}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`, checkedAt };
    }
  }

  // ---------------------------------------------------------------- discovery

  async readRegistry(procs: Map<number, string>): Promise<RegistryEntry[]> {
    let names: string[];
    try {
      names = (await this.files.readdir(this.o.sessionsDir)).filter((n) => /^\d+\.json$/.test(n)); // never the *.key files
    } catch {
      return [];
    }
    const out: RegistryEntry[] = [];
    for (const n of names) {
      try {
        const j = JSON.parse(await this.files.readText(join(this.o.sessionsDir, n))) as Record<string, unknown>;
        const pid = Number(j.pid);
        if (!pid || typeof j.sessionId !== 'string') continue;
        const procStart = typeof j.procStart === 'string' ? norm(j.procStart) : undefined;
        const live = procs.get(pid);
        // pid reuse guard: the process start time must equal the registry's procStart.
        const alive = live !== undefined && (!procStart || live === procStart);
        out.push({
          pid,
          sessionId: j.sessionId,
          hostSessionId: typeof j.hostSessionId === 'string' ? j.hostSessionId : undefined,
          cwd: typeof j.cwd === 'string' ? j.cwd : undefined,
          entrypoint: typeof j.entrypoint === 'string' ? j.entrypoint : undefined,
          kind: typeof j.kind === 'string' ? j.kind : undefined,
          name: typeof j.name === 'string' ? j.name : undefined,
          status: typeof j.status === 'string' ? j.status : undefined,
          waitingFor: typeof j.waitingFor === 'string' ? j.waitingFor : null,
          statusUpdatedAt: typeof j.statusUpdatedAt === 'number' ? j.statusUpdatedAt : undefined,
          updatedAt: typeof j.updatedAt === 'number' ? j.updatedAt : undefined,
          startedAt: typeof j.startedAt === 'number' ? j.startedAt : undefined,
          procStart,
          version: typeof j.version === 'string' ? j.version : undefined,
          alive,
        });
      } catch {
        /* unreadable registry file: skip */
      }
    }
    return out;
  }

  async listTranscripts(): Promise<Array<{ path: string; sessionId: string; mtimeMs: number; size: number; ino: number }>> {
    const out: Array<{ path: string; sessionId: string; mtimeMs: number; size: number; ino: number }> = [];
    let dirs: string[];
    try {
      dirs = await this.files.readdir(this.o.projectsDir);
    } catch {
      return out;
    }
    for (const d of dirs) {
      let files: string[];
      try {
        files = await this.files.readdir(join(this.o.projectsDir, d));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        try {
          const p = join(this.o.projectsDir, d, f);
          const st = await this.files.stat(p);
          out.push({ path: p, sessionId: f.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs, size: st.size, ino: st.ino });
        } catch {
          /* vanished */
        }
      }
    }
    return out;
  }

  /** Desktop index (source B). Loaded lazily, cached by mtime+size, `remoteMcpServersConfig` and friends are never kept. */
  private async desktopIndex(): Promise<Map<string, DesktopMeta>> {
    const map = new Map<string, DesktopMeta>();
    const root = this.o.desktopDir;
    if (!root) return map;
    let accts: string[];
    try {
      accts = await this.files.readdir(root);
    } catch {
      return map;
    }
    const archived = new Set<string>();
    for (const a of accts) {
      let orgs: string[];
      try {
        orgs = await this.files.readdir(join(root, a));
      } catch {
        continue;
      }
      for (const org of orgs) {
        const dir = join(root, a, org);
        let files: string[];
        try {
          files = await this.files.readdir(dir);
        } catch {
          continue;
        }
        try {
          const idx = JSON.parse(await this.files.readText(join(dir, 'archived-sessions.idx'))) as { archived?: string[] };
          for (const id of idx.archived ?? []) archived.add(id);
        } catch {
          /* optional */
        }
        for (const f of files) {
          if (!/^local_.*\.json$/.test(f)) continue;
          const p = join(dir, f);
          try {
            const st = await this.files.stat(p);
            const c = this.desktopCache.get(p);
            let meta: DesktopMeta | null;
            if (c && c.mtime === st.mtimeMs && c.size === st.size) meta = c.meta;
            else {
              const j = JSON.parse(await this.files.readText(p)) as Record<string, unknown>;
              meta = {
                sessionId: typeof j.sessionId === 'string' ? j.sessionId : undefined,
                cliSessionId: typeof j.cliSessionId === 'string' ? j.cliSessionId : undefined,
                title: typeof j.title === 'string' ? j.title : undefined,
                titleSource: typeof j.titleSource === 'string' ? j.titleSource : undefined,
                isArchived: j.isArchived === true,
                error: typeof j.error === 'string' ? j.error : undefined,
                errorAt: typeof j.errorAt === 'number' ? j.errorAt : undefined,
                lastTurnCutShort: j.lastTurnCutShort === true,
                writtenBranches: Array.isArray(j.writtenBranches) ? (j.writtenBranches as string[]) : undefined,
                forkedFromSessionId: typeof j.forkedFromSessionId === 'string' ? j.forkedFromSessionId : undefined,
                scheduledTaskId: typeof j.scheduledTaskId === 'string' ? j.scheduledTaskId : undefined,
                originCwd: typeof j.originCwd === 'string' ? j.originCwd : undefined,
              };
              this.desktopCache.set(p, { mtime: st.mtimeMs, size: st.size, meta });
            }
            if (meta?.cliSessionId) map.set(meta.cliSessionId, meta);
          } catch {
            /* skip */
          }
        }
      }
    }
    for (const m of map.values()) if (m.sessionId && archived.has(m.sessionId)) m.isArchived = true;
    return map;
  }

  /** Subagent transcripts modified in the last 90 s (background agents), with their labels. */
  private async backgroundAgents(transcriptPath: string, nowMs: number): Promise<{ count: number; labels: string[] }> {
    const dir = transcriptPath.slice(0, -'.jsonl'.length) + '/subagents';
    let files: string[];
    try {
      files = await this.files.readdir(dir);
    } catch {
      return { count: 0, labels: [] };
    }
    let count = 0;
    const labels: string[] = [];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const st = await this.files.stat(join(dir, f));
        if (nowMs - st.mtimeMs <= FRESH_MS) {
          count++;
          try {
            const meta = JSON.parse(await this.files.readText(join(dir, f.replace(/\.jsonl$/, '.meta.json')))) as { description?: string };
            if (meta.description && labels.length < 5) labels.push(redact(meta.description).text.slice(0, 120));
          } catch {
            /* no meta */
          }
        }
      } catch {
        /* vanished */
      }
    }
    return { count, labels };
  }

  // ---------------------------------------------------------------- parse a transcript incrementally

  private async advance(path: string, st: { size: number; ino: number }, fc: FileCursor | undefined): Promise<{ s: TranscriptState; fromZero: boolean }> {
    let state = await this.o.stateStore.get(path);
    // a state from before `turns` (2026-11-14) is re-derived from 0 once, so every prompt's time is known
    const offsetOk = state && state.turnsV === TURNS_V && fc && state.offset === fc.o && fc.i === st.ino && st.size >= fc.o;
    if (!offsetOk) state = emptyTranscriptState(); // re-derive from 0: idempotent
    const s = state!;
    if (st.size > s.offset) {
      const len = Math.min(st.size - s.offset, this.o.maxBytesPerFile);
      applyChunk(s, await this.files.readRange(path, s.offset, len));
    }
    return { s, fromZero: !offsetOk };
  }

  // ---------------------------------------------------------------- fetch

  async fetch(_scope: string, cursor: Cursor | null, window: TimeWindow, opts: { signal: AbortSignal; limit?: number }): Promise<FetchResult> {
    const now = this.o.clock();
    const nowMs = now.getTime();
    const prev = decodeCursor<ClaudeCursor>(cursor, { files: {} });
    const next: ClaudeCursor = { files: {} };
    const procs = await this.o.listProcesses();
    const registry = await this.readRegistry(procs);
    const regBySession = new Map(registry.map((r) => [r.sessionId, r]));
    const desktop = await this.desktopIndex();
    const transcripts = await this.listTranscripts();

    // Candidates: touched within recentDays AND (new to the cursor, grown/rotated, live, or recently active so that
    // time-based transitions such as busy -> interrupted are re-evaluated).
    const recentMs = nowMs - this.o.recentDays * 86400_000;
    const backfillMs = nowMs - this.o.turnsBackfillDays * 86400_000;
    // 2026-11-14: a transcript the cursor knows whose item predates `humanTurns`, re-read once (no model: forced quiet)
    const backfill = (t: { path: string; mtimeMs: number }) => {
      const known = prev.files[t.path];
      return !!known && known.tv !== TURNS_V && t.mtimeMs >= backfillMs;
    };
    const cand = transcripts
      .filter((t) => {
        if (t.mtimeMs < recentMs && !regBySession.get(t.sessionId)?.alive && !backfill(t)) return false;
        const known = prev.files[t.path];
        // D3: a session whose model look is waiting out its interval stays a candidate until it gets it.
        return !known || t.size !== known.o || t.ino !== known.i || !!regBySession.get(t.sessionId)?.alive || nowMs - t.mtimeMs < 10 * 60_000 || known.p === 1 || backfill(t);
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const limit = Math.min(opts.limit ?? this.o.maxSessionsPerRun, this.o.maxSessionsPerRun);
    const chosen = cand.slice(0, limit);
    const items: NormalizedSourceItem[] = [];
    const quietItems: NormalizedSourceItem[] = [];
    const decisions: NonNullable<FetchResult['decisions']> = [];
    const linked = chosen.length ? await this.o.linkedSessions().catch(() => new Set<string>()) : new Set<string>();
    const coverage: CoverageObject[] = [{ kind: 'session', ref: 'claude:registry', from: window.from, to: now.toISOString(), meta: { live: registry.filter((r) => r.alive).length, stale: registry.filter((r) => !r.alive).length, transcripts: transcripts.length } }];

    // Carry over untouched entries so cursors do not forget files outside this run's candidate set.
    for (const [p, v] of Object.entries(prev.files)) if (transcripts.some((t) => t.path === p)) next.files[p] = v;

    const branchCache = new Map<string, string | undefined>();
    for (const t of chosen) {
      throwIfAborted(opts.signal);
      const fc = prev.files[t.path];
      const { s, fromZero } = await this.advance(t.path, t, fc);
      await this.o.stateStore.put(t.path, s);
      // a known transcript re-read from 0 that is not read to its end yet (over maxBytesPerFile): nothing is emitted from
      // a partial state; the cursor keeps what was accounted and the next run reads on
      if (fc && (fromZero || fc.tv !== TURNS_V) && s.offset < t.size) {
        next.files[t.path] = { ...fc, o: s.offset, i: t.ino };
        continue;
      }

      const reg = regBySession.get(t.sessionId);
      const dm = desktop.get(t.sessionId);
      const cwd = s.cwd ?? reg?.cwd ?? dm?.originCwd;
      if (s.entrypoint?.startsWith('sdk-') || reg?.entrypoint?.startsWith('sdk-')) {
        next.files[t.path] = { o: s.offset, i: t.ino, eh: fc?.eh, tv: TURNS_V };
        continue;
      }
      if (cwd && this.o.excludeCwdPrefixes.some((p) => cwd.startsWith(p))) {
        next.files[t.path] = { o: s.offset, i: t.ino, eh: fc?.eh, tv: TURNS_V };
        continue;
      }
      const d = deriveStatus({ reg, t: s, desktop: dm, mtimeMs: t.mtimeMs, nowMs });
      const bg = await this.backgroundAgents(t.path, nowMs);

      let branch = s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : undefined;
      if (!branch && dm?.writtenBranches?.length) branch = dm.writtenBranches[dm.writtenBranches.length - 1]!.split('\u0000').pop();
      if (!branch && cwd && this.o.resolveBranch) {
        if (!branchCache.has(cwd)) branchCache.set(cwd, await this.o.resolveBranch(cwd).catch(() => undefined));
        branch = branchCache.get(cwd);
      }

      const item = this.toItem({ path: t.path, sessionId: t.sessionId, mtimeMs: t.mtimeMs, size: t.size }, s, d, reg, dm, bg, cwd, branch, nowMs);
      // D3: the live status always lands (recorded, no model); the model sees only a meaningful change, rate-limited.
      const meaning = sessionMeaningHash(item);
      // the turns backfill of a cursor from before D3 (nothing accounted, untouched since): recorded, never the model,
      // and accounting starts here; a cursor with accounted state takes the normal decision (an unchanged meaning is quiet)
      const onlyBackfill = !!fc && fc.tv !== TURNS_V && fc.mh === undefined && !reg?.alive;
      const v: ReturnType<typeof sessionModelDecision> = onlyBackfill
        ? { to: 'quiet', reason: 'turns_backfill', next: { eh: item.contentHash, mh: meaning, ms: d.status, ...(fc.m ? { m: fc.m } : {}) } }
        : sessionModelDecision({ prev: fc, contentHash: item.contentHash, meaning, status: d.status, linked: linked.has(t.sessionId), nowMs, minIntervalMs: this.o.modelMinIntervalMs, quietMs: nowMs - t.mtimeMs });
      next.files[t.path] = { o: s.offset, i: t.ino, ...v.next, tv: TURNS_V };
      if (v.to === 'model') items.push(item);
      else if (v.to === 'quiet') {
        quietItems.push(item);
        if (v.reason) decisions.push({ reason: v.reason, subject: t.sessionId, detail: { status: d.status } });
      }
      coverage.push({ kind: 'session', ref: t.sessionId, from: s.firstTs, to: s.lastTs, meta: { offset: s.offset, size: t.size, status: d.status } });
    }

    const complete = cand.length <= chosen.length;
    return { items, coverage, nextCursor: encodeCursor(next, now.toISOString()), complete, ...(quietItems.length ? { quietItems } : {}), ...(decisions.length ? { decisions } : {}) };
  }

  async listForReconcile(_scope: string, window: TimeWindow, _opts?: { signal: AbortSignal }): Promise<CoverageObject[]> {
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    return (await this.listTranscripts())
      .filter((t) => t.mtimeMs >= from && t.mtimeMs < to)
      .map((t) => ({ kind: 'session' as const, ref: t.sessionId }));
  }

  private toItem(
    t: { path: string; sessionId: string; mtimeMs: number; size: number },
    s: TranscriptState,
    d: Derived,
    reg: RegistryEntry | undefined,
    dm: DesktopMeta | undefined,
    bg: { count: number; labels: string[] },
    cwd: string | undefined,
    branch: string | undefined,
    nowMs: number,
  ): NormalizedSourceItem {
    // Title priority: user-set desktop title > custom-title > desktop title > ai-title > agent-name > first prompt.
    const title =
      (dm?.titleSource === 'user' ? dm.title : undefined) ??
      s.titles.custom ??
      dm?.title ??
      reg?.name ??
      s.titles.ai ??
      s.titles.agentName ??
      (s.firstPrompt ? norm(s.firstPrompt).slice(0, 60) : undefined) ??
      '(untitled session)';
    const hostSessionId = reg?.hostSessionId ?? dm?.sessionId;
    const tagId = findCcTag(s.firstPrompt);
    const ccTag = tagId
      ? {
          id: tagId,
          source: 'first_prompt' as const,
          // Which identifier the tag equals, in case the launcher reuses a session id as the tag.
          matchesSessionId: tagId === t.sessionId,
          matchesHostSessionId: !!hostSessionId && tagId === hostSessionId,
        }
      : undefined;
    const summaryRaw = s.awaySummary ? `${s.awaySummary}\n${s.lastAssistantText ?? ''}` : (s.lastAssistantText ?? '');
    const summary = redactExcerpt(norm(summaryRaw).slice(-400), 400);
    const archived = dm?.isArchived === true;
    const scheduled = s.scheduled || !!dm?.scheduledTaskId;
    const statusAge = reg?.statusUpdatedAt ? Math.max(0, Math.round((nowMs - reg.statusUpdatedAt) / 1000)) : undefined;
    const turns = s.turns ?? [];
    const lastTurn = turns[turns.length - 1];
    // the turns are recorded content (a new prompt, a turn that ran on), never what the model reads (sessionMeaningHash)
    const hash = h16(t.sessionId, d.status, d.waitingFor, d.errorKind, title, branch, cwd, bg.count, summary.text, tagId, archived ? 'a' : '', !!reg?.alive ? 'live' : 'gone', `t${TURNS_V}:${turns.length}:${lastTurn?.[1] ?? ''}`);
    const repoRel = (p: string) => (cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p);
    return {
      connector: 'claude_sessions',
      kind: 'claude_session',
      externalId: t.sessionId,
      dedupeKey: `claude:${t.sessionId}`,
      contentHash: hash,
      occurredAt: new Date(s.lastTs ? Date.parse(s.lastTs) : t.mtimeMs).toISOString(),
      title: redact(title).text,
      excerpt: summary.text.slice(0, 1000),
      redacted: summary.redacted,
      threadRef: `claude-session:${t.sessionId}`,
      fileRefs: undefined,
      payload: {
        sessionId: t.sessionId,
        hostSessionId,
        ccTag,
        status: d.status,
        waitingFor: d.waitingFor,
        statusReason: d.reason,
        statusConfidence: d.confidence,
        statusSoft: d.soft === true,
        errorKind: d.errorKind,
        resumable: d.resumable === true,
        hasLiveProcess: !!reg?.alive,
        entrypoint: reg?.entrypoint ?? s.entrypoint,
        statusAgeSeconds: statusAge,
        title: redact(title).text,
        cwd,
        repo: repoOfCwd(cwd),
        branch,
        startedAt: s.firstTs,
        lastActivityAt: s.lastTs ?? new Date(t.mtimeMs).toISOString(),
        lastHumanPromptAt: s.lastHumanTs,
        humanPromptCount: s.humanPromptCount,
        // every prompt and the end of Claude's turn after it (timestamps only): the time engine's engaged time
        humanTurns: turns.map(([a, b]) => [a, b]),
        firstPrompt: s.firstPrompt ? redact(norm(s.firstPrompt).slice(0, 300)).text : undefined,
        summary: summary.text,
        backgroundAgents: bg.count,
        backgroundAgentLabels: bg.labels,
        filesTouchedCount: s.filesTouched.length,
        filesTouched: s.filesTouched.slice(0, 15).map(repoRel),
        archived,
        scheduled,
        forkedFrom: dm?.forkedFromSessionId,
        compactions: s.compactions,
        costUsd: s.costUsd,
        error: dm?.error ? redact(dm.error).text.slice(0, 200) : undefined,
      },
    };
  }
}
