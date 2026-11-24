/**
 * Daily surfaces a persona gates (D-55, "inactive means no daily surface"), as pure filters the db and mock
 * DataSources both apply, so they stay in parity: Health's connector rows (and Home's re-auth rows, which read them)
 * and the Outbox / Time admin items of an inactive feature (VDP changes without VDP).
 */
import type { Draft } from '@/contract';
import { adminSurfaceOf } from '@/contract';
import type { ConnectorId } from '@/scanner/types';
import { ALL_CONNECTORS, type ResolvedPersona } from './types';

/** Connector rows use the source kind (`gemini`, `claude`); the persona uses scanner connector ids. */
const ROW_CONNECTOR: Readonly<Record<string, ConnectorId>> = { gemini: 'gemini_notes', claude: 'claude_sessions' };

/**
 * The scanner connector a Health row stands for, or null for a row that is not one (it is always shown). The row's
 * `source` (a SourceKind) decides when it has one: the db's rows have uuid ids, the mock's use the source as the id.
 */
export function connectorOfRow(row: { id: string; source?: string | null }): ConnectorId | null {
  const key = row.source || row.id;
  const c = (ROW_CONNECTOR[key] ?? key) as ConnectorId;
  return ALL_CONNECTORS.includes(c) ? c : null;
}

/** Health / Settings ▸ Connectors / Home rows: only the sources the persona has active. No persona: all of them. */
export function connectorRowsFor<T extends { id: string; source?: string | null }>(rows: readonly T[], persona: ResolvedPersona | null | undefined): T[] {
  if (!persona) return [...rows];
  return rows.filter((r) => {
    const c = connectorOfRow(r);
    return !c || persona.connectors.includes(c);
  });
}

/** A draft's daily surface: a VDP change (`vdp.*` action) exists only while VDP is active. Every other draft shows. */
export function draftHasSurface(d: { destination: { kind: string; action?: string } }, persona: ResolvedPersona | null | undefined): boolean {
  if (!persona || d.destination.kind !== 'action') return true;
  return !String(d.destination.action ?? '').startsWith('vdp.') || persona.features.vdp === true;
}

/**
 * An admin item Time shows (D-52; the sidebar's Time badge counts these): a logging canvas (Week), a forecast canvas
 * while Specialist Forecast is active (Forecast), a VDP change while VDP is active (VDP). Messages and the feedback
 * post are the Outbox's. No persona: every admin item.
 */
export function adminOnTime(d: Pick<Draft, 'destination'>, persona: ResolvedPersona | null | undefined): boolean {
  const s = adminSurfaceOf(d);
  if (!s) return false;
  if (!persona || s === 'log') return true;
  return persona.features[s === 'vdp' ? 'vdp' : 'specialistForecast'] === true;
}

/**
 * The admin items waiting on Time (ready or failed), by the tab that holds them (D-60): logging canvases (Log it),
 * forecast canvases (Forecast), VDP changes (VDP ▸ Changes). `total` is the sidebar's loud Time count.
 */
export function adminWaitingBySurface(drafts: ReadonlyArray<Pick<Draft, 'destination' | 'status'>>, persona: ResolvedPersona | null | undefined): { total: number; log: number; forecast: number; vdp: number } {
  const out = { total: 0, log: 0, forecast: 0, vdp: 0 };
  for (const d of drafts) {
    if ((d.status !== 'ready' && d.status !== 'failed') || !adminOnTime(d, persona)) continue;
    out.total += 1;
    out[adminSurfaceOf(d) ?? 'log'] += 1;
  }
  return out;
}

const SEVERITY: Readonly<Record<string, number>> = { ok: 0, paused: 1, catching_up: 2, degraded: 3, offline: 4, error: 5, auth_needed: 6 };

/**
 * Health ▸ Setup rows that exist only for sources (src/ops/doctor-service.ts DEPENDENCIES): a row goes when every
 * source it serves is inactive for the persona (VDP for an AE: no "VDP signed out" to fix, no Setup badge for it).
 * Claude sign-in, the database, the worker and the rest serve the whole app and always show.
 */
const SETUP_DEP_SOURCES: Readonly<Record<string, readonly ConnectorId[]>> = {
  'vdp-access': ['vdp'],
  'slack-mcp': ['slack'],
  'org62-mcp': ['org62'],
  devbar: ['gmail', 'calendar', 'drive', 'gemini_notes'],
};

/** Setup's dependency rows the persona has (29-persona-qa). No persona: all of them. */
export function setupDepsFor<D extends { id: string }>(deps: readonly D[], persona: ResolvedPersona | null | undefined): D[] {
  if (!persona) return [...deps];
  return deps.filter((d) => {
    const sources = SETUP_DEP_SOURCES[d.id];
    return !sources || sources.some((c) => persona.connectors.includes(c));
  });
}

/**
 * Health as the persona sees it, applied at the very end of getHealth (db and mock): the rows of inactive sources go,
 * and the summary (the sidebar's "needs re-auth" lines, the health dot, "n of m live") is recomputed from the rows
 * that stay; Setup keeps only the dependencies of active sources (`setupDepsFor`). No persona: unchanged.
 */
export function healthForPersona<C extends { id: string; source?: string | null; state: string }, H extends { connectors: C[]; summary: { ok: number; total: number; worst: string; broken: Array<{ id: string }> }; setup?: { dependencies: Array<{ id: string }> } }>(h: H, persona: ResolvedPersona | null | undefined): H {
  if (!persona) return h;
  const deps = h.setup ? setupDepsFor(h.setup.dependencies, persona) : null;
  const withSetup: H = h.setup && deps && deps.length !== h.setup.dependencies.length ? { ...h, setup: { ...h.setup, dependencies: deps } } : h;
  return connectorsForPersona(withSetup, persona);
}

function connectorsForPersona<C extends { id: string; source?: string | null; state: string }, H extends { connectors: C[]; summary: { ok: number; total: number; worst: string; broken: Array<{ id: string }> } }>(h: H, persona: ResolvedPersona): H {
  const connectors = connectorRowsFor(h.connectors, persona);
  if (connectors.length === h.connectors.length) return h;
  const kept = new Set(connectors.map((c) => c.id));
  const worst = connectors.reduce((w, c) => ((SEVERITY[c.state] ?? 0) > (SEVERITY[w] ?? 0) ? c.state : w), 'ok');
  return {
    ...h,
    connectors,
    summary: { ...h.summary, ok: connectors.filter((c) => c.state === 'ok' || c.state === 'catching_up').length, total: connectors.length, worst, broken: h.summary.broken.filter((b) => kept.has(b.id)) },
  };
}

/**
 * A work item's "may be stale because <source> is broken" marker, only while that source is active for the persona:
 * an inactive source (VDP for an AE) never warns about anything (D-55). `rows` are the connector rows, to map the
 * marker's connector id (a row id on Postgres, the source id on the mock) to its source.
 */
export function staleFor<T extends { connectorId: string }>(stale: T | null | undefined, rows: readonly { id: string; source?: string | null }[], persona: ResolvedPersona | null | undefined): T | null {
  if (!stale) return null;
  const row = rows.find((r) => r.id === stale.connectorId) ?? { id: stale.connectorId };
  return connectorRowsFor([row], persona).length ? stale : null;
}

