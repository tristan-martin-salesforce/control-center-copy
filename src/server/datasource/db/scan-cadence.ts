/**
 * Health's scan cadence data (FTI, review 04 §4.1 #6): "next check in N min" per source, from the worker's
 * `scan-cadence.json` (src/scanner/runtime/cadence-state.ts), and the first scan's per-source progress from
 * `first-scan.json`. Read-only, data only (the surfaces chunk owns the copy). The mock datasource gets the same shape
 * from the cadence defaults (mock parity).
 */
import type { Connector, FirstScanSource } from '@/contract';
import { DEFAULT_BASE_CADENCE_MS } from '@/scanner/runtime/cadence';
import { defaultCadenceFile, nextCheckBySource, readCadenceSnapshot, type CadenceSnapshot } from '@/scanner/runtime/cadence-state';
import { firstScanProgressLine, type FirstScanSourceProgress } from '@/scanner/runtime/first-scan';
import { connectorOfName } from '@/scanner/scope-catalog';

/** The worker's snapshot (null under vitest without CC_STATE_DIR, or when the worker has not written one). */
export function readWorkerCadence(env: Record<string, string | undefined> = process.env): CadenceSnapshot | null {
  const file = defaultCadenceFile(env);
  return file ? readCadenceSnapshot(file) : null;
}

/** Each Health connector with its next check (connectors with nothing planned keep null). */
export function withNextChecks(connectors: Connector[], snap: CadenceSnapshot | null, now: Date): Connector[] {
  const next = nextCheckBySource(snap, now);
  return connectors.map((c) => {
    const id = connectorOfName(c.id) ?? connectorOfName(c.source);
    const n = id ? next[id] : undefined;
    return { ...c, nextCheckAt: n?.nextCheckAt ?? null, nextCheckInMin: n?.inMinutes ?? null };
  });
}

/** Mock parity: a snapshot where each healthy source is next checked one base interval after its last success. */
export function mockCadenceSnapshot(connectors: Connector[], now: Date): CadenceSnapshot {
  const scopes: CadenceSnapshot['scopes'] = [];
  for (const c of connectors) {
    const id = connectorOfName(c.id) ?? connectorOfName(c.source);
    if (!id || c.state === 'auth_needed' || c.state === 'paused') continue;
    const base = DEFAULT_BASE_CADENCE_MS[id];
    const from = c.lastSuccessAt ? Date.parse(c.lastSuccessAt) : now.getTime();
    // the first base-interval step at or after now
    const at = from + Math.max(1, Math.ceil((now.getTime() - from) / base)) * base;
    scopes.push({ connector: id, scope: 'default', nextDueAt: new Date(at).toISOString(), quietLevel: 0, intervalMs: base });
  }
  return { version: 1, writtenAt: now.toISOString(), scopes };
}

/** first-scan.json `sources` → the contract rows, in a stable order. */
export function firstScanSources(sources: Record<string, FirstScanSourceProgress> | undefined): FirstScanSource[] | undefined {
  if (!sources || !Object.keys(sources).length) return undefined;
  return Object.entries(sources)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([connector, p]) => ({ connector, itemsRead: p.read, asksFound: p.found, linked: p.linked, spentUsd: Math.round(p.usd * 1e4) / 1e4, runs: p.runs, line: firstScanProgressLine(connector, p) }));
}
