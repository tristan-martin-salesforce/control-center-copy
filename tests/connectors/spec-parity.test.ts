/**
 * Registry dispatch parity: the scanner specs the runtime drives (src/scanner/runtime/connectors.ts) are the same
 * after the per-source branches became registry lookups. The snapshot was written from the branching code.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { deterministicSpec, org62Spec, slackSpec, type ConnectorSpec } from '@/scanner/runtime/connectors';
import type { ConnectorId, DeterministicFetcher } from '@/scanner/types';

const fake = (connector: ConnectorId, issuedAt: number | null = null): DeterministicFetcher => ({
  connector,
  scopes: async () => ['x'],
  fetch: async () => ({ items: [], coverage: [], nextCursor: null }) as never,
  health: async () => ({ state: 'ok', checkedAt: '2026-01-01T00:00:00.000Z' }),
  credentialsIssuedAt: () => issuedAt,
});

const SCOPES = ['inbox', 'channel:C1', 'events', 'opps', 'book', 'missed_opps', 'mine', 'all', 'tracked', 'primary', 'poll', 'gmail'];
const MODES = ['incremental', 'backfill', 'head', 'continuation', 'relink'] as const;

/** Every value a spec carries, functions evaluated over a grid of scopes and modes. */
function shape(s: ConnectorSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s).sort(([a], [b]) => a.localeCompare(b))) {
    if (k === 'fetcher' || k === 'precheck' || k === 'scopes' || k === 'scopeVars') continue;
    if (k === 'mcpServers') {
      out[k] = 'fn';
      continue;
    }
    if (k === 'persistAuthPause') {
      const p = v as { credentialsChangedSince?: (ms: number) => boolean };
      out[k] = { changed: p.credentialsChangedSince?.(1000) ?? null };
      continue;
    }
    if (typeof v === 'function') {
      out[k] = Object.fromEntries(SCOPES.map((sc) => [sc, Object.fromEntries(MODES.map((m) => [m, safe(() => (v as (a: string, b: string) => unknown)(sc, m))]))]));
      continue;
    }
    out[k] = v;
  }
  return out;
}
const safe = (f: () => unknown) => {
  try {
    const r = f();
    return r === undefined ? null : r;
  } catch {
    return 'throws';
  }
};

const IDS: ConnectorId[] = ['gmail', 'calendar', 'drive', 'gemini_notes', 'claude_sessions', 'trainings', 'watch', 'vdp'];

describe('scanner specs: registry dispatch keeps every value', () => {
  it('deterministic specs', async () => {
    const all = Object.fromEntries(IDS.map((id) => [id, shape(deterministicSpec(fake(id, id === 'vdp' ? 5000 : null)))]));
    await expect(`${JSON.stringify(all, null, 2)}\n`).toMatchFileSnapshot(join(__dirname, '__snapshots__', 'specs', 'deterministic.json'));
  });
  it('traversal specs', async () => {
    const all = { slack: shape(slackSpec()), org62: shape(org62Spec()) };
    await expect(`${JSON.stringify(all, null, 2)}\n`).toMatchFileSnapshot(join(__dirname, '__snapshots__', 'specs', 'traversal.json'));
  });
});
