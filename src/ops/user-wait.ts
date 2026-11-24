/** The worker's wait for a user before Getting started (ON-18): a leaf, so its test needs nothing of the worker. */
import { HEARTBEAT_INTERVAL_MS } from './heartbeat';

/**
 * Before Getting started there is no user: look again every minute, and keep the heartbeat beating meanwhile (every
 * HEARTBEAT_INTERVAL_MS), so the doctor reads a live worker that waits, not a stale one to restart (ON-18).
 */
export async function waitForUser<U>(o: {
  resolve: () => Promise<U | null>;
  stopping: () => boolean;
  beat: () => void;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  everyMs?: number;
  beatEveryMs?: number;
}): Promise<U | null> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const every = o.everyMs ?? 60_000;
  const beatEvery = Math.min(o.beatEveryMs ?? HEARTBEAT_INTERVAL_MS, every);
  let user = await o.resolve();
  while (!user && !o.stopping()) {
    o.log('no user yet (run npm run setup or set CC_USER_EMAIL); waiting');
    for (let waited = 0; waited < every && !o.stopping(); waited += beatEvery) {
      o.beat();
      await sleep(beatEvery);
    }
    if (o.stopping()) return null;
    user = await o.resolve();
  }
  return user;
}
