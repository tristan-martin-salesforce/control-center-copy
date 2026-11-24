/**
 * Signal-driven cadence, persisted (review 04 §4.1 #6): the worker writes each scope's next check and backoff level to
 * `<CC_STATE_DIR>/scan-cadence.json` (0600, like first-scan.json), so
 *   - Health can say "next check in N min" per source (data only; the surfaces chunk owns the copy), and
 *   - a restart keeps each scope's backoff instead of polling every quiet scope at its base interval again.
 * Ids, times and levels only.
 */
import fs from 'node:fs';
import path from 'node:path';

import { stateDir } from '../../ops/paths';
import type { ConnectorId } from '../types';
import type { ScopeStatus } from './scanner-runtime';

export const CADENCE_FILE = 'scan-cadence.json';

export interface CadenceScope {
  connector: ConnectorId;
  scope: string;
  nextDueAt: string;
  quietLevel: number;
  intervalMs?: number;
  paused?: string;
}

export interface CadenceSnapshot {
  version: 1;
  writtenAt: string;
  scopes: CadenceScope[];
}

export const cadenceFile = (env: Record<string, string | undefined> = process.env) => path.join(stateDir(env), CADENCE_FILE);

/** The worker's file, or null under vitest without CC_STATE_DIR (tests never touch the real state folder). */
export function defaultCadenceFile(env: Record<string, string | undefined> = process.env): string | null {
  return env.VITEST && !env.CC_STATE_DIR ? null : cadenceFile(env);
}

export function snapshotOf(status: ScopeStatus[], now: Date): CadenceSnapshot {
  const scopes = status
    .filter((s) => !s.scope.startsWith('thread:') && !s.scope.startsWith('reconcile:'))
    .map((s) => ({ connector: s.connector, scope: s.scope, nextDueAt: s.nextDueAt, quietLevel: s.quietLevel, ...(s.intervalMs ? { intervalMs: s.intervalMs } : {}), ...(s.paused ? { paused: s.paused } : {}) }))
    .sort((a, b) => `${a.connector}:${a.scope}`.localeCompare(`${b.connector}:${b.scope}`));
  return { version: 1, writtenAt: now.toISOString(), scopes };
}

export function writeCadenceSnapshot(snap: CadenceSnapshot, file = cadenceFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readCadenceSnapshot(file = cadenceFile()): CadenceSnapshot | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as CadenceSnapshot;
    return s && s.version === 1 && Array.isArray(s.scopes) ? s : null;
  } catch {
    return null;
  }
}

/** A restart's backoff seed: scope id → its level, from a snapshot no older than `maxAgeMs` (default 6 h). */
export function cadenceSeedFrom(snap: CadenceSnapshot | null, now: Date, maxAgeMs = 6 * 3_600_000): (scopeId: string) => number | undefined {
  if (!snap || now.getTime() - Date.parse(snap.writtenAt) > maxAgeMs) return () => undefined;
  const by = new Map(snap.scopes.map((s) => [`${s.connector}:${s.scope}`, s.quietLevel]));
  return (sid) => by.get(sid);
}

export interface NextCheck {
  /** The earliest next check of the source's unpaused scopes; null when every scope is paused (or none is planned). */
  nextCheckAt: string | null;
  /** Whole minutes from `now` (0 when due); null with no next check. */
  inMinutes: number | null;
  /** The scope that checks next. */
  scope: string | null;
}

/** Per source: when it is checked next ("next check in N min"). */
export function nextCheckBySource(snap: CadenceSnapshot | null, now: Date): Partial<Record<ConnectorId, NextCheck>> {
  const out: Partial<Record<ConnectorId, NextCheck>> = {};
  if (!snap) return out;
  for (const s of snap.scopes) {
    const cur = out[s.connector] ?? { nextCheckAt: null, inMinutes: null, scope: null };
    if (!s.paused && (!cur.nextCheckAt || Date.parse(s.nextDueAt) < Date.parse(cur.nextCheckAt))) {
      cur.nextCheckAt = s.nextDueAt;
      cur.scope = s.scope;
      cur.inMinutes = Math.max(0, Math.ceil((Date.parse(s.nextDueAt) - now.getTime()) / 60_000));
    }
    out[s.connector] = cur;
  }
  return out;
}
