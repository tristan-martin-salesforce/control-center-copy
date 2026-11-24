/**
 * GET /version (D-57): the build's version, sha and build time (embedded by next.config.ts `env`), the database's
 * latest applied migration, the persona, and the worker's version. Pure helpers; the DataSources read the database
 * and the persona and call `versionPayload`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import type { VersionPayload, VersionUpdate } from '@/contract';
import journal from '@/db/migrations/meta/_journal.json';
import { compareVersions, installedRelease, readUpdateStatus, updatePrompt, type UpdateStatus } from '@/ops/release';
import type { ResolvedPersona } from '@/personas';

/**
 * ON-17: the settings GET /version reads the persona from. The build's version needs no user: a fresh install has
 * none until Getting started runs (the installer, `npm run shot` and monitors probe this route), and then it is `{}`
 * (the default persona) without loading the user's model.
 */
export async function versionSettings<S>(o: { userId: () => Promise<unknown>; settings: () => Promise<S> }): Promise<S | Record<string, never>> {
  const hasUser = await o.userId().then(
    () => true,
    () => false,
  );
  return hasUser ? o.settings() : {};
}

export interface BuildInfo {
  version: string;
  sha: string | null;
  builtAt: string | null;
  /** Files that differed from `sha` when it was built (PKG-4: "modified"); 0 for a clean build or outside git. */
  dirty: number;
  /** stable | beta (a release build, CC_CHANNEL) or dev (anything built from source). */
  channel: BuildChannel;
}

export type BuildChannel = 'stable' | 'beta' | 'dev';

export const channelOf = (v: string | undefined): BuildChannel => (v === 'stable' || v === 'beta' ? v : 'dev');

const dirtyOf = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const ENTRIES = [...(journal as { entries: JournalEntry[] }).entries].sort((a, b) => a.idx - b.idx);

function packageVersion(): string {
  try {
    return (JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * The build's identity. Next inlines `process.env.CC_*` at build time (next.config.ts); scripts and tests that run
 * outside Next fall back to package.json and no sha.
 */
export function buildInfo(
  env: { CC_APP_VERSION?: string; CC_GIT_SHA?: string; CC_BUILT_AT?: string; CC_GIT_DIRTY?: string; CC_BUILD_CHANNEL?: string; CC_CHANNEL?: string } = {
    CC_APP_VERSION: process.env.CC_APP_VERSION,
    CC_GIT_SHA: process.env.CC_GIT_SHA,
    CC_BUILT_AT: process.env.CC_BUILT_AT,
    CC_GIT_DIRTY: process.env.CC_GIT_DIRTY,
    CC_BUILD_CHANNEL: process.env.CC_BUILD_CHANNEL,
    CC_CHANNEL: process.env.CC_CHANNEL,
  },
): BuildInfo {
  const builtAt = env.CC_BUILT_AT && !Number.isNaN(Date.parse(env.CC_BUILT_AT)) ? new Date(env.CC_BUILT_AT).toISOString() : null;
  return { version: env.CC_APP_VERSION || packageVersion(), sha: env.CC_GIT_SHA || null, builtAt, dirty: dirtyOf(env.CC_GIT_DIRTY), channel: channelOf(env.CC_BUILD_CHANNEL || env.CC_CHANNEL) };
}

/** The newest migration this build ships ("0011_vdp_asset_candidates"). */
export function bundledMigration(): string | null {
  return ENTRIES.at(-1)?.tag ?? null;
}

/**
 * The tag of the newest applied migration, from drizzle's `created_at` (the journal's `when`). An applied
 * migration this build does not know (a newer build ran migrate) reads as "newer than this build".
 */
export function migrationTagFor(createdAtMs: number | null): string | null {
  if (createdAtMs === null || !Number.isFinite(createdAtMs)) return null;
  const hit = ENTRIES.find((e) => e.when === createdAtMs);
  if (hit) return hit.tag;
  const last = ENTRIES.at(-1);
  return last && createdAtMs > last.when ? 'newer than this build' : null;
}

/** "1.2.0+abc1234" and "v1.2.0" compare as "1.2.0". */
export function coreVersion(v: string): string {
  return v.trim().replace(/^v/, '').split('+')[0]!;
}

/**
 * D-90: the worker's last update check as the contract's `update` (null: no check yet). The answer compares the feed
 * with THIS build's version, so a check written before an update never offers the version already installed.
 */
export function versionUpdateOf(s: UpdateStatus | null, buildVersion: string): VersionUpdate | null {
  if (!s) return null;
  const latest = s.latest;
  const available = !!latest && compareVersions(latest.version, buildVersion) > 0;
  return {
    available,
    version: latest?.version ?? null,
    ...(latest?.notes ? { notes: latest.notes } : {}),
    channel: s.channel === 'beta' ? 'beta' : 'stable',
    publishedAt: latest?.published_at && !Number.isNaN(Date.parse(latest.published_at)) ? new Date(latest.published_at).toISOString() : null,
    checkedAt: new Date(s.checkedAt).toISOString(),
    error: s.error,
    ...(available && latest ? { prompt: updatePrompt(latest, s.folderId) } : {}),
  };
}

export function versionPayload(input: {
  build: BuildInfo;
  migration: string | null;
  persona: Pick<ResolvedPersona, 'id' | 'level' | 'label'>;
  workerVersion: string | null;
  dataSource: 'mock' | 'db';
  /** D-90: the update check's result; default: read from the state folder (db only; the mock has none). */
  update?: VersionUpdate | null;
  /** D-90: the compiled release this runs from; default: this process's release manifest (none in a checkout). */
  release?: VersionPayload['release'] | null;
  /** ON-23: default: this process's `instanceId()`. */
  instance?: string;
}): VersionPayload {
  const bundled = bundledMigration();
  const { build, migration, persona, workerVersion, dataSource } = input;
  const update = input.update !== undefined ? input.update : dataSource === 'db' ? versionUpdateOf(readUpdateStatus(), build.version) : null;
  const rel = input.release !== undefined ? input.release : releaseOfThisProcess();
  return {
    version: build.version,
    sha: build.sha,
    builtAt: build.builtAt,
    dirty: build.dirty,
    channel: build.channel,
    migration,
    bundledMigration: bundled,
    persona: { id: persona.id, level: persona.level, label: persona.label },
    workerVersion,
    mismatch: workerVersion !== null && coreVersion(workerVersion) !== coreVersion(build.version),
    migrationPending: dataSource === 'db' && bundled !== null && migration !== bundled && migration !== 'newer than this build',
    dataSource,
    ...(update ? { update } : {}),
    ...(rel ? { release: rel } : {}),
    instance: input.instance ?? instanceId(),
  };
}

/**
 * ON-23: which install answers /version, the twin of scripts/ops/lib/release-wiring.mjs `instanceId` (keep the two in
 * step): the first 16 hex of sha256 of the folder this process runs from (a release's real path, releases/<v>). The
 * installer compares it with `current`'s, so another app, or another install of the same version, can't pass.
 */
export function instanceId(dir: string = process.cwd()): string {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    /* the folder as given */
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

/** The release manifest in this process's working directory (a compiled release), else null. */
function releaseOfThisProcess(): VersionPayload['release'] | null {
  const r = installedRelease(process.env, process.cwd());
  return r.dir === process.cwd() && r.version ? { version: r.version, channel: r.channel, arch: r.arch, builtAt: r.builtAt } : null;
}
