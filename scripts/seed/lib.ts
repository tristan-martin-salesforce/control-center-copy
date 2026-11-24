/**
 * Shared helpers for the real-seed builder. Contains NO data: everything personal is read at run time from
 * ~/Library/Application Support/command-center/fixtures/raw/ (outside the repo).
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeStateDir } from '../../src/lib/state-folder';
import type { SeedInput } from '../../src/contract';

export type In = SeedInput;
export type WorkItemIn = In['workItems'][number];
export type DraftIn = In['drafts'][number];
export type NbaIn = In['nbas'][number];
export type EvidenceIn = In['evidence'][number];
export type SourceRefIn = In['evidence'][number]['source'];
export type PersonRefIn = NonNullable<WorkItemIn['owner']>;
export type EventIn = In['calendar']['events'][number];

export const APP_SUPPORT = homeStateDir();
export const RAW_DIR = path.join(APP_SUPPORT, 'fixtures/raw');
export const OUT_PATH = path.join(APP_SUPPORT, 'fixtures/seed.json');
export const VOICE_PATH = path.join(APP_SUPPORT, 'voice/profile.json');
export const SESSIONS_DIR = path.join(os.homedir(), '.claude/sessions');

export class SeedBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedBuildError';
  }
}
export function die(message: string): never {
  throw new SeedBuildError(message);
}

export function readRaw<T>(name: string): T {
  const file = path.join(RAW_DIR, name);
  if (!existsSync(file)) die(`missing raw file: ${file}. Run the SEED-raw gatherer first.`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (err) {
    return die(`raw file is not valid JSON: ${name} (${(err as Error).message})`);
  }
}

// ---------------------------------------------------------------------------
// time. The user's Mac is on America/Denver (MST = UTC-7 on 2026-11-05).
// ---------------------------------------------------------------------------
export const TZ = 'America/Denver';
const MT_OFFSET_H = 7;
/** The seed's "today". */
export const BASE = { y: 2026, m: 10, d: 5 }; // month is 0-based

/** Instant on day `off` (0 = Thu 2026-11-05) at local HH:MM Mountain Time. */
export const t = (off: number, hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(BASE.y, BASE.m, BASE.d + off, h + MT_OFFSET_H, m)).toISOString();
};
export const day = (off: number): string => t(off, '12:00').slice(0, 10);
/** Normalise any ISO string (any offset) to a UTC instant. */
export const iso = (s: string): string => {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) die(`unparseable date: ${s}`);
  return new Date(ms).toISOString();
};
/** Calendar day (YYYY-MM-DD) of an instant in Mountain Time. */
export const mtDay = (s: string): string => new Date(Date.parse(s) - MT_OFFSET_H * 3_600_000).toISOString().slice(0, 10);
/** HH:MM of an instant in Mountain Time. */
export const mtHM = (s: string): string => new Date(Date.parse(s) - MT_OFFSET_H * 3_600_000).toISOString().slice(11, 16);
/** Whole days between an instant and the seed's now. */
export const ageDaysOf = (s: string, nowIso: string): number => Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(s)) / 86_400_000));
/** An instant a given number of minutes after another. */
export const plusMin = (s: string, min: number): string => new Date(Date.parse(s) + min * 60_000).toISOString();

// ---------------------------------------------------------------------------
// text hygiene
// ---------------------------------------------------------------------------
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|cookie|bearer)\b\s*[:=]\s*\S+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Za-z0-9+_-]{56,}={0,2}\b/g, // long opaque blobs (Drive/Slack ids are shorter)
];
/** Strips anything credential-like from an excerpt. */
export function redact(s: string): string {
  let out = s;
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}
export const trunc = (s: string, n = 280): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
/** Redact + trim to the excerpt budget. Use for every string taken from a source. */
export const x = (s: string | null | undefined, n = 280): string => trunc(redact((s ?? '').replace(/\s+/g, ' ').trim()), n);

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

// ---------------------------------------------------------------------------
// Claude desktop sessions (~/.claude/sessions/*.json). Reads ONLY sessionId + hostSessionId; never the .key files.
// ---------------------------------------------------------------------------
export function loadHostSessions(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(SESSIONS_DIR)) return out;
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(SESSIONS_DIR, f), 'utf8')) as { sessionId?: unknown; hostSessionId?: unknown };
      if (typeof j.sessionId === 'string' && typeof j.hostSessionId === 'string') out.set(j.sessionId, j.hostSessionId);
    } catch {
      /* ignore unreadable session files */
    }
  }
  return out;
}

/** Final guard over the serialized seed: fails loudly if anything credential-like slipped through. */
export function assertNoCredentials(json: string): void {
  const hits: string[] = [];
  const checks: [string, RegExp][] = [
    ['password/secret/token assignment', /\b(pass(?:word|wd)?|pwd|secret|api[_-]?key)\b"?\s*[:=]\s*"?[^\s"\],}]{4,}/i],
    ['Bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/],
    ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
    ['API key', /\bsk-[A-Za-z0-9_-]{16,}/],
    ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
    ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ];
  for (const [name, re] of checks) {
    const m = re.exec(json);
    // report only the keyword and the text BEFORE it, never the matched value
    if (m) hits.push(`${name} near "${json.slice(Math.max(0, m.index - 40), m.index).replace(/\s+/g, ' ')}${m[0].slice(0, m[0].search(/[:=]/) + 1)}…"`);
  }
  if (hits.length) die(`credential-like text found in the seed (${hits.join(', ')}). Fix the source mapping; nothing was written.`);
}
