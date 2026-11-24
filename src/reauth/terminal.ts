/**
 * Terminal.app launcher. Command construction is pure and unit-tested; `openInTerminal` is the only
 * function that actually opens a window and is never called from tests.
 */
import { spawn } from 'node:child_process';
import { run } from '../ops/exec';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeServerName(name: string): boolean {
  return SAFE_NAME.test(name);
}

/** Shell command typed into Terminal for an OAuth MCP server. Throws on an unsafe name (no quoting tricks). */
export function loginCommand(server: string): string {
  if (!isSafeServerName(server)) throw new Error(`unsafe MCP server name: ${JSON.stringify(server)}`);
  return `claude mcp login ${server}`;
}

/** argv for osascript: the command is passed as an argument, never spliced into the AppleScript. */
export function terminalAppleScriptArgs(command: string): string[] {
  return [
    '-e', 'on run argv',
    '-e', 'tell application "Terminal"',
    '-e', 'activate',
    '-e', 'do script (item 1 of argv)',
    '-e', 'end tell',
    '-e', 'end run',
    command,
  ];
}

export async function openInTerminal(command: string): Promise<{ ok: boolean }> {
  const r = await run('/usr/bin/osascript', terminalAppleScriptArgs(command), { timeoutMs: 10_000 });
  return { ok: r.code === 0 };
}

/**
 * Start `cmd` detached and resolve once it has started ('spawn') or failed to ('error', e.g. ENOENT for a program
 * that is not installed). Before, it answered ok before the async ENOENT, so "Restart devbar: started" showed for a
 * devbar that does not exist (CONN-5). The error is its code only ("ENOENT").
 */
export function spawnDetached(cmd: string, args: string[], spawnFn: typeof spawn = spawn): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (e) {
      resolve({ ok: false, error: String((e as { code?: unknown })?.code ?? 'spawn_failed') });
      return;
    }
    let done = false;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    child.once('error', (e) => finish({ ok: false, error: String((e as { code?: unknown }).code ?? 'spawn_failed') }));
    child.once('spawn', () => {
      child.unref();
      finish({ ok: true });
    });
  });
}
