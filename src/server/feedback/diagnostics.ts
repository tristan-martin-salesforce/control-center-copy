/**
 * The feedback post's Diagnostics block (PKG-8, 11 R8): a fixed, scrubbed code block appended to every report, so
 * reports from several teammates can be grouped ("9 of 12 are NET.GATEWAY_DOWN on v1.4.0"):
 *
 *   version · sha · modified · channel, OS, Node, Claude CLI version; worker version and mismatch; migration state;
 *   the top code; connector states with their catalog codes; the last 10 open app_events codes with counts; the
 *   doctor summary; the last 50 lines of worker.log and web.log, each through `safeLogText` (credentials) and the
 *   feedback Scrubber (names, ids), capped per line.
 *
 * The user sees and can edit the whole text before Send: it is the same Outbox item and the same dry run (*tenet:
 * Nothing leaves without approval*). Codes, states, counts and redacted log lines only (*tenet: Local data,
 * privacy-safe logs*). The block keeps under DIAGNOSTICS_MAX_CHARS by dropping the oldest log lines first, so the
 * post stays under one Slack message.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import type { Connector, EventLogPayload, HealthPayload, VersionPayload } from '@/contract';
import { codeFromStatusReason, toCatalogCode } from '@/errors/aliases';
import { safeLogText } from '@/llm/redact';
import { doctorSummaryLine } from '@/ops/doctor';
import { doctorCachePath, readCachedReport } from '@/ops/doctor-service';
import { logDir } from '@/ops/paths';
import { installedRelease } from '@/ops/release';

import type { FeedbackHost } from './host';
import type { Scrubber } from './scrub';

export const DIAGNOSTICS_MAX_CHARS = 3200;
export const LOG_TAIL_LINES = 50;
export const LOG_LINE_CAP = 140;

export interface DiagnosticsInput {
  version: string;
  sha: string | null;
  dirty: number;
  channel: string;
  os: string;
  node: string;
  claudeCli: string | null;
  workerVersion: string | null;
  mismatch: boolean;
  migration: string | null;
  migrationPending: boolean;
  connectors: Array<{ id: string; state: string; code: string | null }>;
  /** Open events: catalog code (or the stored code) → occurrences. */
  events: Array<{ code: string; count: number }>;
  doctor: string | null;
  logs: { worker: string[]; web: string[] };
  /** D-90: the compiled release this runs (from its manifest): version, channel, arch; absent for a source checkout. */
  release?: { version: string; channel: string | null; arch: string | null } | null;
}

/** A connector's catalog code: from its status line, else from its state (auth_needed is that source's sign-in). */
const CLASS_ALIAS: Record<string, string> = { auth: 'auth', transient: 'transient', rate_limited: 'rate_limited', bug: 'unknown', offline: 'network' };

export function connectorCode(c: Pick<Connector, 'id' | 'state' | 'lastError' | 'impact'> & { source?: string }): string | null {
  const who = c.source ?? c.id; // the source kind: a db connector's id is a uuid
  if (c.state === 'ok' || c.state === 'catching_up') return null;
  const fromLine = codeFromStatusReason(c.lastError?.message ?? c.impact ?? null, who);
  if (fromLine) return fromLine;
  if (c.state === 'auth_needed') return toCatalogCode('auth_needed', who);
  return c.lastError ? toCatalogCode(CLASS_ALIAS[c.lastError.class] ?? 'unknown', who) : null;
}

/** The last open events by catalog code, most frequent first (at most 10). */
export function eventCodes(log: Pick<EventLogPayload, 'entries'> | null): Array<{ code: string; count: number }> {
  const by = new Map<string, number>();
  for (const e of log?.entries ?? []) {
    if (e.level === 'info') continue;
    const code = toCatalogCode(e.code, e.source) ?? e.code;
    by.set(code, (by.get(code) ?? 0) + (e.count || 1));
  }
  return [...by].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, 10);
}

/** The last `n` lines of a file (reads at most the last 256 KB). [] when it is missing. */
export function tailLines(file: string, n = LOG_TAIL_LINES): string[] {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    return (len < size ? lines.slice(1) : lines).slice(-n);
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** A pino JSON line → "10:42:07 warn worker: scanner run_fail code=…" (ids and codes only); any other line as it is. */
export function compactLogLine(line: string): string {
  const t = line.trim();
  if (!t.startsWith('{')) return t;
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    const time = typeof j.time === 'string' ? j.time.slice(11, 19) : '';
    const keep = ['code', 'connector', 'scope', 'event', 'error', 'jobId', 'runId', 'status', 'kind'].filter((k) => j[k] !== undefined && j[k] !== null).map((k) => `${k}=${String(j[k])}`);
    return [time, j.level, `${String(j.component ?? '')}:`, j.msg, ...keep].filter((x) => x !== '' && x !== undefined).join(' ');
  } catch {
    return t;
  }
}

/** One log line, safe to post: compacted, credentials redacted, names and ids scrubbed, capped. */
export const safeLine = (line: string, sc: Scrubber, cap = LOG_LINE_CAP): string => sc.scrub(safeLogText(compactLogLine(line), cap * 2)).slice(0, cap);

