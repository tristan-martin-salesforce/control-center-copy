/**
 * Who holds the app's port (PKG-1, R6: DEP.PORT.TAKEN / DEP.PORT.EXPOSED), and the maintainer-only checks (sibling apps,
 * ~/Projects/PORTS.md), which skip unless CC_DEV_CHECKS=1.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { APP_PORT, plistPath, WEB_LABEL } from '../paths';
import { plistProgramArgs } from './agents';
import { appPort, bad, npmRun, ok, tilde, type Check, type CheckResult, type DoctorContext } from './types';

/** Where the sibling repos and the port registry (PORTS.md) live: ~/Projects. A teammate may have neither. */
export const projectsDir = (env: DoctorContext['env']): string => join(env.HOME ?? homedir(), 'Projects');

export const checkPorts: Check = (c) => checkSiblingApps(c);

/** Checks that only make sense on the maintainer's Mac (sibling apps, ~/Projects/PORTS.md): skipped unless CC_DEV_CHECKS=1. */
export const devOnly =
  (id: string, label: string, check: Check): Check =>
  async (c) =>
    c.env.CC_DEV_CHECKS === '1' ? check(c) : bad('skip', id, label, 'developer check (set CC_DEV_CHECKS=1 to run it)');

/** `lsof -F pcn` output → the listening processes ({ pid, command, names: ["127.0.0.1:4327", "*:4327"] }). */
export function parseLsofListeners(out: string): Array<{ pid: number; command: string; names: string[] }> {
  const procs: Array<{ pid: number; command: string; names: string[] }> = [];
  for (const line of out.split('\n')) {
    const tag = line[0];
    const v = line.slice(1).trim();
    if (tag === 'p') procs.push({ pid: Number(v), command: '', names: [] });
    else if (tag === 'c' && procs.length) procs.at(-1)!.command = v;
    else if (tag === 'n' && procs.length && !procs.at(-1)!.names.includes(v)) procs.at(-1)!.names.push(v);
  }
  return procs.filter((p) => Number.isInteger(p.pid) && p.pid > 0);
}

/** A listen address on every interface ("*:4327", "0.0.0.0:4327", "[::]:4327"). */
const allInterfaces = (name: string) => /^(\*|0\.0\.0\.0|\[::\]):\d+$/.test(name);

/**
 * PKG-1 + R6: who holds the app's port. Ours (the web LaunchAgent or a child of it) is ok, but not when it listens on
 * every interface (a web agent installed before the loopback fix: `npm run ops:install` writes it again with
 * -H 127.0.0.1). Anything else is named ("used by <process>"); it is a warning when the web agent is installed, since
 * the agent can't serve while another process holds the port.
 */
export const checkPortOwner: Check = async (c) => {
  const port = appPort(c);
  const label = `Port ${port}`;
  const webPlist = plistPath(WEB_LABEL, c.env);
  const args = existsSync(webPlist) ? plistProgramArgs(readFileSync(webPlist, 'utf8')) : null;
  const unbound = args !== null && args.includes('start') && !args.includes('-H');
  // UPG-3: a web plist without the loopback bind (1.x, or one the rename copied) is a fail, not a warning
  const reinstall = `${npmRun(c, 'ops:install')} -- --yes  (writes the web agent again with -H 127.0.0.1)`;
  const ls = await c.exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'], { timeoutMs: 5000 });
  const listeners = ls.code === 0 ? parseLsofListeners(ls.stdout) : [];
  if (!listeners.length) {
    if (unbound) return bad('fail', 'port-owner', label, 'free; the installed web agent would listen on every interface', reinstall, undefined, { code: 'DEP.PORT.EXPOSED' });
    return bad('skip', 'port-owner', label, ls.code === 0 || ls.code === 1 ? 'free (nothing is listening)' : 'could not run lsof');
  }
  const agent = await c.exec(c.env.CC_LAUNCHCTL || 'launchctl', ['print', `gui/${c.uid}/${WEB_LABEL}`], { timeoutMs: 5000 });
  const agentPid = agent.code === 0 ? Number(/^\s*pid = (\d+)/m.exec(agent.stdout)?.[1] ?? NaN) : NaN;
  const ancestors = async (pid: number): Promise<number[]> => {
    const chain = [pid];
    for (let i = 0; i < 4; i++) {
      const r = await c.exec('ps', ['-o', 'ppid=', '-p', String(chain.at(-1))], { timeoutMs: 3000 });
      const ppid = Number(r.stdout.trim());
      if (r.code !== 0 || !(ppid > 1)) break;
      chain.push(ppid);
    }
    return chain;
  };
  const l = listeners[0]!;
  const ours = Number.isInteger(agentPid) && (await ancestors(l.pid)).includes(agentPid);
  const names = [...new Set(listeners.flatMap((x) => x.names))];
  const data = { pid: l.pid, command: l.command, addresses: names, agentPid: Number.isInteger(agentPid) ? agentPid : null };
  if (ours) {
    if (unbound || names.some(allInterfaces)) return bad(unbound ? 'fail' : 'warn', 'port-owner', label, `the web agent (pid ${l.pid}) listens on every interface (${names.join(', ')})`, reinstall, data, { code: 'DEP.PORT.EXPOSED' });
    return ok('port-owner', label, `the web agent (pid ${l.pid}) on ${names.join(', ')}`, data);
  }
  const who = `used by ${l.command || 'a process'} (pid ${l.pid})`;
  if (existsSync(webPlist)) return bad('warn', 'port-owner', label, `${who}, not the web agent`, `stop that process (kill ${l.pid}); launchd then starts the web agent`, data, { code: 'DEP.PORT.TAKEN' });
  return ok('port-owner', label, `${who}; no web agent installed (a dev server?)`, data);
};


