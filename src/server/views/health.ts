/**
 * Health, read side (R7 step 3): the connector summary (Today's Health line, Home's footer), the event log, and the
 * spend holds and asks (GET /spend/holds; the db governor in datasource/db/spend.ts re-exports those three, so the mock
 * reads them without the scanner store or the job queue: ENG-5, docs/reviews/2026-11-20-holistic/21-engine-fanout.md).
 */
import type { ConnectorState, EventLogEntry, HealthSummary, ScanRun, ScansPayload, SpendAsk, SpendHold, SpendHoldsPayload } from '@/contract';
import { askMoreUsd, askQuestion, quantile } from '@/llm/spend/governor';
import type { Hold } from '@/llm/spend/types';
import { connectorRowsFor, personaOf } from '@/personas';

import type { ReadSource } from './source';

const STATE_SEVERITY: Record<ConnectorState, number> = { ok: 0, paused: 1, catching_up: 2, degraded: 3, offline: 4, error: 5, auth_needed: 6 };

export function healthSummary(src: ReadSource): HealthSummary {
  // D-55: only the sources active for the persona (Today's Health line, Home's footer)
  const cs = connectorRowsFor(src.all('connectors'), personaOf(src.settings()));
  const worst = cs.reduce<ConnectorState>((w, c) => (STATE_SEVERITY[c.state] > STATE_SEVERITY[w] ? c.state : w), 'ok');
  return {
    ok: cs.filter((c) => c.state === 'ok' || c.state === 'catching_up').length,
    total: cs.length,
    worst,
    broken: cs.filter((c) => STATE_SEVERITY[c.state] >= 3).map((c) => ({ id: c.id, label: c.label, state: c.state })),
  };
}

/** GET /events/log: newest first, with the unacknowledged count. */
export function eventLogView(src: ReadSource): { entries: EventLogEntry[]; unacknowledged: number } {
  const entries = src.all('eventLog').sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  return { entries, unacknowledged: entries.filter((e) => !e.acknowledged).length };
}

/** The API shape of a hold. */
export function spendHoldView(h: Hold): SpendHold {
  return {
    id: h.id,
    scope: h.scope,
    jobKey: h.jobKey,
    estimate: { p50: h.estimate.p50, p90: h.estimate.p90, basis: h.estimate.basis, n: h.estimate.n },
    heldUsd: h.heldUsd,
    spentUsd: h.spentUsd,
    state: h.state,
    budget: h.budget,
    budgetDay: h.budgetDay,
    askedAt: h.askedAt,
    answeredAt: h.answeredAt,
    answerUsd: h.answerUsd,
    createdAt: h.createdAt,
    settledAt: h.settledAt,
  };
}

/** An asked hold as Health's row / the Assistant card: the plain question and the "Allow $Z more" amount. */
export function spendAskOf(h: Hold, pctDone: number | null = null): SpendAsk {
  const moreUsd = askMoreUsd(h);
  return { holdId: h.id, scope: h.scope, question: askQuestion(h, pctDone, moreUsd), spentUsd: h.spentUsd, heldUsd: h.heldUsd, moreUsd, askedAt: h.askedAt ?? h.createdAt };
}

/** GET /spend/holds: holds since a time, the open asks, and the receipts' counts (both DataSources). */
export function spendHoldsPayload(holds: Hold[], open: Hold[]): SpendHoldsPayload {
  const asked = holds.filter((h) => h.askedAt).length;
  const approved = holds.filter((h) => h.answeredAt && h.state !== 'denied').length;
  const denied = holds.filter((h) => h.state === 'denied').length;
  const over = holds
    .filter((h) => (h.state === 'settled' || h.state === 'denied') && h.heldUsd > 0 && h.spentUsd > h.heldUsd)
    .map((h) => ((h.spentUsd - h.heldUsd) / h.heldUsd) * 100)
    .sort((a, b) => a - b);
  return {
    holds: holds.map(spendHoldView),
    asks: open
      .filter((h) => h.state === 'asked')
      .sort((a, b) => ((a.askedAt ?? '') < (b.askedAt ?? '') ? -1 : 1))
      .map((h) => spendAskOf(h)),
    summary: { asked, approved, denied, overrunMedianPct: over.length ? Math.round(quantile(over, 0.5)) : null },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
/**
 * The scan ledger's paging (GET /scans, caps audit F-2; both DataSources call it, so they page alike). Newest first by
 * started at; runs that started at the same instant keep their load order (the db's created at, id; the mock's
 * insertion order), as before paging. The cursor is a keyset of the last run shown: its started-at instant and how
 * many runs of that instant were shown (`s:<startedAt>|<n>`), so a scan that starts between pages neither repeats
 * nor skips a row. A page size, never a cap: the last page's `nextCursor` is null.
 */
const SCAN_PREFIX = 's:';

export function scanCursorOf(startedAt: string, shownAtInstant: number): string {
  return `${SCAN_PREFIX}${startedAt}|${shownAtInstant}`;
}

/** The key a cursor names, or null (no cursor, or one this module did not make: read from the start). */
export function parseScanCursor(c: string | undefined): { startedAt: string; n: number } | null {
  if (!c?.startsWith(SCAN_PREFIX)) return null;
  const body = c.slice(SCAN_PREFIX.length);
  const bar = body.lastIndexOf('|');
  const n = Number(body.slice(bar + 1));
  if (bar <= 0 || !Number.isInteger(n) || n < 0) return null;
  return { startedAt: body.slice(0, bar), n };
}

export function scanPage(all: readonly ScanRun[], q: { limit: number; cursor?: string }): ScansPayload {
  const sorted = [...all].sort((a, b) => b.startedAt.localeCompare(a.startedAt)); // stable: ties keep load order
  const k = parseScanCursor(q.cursor);
  let start = 0;
  if (k) {
    while (start < sorted.length && sorted[start]!.startedAt > k.startedAt) start++;
    for (let seen = 0; seen < k.n && start < sorted.length && sorted[start]!.startedAt === k.startedAt; seen++) start++;
  }
  const end = Math.min(sorted.length, start + q.limit);
  const runs = sorted.slice(start, end);
  const last = runs[runs.length - 1];
  let nextCursor: string | null = null;
  if (end < sorted.length && last) {
    let n = 0;
    for (let i = end - 1; i >= 0 && sorted[i]!.startedAt === last.startedAt; i--) n++;
    nextCursor = scanCursorOf(last.startedAt, n);
  }
  return { runs, nextCursor, total: all.length };
}