/** The block, in Slack mrkdwn (a heading and one code block). Pure. */
export function diagnosticsBlock(i: DiagnosticsInput, sc: Scrubber, max = DIAGNOSTICS_MAX_CHARS): string {
  const bad = i.connectors.filter((c) => c.state !== 'ok' && c.state !== 'catching_up');
  const top = i.events[0]?.code ?? bad.find((c) => c.code)?.code ?? null;
  const head = [
    `version ${i.version || '?'} · sha ${i.sha ? i.sha.slice(0, 7) : '?'} · ${i.dirty > 0 ? `modified (${i.dirty} file${i.dirty === 1 ? '' : 's'})` : 'clean'} · channel ${i.channel}`,
    ...(i.release ? [`release ${i.release.version} · channel ${i.release.channel ?? '?'} · arch ${i.release.arch ?? '?'}`] : []),
    `os ${i.os} · node ${i.node} · claude ${i.claudeCli ?? '?'}`,
    `worker ${i.workerVersion ?? 'not running'}${i.mismatch ? ' (MISMATCH: restart both)' : ''} · migrations ${i.migration ?? '?'}${i.migrationPending ? ' (pending)' : ''}`,
    `top code: ${top ?? 'none'}`,
    `connectors: ${i.connectors.length ? i.connectors.map((c) => `${c.id}=${c.state}${c.code ? ` ${c.code}` : ''}`).join(', ') : 'none'}`,
    `open events: ${i.events.length ? i.events.map((e) => `${e.code}×${e.count}`).join(', ') : 'none'}`,
    `doctor: ${i.doctor ?? 'no run yet'}`,
  ].map((l) => sc.scrub(safeLogText(l, 600)));
  // a line can't close the code block early
  const fence = (l: string) => l.replace(/```/g, "'''");
  const worker = i.logs.worker.map((l) => fence(safeLine(l, sc)));
  const web = i.logs.web.map((l) => fence(safeLine(l, sc)));
  const build = (w: string[], b: string[]) =>
    ['*Diagnostics*', '```', ...head.map(fence), ...(w.length ? [`--- worker.log (last ${w.length}) ---`, ...w] : []), ...(b.length ? [`--- web.log (last ${b.length}) ---`, ...b] : []), '```'].join('\n');
  // oldest lines go first until it fits (web and worker in turn)
  let w = worker;
  let b = web;
  let out = build(w, b);
  while (out.length > max && (w.length || b.length)) {
    if (w.length >= b.length) w = w.slice(1);
    else b = b.slice(1);
    out = build(w, b);
  }
  return out.length > max ? out.slice(0, max - 4) + '\n```' : out;
}

/** D-90: the release from GET /version, else what releases/current points at; null for a source checkout. */
function releaseLine(v: VersionPayload | null, env: Record<string, string | undefined>): DiagnosticsInput['release'] {
  if (v?.release) return { version: v.release.version, channel: v.release.channel, arch: v.release.arch };
  const r = installedRelease(env);
  return r.version ? { version: r.version, channel: r.channel, arch: r.arch } : null;
}

/** What the block needs, from the DataSource's own reads, the doctor's stored report and the two logs. Never throws. */
export async function collectDiagnostics(h: Pick<FeedbackHost, 'ds' | 'live'>, o: { env?: Record<string, string | undefined> } = {}): Promise<DiagnosticsInput> {
  const env = o.env ?? process.env;
  const read = async <T>(fn: () => Promise<T>): Promise<T | null> => fn().catch(() => null);
  const [v, health, log] = await Promise.all([
    read(() => h.ds.getVersion({} as never) as Promise<VersionPayload>),
    read(() => h.ds.getHealth({} as never) as Promise<HealthPayload>),
    read(() => h.ds.getEventLog({} as never) as Promise<EventLogPayload>),
  ]);
  // mock mode is a demo: this Mac's doctor report and logs are not its story (and tests stay deterministic)
  const live = h.live ? await h.live().catch(() => false) : h.ds.kind === 'db';
  const doctor = live ? readCachedReport(doctorCachePath(env)) : null;
  const claude = doctor?.checks.find((c) => c.id === 'claude');
  const dir = logDir(env);
  return {
    version: v?.version ?? '',
    sha: v?.sha ?? null,
    dirty: v?.dirty ?? 0,
    channel: v?.channel ?? 'dev',
    os: `${os.platform()} ${os.release()}`,
    node: process.version,
    claudeCli: typeof claude?.data?.version === 'string' ? claude.data.version : null,
    // a demo (mock or a seeded database) has no worker or migrations of its own: those lines would only differ by DataSource
    workerVersion: live ? (v?.workerVersion ?? null) : null,
    mismatch: live ? (v?.mismatch ?? false) : false,
    migration: live ? (v?.migration ?? null) : null,
    migrationPending: live ? (v?.migrationPending ?? false) : false,
    connectors: (health?.connectors ?? []).map((c) => ({ id: c.source, state: c.state, code: connectorCode(c) })),
    events: eventCodes(log),
    doctor: doctor ? doctorSummaryLine(doctor) : live ? null : 'demo data (nothing checked)',
    logs: live ? { worker: tailLines(join(dir, 'worker.log')), web: tailLines(join(dir, 'web.log')) } : { worker: [], web: [] },
    // a demo is not this Mac's install either
    release: live ? releaseLine(v, env) : null,
  };
}
