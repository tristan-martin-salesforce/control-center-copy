/** Node.js: 20+ runs, the tested major is .nvmrc's (22); a newer major warns (DEP.NODE.TOO_OLD / DEP.NODE.UNTESTED). */
import { bad, npmRun, ok, type Check, type CheckResult } from './types';

/** The Node the app is tested on (.nvmrc); it runs on 20+, and a newer major than this one gets a warning. */
export const TESTED_NODE_MAJOR = 22;

export function nodeCheck(version: string = process.versions.node, install = 'npm run ops:install'): CheckResult {
  const major = Number(version.split('.')[0]);
  if (!(major >= 20)) return bad('fail', 'node', 'Node.js', `v${version} (need 20+)`, `brew install node@${TESTED_NODE_MAJOR}`, undefined, { code: 'DEP.NODE.TOO_OLD', state: 'installed' });
  if (major >= 25) return bad('warn', 'node', 'Node.js', `v${version} (tested on ${TESTED_NODE_MAJOR}; a newer Node can break things)`, `brew install node@${TESTED_NODE_MAJOR}, then ${install}`, undefined, { code: 'DEP.NODE.UNTESTED', state: 'ok' });
  return ok('node', 'Node.js', `v${version}`);
}

export const checkNode: Check = async (c) => nodeCheck(undefined, npmRun(c, 'ops:install'));