export interface SiblingApp {
  name: string;
  port: number;
  /** Repo folder under the projects dir. */
  repo: string;
}
export const SIBLING_APPS: SiblingApp[] = [
  { name: 'talk-track', port: 4320, repo: 'talk-track' },
  { name: 'pulse-footprint', port: 4318, repo: 'greg-playground' },
];

export interface LocalDirOptions {
  /** Defaults to projectsDir(c.env). */
  projects?: string;
  exists?: (path: string) => boolean;
}

/**
 * The optional sibling apps. One that is neither checked out under the projects dir nor listening is not used on this
 * machine and is skipped, not warned about; with none in use the whole check is `skip`.
 */
export async function checkSiblingApps(c: DoctorContext, o: LocalDirOptions & { apps?: SiblingApp[] } = {}): Promise<CheckResult> {
  const projects = o.projects ?? projectsDir(c.env);
  const exists = o.exists ?? existsSync;
  const apps = o.apps ?? SIBLING_APPS;
  const label = `Sibling apps (${apps.map((a) => a.name).join(', ')})`;
  const states = await Promise.all(apps.map(async (a) => ({ ...a, here: exists(join(projects, a.repo)), open: await c.portOpen(a.port) })));
  const used = states.filter((s) => s.here || s.open);
  const absent = states.filter((s) => !s.here && !s.open).map((s) => s.name);
  const data = { ports: Object.fromEntries(states.map((s) => [s.name, s.open])), ...(absent.length ? { not_on_this_machine: absent } : {}) };
  if (!used.length) return bad('skip', 'ports', label, 'not used on this machine (optional integrations)', undefined, data);
  const detail = used.map((s) => `${s.name} :${s.port} ${s.open ? 'up' : 'down'}`).join(', ') + (absent.length ? `; ${absent.join(', ')} not on this machine` : '');
  if (used.every((s) => s.open)) return ok('ports', label, detail, data);
  const registry = join(projects, 'PORTS.md');
  const see = exists(registry) ? ` (see ${tilde(registry, c.env.HOME)})` : '';
  return bad('warn', 'ports', label, `${detail} (optional integrations)`, `start the app(s) from ${tilde(projects, c.env.HOME)}${see}`, data);
}

/**
 * The shared port registry (~/Projects/PORTS.md) should claim the app's port. Optional: without the file the check is
 * `skip` ("not used on this machine"), never a failure.
 */
export async function checkPortRegistry(c: DoctorContext, o: LocalDirOptions & { read?: (path: string) => string } = {}): Promise<CheckResult> {
  const label = 'Port registry (PORTS.md)';
  const file = join(o.projects ?? projectsDir(c.env), 'PORTS.md');
  const exists = o.exists ?? existsSync;
  const shown = tilde(file, c.env.HOME);
  if (!exists(file)) return bad('skip', 'port-registry', label, `not used on this machine (no ${shown})`);
  let text: string;
  try {
    text = (o.read ?? ((p) => readFileSync(p, 'utf8')))(file);
  } catch {
    return bad('warn', 'port-registry', label, `${shown} is unreadable`, `check the file's permissions`);
  }
  const listed = text.split('\n').some((line) => line.startsWith('|') && line.split('|')[1]?.trim() === String(APP_PORT));
  return listed
    ? ok('port-registry', label, `:${APP_PORT} registered in ${shown}`)
    : bad('warn', 'port-registry', label, `:${APP_PORT} is not listed in ${shown}`, `add a command-center row for :${APP_PORT} to ${shown}`);
}
