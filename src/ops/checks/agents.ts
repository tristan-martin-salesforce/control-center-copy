/** The LaunchAgents (installed, loaded) and the Node baked into them (DEP.AGENTS.MISSING / DEP.AGENTS.NODE_GONE). */
import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs';

import { plistPath, WEB_LABEL, WORKER_LABEL } from '../paths';
import { appPort, bad, npmRun, ok, tilde, type Check } from './types';

export const checkAgents: Check = async (c) => {
  const labels = [WEB_LABEL, WORKER_LABEL];
  const installed = labels.map((l) => existsSync(plistPath(l, c.env)));
  const loaded: boolean[] = [];
  for (const l of labels) {
    const r = await c.exec(c.env.CC_LAUNCHCTL || 'launchctl', ['print', `gui/${c.uid}/${l}`], { timeoutMs: 5000 });
    loaded.push(r.code === 0);
  }
  const data = { web: { installed: installed[0], loaded: loaded[0] }, worker: { installed: installed[1], loaded: loaded[1] } };
  const port = appPort(c);
  const webUp = await c.portOpen(port);
  if (installed.every(Boolean) && loaded.every(Boolean)) {
    if (webUp) return ok('agents', 'LaunchAgents', `installed and loaded; web :${port} up`, data);
    // loaded but not answering: starting, or failing to start (its log says which); never a ✓ (ON-16)
    return bad('warn', 'agents', 'LaunchAgents', `installed and loaded, but the web is down on :${port} (starting, or failing to start)`, `wait a minute; if it stays down, read ~/Library/Logs/command-center/web.log, then ${npmRun(c, 'ops:install')}`, data);
  }
  if (!installed.some(Boolean)) {
    return bad('warn', 'agents', 'LaunchAgents', 'not installed (the app only runs while a terminal is open)', npmRun(c, 'ops:install'), data, { code: 'DEP.AGENTS.MISSING' });
  }
  return bad('warn', 'agents', 'LaunchAgents', `partial: web installed=${installed[0]} loaded=${loaded[0]}, worker installed=${installed[1]} loaded=${loaded[1]}`, npmRun(c, 'ops:install'), data, { code: 'DEP.AGENTS.MISSING' });
};

/** ProgramArguments of a rendered LaunchAgent plist (XML-unescaped), or null when it has none. */
export function plistProgramArgs(xml: string): string[] | null {
  const arr = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1];
  if (arr === undefined) return null;
  const un = (v: string) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return [...arr.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => un(m[1]!));
}

const executable = (p: string) => {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Lane E (E5): the Node (and, for the worker, npm) baked into each installed LaunchAgent at install time still exists
 * and is 20+. A Node removed or replaced since (a Homebrew cleanup, an nvm version deleted) leaves the agent failing
 * to start with nothing in the app's own log.
 */
export const checkAgentNode: Check = async (c) => {
  const label = 'LaunchAgent Node path';
  const found: string[] = [];
  const problems: string[] = [];
  for (const l of [WEB_LABEL, WORKER_LABEL]) {
    const file = plistPath(l, c.env);
    if (!existsSync(file)) continue;
    const kind = l === WEB_LABEL ? 'web' : 'worker';
    let args: string[] | null = null;
    try {
      args = plistProgramArgs(readFileSync(file, 'utf8'));
    } catch {
      args = null;
    }
    const node = args?.[0];
    if (!node) {
      problems.push(`${kind}: no program in its plist`);
      continue;
    }
    if (!executable(node)) {
      problems.push(`${kind}: ${tilde(node, c.env.HOME)} is gone`);
      continue;
    }
    const v = await c.exec(node, ['--version'], { timeoutMs: 5000 });
    const major = Number(/^v?(\d+)/.exec(v.stdout.trim())?.[1] ?? 0);
    if (v.code !== 0 || major < 20) problems.push(`${kind}: ${tilde(node, c.env.HOME)} is ${v.code === 0 ? v.stdout.trim() : 'not runnable'} (need 20+)`);
    else found.push(`${kind} ${v.stdout.trim()}`);
    // the worker runs `npm run worker:start` through the npm it was installed with
    const sep = args!.indexOf('--');
    const npm = kind === 'worker' && sep >= 0 ? args![sep + 1] : undefined;
    if (npm && npm.startsWith('/') && !executable(npm)) problems.push(`worker: npm ${tilde(npm, c.env.HOME)} is gone`);
  }
  if (!found.length && !problems.length) return bad('skip', 'agent-node', label, 'no LaunchAgents installed');
  return problems.length
    ? bad('fail', 'agent-node', label, problems.join('; '), `${npmRun(c, 'ops:install')}  (writes both plists again with the Node on your PATH)`, { found }, { code: 'DEP.AGENTS.NODE_GONE' })
    : ok('agent-node', label, found.join(', '), { found });
};
