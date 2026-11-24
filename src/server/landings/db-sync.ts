/**
 * D-70: one landing sync for a user in Postgres, from anywhere (the db DataSource after a write, the worker after an
 * Org62 read-back or a VDP push). It reads the model the DataSource reads, so the read-backs' verified / missing /
 * differs reach the landings without waiting for the next page load. Never throws into its caller's work: a failed sync
 * is retried by the next one (every sync is the whole pass), and its error carries only its code.
 */
import type { Db } from '@/db/client';
import { loadModel } from '@/server/datasource/db/model';
import { everything } from '@/server/datasource/db/reads/scope';
import { loadLandingWorld, syncLandingsDb } from '@/server/datasource/db/store/landings';

export async function syncLandingsForUser(db: Db, userId: string, now: Date): Promise<{ ok: boolean; error?: string }> {
  try {
    const model = await loadModel(db, userId, now, { scope: everything('landings sync') });
    const world = await loadLandingWorld(db, userId, model, now);
    await syncLandingsDb(db, userId, world);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.name : 'error' };
  }
}
