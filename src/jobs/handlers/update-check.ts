/**
 * `update.check` (queue `maintenance`, D-90): once a day (src/worker/schedules.ts) and on "Check for updates"
 * (POST /version/check-updates), read the release feed from the shared Drive folder and compare it with this build.
 *
 *   1. the folder: settings.distribution, else config/team.json, else CC_DISTRIBUTION_FOLDER_ID (src/ops/distribution.ts)
 *   2. search_drive_files  "'<folder>' in parents and name = 'manifest.json'"   (devbar's google_workspace_readonly)
 *   3. get_drive_file_content {file_id}: the feed's text → parsed and checked (src/ops/release.ts)
 *   4. compare with this build's version on the install's channel → <state>/update-check.json, which GET /version
 *      (`update`) and doctor's `update` check read
 *
 * Both tools go through the Drive connector's runtime with RELEASE_FEED_READ_TOOLS as its allowlist
 * (src/connectors/google/manifest.ts): read-only, no model, zero cost (*Read-only ingest*). Nothing is downloaded or
 * installed here: the read path returns a file's text, so a 100-200 MB build can't come through it; the update is
 * "Ask Claude Code to update" with the exact prompt (docs/INSTALL.md), and the installer checks the build's sha256
 * against this feed before anything in it runs. jobs.result holds versions and codes only.
 */
import { sql } from 'drizzle-orm';

import { GoogleCallError, GoogleWorkspaceClient } from '@/connectors/google/client';
import { RELEASE_FEED_READ_TOOLS } from '@/connectors/google/manifest';
import { parseDriveSearch } from '@/connectors/google/parse';
import { directMcpRuntime } from '@/connectors/runtime/direct-mcp';
import type { ConnectorRuntime } from '@/connectors/runtime/types';
import type { DbOrTx } from '@/db/client';
import { resolveDistribution, type Distribution } from '@/ops/distribution';
import { compareWithFeed, parseReleaseFeed, writeUpdateStatus, type UpdateStatus } from '@/ops/release';
import { buildInfo } from '@/server/version';

import type { JobHandlerDef } from '../types';

export const UPDATE_CHECK_KIND = 'update.check';
export const FEED_FILE_NAME = 'manifest.json';

export interface UpdateCheckDeps {
  /** The Drive read runtime (default: devbar's Google gateway, Drive allowlist = RELEASE_FEED_READ_TOOLS). */
  runtime?: () => ConnectorRuntime;
  distribution?: (db: DbOrTx, userId: string) => Promise<Distribution>;
  /** This build's version and channel (default: buildInfo(), i.e. the release's package.json). */
  build?: () => { version: string; channel: string };
  arch?: string;
  write?: (s: UpdateStatus) => void;
}

const defaultRuntime = () => directMcpRuntime({ connector: 'drive', readTools: RELEASE_FEED_READ_TOOLS, client: new GoogleWorkspaceClient() });

async function distributionOf(db: DbOrTx, userId: string): Promise<Distribution> {
  const r = await db.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${userId} and key = 'settings.distribution'`);
  return resolveDistribution(r.rows[0]?.value ?? null);
}

/** The error code a failed read is recorded with (no message text). */
export function feedErrorCode(err: unknown): string {
  if (err instanceof GoogleCallError) return err.info.errorClass === 'auth' ? 'drive_auth' : err.info.daemonDown || err.info.devbarMissing ? 'devbar_down' : err.info.objectScoped ? 'drive_no_access' : `drive_${err.info.errorClass}`;
  if (err instanceof SyntaxError || (err instanceof Error && /feed|JSON|schema|literal/i.test(err.message))) return 'feed_invalid';
  return 'unknown';
}

/** One check, pure over its deps (tests/release/update-check.test.ts). */
export async function runUpdateCheck(o: { runtime: ConnectorRuntime; dist: Distribution; build: { version: string; channel: string }; arch?: string; now: Date }): Promise<UpdateStatus> {
  const base = { checkedAt: o.now.toISOString(), current: o.build.version, channel: o.dist.channel, folderId: o.dist.driveFolderId || null };
  if (!o.dist.driveFolderId) return { ...base, ok: false, error: 'no_folder', available: false, latest: null, readTools: [] };
  const used: string[] = [];
  try {
    const q = `'${o.dist.driveFolderId}' in parents and name = '${FEED_FILE_NAME}' and trashed = false`;
    used.push('search_drive_files');
    const found = await o.runtime.call('search_drive_files', { query: q, detailed: true, page_size: 5, include_items_from_all_drives: true });
    const file = parseDriveSearch(found.text).files.find((f) => f.name === FEED_FILE_NAME);
    if (!file) return { ...base, ok: false, error: 'feed_missing', available: false, latest: null, readTools: used };
    used.push('get_drive_file_content');
    const content = await o.runtime.call('get_drive_file_content', { file_id: file.id });
    const feed = parseReleaseFeed(content.text);
    const { latest, available } = compareWithFeed(feed, o.build.version, o.dist.channel, o.arch ?? null);
    return { ...base, ok: true, error: null, available, latest, readTools: used };
  } catch (err) {
    return { ...base, ok: false, error: feedErrorCode(err), available: false, latest: null, readTools: used };
  }
}

export function updateCheckJobDef(d: UpdateCheckDeps = {}): JobHandlerDef {
  return {
    kind: UPDATE_CHECK_KIND,
    queue: 'maintenance',
    wired: true,
    description: 'daily update check: read the release feed in the shared Drive folder (read-only) and compare it with this build',
    handler: async (ctx) => {
      const dist = await (d.distribution ?? distributionOf)(ctx.db, ctx.userId);
      if (!dist.checkForUpdates && ctx.job.payload?.trigger !== 'manual') return { skipped: 'off' };
      const runtime = (d.runtime ?? defaultRuntime)();
      try {
        const b = (d.build ?? buildInfo)();
        const s = await runUpdateCheck({ runtime, dist, build: { version: b.version, channel: b.channel }, arch: d.arch ?? process.arch, now: ctx.clock() });
        (d.write ?? ((x) => writeUpdateStatus(x)))(s);
        ctx.log('update check done', { ok: s.ok, error: s.error, current: s.current, latest: s.latest?.version ?? null, available: s.available });
        return { ok: s.ok, error: s.error, current: s.current, latest: s.latest?.version ?? null, available: s.available };
      } finally {
        await runtime.close?.();
      }
    },
  };
}
