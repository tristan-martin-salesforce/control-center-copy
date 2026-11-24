/**
 * HYG-1: scan scopes. The catalog (src/scanner/scope-catalog.ts) is what Health's Rescan validates, the runtime
 * refuses, and the hygiene sweep repairs. A Health scope sent prefixed (`org62:events`) used to run as
 * `org62:org62:events`: it read nothing, said succeeded, and then re-ran on its own as a polled scope.
 */
import { describe, expect, it } from 'vitest';

import { org62Spec } from '../../src/scanner/runtime/connectors';
import { scanJob } from '../../src/scanner/runtime/jobs';
import { isKnownScope, isKnownScopeId, normalizeScanScope, placeholderScopeId, repairScopeId, validScopes } from '../../src/scanner/scope-catalog';
import { makeWorld } from '../scanner/runtime/helpers/world';

describe('normalizeScanScope: what a Rescan may ask for', () => {
  it('drops an optional <connector>: prefix once; a bare scope stays', () => {
    expect(normalizeScanScope('org62', 'org62:events')).toEqual({ ok: true, scope: 'events' });
    expect(normalizeScanScope('org62', 'events')).toEqual({ ok: true, scope: 'events' });
    expect(normalizeScanScope('org62', 'dcs')).toEqual({ ok: true, scope: 'dcs' });
    expect(normalizeScanScope('slack', 'slack:channel:C0PLACEHOLD')).toEqual({ ok: true, scope: 'channel:C0PLACEHOLD' });
    expect(normalizeScanScope('gemini_notes', 'gemini:poll')).toEqual({ ok: true, scope: 'poll' });
  });

  it('empty or "manual" means the connector default (null: the caller picks)', () => {
    expect(normalizeScanScope('org62', undefined)).toEqual({ ok: true, scope: null });
    expect(normalizeScanScope('org62', 'manual')).toEqual({ ok: true, scope: null });
  });

  it('rejects an unknown scope with the valid list (a double prefix stays unknown)', () => {
    const r = normalizeScanScope('org62', 'org62:org62:events');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.valid).toEqual(['opps', 'events', 'dcs', 'book', 'missed_opps', 'readback']);
    expect(normalizeScanScope('gmail', 'everything').ok).toBe(false);
    expect(normalizeScanScope('gmail', 'slack:inbox').ok).toBe(false); // another connector's prefix is not stripped
    expect(validScopes('slack')).toEqual(['inbox', 'channel:<id>']);
  });

  it('internal scopes are known to the ledger but never requestable', () => {
    expect(isKnownScope('slack', 'thread:C0PLACE01:1794368687.873819')).toBe(true);
    expect(normalizeScanScope('slack', 'thread:C0PLACE01:1794368687.873819').ok).toBe(false);
    expect(isKnownScope('gmail', 'completion:check')).toBe(true);
    expect(isKnownScope('slack', 'reconcile:unlinked')).toBe(true);
  });
});

describe('repairScopeId: what the sweep does with a stored ledger scope', () => {
  it('prefixes a bare placeholder scope, maps "manual" to the default, keeps known ones, drops unknown ones', () => {
    expect(repairScopeId('org62', 'dcs')).toBe('org62:dcs');
    expect(repairScopeId('vdp', 'manual')).toBe('vdp:mine');
    expect(repairScopeId('org62', 'org62:events')).toBe('org62:events');
    expect(repairScopeId('slack', 'slack:channel:#team-updates')).toBe('slack:channel:#team-updates');
    expect(repairScopeId('slack', 'slack:thread:C0PLACE01:1.1')).toBe('slack:thread:C0PLACE01:1.1');
    expect(repairScopeId('gmail', 'gmail:completion:check')).toBe('gmail:completion:check');
    expect(repairScopeId('org62', 'org62:org62:events')).toBeNull();
    expect(repairScopeId('org62', 'org62:org62:dcs')).toBeNull();
    expect(isKnownScopeId('org62:org62:events')).toBe(false);
    expect(isKnownScopeId('trainings:gmail')).toBe(true);
  });

  it('a Rescan placeholder carries the ledger id, never a bare scope', () => {
    expect(placeholderScopeId('org62', 'dcs')).toBe('org62:dcs');
    expect(placeholderScopeId('org62', null)).toBe('org62:opps');
    expect(placeholderScopeId('watch', null)).toBe('watch:rescan');
    expect(isKnownScopeId(placeholderScopeId('watch', null))).toBe(true);
  });
});

describe('ScannerRuntime refuses a scope the catalog does not know', () => {
  const NOW = '2026-11-11T16:00:00.000Z';
  const W = { from: '2026-11-11T15:00:00.000Z', to: NOW };

  it('an unknown scope fails at once (config), runs no skill, and is never registered as a polled scope', async () => {
    const w = makeWorld({ now: NOW, script: async () => undefined, specs: [org62Spec({ mcpServers: () => ({}) })] });
    const out = await w.runtime.executeJob(scanJob({ connector: 'org62', scope: 'org62:events', window: W, mode: 'manual', trigger: 'manual', runAt: NOW }));
    expect(out.status).toBe('failed');
    expect(out.errorClass).toBe('config');
    expect(out.runId).toBeUndefined();
    expect(out.detail).toMatch(/unknown scope org62:org62:events \(valid: opps, events/);
    expect(w.runner.calls).toHaveLength(0);
    expect(w.runtime.scopesOf('org62')).not.toContain('org62:events');
    // and the plan never re-runs it on its own (before: startup catch-up head + backfill chunks)
    const planned = await w.runtime.planJobs();
    expect(planned.filter((j) => j.kind === 'scan' && j.scope === 'org62:events')).toHaveLength(0);
  });

  it('a known scope still runs', async () => {
    const w = makeWorld({ now: NOW, script: async (api) => void (await api.call('cc_finish', { status: 'complete', cursor: { value: 'x', at: NOW }, coverage: [{ kind: 'query_window', ref: 'soql:Event', from: W.from, to: W.to }] }, { allowError: true })), specs: [org62Spec({ mcpServers: () => ({}) })] });
    const out = await w.runtime.executeJob(scanJob({ connector: 'org62', scope: 'events', window: W, mode: 'manual', trigger: 'manual', runAt: NOW }));
    expect(out.detail ?? '').not.toMatch(/unknown scope/);
    expect(w.runner.calls).toHaveLength(1);
  });
});
