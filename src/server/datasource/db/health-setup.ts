/**
 * Health ▸ Setup for the db DataSource (11 R6/R7): the worker's last doctor run (state folder `doctor.json`, every
 * 15 minutes) and the user's last Claude check, as one row per dependency. Read from the file, never run on the
 * page's request, and no database read: it answers the same while Postgres is the thing that is down.
 */
import type { SetupSection } from '@/contract';
import { cachedSetup } from '@/ops/doctor-service';

export function dbHealthSetup(env: Record<string, string | undefined> = process.env): SetupSection {
  try {
    return { dependencies: cachedSetup(env) };
  } catch {
    return { dependencies: [] };
  }
}
