/**
 * Claude Code CLI (PKG-6): the binary the runners use (src/ops/claude-bin.ts), present and at least MIN_CLAUDE_CLI
 * (DEP.CLAUDE.MISSING / DEP.CLAUDE.TOO_OLD). The sign-in itself is the user-initiated smoke (src/ops/smoke.ts), never
 * run here: a check never spends.
 */
import { MIN_CLAUDE_CLI } from '../../errors/catalog';
import { bad, ok, tilde, versionBelow, type Check } from './types';

export const checkClaude: Check = async (c) => {
  const r = await c.exec(c.claudeBin, ['--version'], { timeoutMs: 10_000 });
  const where = tilde(c.claudeBin, c.env.HOME);
  if (r.code !== 0) {
    return bad('fail', 'claude', 'claude CLI', `not found (looked for ${where})`, 'install Claude Code (it puts claude in ~/.local/bin), or set CC_CLAUDE_BIN to its path', { path: where }, { code: 'DEP.CLAUDE.MISSING', state: 'missing' });
  }
  const version = r.stdout.trim().split('\n')[0] || 'present';
  const data = { path: where, version, min: MIN_CLAUDE_CLI };
  if (versionBelow(version, MIN_CLAUDE_CLI)) return bad('fail', 'claude', 'claude CLI', `${version} is older than ${MIN_CLAUDE_CLI}`, 'claude update', data, { code: 'DEP.CLAUDE.TOO_OLD', state: 'installed' });
  return ok('claude', 'claude CLI', `${version}${c.claudeBin.includes('/') ? ` (${where})` : ''}`, data);
};
