/** Domain 03: job templates (scan jobs from runs, schedules, engine jobs, dead letters), worker instances, schedules. */
import { rng, uid, slackChannel } from '../../lib/kit';
import { CONN, DAY, HOUR, MIN, NOW_MS, atMs, dowOf, iso, isWeekdayOff, r4, tms } from './ops-lib';
import type { RunX } from './ops-facts';

export interface JobT {
  key: string; kind: string; queue: string; payload: Record<string, any>; status: 'queued' | 'running' | 'succeeded' | 'dead' | 'cancelled';
  priority: number; createdMs: number; runAtMs: number; startedMs?: number; finishedMs?: number;
  attempts: number; maxAttempts: number; backoffBase: number; backoffMax: number; timeoutS: number;
  lastErrClass?: string; lastFailedMs?: number; deadMs?: number; deadReason?: string; lastErrCode?: string; lastErr?: string;
  dedupeKey?: string | null; generation?: number | null; supersedes: boolean; cancelReqMs?: number; cancelReason?: string; supersededByKey?: string;
  idemKey?: string; scheduleKey?: string; parentKey?: string; corr?: string; result?: Record<string, any> | null; runKey?: string; locked?: boolean; id?: number;
  tag?: string; // free label used by the calls / events modules
}
export interface WorkerT { id: string; version: string; startMs: number; lastBeatMs: number; stopMs?: number; stopReason?: string; pid: number }

const R = rng('ops-jobs');
const wi = (n: number) => uid('work_items', `wi-${String(n).padStart(3, '0')}`);
export const WORKERS: WorkerT[] = [];
const HOST = 'rafael-mbp.example';
const wk = (n: number, version: string, startIso: string, lastBeatIso: string, stopIso: string | undefined, reason: string | undefined, pid: number) => {
  const boot = uid('worker_instances', `boot-${n}`).slice(0, 8);
  WORKERS.push({ id: `${HOST}:${pid}:${boot}`, version, startMs: tms(startIso), lastBeatMs: tms(lastBeatIso), stopMs: stopIso ? tms(stopIso) : undefined, stopReason: reason, pid });
};
wk(1, '1.0.2', '2026-10-18T15:20:00.000Z', '2026-10-22T02:41:10.000Z', '2026-10-22T02:41:20.000Z', 'SIGTERM', 41822);
wk(2, '1.1.0', '2026-10-22T14:08:00.000Z', '2026-10-27T01:12:40.000Z', '2026-10-27T01:12:50.000Z', 'SIGTERM', 52014);
wk(3, '1.1.1', '2026-10-27T14:03:00.000Z', '2026-10-29T23:30:10.000Z', '2026-10-29T23:30:20.000Z', 'SIGTERM', 18377);
wk(4, '1.1.1', '2026-10-30T13:44:00.000Z', '2026-11-04T05:02:10.000Z', undefined, undefined, 20931); // killed without a clean stop: stale heartbeat
wk(5, '1.1.2', '2026-11-04T14:22:00.000Z', '2026-11-04T16:59:50.000Z', '2026-11-04T17:00:00.000Z', 'SIGTERM', 66240);
wk(6, '1.2.0', '2026-11-04T17:02:00.000Z', '2026-11-12T21:30:20.000Z', '2026-11-12T21:30:30.000Z', 'SIGTERM', 66811);
wk(7, '1.3.0', '2026-11-12T21:34:00.000Z', '2026-11-16T14:01:50.000Z', '2026-11-16T14:02:00.000Z', 'SIGTERM', 31550);
wk(8, '1.3.0', '2026-11-16T14:04:00.000Z', '2026-11-18T15:59:40.000Z', undefined, undefined, 31877);
export const CUR_WORKER = WORKERS[WORKERS.length - 1]!.id;
const workerAt = (ms: number) => (WORKERS.filter((w) => w.startMs <= ms && (!w.stopMs || w.stopMs >= ms)).pop() ?? WORKERS[0]!).id;
void workerAt;

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
const base = (o: Partial<JobT> & Pick<JobT, 'key' | 'kind' | 'queue' | 'createdMs'>): JobT => ({
  payload: {}, status: 'succeeded', priority: 0, runAtMs: o.createdMs, attempts: 1, maxAttempts: 5, backoffBase: 30, backoffMax: 3600, timeoutS: 600, supersedes: false, ...o,
});
const PRIO: Record<string, number> = { manual: 100, head: 80, incremental: 60, continuation: 55, retry: 50, targeted: 45, backfill: 40, reconcile: 20 };

export interface Built { jobs: JobT[]; wake: Map<number, number> }

