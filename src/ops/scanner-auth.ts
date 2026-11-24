/**
 * W0-1 (wave-0 review): scanners and relays run with `settingSources: []` (src/llm/claude-env.ts
 * `scannerSettingSources`). If Claude Code's MCP OAuth resolution on some machine needs the user settings file, every
 * Slack/Org62 read fails, and it would read as "sign in to Slack". This keeps a tiny record of the Slack/Org62 scan
 * outcomes per setting-sources value (state folder, `scanner-auth.json`: times, codes, the sources value; no ids, no
 * text) and says when an auth failure looks like that cause instead:
 *
 *   - the failure (AUTH.SLACK.*, AUTH.ORG62.*, MCP.SERVER_NOT_DECLARED) ran under `[]`, and the same connector
 *     succeeded under `['user']` within the 24 h before it; or
 *   - it is the first outcome under `[]` (no success under `[]` ever) and CC_SCANNER_SETTING_SOURCES is unset.
 *
 * Either way, one fingerprinted app_events row (`doctor|DEP.CLAUDE.SETTINGS_SOURCES`, written by the worker when it
 * sees it and kept or resolved by the doctor's 15-minute run: src/jobs/handlers/doctor.ts) names the switch
 * (CC_SCANNER_SETTING_SOURCES=user for the worker) and offers Report this. A later success under `[]` clears it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scannerSettingSources } from '../llm/claude-env';
import { stateDir } from './paths';

export const SETTINGS_SOURCES_CODE = 'DEP.CLAUDE.SETTINGS_SOURCES';
const WATCHED = new Set(['slack', 'org62']);
const AUTH_CODE = /^(AUTH\.(SLACK|ORG62)\.|MCP\.SERVER_NOT_DECLARED$)/;
const DAY = 24 * 3600_000;

export interface ConnectorAuthRecord {
  /** The last success: when, and under which setting sources ('' = none, 'user', …). */
  lastOk?: { at: number; sources: string };
  /** The last success under ['user'] (case a). */
  lastUserOkAt?: number;
  /** Whether any run under `[]` ever succeeded. */
  everOkEmpty?: boolean;
  lastAuthFail?: { at: number; sources: string; code: string };
}

export interface ScannerAuthState {
  v: 1;
  byConnector: Record<string, ConnectorAuthRecord>;
}

export const scannerAuthPath = (env: Record<string, string | undefined> = process.env) => join(stateDir(env), 'scanner-auth.json');

/** The setting sources the scanners run with now ('' for none). */
export const currentSources = (env: Record<string, string | undefined> = process.env): string => scannerSettingSources(env as NodeJS.ProcessEnv).join(',');

export function emptyState(): ScannerAuthState {
  return { v: 1, byConnector: {} };
}

/** Pure: the state after one outcome. Only Slack and Org62, and only auth-class failures, are kept. */
export function withOutcome(s: ScannerAuthState, e: { connector: string; ok: boolean; code?: string | null; sources: string; at: number }): ScannerAuthState {
  if (!WATCHED.has(e.connector)) return s;
  const cur = { ...(s.byConnector[e.connector] ?? {}) };
  if (e.ok) {
    cur.lastOk = { at: e.at, sources: e.sources };
    if (e.sources === 'user') cur.lastUserOkAt = e.at;
    if (e.sources === '') cur.everOkEmpty = true;
  } else if (e.code && AUTH_CODE.test(e.code)) {
    cur.lastAuthFail = { at: e.at, sources: e.sources, code: e.code };
  } else return s;
  return { ...s, byConnector: { ...s.byConnector, [e.connector]: cur } };
}

export interface SettingsSourcesSuspect {
  connector: string;
  code: string;
  why: 'after_user_success' | 'first_run_under_none';
  at: number;
}

/** Pure: whether a recorded auth failure looks like the setting-sources change (see the header). */
export function settingsSourcesSuspect(s: ScannerAuthState, env: Record<string, string | undefined> = process.env): SettingsSourcesSuspect | null {
  for (const [connector, r] of Object.entries(s.byConnector)) {
    const f = r.lastAuthFail;
    if (!f || f.sources !== '') continue;
    if (r.lastOk && r.lastOk.at > f.at) continue; // it worked again since
    if (r.lastUserOkAt !== undefined && f.at - r.lastUserOkAt >= 0 && f.at - r.lastUserOkAt <= DAY) return { connector, code: f.code, why: 'after_user_success', at: f.at };
    if (!r.everOkEmpty && !(env.CC_SCANNER_SETTING_SOURCES ?? '').trim()) return { connector, code: f.code, why: 'first_run_under_none', at: f.at };
  }
  return null;
}

export function readScannerAuth(file = scannerAuthPath()): ScannerAuthState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as ScannerAuthState;
    return raw && raw.v === 1 && raw.byConnector && typeof raw.byConnector === 'object' ? raw : emptyState();
  } catch {
    return emptyState();
  }
}

/**
 * Record one Slack/Org62 outcome (the worker's ScannerRuntime `onScanOutcome`). A success is written at most every
 * 10 minutes unless something it records changed; best effort, never throws. Returns the state after it.
 */
export function noteScanOutcome(e: { connector: string; ok: boolean; code?: string | null }, o: { env?: Record<string, string | undefined>; now?: number; file?: string } = {}): ScannerAuthState | null {
  if (!WATCHED.has(e.connector)) return null;
  const env = o.env ?? process.env;
  const at = o.now ?? Date.now();
  const file = o.file ?? scannerAuthPath(env);
  const sources = currentSources(env);
  const before = readScannerAuth(file);
  const next = withOutcome(before, { ...e, sources, at });
  if (next === before) return before;
  const r = before.byConnector[e.connector];
  // a success that changes nothing recorded (same sources, nothing failed since, written under 10 min ago) is skipped
  const pendingFail = !!r?.lastAuthFail && (!r.lastOk || r.lastOk.at < r.lastAuthFail.at);
  if (e.ok && r?.lastOk && r.lastOk.sources === sources && !pendingFail && (sources !== '' || r.everOkEmpty) && at - r.lastOk.at < 10 * 60_000) return before;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(next));
    renameSync(`${file}.tmp`, file);
  } catch {
    /* best effort */
  }
  return next;
}

/** The app_events row's words (the catalog's entry carries the next step and the Report this button). */
export function settingsSourcesMessage(s: SettingsSourcesSuspect): string {
  const who = s.connector === 'org62' ? 'Org62' : 'Slack';
  return s.why === 'after_user_success'
    ? `${who} reads started failing sign-in after the scanners stopped loading your Claude settings file; they worked with it within the last day.`
    : `${who} reads failed sign-in on their first run without your Claude settings file; Claude Code may need that file to find the sign-in.`;
}
