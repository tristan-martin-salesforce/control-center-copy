/**
 * W34-4 / W34-5: the read-scope miss counter and the two doctor rows it and the migration marker feed
 * (`data:read-scopes`, `setup:state-folder`). Fakes and a temp HOME only: no real state folder.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkStateFolder, type DoctorContext } from '../../src/ops/checks';
import { checkReadScopes } from '../../src/ops/checks/data';
import { setupDependencies, withLiveScopes } from '../../src/ops/doctor-service';
import { readScoped, resetScopeMisses, scopeMissSnapshot } from '../../src/server/datasource/db/reads/session';
import { ScopeMissError } from '../../src/server/datasource/db/reads/scope';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-scopes-state-'));
  resetScopeMisses(new Date('2026-11-21T08:00:00Z'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const ctx = (over: Partial<DoctorContext> = {}) => ({ env: { HOME: home }, ...over }) as DoctorContext;

describe('scope-miss counter', () => {
  it('counts per scope label, ids-free, and the page still renders', async () => {
    const scope = { kind: 'today' } as never;
    let first = true;
    const load = async () => ({}) as never;
    const render = () => {
      if (first) {
        first = false;
        throw new ScopeMissError(scope, 'deals' as never);
      }
      return 'ok';
    };
    expect(await readScoped(scope, load, render, false)).toBe('ok');
    const snap = scopeMissSnapshot();
    expect(snap.total).toBe(1);
    expect(snap.since).toBe('2026-11-21T08:00:00.000Z');
    expect(Object.keys(snap.scopes)).toHaveLength(1);
  });
});

describe('data:read-scopes', () => {
  it('skips where the counter is not (CLI, worker)', async () => {
    expect((await checkReadScopes(ctx())).status).toBe('skip');
  });
  it('ok at zero', async () => {
    const r = await checkReadScopes(ctx({ scopeMisses: scopeMissSnapshot }));
    expect(r).toMatchObject({ status: 'ok', data: { total: 0 } });
  });
  it('warns with the count, scopes since start and the fix', async () => {
    const r = await checkReadScopes(ctx({ scopeMisses: () => ({ since: 'S', total: 3, scopes: { today: 2, deals: 1 } }) }));
    expect(r.status).toBe('warn');
    expect(r.detail).toBe('3 reads fell back to the whole model since S (scopes: today x2, deals x1)');
    expect(r.fix).toBe('report it; CC_READ_SCOPES=off if a page looks wrong');
  });
  it('the web overlay replaces the worker skip, and Setup shows the row', () => {
    const base = { generated_at: '2026-11-21T08:00:00Z', ok: true, summary: { ok: 0, warn: 0, fail: 0, skip: 1 }, checks: [{ id: 'data:read-scopes', label: 'x', status: 'skip' as const, detail: 'worker' }] };
    const live = withLiveScopes(base, () => ({ since: 'S', total: 1, scopes: { today: 1 } }));
    expect(live.checks.filter((c) => c.id === 'data:read-scopes')).toHaveLength(1);
    expect(live.summary).toMatchObject({ warn: 1, skip: 0 });
    const row = setupDependencies(live).find((d) => d.id === 'read-scopes');
    expect(row).toMatchObject({ state: 'installed', nextStep: 'report it; CC_READ_SCOPES=off if a page looks wrong' });
    expect(row?.why).toContain('1 reads fell back');
  });
});

describe('setup:state-folder', () => {
  const support = () => join(home, 'Library', 'Application Support');
  const marker = (dir: string, m: object) => {
    mkdirSync(join(support(), dir), { recursive: true });
    writeFileSync(join(support(), dir, 'migration.json'), JSON.stringify(m));
  };
  it('ok "command-center" when never migrated', async () => {
    mkdirSync(join(support(), 'command-center'), { recursive: true });
    expect(await checkStateFolder(ctx())).toMatchObject({ status: 'ok', detail: 'command-center' });
  });
  it('ok with the move date when the marker is complete', async () => {
    marker('command-center', { migratedFrom: 'control-center', completedAt: '2026-11-20T10:00:00Z', database: { status: 'renamed' } });
    expect(await checkStateFolder(ctx())).toMatchObject({ status: 'ok', detail: 'command-center (moved from control-center on 2026-11-20)' });
  });
  it('warns when the move is half done', async () => {
    marker('command-center', { migratedFrom: 'control-center', completedAt: null });
    expect(await checkStateFolder(ctx())).toMatchObject({ status: 'warn', fix: 'node scripts/ops/migrate-state.mjs' });
  });
  it('warns when the database rename was postponed', async () => {
    marker('command-center', { migratedFrom: 'control-center', completedAt: '2026-11-20T10:00:00Z', database: { status: 'kept' } });
    const r = await checkStateFolder(ctx());
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('postponed');
  });
  it('warns when only the old folder exists', async () => {
    mkdirSync(join(support(), 'control-center'), { recursive: true });
    expect((await checkStateFolder(ctx())).status).toBe('warn');
  });
});
