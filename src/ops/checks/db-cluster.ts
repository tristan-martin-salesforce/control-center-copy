/**
 * Command Center's own Postgres 17 (D-98): the data folder (owner, mode, room), the server's major against the bundled
 * engine's, the 1.x Homebrew copy left behind by the move (kept 14 days, then the removal commands), and a
 * DATABASE_URL you set (reported, never changed). DB-free except db-major, which also asks the server when it answers.
 */
import { statSync } from 'node:fs';

import { PG17_BIN } from '../paths';
import { dataMajor, dbNameOf, installedEngine, PG_MAJOR, pgDataDir, readMovedMarker } from '../pg-cluster';
import { engineOf } from './database';
import { bad, npmRun, ok, tilde, type Check, type DoctorContext } from './types';

const DAY = 86_400_000;
const statOf = (c: DoctorContext, p: string) => {
  if (c.statPath) return c.statPath(p);
  try {
    const s = statSync(p);
    return { uid: s.uid, mode: s.mode & 0o777 };
  } catch {
    return null;
  }
};

/** The data folder is this user's, mode 700 (Postgres refuses anything looser), with room to write. */
export const checkDbCluster: Check = async (c) => {
  const label = 'Database folder';
  if (engineOf(c).engine !== 'bundled') return bad('skip', 'db-cluster', label, "not used (this install's database is elsewhere)");
  const data = pgDataDir(c.env);
  const where = tilde(data, c.env.HOME);
  const st = statOf(c, data);
  if (!st || !dataMajor(data)) return bad('fail', 'db-cluster', label, 'not set up yet', npmRun(c, 'ops:install'), { data: where }, { code: 'DEP.DB.NOT_SET_UP', state: 'missing' });
  if (!installedEngine(c.env)) return bad('fail', 'db-cluster', label, 'the bundled Postgres engine is missing', npmRun(c, 'ops:install'), { data: where }, { code: 'DEP.DB.NOT_SET_UP', state: 'missing' });
  if (st.uid !== c.uid) return bad('fail', 'db-cluster', label, `${where} belongs to another user (uid ${st.uid})`, `sudo chown -R $(id -un) "${data}"`, { data: where }, { code: 'DEP.DB.CLUSTER_PERMS', state: 'installed' });
  if (st.mode & 0o077) return bad('fail', 'db-cluster', label, `${where} is mode ${st.mode.toString(8)}; Postgres needs 700`, `chmod 700 "${data}"`, { data: where }, { code: 'DEP.DB.CLUSTER_PERMS', state: 'installed' });
  const free = c.freeBytes(data);
  const gb = free === null ? null : free / 1024 ** 3;
  if (gb !== null && gb < 1) return bad('fail', 'db-cluster', label, `${gb.toFixed(1)} GB free: the database cannot write its log`, 'free up space', { data: where, free_gb: gb }, { code: 'DEP.DISK.LOW' });
  return ok('db-cluster', label, `${where}, yours, mode 700${gb === null ? '' : `, ${gb.toFixed(1)} GB free`}`, { data: where, free_gb: gb });
};

/** The data folder's major, the bundled engine's and (when it answers) the server's are all 17. */
export const checkDbMajor: Check = async (c) => {
  const label = 'Postgres version';
  if (engineOf(c).engine !== 'bundled') return bad('skip', 'db-major', label, 'not the bundled database');
  const files = dataMajor(pgDataDir(c.env));
  const engine = installedEngine(c.env);
  if (!files || !engine) return bad('skip', 'db-major', label, 'not set up yet');
  const rows = await c.withDb('postgres', (q) => q('SHOW server_version_num'));
  const server = rows?.[0]?.server_version_num ? Math.floor(Number(rows[0].server_version_num) / 10_000) : null;
  const data = { files, engine: engine.version, server, bundled: PG_MAJOR };
  const majors = [files, engine.major, server].filter((m): m is number => m !== null);
  if (majors.some((m) => m !== PG_MAJOR)) {
    return bad('fail', 'db-major', label, `database files ${files}, bundled engine ${engine.version}${server ? `, server ${server}` : ''}: they must all be ${PG_MAJOR}`, 'npm run ops:rollback, then report this', data, { code: 'DEP.DB.MAJOR_MISMATCH', state: 'installed' });
  }
  return ok('db-major', label, `${PG_MAJOR} everywhere (engine ${engine.version}${server ? ', server answers' : ''})`, data);
};

/**
 * After the move: the old Homebrew database stays 14 days untouched; after that, while it is still there, the two
 * commands that remove it. Before a move: a 1.x install still on Homebrew is told that `npm run update` moves it.
 */
export const checkHomebrewLeftover: Check = async (c) => {
  const label = 'Homebrew copy';
  const e = engineOf(c);
  if (e.engine === 'homebrew') {
    return e.keep ? ok('db-homebrew', label, 'kept on Homebrew Postgres (CC_DB_ENGINE=homebrew)') : bad('warn', 'db-homebrew', label, 'your data is still in Homebrew Postgres', 'npm run update (moves it, checked table by table; the Homebrew copy is kept)', undefined, { code: 'DEP.DB.MOVE_PENDING' });
  }
  const m = readMovedMarker(c.env);
  if (!m) return bad('skip', 'db-homebrew', label, 'nothing was moved from Homebrew');
  const age = c.now() - Date.parse(m.movedAt);
  const days = Math.floor(age / DAY);
  const until = new Date(Date.parse(m.movedAt) + m.keepDays * DAY).toISOString().slice(0, 10);
  if (age < m.keepDays * DAY) return ok('db-homebrew', label, `moved ${days} day(s) ago; Homebrew's ${m.database} is kept, untouched, until ${until}`, { moved_days: days });
  const q = await c.exec(`${PG17_BIN}/psql`, ['-h', 'localhost', '-p', '5432', '-d', 'postgres', '-XAtc', `SELECT 1 FROM pg_database WHERE datname = '${m.database.replace(/'/g, "''")}'`], { timeoutMs: 5000 });
  if (q.spawnError || q.code !== 0 || q.stdout.trim() !== '1') return ok('db-homebrew', label, `moved ${days} days ago; the Homebrew copy is gone`, { moved_days: days });
  return bad('warn', 'db-homebrew', label, `moved ${days} days ago; Homebrew's ${m.database} is still there and no longer used`, `${PG17_BIN}/dropdb -h localhost ${m.database} && brew services stop postgresql@17`, { moved_days: days }, { code: 'DEP.DB.HOMEBREW_LEFTOVER' });
};

/** A DATABASE_URL you set (environment or env file): reported, never changed. */
export const checkDbUrl: Check = async (c) => {
  const e = engineOf(c);
  const label = 'Database URL';
  if (e.engine === 'user') return ok('db-url', label, `set by you (database ${dbNameOf(e.url ?? '') || '?'}, ${e.source === 'env' ? 'in the environment' : 'in the env file'}): used as it is, never moved`, { overridden: true, source: e.source, code: 'DEP.DB.URL_OVERRIDDEN' });
  return ok('db-url', label, e.engine === 'bundled' ? "Command Center's own database" : 'Homebrew Postgres (the 1.x default)', { overridden: false, engine: e.engine });
};
