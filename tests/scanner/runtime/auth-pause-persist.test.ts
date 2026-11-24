/**
 * E3 (audit 2026-11-13, lane E): VDP's auth pause survives a restart. The stored "needs re-auth" (connectors.status)
 * starts the VDP scope paused, so a restarted worker doesn't retry a sign-in that already failed; a cookie refreshed
 * after the last refusal lifts it at startup. A spec that doesn't opt in behaves as before. Memory store, placeholders.
 */
import { describe, expect, it } from 'vitest';

import { deterministicSpec } from '../../../src/scanner/runtime/connectors';
import type { RuntimeLogEvent } from '../../../src/scanner/runtime/scanner-runtime';
import type { DeterministicFetcher } from '../../../src/scanner/types';
import { makeWorld } from './helpers/world';

const NOW = '2026-11-14T16:00:00.000Z';
const at = (minAgo: number) => new Date(Date.parse(NOW) - minAgo * 60_000).toISOString();

function fetcher(connector: 'vdp' | 'gmail', issuedAt: number | null = null): DeterministicFetcher {
  return {
    connector,
    scopes: async () => [connector === 'vdp' ? 'mine' : 'sent'],
    async fetch(_scope, _cursor, window) {
      return { items: [], coverage: [{ kind: 'mailbox_range', ref: `${connector}:x`, from: window.from, to: window.to }], nextCursor: { value: window.to, at: window.to }, complete: true };
    },
    health: async () => ({ state: 'ok', checkedAt: NOW }),
    ...(connector === 'vdp' ? { credentialsIssuedAt: () => issuedAt } : {}),
  };
}

/** A fresh runtime over a store that already recorded VDP's health: a worker restart. */
async function restart(o: { stored?: 'auth_required' | 'ok'; failedMinAgo?: number; issuedMinAgo?: number | null; connector?: 'vdp' | 'gmail' }) {
  const connector = o.connector ?? 'vdp';
  const issued = o.issuedMinAgo === undefined || o.issuedMinAgo === null ? null : Date.parse(at(o.issuedMinAgo));
  const w = makeWorld({ now: NOW, script: async () => ({}) as never, specs: [deterministicSpec(fetcher(connector, issued))] });
  if (o.stored) await w.store.recordHealth(connector, { state: o.stored, errorClass: o.stored === 'ok' ? undefined : 'auth', detail: 'cookie_expired', checkedAt: at(o.failedMinAgo ?? 10) });
  const events: RuntimeLogEvent[] = [];
  (w.runtime as unknown as { deps: { log?: (e: RuntimeLogEvent) => void } }).deps.log = (e) => void events.push(e);
  const jobs = await w.runtime.planJobs();
  return { ...w, jobs: jobs.filter((j) => j.kind === 'scan' && j.connector === connector), events };
}

describe('VDP auth pause across a restart (E3)', () => {
  it('a stored "needs re-auth" starts the scope paused: no job is planned', async () => {
    const r = await restart({ stored: 'auth_required' });
    expect(r.jobs).toEqual([]);
    expect(r.runtime.status().find((s) => s.connector === 'vdp')).toMatchObject({ paused: 'auth' });
    expect(r.events).toContainEqual(expect.objectContaining({ event: 'paused', connector: 'vdp', code: 'auth_stored' }));
  });

  it('a cookie refreshed after the last refusal lifts it at startup', async () => {
    const r = await restart({ stored: 'auth_required', failedMinAgo: 10, issuedMinAgo: 2 });
    expect(r.jobs.length).toBeGreaterThan(0);
    expect(r.runtime.status().find((s) => s.connector === 'vdp')?.paused).toBeUndefined();
    expect(r.events).toContainEqual(expect.objectContaining({ event: 'resumed', connector: 'vdp', code: 'credentials_refreshed' }));
  });

  it('the same old cookie keeps it paused (issued before the refusal)', async () => {
    const r = await restart({ stored: 'auth_required', failedMinAgo: 10, issuedMinAgo: 50 });
    expect(r.jobs).toEqual([]);
  });

  it('a healthy stored state plans as usual', async () => {
    const r = await restart({ stored: 'ok' });
    expect(r.jobs.length).toBeGreaterThan(0);
  });

  it('Re-auth (resumeConnector) lifts a stored pause like a live one', async () => {
    const r = await restart({ stored: 'auth_required' });
    expect(r.runtime.resumeConnector('vdp')).toEqual(['mine']);
    expect((await r.runtime.planJobs()).filter((j) => j.kind === 'scan' && j.connector === 'vdp').length).toBeGreaterThan(0);
  });

  it('a connector that does not opt in starts unpaused, as before', async () => {
    const r = await restart({ stored: 'auth_required', connector: 'gmail' });
    expect(r.jobs.length).toBeGreaterThan(0);
  });
});
