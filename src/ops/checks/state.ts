/** The state folder and its env file (mode 600) the LaunchAgents read (DEP.STATE.MISSING). */
import { existsSync } from 'node:fs';

import { fileMode } from '../envfile';
import { envFilePath, stateDir } from '../paths';
import { LEGACY, NEW_DB, migrationState } from '../../../scripts/ops/lib/migrate-state.mjs';
import { bad, isCompiledRelease, npmRun, ok, type Check } from './types';

/** A compiled release has no `npm run setup`: its installer writes the state folder and the env file (ON-11). */
const setupCmd = (c: Parameters<Check>[0]) => (isCompiledRelease(c) ? npmRun(c, 'ops:install') : 'npm run setup');

export const checkState: Check = async (c) => {
  const dir = stateDir(c.env);
  if (!existsSync(dir)) return bad('fail', 'state', 'State directory', 'missing', setupCmd(c), undefined, { code: 'DEP.STATE.MISSING' });
  const mode = fileMode(envFilePath(c.env));
  if (mode === null) return bad('warn', 'state', 'State directory', 'env file missing (the LaunchAgents read it)', setupCmd(c), undefined, { code: 'DEP.STATE.MISSING' });
  if ((mode & 0o077) !== 0) return bad('warn', 'state', 'State directory', `env file mode is ${mode.toString(8)}, should be 600`, `chmod 600 "${envFilePath(c.env)}"`, undefined, { code: 'DEP.STATE.MISSING' });
  return ok('state', 'State directory', 'present, env file mode 600');
};

const MOVE_FIX = 'node scripts/ops/migrate-state.mjs';

/**
 * `setup:state-folder` (W34-5): where the state folder lives, from the migration marker (the 1.x folder to command-center).
 * Read only: no launchctl, no file moves. A half-done move, or a postponed database rename, warns with the command.
 */
export const checkStateFolder: Check = async (c) => {
  const id = 'setup:state-folder';
  const label = 'State folder';
  const st = migrationState(c.env) as { kind: string; marker?: { completedAt?: string | null; database?: { status?: string } } | null };
  const m = st.marker ?? null;
  if (st.kind === 'migrate' || st.kind === 'finish' || st.kind === 'both') return bad('warn', id, label, st.kind === 'both' ? 'both the 1.x folder and command-center exist; the move is half done' : 'the move to command-center is half done', MOVE_FIX, { kind: st.kind }, { state: 'installed' });
  if (m?.completedAt && m.database?.status === 'kept') return bad('warn', id, label, `moved to command-center; the database rename (${LEGACY.db} to ${NEW_DB}) was postponed`, MOVE_FIX, { kind: st.kind, database: 'kept' }, { state: 'installed' });
  if (m?.completedAt) return ok(id, label, `command-center (moved from ${LEGACY.stateFolder} on ${m.completedAt.slice(0, 10)})`, { kind: st.kind, completedAt: m.completedAt });
  return ok(id, label, 'command-center', { kind: st.kind });
};
