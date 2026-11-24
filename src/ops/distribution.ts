/**
 * Where releases are published (D-90): the user's `settings.distribution` row, else the team defaults in
 * config/team.json (`distributionDriveFolderId`, `distributionAnnounceChannel`, `distributionAnnounceChannelName`),
 * else CC_DISTRIBUTION_FOLDER_ID / CC_DISTRIBUTION_CHANNEL from the environment. Ids only; a malformed value reads as
 * empty (never a guess).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DistributionSettings } from '@/contract';

const FOLDER = /^[A-Za-z0-9_-]{10,}$/;
const CHANNEL = /^[CG][A-Z0-9]{8,}$/;

export interface Distribution {
  driveFolderId: string;
  announceChannel: string;
  announceChannelName: string;
  channel: 'stable' | 'beta';
  checkForUpdates: boolean;
  /** Where the folder id came from. */
  source: 'settings' | 'team' | 'env' | 'none';
}

export function readTeamDistribution(file = process.env.CC_TEAM_CONFIG ?? join(process.cwd(), 'config', 'team.json')): Partial<Distribution> {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
    return { driveFolderId: s('distributionDriveFolderId'), announceChannel: s('distributionAnnounceChannel'), announceChannelName: s('distributionAnnounceChannelName') };
  } catch {
    return {};
  }
}

export function resolveDistribution(settings: unknown, team: Partial<Distribution> = readTeamDistribution(), env: Record<string, string | undefined> = process.env): Distribution {
  const parsed = DistributionSettings.safeParse(settings ?? {});
  const s = parsed.success ? parsed.data : DistributionSettings.parse({});
  const pick = (re: RegExp, ...vals: Array<string | undefined>) => vals.map((v) => (v ?? '').trim()).find((v) => re.test(v)) ?? '';
  const folder = pick(FOLDER, s.driveFolderId, team.driveFolderId, env.CC_DISTRIBUTION_FOLDER_ID);
  const announce = pick(CHANNEL, s.announceChannel, team.announceChannel, env.CC_DISTRIBUTION_CHANNEL);
  const source: Distribution['source'] = !folder ? 'none' : FOLDER.test(s.driveFolderId) ? 'settings' : FOLDER.test(team.driveFolderId ?? '') ? 'team' : 'env';
  const name = announce && announce === s.announceChannel ? s.announceChannelName : announce && announce === team.announceChannel ? (team.announceChannelName ?? '') : '';
  return { driveFolderId: folder, announceChannel: announce, announceChannelName: name, channel: s.channel, checkForUpdates: s.checkForUpdates, source };
}

/** The folder's link (for the handoff and the docs; it carries no credentials). */
export const driveFolderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;
