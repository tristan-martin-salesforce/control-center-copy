/**
 * Doctor as a service (11 R6): the same checks as `npm run doctor`, for GET /api/v1/doctor, Health ▸ Setup and the
 * worker's 15-minute `doctor.checks` job.
 *
 *   - The worker runs every check and stores the report in the state folder (`doctor.json`); the web reads that (up to
 *     20 minutes old) instead of spawning `claude mcp list` per page view. `fresh` runs them now.
 *   - `only: 'db'` runs only what needs no database, and says when the app database is down (DEP.DB.DOWN with the
 *     start command), so app/global-error.tsx can explain it while nothing else loads.
 *   - Setup rows: one per dependency with its state machine (missing → installed → signed_out → expired → ok, plus
 *     offline and unknown) and the catalog's next step and button.
 * Reads only. Nothing here starts a sign-in or spends; the Claude smoke is its own, user-initiated call (./smoke.ts).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { DoctorPayload, SetupDependency } from '../contract/health';
import { render } from '../errors/render';
import { DB_FREE_CHECKS, type CheckResult, type DoctorContext } from './checks';
import type { McpServerSetup } from './checks/mcp';
import { doctorSummaryLine, realContext, runDoctor, type DoctorReport } from './doctor';
import { scopeMissSnapshot } from '../server/datasource/db/reads/session';
import { readScopesResult } from './checks/data';
import { stateDir } from './paths';
import { readSmoke, type StoredSmoke } from './smoke';
import { ORG62_SERVER, SLACK_SERVER } from './mcp';
import type { DependencyState } from '../reauth/types';

type Env = Record<string, string | undefined>;

export const DOCTOR_CACHE_MAX_AGE_MS = 20 * 60_000;
export const doctorCachePath = (env: Env = process.env) => join(stateDir(env), 'doctor.json');

export function writeCachedReport(r: DoctorReport, file = doctorCachePath()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(r));
    renameSync(`${file}.tmp`, file);
  } catch {
    /* best effort: the next run writes it */
  }
}

