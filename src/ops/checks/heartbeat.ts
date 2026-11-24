/** The worker's heartbeat file (DEP.WORKER.*; a worker waiting for the schema is DATA.SCHEMA_BEHIND, one waiting out a crash loop BUG.WORKER_CRASH_LOOP). */
import { CRASH_LOOP, readWorkerStarts, workerStartsPath } from '../crash';
import { classifyHeartbeat, readHeartbeat } from '../heartbeat';
import { heartbeatPath } from '../paths';
import { bad, isCompiledRelease, npmRun, ok, type Check } from './types';

export const checkHeartbeat: Check = async (c) => {
  // a compiled release: one command starts a stopped or unloaded worker (kickstart can't start an unloaded one, ON-12)
  const compiled = isCompiledRelease(c);
  const restart = compiled ? `restart the worker: ${npmRun(c, 'ops:install')}` : 'restart: launchctl kickstart -k gui/$UID/com.commandcenter.worker';
  const { hb, health } = readHeartbeat(heartbeatPath(c.env));
  if (!hb) {
    return health === 'invalid'
      ? bad('warn', 'heartbeat', 'Worker heartbeat', 'file is unreadable', compiled ? restart : 'restart the worker (launchctl kickstart -k gui/$UID/com.commandcenter.worker)', undefined, { code: 'DEP.WORKER.DOWN', state: 'unknown' })
      : bad('warn', 'heartbeat', 'Worker heartbeat', 'no heartbeat file: the worker has not run yet', compiled ? `start it: ${npmRun(c, 'ops:install')}` : 'npm run worker (or npm run ops:install)', undefined, { code: 'DEP.WORKER.NOT_STARTED', state: 'missing' });
  }
  const { health: h, ageMs } = classifyHeartbeat(hb, c.now());
  const age = ageMs < 90_000 ? `${Math.round(ageMs / 1000)} s` : `${Math.round(ageMs / 60_000)} min`;
  const data = { state: hb.state, age_ms: ageMs, pid: hb.pid, seq: hb.seq, active_jobs: hb.active_jobs };
  if (hb.state === 'stopped') return bad('warn', 'heartbeat', 'Worker heartbeat', `worker stopped cleanly ${age} ago`, compiled ? `start it: ${npmRun(c, 'ops:install')}` : 'start it: npm run ops:install, or npm run worker', data, { code: 'DEP.WORKER.DOWN', state: 'installed' });
  // ON-30: `blocked` says why in last_error_code. crash_loop: it waits out the backoff (PKG R9); schema_mismatch (lane
  // E, and a beat with no code): it claims nothing until the schema matches its build (the migrations check says how)
  if (hb.state === 'blocked' && h === 'fresh') {
    const why = hb.last_error_code;
    if (why === 'crash_loop') {
      const now = c.now();
      const n = readWorkerStarts(workerStartsPath(c.env)).filter((t) => t <= now && now - t < CRASH_LOOP.windowMs).length;
      const fix = `it starts its work by itself after ${CRASH_LOOP.backoffMs / 60_000} minutes; if it keeps happening, report it from the Feedback button`;
      return bad('fail', 'heartbeat', 'Worker heartbeat', `the worker restarted ${n || 'several'} times in ${CRASH_LOOP.windowMs / 60_000} minutes and is waiting (beat ${age} ago); no jobs run`, fix, data, { code: 'BUG.WORKER_CRASH_LOOP', state: 'installed' });
    }
    if (why === 'schema_mismatch' || why === null) return bad('fail', 'heartbeat', 'Worker heartbeat', `waiting: the database schema differs from the worker's build (beat ${age} ago); no jobs run`, compiled ? `${npmRun(c, 'db:migrate')}, then ${npmRun(c, 'ops:install')}` : 'npm run update (see the Migrations line)', data, { code: 'DATA.SCHEMA_BEHIND', state: 'installed' });
    return bad('fail', 'heartbeat', 'Worker heartbeat', `waiting (${why}, beat ${age} ago); no jobs run`, `see the worker's last error below; if it persists, ${restart}`, data, { state: 'installed' });
  }
  if (h === 'fresh') return ok('heartbeat', 'Worker heartbeat', `${hb.state}, beat ${age} ago, pid ${hb.pid}`, data);
  if (h === 'stale') return bad('warn', 'heartbeat', 'Worker heartbeat', `stale: last beat ${age} ago (asleep, or busy)`, `wait a minute; if it persists, ${restart}`, data, { state: 'unknown' });
  return bad('fail', 'heartbeat', 'Worker heartbeat', `dead: last beat ${age} ago`, restart, data, { code: 'DEP.WORKER.DOWN', state: 'installed' });
};
