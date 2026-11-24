/**
 * D-90: the daily update check (src/jobs/handlers/update-check.ts): when it last ran, whether it could read the
 * release feed in the shared Drive folder, and whether a newer version is there. A newer version is not a problem
 * (status ok, `data.available`: the Health banner offers it); a check that fails or is older than three days warns
 * DEP.UPDATE.CHECK_FAILED.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { updateCheckPath } from '../paths';
import { compareVersions, readUpdateStatus } from '../release';
import { bad, ok, type Check } from './types';

const LABEL = 'Updates';
const STALE_MS = 3 * 86_400_000;

const ago = (ms: number) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min ago` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)} h ago` : `${Math.round(ms / 86_400_000)} days ago`);

function versionAt(root: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export const checkUpdate: Check = async (c) => {
  const s = readUpdateStatus(updateCheckPath(c.env));
  if (!s) return bad('skip', 'update', LABEL, 'not checked yet (the worker checks the Drive folder once a day)');
  const age = Math.max(0, c.now() - Date.parse(s.checkedAt));
  const current = versionAt(c.repoRoot) ?? s.current;
  const latest = s.latest?.version ?? null;
  const available = !!latest && compareVersions(latest, current) > 0;
  const data = { checkedAt: s.checkedAt, current, latest, available, channel: s.channel, error: s.error };
  const fix = s.error === 'no_folder' ? 'set distributionDriveFolderId in config/team.json (or Settings), then Check for updates' : 'check Google in Health (devbar sign-in), then Check for updates';
  if (!s.ok) return bad('warn', 'update', LABEL, `the last check (${ago(age)}) could not read the release feed (${s.error ?? 'unknown'})`, fix, data, { code: 'DEP.UPDATE.CHECK_FAILED' });
  if (age > STALE_MS) return bad('warn', 'update', LABEL, `last checked ${ago(age)}`, 'is the worker running? Then Check for updates', data, { code: 'DEP.UPDATE.CHECK_FAILED' });
  return ok('update', LABEL, available ? `v${latest} is available (${s.channel}); ask Claude Code to update (docs/INSTALL.md)` : `up to date (v${current}), checked ${ago(age)}`, data);
};
