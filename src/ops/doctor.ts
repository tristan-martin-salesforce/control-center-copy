/**
 * `npm run doctor [-- --json] [--skip id,id] [--only id,id]`
 *
 * Read-only health and prerequisite check (R-UI-12, D-42), now a service (11 R6): the checks live in
 * src/ops/checks/* (one file each), and the same `runDoctor` serves this CLI, GET /api/v1/doctor
 * (src/ops/doctor-service.ts) and the worker's 15-minute `doctor.checks` job. Each failing check carries an error
 * catalog code (src/errors/catalog.ts) that the CLI prints, Health ▸ Setup renders and the worker records.
 * Never prints secrets: the VDP PAT and cookie are only tested for presence/expiry, env-file values are never echoed,
 * and `claude mcp list` output is reduced to server names and a state.
 */
import net from 'node:net';
import { resolve } from 'node:path';
import { statfsSync } from 'node:fs';

import { render } from '../errors/render';
import { findClaudeBin } from './claude-bin';
import { ALL_CHECKS, bad, pasteableStep, type CheckResult, type CheckStatus, type DoctorContext } from './checks';
import { readEnvFile } from './envfile';
import { run } from './exec';
import { resolveDatabaseUrl } from '../db/client';
import { envFilePath } from './paths';

export * from './checks';

// ---------------------------------------------------------------- runner

export interface DoctorReport {
  generated_at: string;
  ok: boolean;
  summary: Record<CheckStatus, number>;
  checks: CheckResult[];
}

export async function runDoctor(ctx: DoctorContext, opts: { skip?: string[]; only?: string[] } = {}): Promise<DoctorReport> {
  const selected = ALL_CHECKS.filter(([id]) => (!opts.only?.length || opts.only.includes(id)) && !opts.skip?.includes(id));
  // Run concurrently; the slow ones (claude mcp list, devbar) dominate.
  const checks = await Promise.all(
    selected.map(async ([id, fn]) => {
      try {
        return await fn(ctx);
      } catch (e) {
        return bad('warn', id, id, `check crashed (${e instanceof Error ? e.name : 'error'})`, 'report this as a bug', undefined, { code: 'BUG.CHECK_CRASHED', state: 'unknown' });
      }
    }),
  );
  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) summary[c.status]++;
  return { generated_at: new Date(ctx.now()).toISOString(), ok: summary.fail === 0, summary, checks };
}

const MARK: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

/** The catalog codes of the checks that are not ok (warn/fail), in report order, deduplicated. */
export function failingCodes(r: Pick<DoctorReport, 'checks'>): string[] {
  return [...new Set(r.checks.filter((c) => c.status === 'warn' || c.status === 'fail').flatMap(codesOf))];
}

/** A check's codes: its own, plus one per sub-dependency it reports (the MCP check's Slack and Org62 rows). */
export function codesOf(c: CheckResult): string[] {
  const setup = (c.data?.setup ?? {}) as Record<string, { code?: string }>;
  return [...new Set([...(c.code ? [c.code] : []), ...Object.values(setup).flatMap((s) => (s?.code ? [s.code] : []))])];
}

/** One line: "3 ok, 1 warning, 1 failed · DEP.DEVBAR.MISSING, AUTH.SLACK.SIGNED_OUT". */
export function doctorSummaryLine(r: Pick<DoctorReport, 'checks' | 'summary'>): string {
  const s = r.summary;
  const codes = failingCodes(r);
  return `${s.ok} ok, ${s.warn} warnings, ${s.fail} failed, ${s.skip} skipped${codes.length ? ` · ${codes.join(', ')}` : ''}`;
}

/** `ctx`: the doctor's context, so the catalog's `npm run …` steps come out pasteable in a release (ON-19). */
export function formatReport(r: DoctorReport, ctx?: Pick<DoctorContext, 'repoRoot' | 'env'>): string {
  const lines = r.checks.map((c) => {
    const tag = c.code && c.status !== 'ok' && c.status !== 'skip' ? ` [${c.code}]` : '';
    const base = `${MARK[c.status]} ${c.label}: ${c.detail}${tag}`;
    if (c.status === 'ok' || !c.fix) return base;
    // the exact command, then the catalog's plain-language next step
    const next = c.code && c.status !== 'skip' ? render(c.code).nextStep : '';
    const step = next ? `\n    what to do: ${ctx ? pasteableStep(ctx, next) : next}` : '';
    return `${base}\n    fix: ${c.fix}${step}`;
  });
  const s = r.summary;
  lines.push('', `${s.ok} ok, ${s.warn} warnings, ${s.fail} failed, ${s.skip} skipped`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- real context + CLI

export async function realContext(): Promise<DoctorContext> {
  const env = process.env;
  const fileEnv = readEnvFile(envFilePath(env)) ?? {};
  const configured = env.DATABASE_URL ?? fileEnv.DATABASE_URL;
  let configuredDb: string | undefined;
  try {
    configuredDb = configured ? decodeURIComponent(new URL(configured).pathname.replace(/^\//, '')) || undefined : undefined;
  } catch {
    configuredDb = undefined;
  }
  // the database the app uses (D-98: environment → env file → the bundled cluster's socket)
  const base = resolveDatabaseUrl(undefined, env);
  const dbUrl = (database: string) => {
    try {
      const u = new URL(base);
      u.pathname = `/${database}`;
      return u.toString();
    } catch {
      return `postgresql://localhost:5432/${database}`;
    }
  };
  return {
    env,
    repoRoot: resolve(process.cwd()),
    exec: run,
    now: Date.now,
    claudeBin: findClaudeBin({ env }).path,
    appDb: configuredDb,
    uid: process.getuid?.() ?? 501,
    portOpen: (port) =>
      new Promise((res) => {
        const s = net.connect({ port, host: '127.0.0.1' });
        s.setTimeout(1500);
        s.once('connect', () => (s.destroy(), res(true)));
        s.once('timeout', () => (s.destroy(), res(false)));
        s.once('error', () => res(false));
      }),
    fetchStatus: async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        await r.body?.cancel();
        return r.status;
      } catch {
        return null;
      }
    },
    freeBytes: (p) => {
      try {
        const s = statfsSync(p);
        return s.bavail * s.bsize;
      } catch {
        try {
          const s = statfsSync('/');
          return s.bavail * s.bsize;
        } catch {
          return null;
        }
      }
    },
    withDb: async (database, fn) => {
      let pg: typeof import('pg');
      try {
        pg = (await import('pg')).default as unknown as typeof import('pg');
      } catch {
        return null;
      }
      const client = new pg.Client({ connectionString: dbUrl(database), connectionTimeoutMillis: 4000 });
      try {
        await client.connect();
      } catch {
        return null;
      }
      try {
        await client.query('SET default_transaction_read_only = on');
        return await fn(async (sql, params) => (await client.query(sql, params as unknown[])).rows as Array<Record<string, unknown>>);
      } catch {
        return null;
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}

function listArg(argv: string[], flag: string): string[] | undefined {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  // D-101: a 1.x state folder (and its database, agents and logs) moves before the checks read it
  if (!argv.includes('--json')) await (await import('../../scripts/ops/lib/migrate-state-real.mjs')).ensureStateMigrated({ say: (m: string) => console.log('[migrate] ' + m) });
  const ctx = await realContext();
  const report = await runDoctor(ctx, { skip: listArg(argv, '--skip'), only: listArg(argv, '--only') });
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report, ctx));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && /doctor\.(ts|js|mjs)$/.test(process.argv[1])) {
  main().then((code) => process.exit(code));
}
