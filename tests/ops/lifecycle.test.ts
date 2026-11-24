import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { eventually } from '../support/until';
import { Lifecycle, SingleInstanceLock, WakeDetector, type PgLike } from '../../src/ops/lifecycle';

describe('Lifecycle', () => {
  const quiet = { log: () => undefined };

  it('stops claiming, aborts runs, runs steps in order and returns 0', async () => {
    const life = new Lifecycle(quiet);
    const order: string[] = [];
    life.onShutdown('timers', () => void order.push('timers'));
    life.onShutdown('flush', async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('flush');
    });
    life.onShutdown('pool', () => void order.push('pool'));
    expect(life.stopping).toBe(false);
    expect(life.signal.aborted).toBe(false);
    const code = await life.shutdown('SIGTERM');
    expect(code).toBe(0);
    expect(life.stopping).toBe(true);
    expect(life.signal.aborted).toBe(true);
    expect(order).toEqual(['timers', 'flush', 'pool']);
  });

  it('is idempotent: a second signal does not rerun steps', async () => {
    const life = new Lifecycle(quiet);
    const fn = vi.fn();
    life.onShutdown('x', fn);
    await Promise.all([life.shutdown('SIGTERM'), life.shutdown('SIGINT')]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('continues after a failing step and reports exit code 1', async () => {
    const life = new Lifecycle(quiet);
    const after = vi.fn();
    life.onShutdown('boom', () => {
      throw new Error('secret detail');
    });
    life.onShutdown('after', after);
    expect(await life.shutdown('SIGTERM')).toBe(1);
    expect(after).toHaveBeenCalled();
  });

  it('gives up after the timeout', async () => {
    const life = new Lifecycle({ ...quiet, timeoutMs: 20 });
    life.onShutdown('hang', () => new Promise(() => undefined));
    expect(await life.shutdown('SIGTERM')).toBe(1);
  });

  it('installSignalHandlers wires SIGTERM and SIGINT to shutdown + exit', async () => {
    const handlers: Record<string, () => void> = {};
    const exit = vi.fn();
    const life = new Lifecycle({ ...quiet, exit });
    life.installSignalHandlers({ on: ((sig: string, fn: () => void) => void (handlers[sig] = fn)) as never });
    expect(Object.keys(handlers).sort()).toEqual(['SIGINT', 'SIGTERM']);
    handlers.SIGTERM!();
    await eventually(() => expect(exit).toHaveBeenCalledWith(0));
  });
});

describe('WakeDetector', () => {
  it('fires only on a clock jump beyond the interval + threshold', () => {
    let t = 1_000_000;
    const wakes: number[] = [];
    const d = new WakeDetector((e) => wakes.push(e.gapMs), { intervalMs: 5000, thresholdMs: 30_000, now: () => t });
    t += 5000;
    expect(d.check()).toBeNull(); // normal tick
    t += 9000; // a late tick (busy loop) is not a sleep
    expect(d.check()).toBeNull();
    t += 8 * 3600_000; // laptop lid closed overnight
    const ev = d.check();
    expect(ev?.gapMs).toBeGreaterThan(7 * 3600_000);
    expect(wakes).toHaveLength(1);
    t += 5000;
    expect(d.check()).toBeNull(); // back to normal afterwards
  });
});

describe('SingleInstanceLock', () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'cc-lock-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fakePg = (grant: boolean) => {
    const calls: string[] = [];
    const client: PgLike = {
      query: async (sql) => {
        calls.push(sql);
        return { rows: [{ ok: grant }] };
      },
    };
    return { client, calls };
  };

  it('acquires, blocks a live second holder, and releases', async () => {
    const pidFile = join(dir, 'worker.pid');
    const a = new SingleInstanceLock({ pidFile, pid: 111, alive: () => true });
    expect(await a.acquire()).toEqual({ acquired: true });
    const b = new SingleInstanceLock({ pidFile, pid: 222, alive: () => true });
    expect(await b.acquire()).toEqual({ acquired: false, reason: 'pidfile', holderPid: 111 });
    await a.release();
    expect(existsSync(pidFile)).toBe(false);
    expect(await b.acquire()).toEqual({ acquired: true });
  });

  it('takes over a stale pid file', async () => {
    const pidFile = join(dir, 'worker.pid');
    writeFileSync(pidFile, '999999');
    const l = new SingleInstanceLock({ pidFile, pid: 5, alive: () => false });
    expect((await l.acquire()).acquired).toBe(true);
  });

  it('uses the advisory lock and cleans the pid file when it is held elsewhere', async () => {
    const pidFile = join(dir, 'worker.pid');
    const { client } = fakePg(false);
    const l = new SingleInstanceLock({ pidFile, client, pid: 7, alive: () => true });
    expect(await l.acquire()).toEqual({ acquired: false, reason: 'advisory' });
    expect(existsSync(pidFile)).toBe(false);
  });

  it('takes then unlocks the advisory lock', async () => {
    const { client, calls } = fakePg(true);
    const l = new SingleInstanceLock({ pidFile: join(dir, 'p'), client, pid: 7, alive: () => true });
    expect((await l.acquire()).acquired).toBe(true);
    await l.release();
    expect(calls[0]).toContain('pg_try_advisory_lock');
    expect(calls[1]).toContain('pg_advisory_unlock');
  });
});
