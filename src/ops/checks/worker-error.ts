/**
 * The worker's last error (the heartbeat's `last_error_code`): the Health catalog entry it names, with that entry's
 * fix. The heartbeat check says whether the worker is alive; this one says what it last tripped on while alive (the
 * database it waited for, a crash loop, a schema it was not built for). A code only, never message text.
 */
import { render } from '../../errors/render';
import { classifyHeartbeat, readHeartbeat } from '../heartbeat';
import { heartbeatPath } from '../paths';
import { bad, npmRun, ok, type Check, type DoctorContext } from './types';

/** The worker's own short codes (src/worker/index.ts) → the catalog entry a person reads. Catalog codes pass as is. */
export const WORKER_ERROR_CODES: Record<string, string> = {
  crash_loop: 'BUG.WORKER_CRASH_LOOP',
  schema_mismatch: 'DATA.SCHEMA_BEHIND',
};

/** A catalog next step with every `npm run <script>` written so it can be pasted in any Terminal (ON-11). */
export function pasteableStep(c: Pick<DoctorContext, 'repoRoot' | 'env'>, step: string): string {
  return step.replace(/npm run ([a-z][\w:-]*)/g, (_m, script: string) => npmRun(c, script));
}

export const checkWorkerError: Check = async (c) => {
  const id = 'worker-error';
  const label = "Worker's last error";
  const { hb } = readHeartbeat(heartbeatPath(c.env));
  if (!hb) return bad('skip', id, label, 'no heartbeat (see the Worker heartbeat line)');
  const { health } = classifyHeartbeat(hb, c.now());
  // a stopped or dead worker's last code is history: the heartbeat line already says what to do
  if (hb.state === 'stopped' || health === 'dead') return bad('skip', id, label, 'the worker is not running (see the Worker heartbeat line)');
  const raw = hb.last_error_code;
  if (!raw) return ok(id, label, 'none');
  const code = WORKER_ERROR_CODES[raw] ?? raw;
  const r = render(code);
  const data = { last_error_code: raw, code: r.code, known: r.known };
  if (!r.known) return bad('warn', id, label, `the worker reported ${raw}, which the Health catalog does not know`, 'Report this from Health (the report carries the worker log).', data, { code: 'BUG.UNKNOWN', state: 'unknown' });
  return bad(r.severity === 'critical' ? 'fail' : 'warn', id, label, `${r.title} (${r.code})`, pasteableStep(c, r.nextStep), data, { code: r.code, state: 'installed' });
};
