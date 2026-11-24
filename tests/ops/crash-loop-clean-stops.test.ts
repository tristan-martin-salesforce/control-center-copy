/**
 * ON-30: clean stops (SIGTERM from our own bootout/kickstart/install) take their start back out of worker-starts.json,
 * so repeated installs are not a crash loop; the doctor reads a `blocked` heartbeat's last_error_code to say why.
 * Temp folders only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { countWorkerStart, forgetWorkerStart, readWorkerStarts } from '@/ops/crash';
import { checkHeartbeat } from '../../src/ops/checks/heartbeat';
import type { DoctorContext } from '../../src/ops/checks/types';

let home: string;
const NOW = Date.parse('2026-11-21T15:00:00Z');
const state = () => join(home, 'state');
const file = () => join(state(), 'worker-starts.json');
const min = 60_000;

function ctx(): DoctorContext {
  return {
    env: { HOME: home, CC_STATE_DIR: state(), CC_LAUNCH_AGENTS_DIR: join(home, 'agents') },
    repoRoot: home,
    exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    now: () => NOW,
    portOpen: async () => false,
    withDb: async () => null,
    fetchStatus: async () => null,
    freeBytes: () => 50 * 1024 ** 3,
    uid: 501,
    claudeBin: 'claude',
  } as DoctorContext;
}
function beat(lastErrorCode: string | null) {
  const at = new Date(NOW - 5_000).toISOString();
  writeFileSync(join(state(), 'worker.heartbeat'), JSON.stringify({ v: 1, instance_id: 'x', pid: 1, state: 'blocked', started_at: at, beat_at: at, seq: 1, active_jobs: 0, app_version: '2.0.0', last_error_code: lastErrorCode }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-crash-clean-'));
  mkdirSync(state(), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('ON-30: clean stops do not count', () => {
  it('seven starts that each end in a clean stop are no crash loop', () => {
    for (let i = 0; i < 7; i++) {
      const t = NOW + i * min;
      expect(countWorkerStart(file(), t).loop).toBe(false);
      forgetWorkerStart(t, file());
    }
    expect(readWorkerStarts(file())).toEqual([]);
  });

  it('unclean exits still count: the sixth start in 10 minutes is a loop', () => {
    let last = { loop: false, starts: [] as number[] };
    for (let i = 0; i < 6; i++) last = countWorkerStart(file(), NOW + i * min);
    expect(last.loop).toBe(true);
  });

  it('forgets only its own start', () => {
    countWorkerStart(file(), NOW);
    countWorkerStart(file(), NOW + min);
    forgetWorkerStart(NOW + min, file());
    forgetWorkerStart(NOW + 5 * min, file()); // not counted: no change
    expect(readWorkerStarts(file())).toEqual([NOW]);
  });
});

describe('ON-30: the doctor says why a worker is blocked', () => {
  it('crash_loop: restarts counted, waiting, not a schema mismatch', async () => {
    writeFileSync(file(), JSON.stringify([1, 2, 3, 4, 5, 6].map((i) => NOW - i * min)));
    beat('crash_loop');
    const r = await checkHeartbeat(ctx());
    expect(r.code).toBe('BUG.WORKER_CRASH_LOOP');
    expect(r.detail).toContain('the worker restarted 6 times in 10 minutes and is waiting');
    expect(r.fix).toContain('report it from the Feedback button');
    expect(r.detail).not.toContain('schema');
  });

  it('schema_mismatch keeps the schema text', async () => {
    beat('schema_mismatch');
    const r = await checkHeartbeat(ctx());
    expect(r.code).toBe('DATA.SCHEMA_BEHIND');
    expect(r.detail).toContain("the database schema differs from the worker's build");
  });

  it('any other reason gets its own line', async () => {
    beat('something_else');
    const r = await checkHeartbeat(ctx());
    expect(r.code).toBeUndefined();
    expect(r.detail).toContain('waiting (something_else');
  });
});
