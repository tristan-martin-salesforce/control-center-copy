/**
 * 11 R6: doctor as a service: catalog codes on the checks, Health ▸ Setup rows, GET /doctor (cached, fresh, DB-free
 * with DEP.DB.DOWN), the user-initiated Claude smoke (refused without a gateway), the doctor job's events, and the
 * DB-down API error (no raw ECONNREFUSED).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DoctorPayload, HealthPayload } from '../../src/contract';
import { recordDoctorEvents } from '../../src/jobs/handlers/doctor';
import { formatReport, runDoctor, type DoctorContext } from '../../src/ops/doctor';
import { doctorPayload, readCachedReport, doctorCachePath, setupDependencies, writeCachedReport } from '../../src/ops/doctor-service';
import type { ExecFn, ExecResult } from '../../src/ops/exec';
import { readSmoke, runClaudeSmoke } from '../../src/ops/smoke';
import { resetDataSourceForTests } from '../../src/server/datasource';
import { appErrorFrom } from '../../src/server/errors';
import * as doctorRoute from '../../app/api/v1/doctor/route';
import * as healthRoute from '../../app/api/v1/health/route';

let dir: string;
const NOW = Date.parse('2026-11-20T15:00:00Z');
const res = (o: Partial<ExecResult> = {}): ExecResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...o });

function ctx(exec: ExecFn, over: Partial<DoctorContext> = {}): DoctorContext {
  return {
    env: { HOME: dir, CC_STATE_DIR: join(dir, 'state'), CC_LAUNCH_AGENTS_DIR: join(dir, 'agents') },
    repoRoot: dir,
    exec,
    now: () => NOW,
    portOpen: async () => false,
    withDb: async () => null,
    fetchStatus: async () => 405,
    freeBytes: () => 50 * 1024 ** 3,
    uid: 501,
    claudeBin: 'claude',
    ...over,
  };
}

const machine: ExecFn = async (cmd, args) => {
  if (cmd === 'claude' && args[0] === '--version') return res({ stdout: '2.1.329 (Claude Code)\n' });
  if (cmd === 'claude') return res({ stdout: 'slack: https://u (HTTP) - ! Needs authentication\n' });
  if (cmd === 'devbar') return res({ code: null, spawnError: 'ENOENT' });
  if (cmd.endsWith('pg_isready')) return res({ code: 2 });
  return res({ code: 1 });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-doctor-svc-'));
  // a 1.x machine: the env file holds the Homebrew default (D-98: no URL at all means the bundled cluster)
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'env'), 'DATABASE_URL=postgresql://localhost:5432/command_center\n', { mode: 0o600 });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetDataSourceForTests();
});

describe('checks carry catalog codes and states', () => {
  it('names devbar missing, Slack signed out, Org62 not declared, the database down, and an old Claude CLI', async () => {
    const r = await runDoctor(ctx(machine), { only: ['claude', 'mcp', 'devbar', 'postgres'] });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(by.devbar).toMatchObject({ status: 'fail', code: 'DEP.DEVBAR.MISSING', state: 'missing', detail: 'devbar not installed' });
    expect(by.mcp).toMatchObject({ code: 'AUTH.SLACK.SIGNED_OUT', data: { setup: { slack: { state: 'signed_out', code: 'AUTH.SLACK.SIGNED_OUT' }, 'Org62-Sobject-Read': { state: 'missing', code: 'MCP.SERVER_NOT_DECLARED' } } } });
    expect(by.postgres).toMatchObject({ status: 'fail', code: 'DEP.DB.DOWN' });
    expect(by.claude).toMatchObject({ status: 'ok', data: { version: '2.1.329 (Claude Code)' } });
    const old = await runDoctor(ctx(async () => res({ stdout: '1.0.3 (Claude Code)\n' })), { only: ['claude'] });
    expect(old.checks[0]).toMatchObject({ status: 'fail', code: 'DEP.CLAUDE.TOO_OLD', fix: 'claude update' });
    expect(formatReport(r)).toMatch(/devbar not installed \[DEP\.DEVBAR\.MISSING\]\n\s+fix: .*\n\s+what to do: Install devbar/);
  });

  it('the setup rows follow the state machine, with the catalog next step and button', async () => {
    const r = await runDoctor(ctx(machine), { only: ['claude', 'mcp', 'devbar', 'postgres', 'node'] });
    const rows = Object.fromEntries(setupDependencies(r).map((d) => [d.id, d]));
    expect(rows.devbar).toMatchObject({ state: 'missing', code: 'DEP.DEVBAR.MISSING', action: { kind: 'link' } });
    expect(rows['slack-mcp']).toMatchObject({ state: 'signed_out', code: 'AUTH.SLACK.SIGNED_OUT', action: { kind: 'reauth', ref: 'slack' } });
    expect(rows['org62-mcp']).toMatchObject({ state: 'missing', code: 'MCP.SERVER_NOT_DECLARED' });
    expect(rows.database).toMatchObject({ code: 'DEP.DB.DOWN', action: { kind: 'run', ref: 'brew services start postgresql@17' } });
    expect(rows['claude-cli']).toMatchObject({ state: 'ok' });
    expect(rows['claude-cli']!.nextStep).toBeUndefined();
    // the sign-in is unknown (never "broken") until the user's Check again
    expect(rows['claude-signin']).toMatchObject({ state: 'unknown', lastChecked: null });
    expect(rows.worker).toMatchObject({ state: 'unknown' });
  });
});

describe('the bundled database (D-98)', () => {
  const bundled = (over: Partial<DoctorContext> = {}) => {
    writeFileSync(join(dir, 'state', 'env'), 'CC_DATA=db\n', { mode: 0o600 }); // no DATABASE_URL: Command Center's own
    return ctx(machine, over);
  };
  it('not set up yet: DEP.DB.NOT_SET_UP, and the install command; the DB-down page says so too', async () => {
    const r = await runDoctor(bundled(), { only: ['postgres'] });
    expect(r.checks[0]).toMatchObject({ status: 'fail', code: 'DEP.DB.NOT_SET_UP', fix: 'npm run ops:install', state: 'missing' });
    const p = await doctorPayload({ only: 'db' }, { context: async () => bundled(), env: { CC_STATE_DIR: join(dir, 'state') } });
    expect(p.database).toMatchObject({ code: 'DEP.DB.NOT_SET_UP', command: 'npm run ops:install' });
  });
  it('set up but down: DEP.DB.DOWN with the agent restart, on the check, the setup row and the DB-down page', async () => {
    mkdirSync(join(dir, 'state', 'pg', 'data'), { recursive: true });
    writeFileSync(join(dir, 'state', 'pg', 'data', 'PG_VERSION'), '17\n');
    const pinged: string[] = [];
    const c = bundled({ pingSocket: async (s) => (pinged.push(s), 'down') });
    const r = await runDoctor(c, { only: ['postgres'] });
    expect(r.checks[0]).toMatchObject({ status: 'fail', code: 'DEP.DB.DOWN', fix: 'launchctl kickstart -k gui/$UID/com.commandcenter.db' });
    expect(pinged).toEqual([join(dir, 'state', 'pg', 'run', '.s.PGSQL.5432')]);
    expect(Object.fromEntries(setupDependencies(r).map((d) => [d.id, d])).database).toMatchObject({ code: 'DEP.DB.DOWN', action: { kind: 'run', ref: 'launchctl kickstart -k gui/$UID/com.commandcenter.db' } });
    const up = await runDoctor(bundled({ pingSocket: async () => 'ready' }), { only: ['postgres'] });
    expect(up.checks[0]).toMatchObject({ status: 'ok', data: { engine: 'bundled' } });
  });
});

describe('GET /doctor', () => {
  it('only=db answers without the database and says DEP.DB.DOWN with the start command', async () => {
    const p = await doctorPayload({ only: 'db' }, { context: async () => ctx(machine), env: { CC_STATE_DIR: join(dir, 'state') } });
    expect(DoctorPayload.safeParse(p).success).toBe(true);
    expect(p.database).toMatchObject({ code: 'DEP.DB.DOWN', title: "The database isn't running", command: 'brew services start postgresql@17' });
    expect(p.checks.map((c) => c.id)).not.toContain('mcp');
  });

  it('reads the stored report while it is fresh, runs (and stores) otherwise', async () => {
    const env = { CC_STATE_DIR: join(dir, 'state') };
    const run = vi.fn(async () => ctx(machine));
    const first = await doctorPayload({}, { context: run, env, now: () => NOW });
    expect(first.cached).toBe(false);
    expect(readCachedReport(doctorCachePath(env))).not.toBeNull();
    const second = await doctorPayload({}, { context: run, env, now: () => NOW + 60_000 });
    expect(second.cached).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect((await doctorPayload({ fresh: true }, { context: run, env, now: () => NOW + 60_000 })).cached).toBe(false);
    expect((await doctorPayload({}, { context: run, env, now: () => NOW + 30 * 60_000 })).cached).toBe(false);
    expect(first.summaryLine).toMatch(/DEP\.DEVBAR\.MISSING/);
  });

  it('the generated route answers in mock mode with fixture states, and Health carries setup', async () => {
    const r = await doctorRoute.GET(new Request('http://localhost/api/v1/doctor'), { params: Promise.resolve({}) });
    expect(r.status).toBe(200);
    const body = DoctorPayload.parse(await r.json());
    expect(body.simulated).toBe(true);
    expect(body.dependencies.map((d) => d.id)).toEqual(expect.arrayContaining(['claude-cli', 'claude-signin', 'slack-mcp', 'org62-mcp', 'devbar', 'database', 'worker', 'node']));
    const h = HealthPayload.parse(await (await healthRoute.GET(new Request('http://localhost/api/v1/health'), { params: Promise.resolve({}) })).json());
    expect(h.setup?.dependencies.length).toBeGreaterThan(5);
  });
});

describe('the Claude smoke (user-initiated, never automatic)', () => {
  it('refuses cleanly, running nothing, when no AI gateway is configured', async () => {
    const exec = vi.fn<ExecFn>(async () => res());
    const env = { CC_STATE_DIR: join(dir, 'state') };
    const r = await runClaudeSmoke({ exec, env, gateway: false, now: () => new Date(NOW) });
    expect(r).toMatchObject({ status: 'refused', code: 'AUTH.LLM.NO_GATEWAY', costUsd: null, estimateUsd: 0.001 });
    expect(exec).not.toHaveBeenCalled();
    expect(readSmoke(env)).toMatchObject({ status: 'refused' });
    expect(setupDependencies(null, readSmoke(env)).find((d) => d.id === 'claude-signin')).toMatchObject({ state: 'unknown' });
  });

  it('with a gateway: one `claude -p "reply OK" --max-turns 1`; ok shows its cost, a failure its catalog code', async () => {
    const env = { CC_STATE_DIR: join(dir, 'state') };
    const ok = vi.fn<ExecFn>(async () => res({ stdout: JSON.stringify({ is_error: false, result: 'OK', total_cost_usd: 0.0008 }) }));
    expect(await runClaudeSmoke({ exec: ok, env, gateway: true, claudeBin: 'claude' })).toMatchObject({ status: 'ok', costUsd: 0.0008 });
    expect(ok.mock.calls[0]![1].slice(0, 4)).toEqual(['-p', 'reply OK', '--max-turns', '1']);
    const limit = vi.fn<ExecFn>(async () => res({ code: 1, stdout: JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached|1793900000' }) }));
    const f = await runClaudeSmoke({ exec: limit, env, gateway: true, claudeBin: 'claude' });
    expect(f).toMatchObject({ status: 'failed', code: 'RATE.LLM.USAGE_LIMIT' });
    expect(f.message).not.toMatch(/1793900000/);
  });
});

describe('the doctor job and the DB-down error', () => {
  it('writes one row per failing code (fingerprint doctor|<code>) and resolves the rest', async () => {
    const r = await runDoctor(ctx(machine), { only: ['devbar', 'mcp', 'claude'] });
    const calls: string[] = [];
    const db = { execute: vi.fn(async (q: { queryChunks?: unknown[] }) => void calls.push(JSON.stringify(q.queryChunks ?? q))) } as never;
    const codes = await recordDoctorEvents(db, '00000000-0000-0000-0000-000000000001', r);
    expect(codes).toEqual(expect.arrayContaining(['DEP.DEVBAR.MISSING', 'MCP.SERVER_NOT_DECLARED']));
    expect(calls).toHaveLength(codes.length + 1);
    expect(calls.join(' ')).toMatch(/doctor\|DEP\.DEVBAR\.MISSING/);
    expect(calls.at(-1)).toMatch(/resolved_at = now\(\)/);
  });

  it('a refused database connection reads as DEP.DB.DOWN, never the raw ECONNREFUSED', () => {
    const e = appErrorFrom(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }));
    expect(e.code).toBe('upstream_unavailable');
    expect(e.message).toBe("The database isn't running. Start it: launchctl kickstart -k gui/$UID/com.commandcenter.db (on Homebrew Postgres: brew services start postgresql@17), then reload this page.");
    expect(e.details).toEqual({ code: 'DEP.DB.DOWN' });
    // D-98: the bundled cluster's socket is gone (a clean shutdown removes it)
    expect(appErrorFrom(Object.assign(new Error('connect ENOENT /Users/a/Library/Application Support/command-center/pg/run/.s.PGSQL.5432'), { code: 'ENOENT' })).details).toEqual({ code: 'DEP.DB.DOWN' });
    expect(appErrorFrom(new Error('database "command_center" does not exist')).details).toEqual({ code: 'DEP.DB.MISSING' });
    expect(appErrorFrom(new Error('boom')).code).toBe('internal');
  });

  it('a stored report round-trips', () => {
    const file = join(dir, 'state', 'doctor.json');
    writeCachedReport({ generated_at: new Date(NOW).toISOString(), ok: true, summary: { ok: 1, warn: 0, fail: 0, skip: 0 }, checks: [] }, file);
    expect(readCachedReport(file)?.summary.ok).toBe(1);
  });
});
