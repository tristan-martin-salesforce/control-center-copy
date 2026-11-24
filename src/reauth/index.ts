import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveClaudeBin } from '../ops/claude-bin';
import { run } from '../ops/exec';
import { allHandlers } from './handlers';
import { openInTerminal, spawnDetached } from './terminal';
import type { ReauthDeps, ReauthHandler, ReauthKind } from './types';

export * from './types';
export { serverDeclared, DEVBAR_MISSING_MESSAGE } from './handlers';
export { allHandlers, slackHandler, org62Handler, vdpHandler, devbarHandler, expandHome, resolvePython, PYTHON_CANDIDATES, type VdpReauthOptions } from './handlers';
export { REAUTH_KIND_OF, reauthStarter, runConnectorReauth } from './run';
export { loginCommand, terminalAppleScriptArgs } from './terminal';

export function realDeps(): ReauthDeps {
  const home = homedir();
  return { exec: run, openTerminal: openInTerminal, spawnDetached: (cmd, args) => spawnDetached(cmd, args), now: Date.now, home, claudeJson: join(home, '.claude.json'), claudeBin: resolveClaudeBin() };
}

/** Entry point for API routes: `reauth('slack', { confirm: true })`. */
export function reauthHandler(kind: ReauthKind, deps: ReauthDeps = realDeps()): ReauthHandler {
  return allHandlers(deps)[kind];
}
