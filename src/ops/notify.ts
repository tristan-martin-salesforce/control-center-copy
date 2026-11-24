/**
 * macOS notifications (D-22, UI-SPEC §9).
 *
 * Only four kinds ever reach the OS (everything else is inline / rail / badge, never a notification):
 *   waiting_on_you   a Claude session or run became "waiting on you" (only when the app isn't focused)
 *   failed_top3      a run failed and its task is in the Top 3
 *   connector_broken a connector broke and today's data is affected
 *   brief_high       a High-relevance brief, only if the user opted in
 * One notification per transition: the dedupe key is remembered until the caller `resolve()`s it
 * (the item left that state), so a flapping or still-broken thing never re-notifies.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { run as realRun, type ExecFn } from './exec';
import { APP_PORT, notifyStatePath } from './paths';

export const NOTIFY_KINDS = ['waiting_on_you', 'failed_top3', 'connector_broken', 'brief_high'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export interface NotifyRequest {
  kind: NotifyKind;
  /** Entity the transition happened to: session id, work item id, connector name, brief id. */
  entityId: string;
  /** The transition name, e.g. "waiting", "failed", "auth_needed". Part of the dedupe key. */
  transition: string;
  title: string;
  body: string;
  /** App-relative path ("/agents?run=123") or a full http://localhost:4327 URL. */
  url?: string;
  /** Is the Command Center window focused right now? waiting_on_you is suppressed when it is. */
  appFocused?: boolean;
}

export type NotifyOutcome =
  | { sent: true; key: string }
  | { sent: false; key: string; reason: 'deduped' | 'quiet_hours' | 'rate_limited' | 'app_focused' | 'opted_out' | 'invalid_kind' | 'send_failed' };

export interface QuietHours {
  /** "HH:MM" local. Wraps midnight when start > end (e.g. 21:00 to 07:00). */
  start: string;
  end: string;
}

export interface NotifierOptions {
  statePath?: string;
  quietHours?: QuietHours | null;
  /** brief_high only fires when true (user opt-in, UI-SPEC §9). */
  briefHighOptIn?: boolean;
  /** Global cap per rolling hour. */
  maxPerHour?: number;
  /** Min gap between two notifications of the same kind. */
  minGapMsByKind?: Partial<Record<NotifyKind, number>>;
  now?: () => Date;
  exec?: ExecFn;
  /** Override for tests; defaults to detecting terminal-notifier. */
  terminalNotifierPath?: string | null;
  port?: number;
}

interface State {
  /** dedupe key -> epoch ms first sent */
  sent: Record<string, number>;
  /** epoch ms of recent sends (rolling-hour rate limit) */
  recent: number[];
  lastByKind: Partial<Record<NotifyKind, number>>;
}

const DEDUPE_TTL_MS = 7 * 24 * 3600_000;
const SECRETISH = /(xox[abp]-[\w-]+|sk-[\w-]{8,}|Bearer\s+[\w.~+/=-]+|eyJ[\w-]{10,}\.[\w-]+\.[\w-]+|00D\w{12,}![\w.]+|(?:password|token|cookie|secret)\s*[:=]\s*\S+)/gi;

