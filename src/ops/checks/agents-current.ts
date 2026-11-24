/**
 * D-90: with a compiled release installed, both LaunchAgents run it through the `current` link (WorkingDirectory and
 * programs under releases/current), so an install or a rollback reaches them by repointing the link. Agents that
 * still run a source checkout or a fixed release folder warn DEP.RELEASE.NOT_CURRENT. No release, or no agents: skip
 * (the `agents` check covers missing agents).
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';

import { currentReleaseLink, plistPath, WEB_LABEL, WORKER_LABEL } from '../paths';
import { plistProgramArgs } from './agents';
import { bad, npmRun, ok, tilde, type Check } from './types';

const LABEL = 'LaunchAgents run the installed release';

/** WorkingDirectory of a rendered plist (XML-unescaped), or null. */
export function plistWorkingDir(xml: string): string | null {
  const m = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
  return m ? m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null;
}

export const checkAgentsCurrent: Check = async (c) => {
  const link = currentReleaseLink(c.env);
  try {
    if (!lstatSync(link).isSymbolicLink()) return bad('skip', 'agents-current', LABEL, 'no compiled release installed');
  } catch {
    return bad('skip', 'agents-current', LABEL, 'no compiled release installed');
  }
  const off: string[] = [];
  let seen = 0;
  for (const [kind, label] of [['web', WEB_LABEL], ['worker', WORKER_LABEL]] as const) {
    const file = plistPath(label, c.env);
    if (!existsSync(file)) continue;
    seen++;
    const xml = readFileSync(file, 'utf8');
    const wd = plistWorkingDir(xml);
    const args = plistProgramArgs(xml) ?? [];
    const under = (p: string | null | undefined) => !!p && (p === link || p.startsWith(`${link}/`));
    if (!under(wd) || !args.slice(1).some(under)) off.push(`${kind} runs ${tilde(wd ?? '?', c.env.HOME)}`);
  }
  if (!seen) return bad('skip', 'agents-current', LABEL, 'no LaunchAgents installed');
  return off.length
    ? bad('warn', 'agents-current', LABEL, off.join('; '), `${npmRun(c, 'ops:install')}  (writes both for releases/current)`, { off }, { code: 'DEP.RELEASE.NOT_CURRENT' })
    : ok('agents-current', LABEL, `web and worker run ${tilde(link, c.env.HOME)}`);
};
