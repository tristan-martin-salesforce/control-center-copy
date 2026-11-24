/**
 * The doctor check on the heartbeat's `last_error_code`: it names the Health catalog entry and its fix, pasteable in
 * a compiled release; it stays quiet when the worker is stopped or dead (the heartbeat line covers that). Fakes only:
 * a temp state folder, no worker, no database.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ALL_CHECKS, checkWorkerError, DB_FREE_CHECKS, pasteableStep, type CheckResult, type DoctorContext } from '../../src/ops/checks';
import { setupDependencies } from '../../src/ops/doctor-service';
import type { ExecResult } from '../../src/ops/exec';

let home: string;
const NOW = Date.parse('2026-11-21T10:00:00Z');
const res = (o: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...o });

function ctx(over: Partial<DoctorContext> = {}): DoctorContext {
  return {
    env: { HOME: home, CC_STATE_DIR: join(home, 'state') },
    repoRoot: join(home, 'repo'),
    exec: async () => res({ code: 1 }),
    now: () => NOW,
    portOpen: async () => false,
    withDb: async () => null,
    fetchStatus: async () => null,
    freeBytes: () => 50 * 1024 ** 3,
    uid: 501,
    claudeBin: 'claude',
    ...over,
  };
}

function beat(o: { state?: string; ageMs?: number; code?: string | null } = {}) {
  mkdirSync(join(home, 'state'), { recursive: true });
  const hb = { v: 1, instance_id: 'h:1:u', pid: 1, state: o.state ?? 'idle', started_at: new Date(NOW - 3600_000).toISOString(), beat_at: new Date(NOW - (o.ageMs ?? 5_000)).toISOString(), seq: 3, active_jobs: 0, app_version: '2.0.0', last_error_code: o.code ?? null };
  writeFileSync(join(home, 'state', 'worker.heartbeat'), JSON.stringify(hb));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-worker-error-'));
  mkdirSync(join(home, 'repo'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('doctor: the worker heartbeat last_error_code', () => {
  it('is registered after the heartbeat and runs without the database', () => {
    const ids = ALL_CHECKS.map(([id]) => id);
    expect(ids.indexOf('worker-error')).toBe(ids.indexOf('heartbeat') + 1);
    expect(DB_FREE_CHECKS).toContain('worker-error');
  });

  it('no heartbeat, a stopped worker or a dead one: skip (the heartbeat line says what to do)', async () => {
    expect((await checkWorkerError(ctx())).status).toBe('skip');
    beat({ state: 'stopped', code: 'DEP.DB.DOWN' });
    expect((await checkWorkerError(ctx())).status).toBe('skip');
    beat({ ageMs: 10 * 60_000, code: 'DEP.DB.DOWN' });
    expect((await checkWorkerError(ctx())).status).toBe('skip');
  });

  it('alive with no error: ok', async () => {
    beat();
    expect(await checkWorkerError(ctx())).toMatchObject({ id: 'worker-error', status: 'ok', detail: 'none' });
  });

  it('a catalog code names the entry and its fix (critical fails)', async () => {
    beat({ code: 'DEP.DB.DOWN' });
    const r = await checkWorkerError(ctx());
    expect(r).toMatchObject({ status: 'fail', code: 'DEP.DB.DOWN', detail: "The database isn't running (DEP.DB.DOWN)" });
    expect(r.fix).toMatch(/^Start it: launchctl kickstart -k gui\/\$UID\/com\.commandcenter\.db/);
  });

  it("the worker's own short codes map to their catalog entries", async () => {
    beat({ state: 'blocked', code: 'schema_mismatch' });
    expect(await checkWorkerError(ctx())).toMatchObject({ status: 'warn', code: 'DATA.SCHEMA_BEHIND', fix: 'Run: npm run update', data: { last_error_code: 'schema_mismatch' } });
    beat({ state: 'blocked', code: 'crash_loop' });
    expect(await checkWorkerError(ctx())).toMatchObject({ status: 'fail', code: 'BUG.WORKER_CRASH_LOOP' });
  });

  it('a code the catalog does not know: a warning that names it and asks for a report', async () => {
    beat({ code: 'something_new' });
    expect(await checkWorkerError(ctx())).toMatchObject({ status: 'warn', code: 'BUG.UNKNOWN', detail: 'the worker reported something_new, which the Health catalog does not know' });
  });

  it('in a compiled release the npm command in the fix names releases/current, quoted', async () => {
    writeFileSync(join(home, 'repo', 'manifest.json'), '{}');
    beat({ state: 'blocked', code: 'schema_mismatch' });
    const r = await checkWorkerError(ctx());
    expect(r.fix).toBe('Run: npm --prefix "$HOME/state/releases/current" run update');
    expect(pasteableStep({ repoRoot: join(home, 'elsewhere'), env: {} }, 'Run: npm run doctor')).toBe('Run: npm run doctor');
  });

  it('Health ▸ Setup: the worker row shows the last error while the heartbeat is ok', () => {
    const hb: CheckResult = { id: 'heartbeat', label: 'Worker heartbeat', status: 'ok', detail: 'idle', state: 'ok' };
    const err: CheckResult = { id: 'worker-error', label: "Worker's last error", status: 'warn', detail: 'x', code: 'DATA.SCHEMA_BEHIND', state: 'installed' };
    const worker = (checks: CheckResult[]) => setupDependencies({ checks, generated_at: '2026-11-21T10:00:00Z' }).find((d) => d.id === 'worker');
    expect(worker([hb])).toMatchObject({ state: 'ok' });
    expect(worker([hb, err])).toMatchObject({ state: 'installed', code: 'DATA.SCHEMA_BEHIND' });
    const down: CheckResult = { ...hb, status: 'fail', code: 'DEP.WORKER.DOWN', state: 'installed' };
    expect(worker([down, err])).toMatchObject({ code: 'DEP.WORKER.DOWN' });
  });

  it('the VDP row reads for whoever has the VDP source (no persona in its words)', () => {
    const vdp = setupDependencies({ checks: [], generated_at: '2026-11-21T10:00:00Z' }).find((d) => d.id === 'vdp-access');
    expect(vdp?.why).toBe('Keeps your VDPs current.');
  });
});