export function sanitize(text: string, max = 160): string {
  const t = text.replace(SECRETISH, '[redacted]').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function dedupeKey(r: Pick<NotifyRequest, 'kind' | 'entityId' | 'transition'>): string {
  return `${r.kind}:${r.entityId}:${r.transition}`;
}

export function isQuietNow(q: QuietHours | null | undefined, now: Date): boolean {
  if (!q) return false;
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = toMin(q.start);
  const e = toMin(q.end);
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** Only localhost:<port> links; relative paths are resolved against it. Anything else is dropped. */
export function clickUrl(url: string | undefined, port = APP_PORT): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, `http://localhost:${port}`);
    if (u.protocol !== 'http:' || u.hostname !== 'localhost' || Number(u.port) !== port) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export interface NotifyCommand {
  cmd: string;
  args: string[];
  via: 'terminal-notifier' | 'osascript';
  clickable: boolean;
}

/**
 * Pure command construction. osascript gets title/body as argv items (never interpolated into the
 * script), so quotes or AppleScript in the text cannot inject anything.
 * osascript cannot carry a click action; terminal-notifier can (-open), so it is preferred when present.
 */
export function buildNotifyCommand(opts: { title: string; body: string; url: string | null; group: string; terminalNotifier: string | null }): NotifyCommand {
  if (opts.terminalNotifier) {
    const args = ['-title', opts.title, '-message', opts.body, '-group', opts.group,];
    if (opts.url) args.push('-open', opts.url);
    return { cmd: opts.terminalNotifier, args, via: 'terminal-notifier', clickable: Boolean(opts.url) };
  }
  return {
    cmd: '/usr/bin/osascript',
    args: [
      '-e', 'on run argv',
      '-e', 'display notification (item 1 of argv) with title (item 2 of argv) subtitle "Command Center"',
      '-e', 'end run',
      opts.body,
      opts.title,
    ],
    via: 'osascript',
    clickable: false,
  };
}

export class Notifier {
  private readonly o: Required<Pick<NotifierOptions, 'maxPerHour' | 'port'>> & NotifierOptions;
  private tnPath: string | null | undefined;

  constructor(opts: NotifierOptions = {}) {
    this.o = { maxPerHour: 6, port: APP_PORT, ...opts };
    this.tnPath = opts.terminalNotifierPath;
  }

  private get statePath() {
    return this.o.statePath ?? notifyStatePath();
  }
  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  private load(): State {
    try {
      const s = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<State>;
      return { sent: s.sent ?? {}, recent: s.recent ?? [], lastByKind: s.lastByKind ?? {} };
    } catch {
      return { sent: {}, recent: [], lastByKind: {} };
    }
  }
  private save(s: State): void {
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.statePath);
  }

  private async terminalNotifier(): Promise<string | null> {
    if (this.tnPath !== undefined) return this.tnPath;
    const exec = this.o.exec ?? realRun;
    const r = await exec('/usr/bin/which', ['terminal-notifier'], { timeoutMs: 3000 });
    this.tnPath = r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    return this.tnPath;
  }

  /** Decide (and, if allowed, send). Suppressed-by-quiet-hours and rate-limited requests are NOT remembered, so a still-true condition can retry on the next sweep. */
  async notify(req: NotifyRequest): Promise<NotifyOutcome> {
    const key = dedupeKey(req);
    if (!NOTIFY_KINDS.includes(req.kind)) return { sent: false, key, reason: 'invalid_kind' };
    const now = this.now();
    const t = now.getTime();
    const st = this.load();
    for (const [k, at] of Object.entries(st.sent)) if (t - at > DEDUPE_TTL_MS) delete st.sent[k];
    st.recent = st.recent.filter((x) => t - x < 3600_000);

    if (st.sent[key]) return { sent: false, key, reason: 'deduped' };
    if (req.kind === 'brief_high' && !this.o.briefHighOptIn) return { sent: false, key, reason: 'opted_out' };
    if (req.kind === 'waiting_on_you' && req.appFocused) return { sent: false, key, reason: 'app_focused' };
    if (isQuietNow(this.o.quietHours, now)) return { sent: false, key, reason: 'quiet_hours' };
    const gap = this.o.minGapMsByKind?.[req.kind] ?? 0;
    const last = st.lastByKind[req.kind];
    if (st.recent.length >= this.o.maxPerHour || (gap > 0 && last !== undefined && t - last < gap)) {
      return { sent: false, key, reason: 'rate_limited' };
    }

    const cmd = buildNotifyCommand({
      title: sanitize(req.title, 60),
      body: sanitize(req.body),
      url: clickUrl(req.url, this.o.port),
      group: key,
      terminalNotifier: await this.terminalNotifier(),
    });
    const r = await (this.o.exec ?? realRun)(cmd.cmd, cmd.args, { timeoutMs: 5000 });
    if (r.code !== 0) return { sent: false, key, reason: 'send_failed' };

    st.sent[key] = t;
    st.recent.push(t);
    st.lastByKind[req.kind] = t;
    this.save(st);
    return { sent: true, key };
  }

  /** The entity left that state (connector recovered, item no longer waiting): the next transition may notify again. */
  resolve(r: Pick<NotifyRequest, 'kind' | 'entityId' | 'transition'>): void {
    const st = this.load();
    if (st.sent[dedupeKey(r)] !== undefined) {
      delete st.sent[dedupeKey(r)];
      this.save(st);
    }
  }
}