export function readCachedReport(file = doctorCachePath()): DoctorReport | null {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as DoctorReport;
    return r && Array.isArray(r.checks) && typeof r.generated_at === 'string' ? r : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ setup rows

interface DepSpec {
  id: string;
  label: string;
  why: string;
}

/** The dependencies Health ▸ Setup lists, in order, with why the app needs each (11 R7's table). */
export const DEPENDENCIES: DepSpec[] = [
  { id: 'claude-cli', label: 'Claude Code', why: 'Command Center reads Slack and Org62, and writes its summaries, through Claude Code.' },
  { id: 'claude-signin', label: 'Claude sign-in', why: 'Every model step (summaries, drafts, triage) needs Claude to answer: your sign-in or the company AI gateway.' },
  { id: 'slack-mcp', label: 'Slack', why: 'To-dos from your DMs, mentions and watched channels.' },
  { id: 'org62-mcp', label: 'Org62', why: 'Deals, events and activity logging.' },
  { id: 'devbar', label: 'Google (devbar)', why: 'Gmail, Calendar, Drive and meeting notes come in through devbar.' },
  { id: 'vdp-access', label: 'VDP', why: 'Keeps your VDPs current.' },
  { id: 'database', label: 'Database', why: 'Where your data lives on this Mac.' },
  { id: 'worker', label: 'Background worker', why: 'Scans your sources while you work.' },
  { id: 'node', label: 'Node.js', why: 'Runs Command Center.' },
  { id: 'state-folder', label: 'State folder', why: 'Where Command Center keeps its settings and logs on this Mac.' },
  { id: 'read-scopes', label: 'Page reads', why: 'Pages read only the data they show; a miss falls back to the whole model and is slower.' },
];

const stateOf = (c: CheckResult | undefined): DependencyState => {
  if (!c) return 'unknown';
  if (c.state) return c.state;
  return c.status === 'ok' ? 'ok' : c.status === 'skip' ? 'unknown' : 'installed';
};

function row(spec: DepSpec, state: DependencyState, code: string | undefined, lastChecked: string | null): SetupDependency {
  const out: SetupDependency = { id: spec.id, label: spec.label, why: spec.why, state, lastChecked };
  if (state !== 'ok' && code) {
    const r = render(code);
    out.code = r.code;
    out.nextStep = r.nextStep;
    if (r.action) out.action = r.action;
  }
  return out;
}

/** The report (and the last Claude smoke) → Health ▸ Setup's rows. Pure. */
export function setupDependencies(report: Pick<DoctorReport, 'checks' | 'generated_at'> | null, smoke: StoredSmoke | null = null): SetupDependency[] {
  const at = report?.generated_at ?? null;
  const by = new Map((report?.checks ?? []).map((c) => [c.id, c]));
  const out: SetupDependency[] = [];
  for (const spec of DEPENDENCIES) {
    switch (spec.id) {
      case 'claude-cli': {
        const c = by.get('claude');
        out.push(row(spec, stateOf(c), c?.code, at));
        break;
      }
      case 'claude-signin': {
        // only the user's Check again proves the sign-in (it costs a model call); before it, unknown, never broken
        if (!smoke) out.push({ ...row(spec, 'unknown', undefined, null), nextStep: 'Click Check again to test Claude (about $0.001).' });
        else out.push(row(spec, smoke.status === 'ok' ? 'ok' : smoke.status === 'refused' ? 'unknown' : smoke.code?.startsWith('RATE.') ? 'expired' : smoke.code?.startsWith('NET.') ? 'offline' : 'signed_out', smoke.code ?? undefined, smoke.checkedAt));
        break;
      }
      case 'slack-mcp':
      case 'org62-mcp': {
        const c = by.get('mcp');
        const setup = (c?.data?.setup ?? {}) as Record<string, McpServerSetup>;
        const s = setup[spec.id === 'slack-mcp' ? SLACK_SERVER : ORG62_SERVER];
        if (s) out.push(row(spec, s.state, s.code, at));
        else if (c?.code === 'DEP.CLAUDE.MISSING') out.push(row(spec, 'missing', 'DEP.CLAUDE.MISSING', at));
        else out.push(row(spec, 'unknown', undefined, c ? at : null));
        break;
      }
      case 'devbar': {
        const c = by.get('devbar');
        out.push(row(spec, stateOf(c), c?.code, at));
        break;
      }
      case 'vdp-access': {
        const c = by.get('vdp');
        if (c?.status === 'skip') continue; // not in this persona
        out.push(row(spec, stateOf(c), c?.code, at));
        break;
      }
      case 'database': {
        const bad = ['postgres', 'database', 'migrations'].map((id) => by.get(id)).find((c) => c && (c.status === 'fail' || c.status === 'warn') && c.code);
        const pg = by.get('postgres');
        const r = row(spec, bad ? stateOf(bad) : pg ? stateOf(pg) : 'unknown', bad?.code, at);
        // D-98: which start command depends on the database (the bundled cluster's agent, or Homebrew's service)
        if (bad?.code === 'DEP.DB.DOWN' && bad.fix && r.action?.kind === 'run') r.action = { ...r.action, ref: bad.fix };
        out.push(r);
        break;
      }
      case 'worker': {
        // alive (the heartbeat line ok) but tripping on something: the worker's last error names the fix
        const hb = by.get('heartbeat');
        const err = by.get('worker-error');
        const c = hb?.status === 'ok' && err && (err.status === 'warn' || err.status === 'fail') ? err : hb;
        out.push(row(spec, stateOf(c), c?.code, at));
        break;
      }
      case 'node': {
        const c = by.get('node');
        out.push(row(spec, stateOf(c), c?.code, at));
        break;
      }
      case 'state-folder':
      case 'read-scopes': {
        // W34-4/5: rows with no catalog code; the check's own detail and fix are the words
        const c = by.get(spec.id === 'state-folder' ? 'setup:state-folder' : 'data:read-scopes');
        if (!c || c.status === 'skip') continue;
        const r = row(spec, stateOf(c), undefined, at);
        if (r.state !== 'ok') {
          r.why = c.detail;
          if (c.fix) r.nextStep = c.fix;
          if (c.fix?.startsWith('node ')) r.action = { kind: 'run', ref: c.fix, label: 'Copy command' };
        }
        out.push(r);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ the route's payload

/** The DB-down block (DEP.DB.DOWN / DEP.DB.MISSING) when Postgres or the app database check failed. */
export function databaseBlock(checks: CheckResult[]): DoctorPayload['database'] {
  const c = checks.find((x) => (x.id === 'postgres' || x.id === 'database') && x.status === 'fail' && (x.code === 'DEP.DB.DOWN' || x.code === 'DEP.DB.MISSING' || x.code === 'DEP.DB.NOT_SET_UP'));
  if (!c) return null;
  const r = render(c.code);
  // DEP.DB.DOWN's start command depends on the database (D-98: the bundled cluster's agent, or Homebrew's service):
  // the check's own fix names the right one
  const command = c.code === 'DEP.DB.DOWN' && c.fix ? c.fix : r.action?.kind === 'run' ? r.action.ref : (c.fix ?? null);
  return { code: r.code, title: r.title, text: r.text, nextStep: r.nextStep, command };
}

/**
 * The read-scope miss counter lives in THIS (web) process, so a report made by the worker or the CLI has only a skip
 * row for it. The web's doctor service swaps in the live count (W34-4).
 */
export function withLiveScopes(r: DoctorReport, scopeMisses: DoctorContext['scopeMisses'] = scopeMissSnapshot): DoctorReport {
  const live = readScopesResult(scopeMisses);
  const rest = r.checks.filter((x) => x.id !== live.id);
  const checks = [...rest, live];
  const summary = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const x of checks) summary[x.status]++;
  return { ...r, checks, summary, ok: summary.fail === 0 };
}

export function toPayload(r: DoctorReport, o: { cached: boolean; simulated?: boolean; smoke?: StoredSmoke | null }): DoctorPayload {
  return {
    generatedAt: r.generated_at,
    ok: r.ok,
    simulated: o.simulated ?? false,
    cached: o.cached,
    summary: r.summary,
    summaryLine: doctorSummaryLine(r),
    checks: r.checks.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status,
      detail: c.detail,
      ...(c.fix ? { fix: c.fix } : {}),
      ...(c.state ? { state: c.state } : {}),
      ...(c.code ? { code: c.code, title: render(c.code).title, nextStep: render(c.code).nextStep } : {}),
    })),
    dependencies: setupDependencies(r, o.smoke ?? null),
    database: databaseBlock(r.checks),
  };
}

export interface DoctorServiceDeps {
  context?: () => Promise<DoctorContext>;
  env?: Env;
  now?: () => number;
}

/**
 * GET /api/v1/doctor. `only: 'db'` always runs (it is quick and needs no database); otherwise the stored report when
 * it is under 20 minutes old and `fresh` is off, else a run now (stored for the next reader).
 */
export async function doctorPayload(q: { fresh?: boolean; only?: 'all' | 'db' }, deps: DoctorServiceDeps = {}): Promise<DoctorPayload> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const smoke = readSmoke(env);
  if (q.only === 'db') {
    const r = await runDoctor(await (deps.context ?? realContext)(), { only: [...DB_FREE_CHECKS, 'database'] });
    return toPayload(r, { cached: false, smoke });
  }
  const cached = q.fresh ? null : readCachedReport(doctorCachePath(env));
  if (cached && now() - Date.parse(cached.generated_at) < DOCTOR_CACHE_MAX_AGE_MS) return toPayload(withLiveScopes(cached), { cached: true, smoke });
  const r = await runDoctor(await (deps.context ?? realContext)());
  writeCachedReport(r, doctorCachePath(env));
  return toPayload(withLiveScopes(r), { cached: false, smoke });
}

/** Health ▸ Setup in the db DataSource: the stored report (never a run on the page's request), plus the last smoke. */
export function cachedSetup(env: Env = process.env): SetupDependency[] {
  const cached = readCachedReport(doctorCachePath(env));
  return setupDependencies(cached ? withLiveScopes(cached) : null, readSmoke(env));
}
