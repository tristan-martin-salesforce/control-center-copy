/**
 * ask #14 (W6): Postgres unreachable when the worker starts. The worker waits with backoff instead of exiting into a
 * crash loop, names the cause for the heartbeat, and stops waiting on SIGTERM. Pure (fake probe, fake sleep).
 */
import { describe, expect, it } from 'vitest';

import { dbDownCode, dbWaitDelayMs, dbWaitedMessage, waitForDatabase, DB_WAIT_MAX_MS } from '@/worker/db-wait';
import { interruptedMessage, pidOfWorker } from '@/worker/recovery';

const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });

describe('waiting for the database at start', () => {
  it('backs off 2 s, 4 s, 8 s … at most a minute, then starts when it answers', async () => {
    let t = 0;
    let calls = 0;
    const waits: Array<{ attempt: number; delayMs: number; code: string }> = [];
    const r = await waitForDatabase({
      probe: async () => {
        calls += 1;
        if (calls < 5) throw refused();
      },
      stopping: () => false,
      sleep: async (ms) => void (t += ms),
      now: () => t,
      onWait: (e) => waits.push(e),
    });
    expect(r).toEqual({ ok: true, attempts: 5, waitedMs: 2_000 + 4_000 + 8_000 + 16_000, code: 'DEP.DB.DOWN' });
    expect(waits.map((w) => w.delayMs)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(waits.every((w) => w.code === 'DEP.DB.DOWN')).toBe(true);
    expect(dbWaitDelayMs(20)).toBe(DB_WAIT_MAX_MS);
  });

  it('answers at once when the database is up (no wait, no Health row)', async () => {
    const r = await waitForDatabase({ probe: async () => undefined, stopping: () => false, sleep: async () => undefined });
    expect(r).toMatchObject({ ok: true, attempts: 1, code: null });
  });

  it('a missing database is DEP.DB.MISSING (doctor says to run the installer)', () => {
    expect(dbDownCode(Object.assign(new Error('database "x" does not exist'), { code: '3D000' }))).toBe('DEP.DB.MISSING');
    expect(dbDownCode(refused())).toBe('DEP.DB.DOWN');
    expect(dbDownCode(Object.assign(new Error('the database system is starting up'), { code: '57P03' }))).toBe('DEP.DB.DOWN');
  });

  it('stops waiting when the worker is asked to stop (SIGTERM during the wait)', async () => {
    let stopping = false;
    let slept = 0;
    const r = await waitForDatabase({
      probe: async () => {
        throw refused();
      },
      stopping: () => stopping,
      sleep: async (ms) => {
        slept += ms;
        if (slept >= 3_000) stopping = true;
      },
    });
    expect(r.ok).toBe(false);
    expect(slept).toBeLessThan(10_000);
  });

  it('the Health row says how long it waited, in plain words', () => {
    expect(dbWaitedMessage(3 * 60_000)).toMatch(/waited 3 min and started once it answered/);
    expect(dbWaitedMessage(12_000)).toMatch(/waited 12 s/);
  });
});

describe('recovery helpers', () => {
  it('reads the pid of a worker id on this Mac only', () => {
    expect(pidOfWorker('mac.local:4242:0f8c7d2e-1111-2222-3333-444455556666', 'mac.local')).toBe(4242);
    expect(pidOfWorker('other.local:4242:0f8c7d2e-1111-2222-3333-444455556666', 'mac.local')).toBeNull();
    expect(pidOfWorker('test:abc', 'mac.local')).toBeNull();
    expect(pidOfWorker(null, 'mac.local')).toBeNull();
  });

  it("names the scope in Health's words", () => {
    expect(interruptedMessage('gmail', 'inbox')).toBe('Inbox: a scan stopped when the app closed; it picks up where it left off.');
    expect(interruptedMessage('slack', 'inbox', true)).toBe('Slack inbox: a scan stopped when the app closed; it picked up where it left off.');
  });
});