export function buildJobs(runs: RunX[]): Built {
  const jobs: JobT[] = [];
  const add = (j: JobT) => { jobs.push(j); return j; };
  const runJob = new Map<string, JobT>();

  // ── scan jobs, one per run ─────────────────────────────────────────────────────────────────────
  for (const r of runs) {
    const sk = CONN[r.conn].scanKind;
    const scopeId = r.scope ? `${sk}:${r.scope}` : sk;
    const from = iso(r.winFrom); const to = iso(r.winTo);
    const isRec = r.mode === 'reconcile';
    const pmode = r.pmode;
    const prio = PRIO[isRec ? 'reconcile' : pmode] ?? 60;
    const id = isRec ? `reconcile:${sk}:${r.reconcilePass}:${to}` : `scan:${sk}:${r.scope}:${pmode}:${from}:${to}`;
    const dedupe = isRec ? id : pmode === 'incremental' ? `scan:${sk}:${r.scope}` : id;
    const chain = r.retryOfKey ? runJob.get(r.retryOfKey) : undefined;
    const lead = r.trigger === 'manual' ? R.int(1, 3) * 1000 : r.mode === 'backfill' && chain ? 4000 : R.int(3, 45) * 1000;
    const created = chain?.finishedMs ? chain.finishedMs + 800 : r.startMs - lead - 1000;
    const runAt = Math.max(created, r.startMs - 1500);
    const payload: Record<string, any> = isRec
      ? { kind: 'reconcile', id, passes: [r.reconcilePass], connector: sk, trigger: 'reconcile', priority: prio, runAt: iso(runAt), dedupeKey: dedupe,
          ...(r.reconcilePass === 'skill_upgrade' ? { upgrades: [{ connector: 'slack', scope: 'inbox', fromVersion: '1.6.0', toVersion: '1.7.0' }, { connector: 'slack', scope: 'channel:' + slackChannel(1), fromVersion: '1.6.0', toVersion: '1.7.0' }] } : {}) }
      : { kind: 'scan', id, connector: sk, scope: r.scope, window: { from, to }, mode: pmode, trigger: r.trigger, priority: prio, runAt: iso(runAt), dedupeKey: dedupe, model: CONN[r.conn].tier === 'none' ? undefined : 'claude-haiku-5-5',
          ...(r.attempt ? { attempt: r.attempt } : {}), ...(r.budget === 'first_scan' ? { budget: 'first_scan' } : {}),
          ...(sk === 'slack' && r.scope?.startsWith('channel:') ? { vars: { channel: { id: r.scope.slice(8) } } } : {}), ...(sk === 'drive' ? { vars: { maxItems: '60' } } : {}) };
    if (payload.model === undefined) delete payload.model;
    const j = base({
      key: `job-${r.key}`, kind: isRec ? 'scan.reconcile' : `scan.${sk}`, queue: isRec ? 'scan.reconcile' : `scan.${sk}`, payload, priority: prio, createdMs: created, runAtMs: runAt,
      startedMs: r.startMs - 900, finishedMs: r.endMs + 300, dedupeKey: dedupe, maxAttempts: 3, timeoutS: r.mode === 'backfill' ? 3000 : 1500, runKey: r.key, parentKey: chain?.key, tag: 'scan',
      corr: uid('jobs', `corr:${r.retryOfKey ?? r.key}`),
    });
    if (r.status === 'cancelled') {
      j.status = 'cancelled'; j.cancelReqMs = r.endMs - 200; j.cancelReason = r.err!.msg.replace(/^cancelled: /, '');
    }
    j.result = { status: r.status === 'succeeded' || r.status === 'partial' ? 'succeeded' : 'failed', connector: sk, runId: undefined, costUsd: 0, ...(r.err && r.status !== 'cancelled' ? { errorClass: r.err.cls === 'config' ? 'config' : r.err.cls, detail: r.err.msg.slice(0, 160) } : {}), followUps: 0, followUpJobIds: [] };
    if (r.status === 'cancelled') j.result = null;
    runJob.set(r.key, j);
    add(j);
  }
  // retry linkage: failed run's job lists its follow-up
  for (const r of runs) {
    if (!r.retryOfKey) continue;
    const p = runJob.get(r.retryOfKey)!; const c = runJob.get(r.key)!;
    if (p.result) { p.result.followUps = (p.result.followUps ?? 0) + 1; (p.result.followUpJobIds as any[]).push(c.key); }
  }
  // the manual run after a re-auth belongs to the connector.reauth job (the handler probes the scope), not to a scan job
  const reauthRun = new Map<string, JobT>();
  for (const r of runs) {
    if (!(r.story === 'vdp-auth-1104' && r.trigger === 'manual') && !(r.story === 'drive-auth' && r.trigger === 'manual') && !(r.story === 'today-vdp' && r.trigger === 'manual')) continue;
    const sj = runJob.get(r.key)!;
    const idx = jobs.indexOf(sj); jobs.splice(idx, 1);
    const attempts = r.story === 'drive-auth' ? 3 : r.story === 'today-vdp' ? 2 : 1;
    const connectorId = CONN[r.conn].id;
    const createdMs = r.story === 'today-vdp' ? tms('2026-11-18T15:24:05.000Z') : r.story === 'drive-auth' ? tms('2026-11-14T21:34:10.000Z') : r.startMs - 3 * MIN;
    const j = base({ key: `job-${r.key}`, kind: 'connector.reauth', queue: 'maintenance', payload: { connectorId }, createdMs, runAtMs: createdMs, startedMs: createdMs + 700, finishedMs: r.endMs + 400, attempts, maxAttempts: 5, backoffBase: 30, backoffMax: 300, timeoutS: 600,
      lastErrClass: attempts > 1 ? 'transient' : undefined, lastErrCode: attempts > 1 ? 'reauth_pending' : undefined, lastErr: attempts > 1 ? `${CONN[r.conn].label} still needs re-auth` : undefined, lastFailedMs: attempts > 1 ? r.endMs - 90_000 : undefined,
      runKey: r.key, tag: 'reauth', result: { status: 'succeeded', connector: CONN[r.conn].scanKind, resumed: true, probe: r.scope ?? 'mine', started: r.story === 'drive-auth' ? 'manual' : 'started' } });
    j.result!.runId = undefined;
    runJob.set(r.key, j); jobs.push(j); reauthRun.set(r.story!, j);
  }
  // the dead VDP re-auth attempt of this morning (the user did not finish the Okta prompt in time)
  const deadReauth = add(base({ key: 'job-reauth-vdp-dead', kind: 'connector.reauth', queue: 'maintenance', payload: { connectorId: CONN.vdp.id }, status: 'dead', createdMs: tms('2026-11-18T15:13:20.000Z'), runAtMs: tms('2026-11-18T15:13:20.000Z'),
    startedMs: tms('2026-11-18T15:20:50.000Z'), finishedMs: tms('2026-11-18T15:22:00.000Z'), attempts: 5, maxAttempts: 5, backoffBase: 30, backoffMax: 300, timeoutS: 600, lastErrClass: 'transient', lastErrCode: 'reauth_pending', lastErr: 'VDP still needs re-auth',
    lastFailedMs: tms('2026-11-18T15:22:00.000Z'), deadMs: tms('2026-11-18T15:22:00.000Z'), deadReason: 'attempts exhausted: reauth_pending', tag: 'dead' }));
  void deadReauth;

  // ── paused by the hard cap (2026-11-10 12:42 – 13:08 MT): the job ran, no scan run was created ─────
  const paused: Array<[string, string, string, string]> = [
    ['12:42', 'slack', 'inbox', 'incremental'], ['12:46', 'slack', 'channel:' + slackChannel(2), 'incremental'], ['12:50', 'gmail-work', 'inbox', 'incremental'], ['12:55', 'org62', 'events', 'incremental'],
    ['12:58', 'claude', 'all', 'incremental'], ['13:01', 'drive', 'tracked', 'incremental'], ['13:03', 'slack', 'channel:' + slackChannel(3), 'incremental'], ['13:05', 'calendar', 'primary', 'incremental'], ['13:08', 'gemini-notes', 'poll', 'incremental'],
  ];
  paused.forEach(([hh, c, scope, pm], i) => {
    const t0 = atMs(-8, hh); const sk = CONN[c as keyof typeof CONN].scanKind;
    const to = iso(t0 - 5 * MIN); const from = iso(t0 - 35 * MIN);
    const dk = `scan:${sk}:${scope}`;
    add(base({ key: `job-paused-${i + 1}`, kind: `scan.${sk}`, queue: `scan.${sk}`, createdMs: t0 - 20_000, runAtMs: t0 - 2000, startedMs: t0, finishedMs: t0 + 900, maxAttempts: 3, timeoutS: 1500, priority: 60, dedupeKey: dk, tag: 'paused',
      payload: { kind: 'scan', id: `${dk}:${pm}:${from}:${to}`, connector: sk, scope, window: { from, to }, mode: pm, trigger: 'schedule', priority: 60, runAt: iso(t0 - 2000), dedupeKey: dk, model: 'claude-haiku-5-5' },
      result: { status: 'paused', connector: sk, detail: 'budget_hard_cap', costUsd: 0, retryAt: iso(t0 + 10 * MIN), followUps: 0, followUpJobIds: [] } }));
  });

  // ── scheduled maintenance jobs (laptop-aware: slots missed overnight run once at wake: run_once) ───
  const wake = new Map<number, number>(); // day offset -> wake instant
  for (let d = -30; d <= 0; d++) {
    const dw = dowOf(d);
    if (d === 0) wake.set(d, tms('2026-11-18T13:38:00.000Z'));
    else if (isWeekdayOff(d)) wake.set(d, atMs(d, '06:15') + R.int(0, 85) * MIN);
    else if ((dw === 6 && R.chance(0.3)) || (dw === 0 && R.chance(0.2))) wake.set(d, atMs(d, '09:30') + R.int(0, 60) * MIN);
  }
  wake.set(-4, atMs(-4, '06:40')); wake.set(-3, atMs(-3, '09:40')); // 11-14 (Fri) normal; 11-15 (Sat) a late-morning session
  const SCHED = SCHEDULES;
  const queueEnd = new Map<string, number>();
  for (const s of SCHED) {
    if (!s.enabled) continue;
    const [hh, mm] = s.at.split(':').map(Number) as [number, number];
    let nextSlot = atMs(s.from, s.at);
    for (let d = s.from; d <= 0; d++) {
      const W = wake.get(d); if (!W) continue;
      const endAwake = atMs(d, '22:30');
      if (nextSlot > endAwake) continue;
      let created: number; const slot = nextSlot;
      if (nextSlot <= W) created = W + 2000 * (SCHED.filter((x) => x.enabled && x.key < s.key).length % 7 + 1) + R.int(0, 800);
      else created = nextSlot + R.int(0, 12_000);
      if (created > NOW_MS - 2 * MIN) break;
      const startMs = Math.max(created + 700, queueEnd.get(`${s.queue}|${d}`) ?? 0);
      const dur = s.dur();
      const jb = base({ key: `job-${s.key}-${d}`, kind: s.key, queue: s.queue, payload: { ...(s.payload ?? {}), scheduleKey: s.key, slot: iso(slot) }, createdMs: created, runAtMs: created, startedMs: startMs, finishedMs: startMs + dur,
        dedupeKey: `sched:${s.key}`, scheduleKey: s.key, tag: 'sched', timeoutS: s.key === 'backup.nightly' ? 1800 : 600, result: s.result(d) });
      queueEnd.set(`${s.queue}|${d}`, startMs + dur + 500);
      add(jb);
      nextSlot = atMs(d + 1, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`); // the next local slot after this run
    }
  }

  // ── engine jobs hung off the scan runs ─────────────────────────────────────────────────────────
  const okRuns = runs.filter((r) => (r.status === 'succeeded' || r.status === 'partial') && r.mode !== 'reconcile' && r.f.nw > 0);
  // completion.check: after 30 successful runs that brought something new
  const compRuns = R.shuffle(okRuns.filter((r) => ['slack', 'gmail-work', 'claude', 'org62', 'gmail-shared'].includes(r.conn))).slice(0, 29);
  compRuns.sort((a, b) => a.endMs - b.endMs).forEach((r, i) => {
    const created = r.endMs + R.int(8, 45) * 1000; const dur = R.int(12, 90) * 1000;
    add(base({ key: `job-comp-${i + 1}`, kind: 'completion.check', queue: 'completion', payload: { connector: CONN[r.conn].scanKind, run_id: uid('scan_runs', r.n), trigger: r.trigger === 'hook' ? 'hook' : 'schedule' }, createdMs: created, runAtMs: created, startedMs: created + 900, finishedMs: created + 900 + dur,
      dedupeKey: `completion:${CONN[r.conn].scanKind}`, tag: 'completion', corr: uid('jobs', `corr:${r.key}`),
      result: { watermark: iso(r.endMs), checked: R.int(3, 18), judged: R.int(1, 9), applied: { close: R.int(0, 2), ask_still_needed: R.int(0, 2), wait: R.int(0, 3), reopen: R.chance(0.1) ? 1 : 0 }, escalated: R.chance(0.25) ? 1 : 0, costUsd: 0, calls: 0 } }));
  });
  // reevaluate: touched work items after a run
  const reevalWanted = (target: number) => {
    const list: JobT[] = [];
    let n = 0;
    for (const r of R.shuffle(okRuns)) {
      const k = Math.min(3, Math.max(1, Math.ceil(r.f.links / 3)));
      for (let i = 0; i < k && n < target; i++, n++) {
        const w = R.int(1, 92); const created = r.endMs + 2000 + i * 600 + R.int(0, 2500);
        list.push(base({ key: `job-reeval-${n}`, kind: 'reevaluate', queue: 'engine', payload: { work_item_id: wi(w), run_id: uid('scan_runs', r.n), connector: CONN[r.conn].scanKind, trigger: r.trigger, ...(r.mode === 'backfill' ? { catching_up: true } : {}) },
          createdMs: created, runAtMs: created + 2000, startedMs: created + 2400, finishedMs: created + 2400 + R.int(900, 7500), dedupeKey: `reeval:work_item:${wi(w)}`, generation: R.int(1, 9), supersedes: true, tag: 'reeval', corr: uid('jobs', `corr:${r.key}`),
          result: { outcome: R.weighted([['updated', 6], ['unchanged', 3], ['no_change', 1]] as any), workItemId: wi(w) } }));
      }
      if (n >= target) break;
    }
    return list;
  };
  const fixedOther = 0; void fixedOther;
  // settle.check, activity.suggest, nba.generate, readin, enrich, tool.run, outbox.dispatch, vdp.identity, activity.notes
  const wkDays = Array.from({ length: 31 }, (_, i) => i - 30).filter((d) => wake.has(d) && d > -29);
  const placeAt = (d: number) => { const W = wake.get(d)!; const lo = Math.max(W + 20 * MIN, atMs(d, '08:00')); const hi = Math.max(lo + 30 * MIN, atMs(d, '17:00')); return R.int(lo, d === 0 ? Math.min(hi, tms('2026-11-18T15:20:00.000Z')) : hi); };
  const days = (n: number) => Array.from({ length: n }, () => R.pick(wkDays));
  days(25).sort((a, b) => a - b).forEach((d, i) => {
    const created = placeAt(d); const dur = R.int(20, 160) * 1000;
    const capDay = d === -8 && created > atMs(-8, '12:41:30') && created < atMs(-8, '13:11');
    add(base({ key: `job-settle-${i + 1}`, kind: 'settle.check', queue: 'settle', payload: { trigger: R.weighted([['interval', 8], ['file_watch', 3], ['schedule', 2], ['catch_up', 1]] as any) }, createdMs: created, runAtMs: created + 10_000, startedMs: created + 11_000, finishedMs: created + 11_000 + dur,
      maxAttempts: 2, timeoutS: 3600, dedupeKey: 'settle:check', tag: 'settle',
      result: capDay ? { status: 'deferred_budget', through: iso(created - 4 * HOUR), firstPass: false, judged: 0, unjudged: R.int(4, 11), costUsd: 0, deferred: 'daily_hard_cap' } : R.chance(0.2) ? { status: 'nothing_to_do', through: iso(created), firstPass: false, judged: 0 } : { status: 'done', through: iso(created), firstPass: false, judged: R.int(2, 9), escalated: R.int(0, 2), changed: R.int(0, 3), costUsd: 0 } }));
  });
  for (let i = 0; i < 8; i++) { const d = R.pick(wkDays); const created = placeAt(d); add(base({ key: `job-asuggest-${i + 1}`, kind: 'activity.suggest', queue: 'engine', payload: { trigger: R.pick(['schedule', 'logging_batch', 'manual']) }, createdMs: created, runAtMs: created, startedMs: created + 800, finishedMs: created + 800 + R.int(6, 40) * 1000, tag: 'asuggest', result: { status: 'done', due: R.int(2, 9), calls: 0, answered: R.int(1, 6), unusable: 0, failed: 0, dropped: R.int(0, 1), costUsd: 0 } })); }
  for (let i = 0; i < 12; i++) { const d = R.pick(wkDays); const created = placeAt(d); add(base({ key: `job-nba-${i + 1}`, kind: 'nba.generate', queue: 'nba', payload: { work_item_id: wi(R.int(1, 80)), trigger: R.pick(['reevaluate', 'user_open', 'priority_top3']) }, createdMs: created, runAtMs: created, startedMs: created + 800, finishedMs: created + 800 + R.int(8, 55) * 1000, timeoutS: 300, dedupeKey: `nba:${R.int(1, 99999)}`, tag: 'nba', result: { nbaId: null, verb: R.pick(['reply', 'nudge', 'log_activity', 'update_vdp', 'schedule']), costUsd: 0, calls: 0 } })); }
  for (let i = 0; i < 8; i++) { const d = R.pick(wkDays); const created = placeAt(d); add(base({ key: `job-readin-${i + 1}`, kind: 'readin', queue: 'readin', payload: { work_item_id: wi(R.int(1, 60)), trigger: R.pick(['direct_ask', 'top_ranked', 'read_me_in']) }, createdMs: created, runAtMs: created, startedMs: created + 900, finishedMs: created + 900 + R.int(25, 140) * 1000, maxAttempts: 2, timeoutS: 900, tag: 'readin', result: { status: 'ready', tools: R.int(3, 12), costUsd: 0 } })); }
  for (let i = 0; i < 6; i++) { const d = R.pick(wkDays); const created = placeAt(d); add(base({ key: `job-enrich-${i + 1}`, kind: 'enrich', queue: 'engine', payload: { capture_id: uid('source_items', `si-${String(R.int(300, 400)).padStart(3, '0')}`), stage: R.pick(['intents', 'rank']) }, createdMs: created, runAtMs: created, startedMs: created + 600, finishedMs: created + 600 + R.int(3, 20) * 1000, tag: 'enrich', result: { stage: 'intents', outcome: 'ok', costUsd: 0 } })); }
  for (let i = 0; i < 4; i++) { const d = R.pick(wkDays.filter((x) => x > -20)); const created = placeAt(d); add(base({ key: `job-toolrun-${i + 1}`, kind: 'tool.run', queue: 'engine', payload: { tool: R.pick(['claude-demo-build', 'repo-status', 'blueprint-outline']), mode: 'launch' }, createdMs: created, runAtMs: created, startedMs: created + 700, finishedMs: created + 700 + R.int(40, 900) * 1000, timeoutS: 3600, maxAttempts: 1, tag: 'toolrun', result: { status: 'succeeded', exitCode: 0 } })); }
  for (let i = 0; i < 3; i++) { const d = R.pick(wkDays.filter((x) => x > -12)); const created = placeAt(d); add(base({ key: `job-vdpid-${i + 1}`, kind: 'vdp.identity', queue: 'vdp', payload: { account_id: uid('accounts', R.pick(['yarrowdale-bh', 'yarrowdale-mg', 'elderglen-home'])), trigger: 'candidate' }, createdMs: created, runAtMs: created, startedMs: created + 600, finishedMs: created + 600 + R.int(5, 25) * 1000, tag: 'vdpid', result: { resolved: 1, confidence: 'medium', costUsd: 0 } })); }
  for (let i = 0; i < 3; i++) { const d = R.pick(wkDays.filter((x) => x > -10)); const created = placeAt(d); add(base({ key: `job-anotes-${i + 1}`, kind: 'activity.notes', queue: 'engine', payload: { trigger: 'batch' }, createdMs: created, runAtMs: created, startedMs: created + 600, finishedMs: created + 600 + R.int(10, 50) * 1000, tag: 'anotes', result: { notes: R.int(3, 11), calls: 0, costUsd: 0 } })); }
  // outbox deliveries: one job, one attempt, idempotency key (Outbox, D-47/D-49); channels per settings.sending
  const outbox: Array<[number, string, string, string]> = [[-14, '15:20', 'slack', 'stage'], [-11, '10:05', 'gmail', 'stage'], [-9, '16:40', 'vdp', 'send'], [-7, '09:15', 'slack', 'stage'], [-5, '13:30', 'gmail', 'stage'], [-5, '17:05', 'slack_canvas', 'send'], [-4, '11:20', 'vdp', 'send'], [-3, '15:35', 'slack', 'stage'], [-2, '10:45', 'vdp', 'send'], [-1, '16:10', 'slack', 'stage']];
  outbox.forEach(([d, hh, ch, mode], i) => {
    const created = atMs(d, hh); const failed = i === 3;
    add(base({ key: `job-outbox-${i + 1}`, kind: 'outbox.dispatch', queue: 'outbox', payload: { channel: ch, delivery: mode, attempt: 1, draft_ref: `outbox-attempt-${i + 1}` }, createdMs: created, runAtMs: created, startedMs: created + 700, finishedMs: created + 700 + R.int(1, 9) * 1000, attempts: 1, maxAttempts: 1, timeoutS: 120,
      idemKey: `${mode}:outbox-attempt-${i + 1}:${uid('jobs', `idem-${i + 1}`).slice(0, 12)}`, tag: 'outbox', result: failed ? { outcome: 'failed', channel: ch, error: 'channel_not_found (the thread was archived)', retryable: false } : { outcome: mode === 'stage' ? 'staged' : 'delivered', channel: ch, readBack: true } }));
  });

  // ── dead letters ───────────────────────────────────────────────────────────────────────────────
  const dead = (key: string, kind: string, queue: string, createdMs: number, attempts: number, max: number, code: string, cls: string, reason: string, err: string, payload: any, spanMin: number) => {
    const j = add(base({ key, kind, queue, payload, status: 'dead', createdMs, runAtMs: createdMs, startedMs: createdMs + spanMin * MIN - 600_000 + 1000, finishedMs: createdMs + spanMin * MIN, attempts, maxAttempts: max, lastErrClass: cls, lastErrCode: code, lastErr: err, lastFailedMs: createdMs + spanMin * MIN, deadMs: createdMs + spanMin * MIN, deadReason: reason, tag: 'dead', timeoutS: 600 }));
    return j;
  };
  dead('job-dead-1', 'completion.check', 'completion', atMs(-19, '11:12'), 5, 5, 'timeout', 'transient', 'attempts exhausted: timeout', 'job exceeded its 600s timeout (lease expired)', { connector: 'slack', run_id: uid('scan_runs', 31), trigger: 'schedule' }, 52);
  dead('job-dead-2', 'scan.org62', 'scan.org62', atMs(-15, '14:30'), 3, 3, 'timeout', 'transient', 'attempts exhausted: timeout', 'job exceeded its 1500s timeout (lease expired)', { kind: 'scan', id: 'scan:org62:book:incremental:dead', connector: 'org62', scope: 'book', mode: 'incremental', trigger: 'schedule', priority: 60, dedupeKey: 'scan:org62:book', model: 'claude-haiku-5-5' }, 96);
  dead('job-dead-3', 'scan.gemini_notes', 'scan.gemini_notes', atMs(-11, '10:48'), 3, 3, 'mcp_failed', 'transient', 'attempts exhausted: mcp_failed', 'MCP server "gemini notes" failed to start (spawn exited with code 1)', { kind: 'scan', id: 'scan:gemini_notes:poll:incremental:dead', connector: 'gemini_notes', scope: 'poll', mode: 'incremental', trigger: 'schedule', priority: 60, dedupeKey: 'scan:gemini_notes:poll', model: 'claude-haiku-5-5' }, 18);
  dead('job-dead-4', 'scan.slack', 'scan.slack', atMs(-6, '08:40'), 3, 3, 'rate_limit', 'rate_limited', 'attempts exhausted: rate_limit', 'Slack: rate limited (429) on every attempt, retry-after 62s', { kind: 'scan', id: 'scan:slack:thread:targeted:dead', connector: 'slack', scope: `thread:${slackChannel(1)}:1762950000.000200`, mode: 'targeted', trigger: 'schedule', priority: 45, dedupeKey: `scan:slack:thread:${slackChannel(1)}`, model: 'claude-haiku-5-5', vars: { thread: { channelId: slackChannel(1), ts: '1762950000.000200' } } }, 12);
  dead('job-dead-5', 'nba.generate', 'nba', atMs(-1, '09:20'), 5, 5, 'timeout', 'transient', 'attempts exhausted: timeout', 'job exceeded its 300s timeout (lease expired)', { work_item_id: wi(14), trigger: 'priority_top3' }, 28).timeoutS = 300;

  // ── queued now and running now ────────────────────────────────────────────────────────────────
  const lastRun = (c: string, scope: string) => [...runs].reverse().find((r) => r.conn === c && r.scope === scope);
  const queuedScan = (key: string, c: keyof typeof CONN, scope: string, createdIso: string, runAtIso: string, pm: string, attempt?: number) => {
    const sk = CONN[c].scanKind; const lr = lastRun(c, scope); const created = tms(createdIso);
    const dk = `scan:${sk}:${scope}${pm === 'retry' ? '#retry' : ''}`;
    const to = runAtIso; const from = iso(lr ? lr.winTo : tms(runAtIso) - HOUR);
    add(base({ key, kind: `scan.${sk}`, queue: `scan.${sk}`, status: 'queued', createdMs: created, runAtMs: tms(runAtIso), priority: PRIO[pm]!, maxAttempts: 3, timeoutS: 1500, dedupeKey: dk, attempts: 0, tag: 'queued',
      payload: { kind: 'scan', id: `scan:${sk}:${scope}:${pm}:${from}:${to}`, connector: sk, scope, window: { from, to }, mode: pm, trigger: 'schedule', priority: PRIO[pm], runAt: runAtIso, dedupeKey: dk, model: 'claude-haiku-5-5', ...(attempt ? { attempt } : {}) },
      parentKey: pm === 'retry' ? runJob.get([...runs].reverse().find((r) => r.story === 'today-slack' && r.status === 'failed')!.key)?.key : undefined }));
  };
  queuedScan('job-q-slack', 'slack', 'inbox', '2026-11-18T15:41:01.000Z', '2026-11-18T16:06:00.000Z', 'retry', 2);
  queuedScan('job-q-org62', 'org62', 'opps', '2026-11-18T15:50:01.000Z', '2026-11-18T16:05:00.000Z', 'incremental');
  queuedScan('job-q-gmail', 'gmail-work', 'inbox', '2026-11-18T15:51:01.000Z', '2026-11-18T16:06:20.000Z', 'incremental');
  queuedScan('job-q-calendar', 'calendar', 'primary', '2026-11-18T15:54:01.000Z', '2026-11-18T16:09:00.000Z', 'incremental');
  queuedScan('job-q-drive', 'drive', 'tracked', '2026-11-18T15:53:01.000Z', '2026-11-18T16:12:00.000Z', 'incremental');
  add(base({ key: 'job-q-comp', kind: 'completion.check', queue: 'completion', status: 'queued', createdMs: tms('2026-11-18T15:55:40.000Z'), runAtMs: tms('2026-11-18T16:00:30.000Z'), attempts: 0, dedupeKey: 'completion:gemini_notes', tag: 'queued', payload: { connector: 'gemini_notes', run_id: uid('scan_runs', runs[runs.length - 1]!.n), trigger: 'schedule' } }));
  add(base({ key: 'job-running-settle', kind: 'settle.check', queue: 'settle', status: 'running', createdMs: tms('2026-11-18T15:58:50.000Z'), runAtMs: tms('2026-11-18T15:59:00.000Z'), startedMs: tms('2026-11-18T15:59:01.000Z'), maxAttempts: 2, timeoutS: 3600, attempts: 1, dedupeKey: 'settle:check', locked: true, tag: 'running', payload: { trigger: 'interval' } }));

  // ── fit reevaluate to the 500 target; cancel superseded ones ───────────────────────────────────
  const others = jobs.length;
  const need = 500 - others;
  const re = reevalWanted(Math.max(need, 0));
  // superseded pairs: a newer job for the same work item while the older one is queued/running
  const cancelled: JobT[] = [];
  for (let i = 0; i < Math.min(12, Math.floor(re.length / 6)); i++) {
    const a = re[i * 6]; const b = re[i * 6 + 1];
    if (!a || !b) continue;
    // b is the newer re-evaluation of the same work item, enqueued 2.5 s after a while a was still waiting
    b.payload.work_item_id = a.payload.work_item_id; b.dedupeKey = a.dedupeKey; b.generation = (a.generation ?? 1) + 1;
    const shift = a.createdMs + 2500 - b.createdMs; b.createdMs += shift; b.runAtMs += shift; b.startedMs! += shift; b.finishedMs! += shift;
    a.status = 'cancelled'; a.cancelReqMs = a.createdMs + 2600; a.cancelReason = 'superseded by a newer re-evaluation'; a.supersededByKey = b.key; a.finishedMs = a.createdMs + 3000; a.result = null; a.startedMs = a.createdMs + 2300; cancelled.push(a);
  }
  jobs.push(...re);
  if (jobs.length !== 500) throw new Error(`jobs total ${jobs.length}, expected 500`);

  // transient failures that succeeded on a second attempt
  for (const j of R.shuffle(jobs.filter((x) => x.status === 'succeeded' && ['reeval', 'completion', 'nba', 'readin', 'sched', 'settle'].includes(x.tag ?? ''))).slice(0, 14)) {
    j.attempts = 2; j.lastErrClass = 'transient'; j.lastErrCode = R.weighted([['timeout', 5], ['mcp_failed', 2], ['lease_expired', 1]] as any); j.lastErr = j.lastErrCode === 'timeout' ? 'job exceeded its timeout (lease expired)' : j.lastErrCode === 'lease_expired' ? 'lease expired while the worker was asleep' : 'MCP server connection reset';
    const prior = Math.min(j.timeoutS * 1000, 65_000); j.lastFailedMs = (j.startedMs ?? j.createdMs) + 1000; j.startedMs = (j.startedMs ?? j.createdMs) + prior + 30_000; j.finishedMs = (j.finishedMs ?? j.startedMs) + prior + 30_000;
  }

  jobs.sort((a, b) => a.createdMs - b.createdMs || a.key.localeCompare(b.key));
  jobs.forEach((j, i) => { j.id = i + 1; });
  void DAY; void r4;
  return { jobs, wake };
}

// ── schedules ──────────────────────────────────────────────────────────────────────────────────
interface Sched { key: string; at: string; queue: string; from: number; enabled: boolean; paused?: string; payload?: Record<string, any>; dur: () => number; result: (d: number) => Record<string, any> }
const q = (ms: [number, number]) => () => R.int(...ms) * 1000;
export const SCHEDULES: Sched[] = [
  { key: 'backup.nightly', at: '02:30', queue: 'maintenance', from: -30, enabled: true, dur: q([14, 42]), result: (d) => (R.chance(0.2) ? { skipped: 'not_due', db: 'control_center' } : { db: 'control_center', file: `cc-${new Date(atMs(d, '07:00')).toISOString().slice(0, 10)}.dump`, bytes: 4_200_000 + R.int(0, 3_000_000) + (d + 30) * 120_000, pruned: R.chance(0.3) ? 1 : 0 }) },
  { key: 'retention.scrub', at: '03:15', queue: 'maintenance', from: -30, enabled: true, dur: q([18, 90]), result: (d) => ({ bodiesPurged: d < -20 ? 0 : R.int(0, 14), sectionTextsPurged: R.int(0, 6), auditRowsScrubbed: R.int(0, 20), revisionsScrubbed: R.int(0, 4), readInsPurged: 0, traceEventsPurged: d < -3 ? R.int(0, 200) : 0, ...(d >= -5 ? { jobsDeleted: 0, healthChecksDeleted: 0, ledgerRowsDropped: 0, ledgerRowsCompacted: 0, scanRunsDeleted: 0, llmCallsRolledUp: 0, errors: [] } : {}) }) },
  { key: 'missed_opps.sweep', at: '06:00', queue: 'maintenance', from: -24, enabled: true, dur: q([35, 140]), result: () => ({ status: 'done', swept: R.int(18, 30), findings: R.int(0, 2), lookups: R.int(1, 4), costUsd: 0 }) },
  { key: 'brief.generate', at: '07:30', queue: 'brief', from: -29, enabled: true, dur: q([30, 180]), result: () => ({ status: 'ok', counts: { watches: 3, due: R.int(0, 3) }, briefs: R.int(0, 3), errors: [], costUsd: 0, followUpAt: null }) },
  { key: 'activity.sync', at: '17:30', queue: 'maintenance', from: -30, enabled: false, paused: 'not_wired', dur: q([1, 2]), result: () => ({ notWired: true, owner: 'BE-5' }) },
  { key: 'forecast.sync', at: '07:15', queue: 'forecast', from: -23, enabled: true, dur: q([18, 70]), result: () => ({ opps: R.int(8, 14), changed: R.int(0, 3), costUsd: 0 }) },
  { key: 'hygiene.sweep', at: '04:10', queue: 'maintenance', from: -5, enabled: true, dur: q([3, 12]), result: () => ({ deadScopesClosed: R.int(0, 2), staleRunsClosed: R.int(0, 1), errors: [] }) },
  { key: 'org62.readback', at: '06:40', queue: 'maintenance', from: -5, enabled: true, dur: q([12, 46]), result: () => ({ sourceItems: R.int(0, 6), events: R.int(0, 5), eventDays: [], dcsRead: R.int(2, 6), dcsDeleted: 0, eventsDeleted: R.chance(0.15) ? 1 : 0, costUsd: 0 }) },
  { key: 'vdp.specialist_aes', at: '06:50', queue: 'vdp', from: -7, enabled: true, payload: { trigger: 'daily' }, dur: q([16, 60]), result: () => ({ opps: R.int(4, 7), withAe: R.int(3, 6), full: true, costUsd: 0 }) },
  { key: 'accounts.hierarchy', at: '06:55', queue: 'vdp', from: -3, enabled: true, payload: { trigger: 'daily' }, dur: q([20, 70]), result: () => ({ accounts: 14, withParent: 5, full: true, costUsd: 0 }) },
];
void wi;
