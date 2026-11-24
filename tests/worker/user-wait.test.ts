/** ON-18: the worker keeps beating while it waits for Getting started to make a user (fake clock, fake sleep). */
import { describe, expect, it } from 'vitest';

import { classifyHeartbeat, HEARTBEAT_INTERVAL_MS, type Heartbeat } from '@/ops/heartbeat';
import { waitForUser } from '@/ops/user-wait';

describe('waitForUser', () => {
  it('beats at least every HEARTBEAT_INTERVAL_MS while there is no user, and looks again every minute', async () => {
    let t = 0;
    const beats: number[] = [];
    const looks: number[] = [];
    const user = await waitForUser({
      resolve: async () => (looks.push(t), t >= 180_000 ? { id: 'u1' } : null),
      stopping: () => false,
      beat: () => void beats.push(t),
      log: () => {},
      sleep: async (ms) => void (t += ms),
    });
    expect(user).toEqual({ id: 'u1' });
    expect(looks).toEqual([0, 60_000, 120_000, 180_000]);
    // never a gap longer than one interval between beats: the doctor's "fresh" check holds the whole wait
    const gaps = beats.slice(1).map((b, i) => b - beats[i]!);
    expect(Math.max(...gaps, t - beats.at(-1)!)).toBeLessThanOrEqual(HEARTBEAT_INTERVAL_MS);
    const last = { beat_at: new Date(beats.at(-1)!).toISOString() } as Heartbeat;
    expect(classifyHeartbeat(last, t).health).toBe('fresh');
  });

  it('a user at once: no wait, no beat; stopping mid-wait: null, quickly', async () => {
    const beats: number[] = [];
    expect(await waitForUser({ resolve: async () => ({ id: 'u1' }), stopping: () => false, beat: () => void beats.push(1), log: () => {}, sleep: async () => {} })).toEqual({ id: 'u1' });
    expect(beats).toEqual([]);
    let slept = 0;
    const r = await waitForUser({ resolve: async () => null, stopping: () => slept >= 2, beat: () => {}, log: () => {}, sleep: async () => void (slept += 1) });
    expect(r).toBeNull();
    expect(slept).toBe(2);
  });
});
