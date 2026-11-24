/**
 * The running app's version (D-57): what a teammate reads off the sidebar footer or Settings ▸ About when someone
 * asks "which version are you on?". Versions follow semver (docs/RELEASING.md); the build embeds the short git sha
 * and the build time, and the worker records its own version in `worker_instances.app_version`.
 */
import { z } from 'zod';
import { IsoDateTime } from './common';
import { PersonaId, PersonaLevel } from './persona';

/**
 * D-90: the worker's last update check (src/jobs/handlers/update-check.ts) against the shared Drive folder's release
 * feed. Absent in mock mode and before the first check. The Health ▸ Setup banner renders it (p3-health-setup); the
 * update itself is "Ask Claude Code to update" (`prompt`), because the Drive read path reads text, not a build.
 */
export const VersionUpdate = z.object({
  /** A newer release than this build exists on this install's channel. */
  available: z.boolean(),
  /** The newest release on the channel ("2.1.0"); null when the feed has none. */
  version: z.string().nullable().optional(),
  /** Its CHANGELOG section (markdown), from the feed. */
  notes: z.string().optional(),
  channel: z.enum(['stable', 'beta']),
  publishedAt: IsoDateTime.nullable(),
  /** When the check last ran, and whether it could read the feed (`error`: no_folder, drive_auth, feed_invalid, …). */
  checkedAt: IsoDateTime.optional(),
  error: z.string().nullable().optional(),
  /** What to paste into Claude Code to download, verify and install it (present when `available`). */
  prompt: z.string().optional(),
});
export type VersionUpdate = z.infer<typeof VersionUpdate>;

/** POST /version/check-updates: the check was queued (db) or answered from the last result (mock). */
export const CheckForUpdatesResult = z.object({
  queued: z.boolean(),
  jobId: z.number().int().nullable().default(null),
  update: VersionUpdate.nullable().default(null),
});
export type CheckForUpdatesResult = z.infer<typeof CheckForUpdatesResult>;

export const VersionPayload = z.object({
  /** package.json version at build time ("1.0.0"). */
  version: z.string(),
  /** Short git sha the build came from; null outside a git checkout. */
  sha: z.string().nullable(),
  /** When this build was made (dev: when the dev server started). */
  builtAt: IsoDateTime.nullable(),
  /** Files that differed from `sha` when this was built (PKG-4): > 0 reads "modified" (local changes). */
  dirty: z.number().int().nonnegative(),
  /** Release channel: stable or beta for a release build (CC_CHANNEL), dev for any build from source. */
  channel: z.enum(['stable', 'beta', 'dev']),
  /** The latest database migration applied ("0011_vdp_asset_candidates"); null in mock mode or before the first migrate. */
  migration: z.string().nullable(),
  /** The latest migration this build ships; differs from `migration` until `npm run db:migrate` runs. */
  bundledMigration: z.string().nullable(),
  persona: z.object({ id: PersonaId, level: PersonaLevel, label: z.string() }),
  /** The running worker's version (worker_instances.app_version); null when no worker is running. */
  workerVersion: z.string().nullable(),
  /** The web app and the worker run different versions (restart both: `npm run update`). */
  mismatch: z.boolean(),
  /** The build ships migrations the database has not applied yet. */
  migrationPending: z.boolean(),
  dataSource: z.enum(['mock', 'db']),
  /** D-90: a newer release on the shared Drive folder (absent in mock mode and before the first update check). */
  update: VersionUpdate.nullable().optional(),
  /** D-90: the compiled release this runs from (version, channel, arch from its manifest); absent for a source checkout. */
  release: z.object({ version: z.string(), channel: z.string().nullable(), arch: z.string().nullable(), builtAt: z.string().nullable() }).optional(),
  /**
   * ON-23: which install answers: the first 16 hex of sha256 of the folder the web runs from (its release's real path),
   * so the installer's health poll can tell its own web from another app (or another install) on the same port.
   */
  instance: z.string().optional(),
});
export type VersionPayload = z.infer<typeof VersionPayload>;
