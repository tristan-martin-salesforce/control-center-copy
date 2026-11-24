/** D-90 / D-98: the installer's database step: Homebrew's probes (1.x, CC_DB_ENGINE=homebrew) and which database it picks. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BREW_INSTALL_PG, BREW_START_PG, bundledPostgres, ensureDatabase, ensureDatabaseMessage, homebrewPostgres, switchEnvToBundled } from '../../scripts/ops/lib/ensure-db.mjs';
import { bundledDatabaseUrl } from '../../scripts/ops/lib/pg.mjs';

const BIN = '/opt/homebrew/opt/postgresql@17/bin';

function deps(o: { installed?: boolean; ready?: boolean; list?: { code: number; stdout: string }; createOk?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    d: {
      bin: BIN,
      exists: () => o.installed ?? true,
      run: (cmd: string, args: string[]) => {
        const tool = cmd.split('/').pop()!;
        calls.push(`${tool} ${args.join(' ')}`);
        if (tool === 'pg_isready') return { code: o.ready === false ? 2 : 0, stdout: '' };
        if (tool === 'psql') return o.list ?? { code: 0, stdout: '1' };
        if (tool === 'createdb') return { code: o.createOk === false ? 1 : 0, stdout: '' };
        return { code: 127, stdout: '' };
      },
    },
  };
}

describe('homebrewPostgres (1.x, and CC_DB_ENGINE=homebrew)', () => {
  it('not installed: says so and prints the exact brew install + start command', () => {
    const { d, calls } = deps({ installed: false });
    const r = homebrewPostgres(d);
    expect(r).toMatchObject({ ok: false, state: 'missing', engine: 'homebrew-pg17', command: 'brew install postgresql@17 && brew services start postgresql@17' });
    expect(BREW_INSTALL_PG).toBe('brew install postgresql@17 && brew services start postgresql@17');
    expect(calls).toEqual([]);
    expect(ensureDatabaseMessage(r)).toBe('Postgres 17 is not installed. Command Center keeps your data in it, on this Mac.\n  Run this in Terminal, then run the install again:\n    brew install postgresql@17 && brew services start postgresql@17');
  });

  it('installed but stopped: the start command only', () => {
    const r = homebrewPostgres(deps({ ready: false }).d);
    expect(r).toMatchObject({ ok: false, state: 'stopped', command: BREW_START_PG });
    expect(ensureDatabaseMessage(r)).toContain('brew services start postgresql@17');
  });

  it('running with the database: ok, nothing created', () => {
    const { d, calls } = deps();
    expect(homebrewPostgres(d, { db: 'command_center' })).toMatchObject({ ok: true, state: 'ok', created: false });
    expect(calls).toEqual(['pg_isready -h localhost -p 5432', "psql -h localhost -p 5432 -d postgres -tAc SELECT 1 FROM pg_database WHERE datname = 'command_center'"]);
  });

  it('running without the database: creates it; --dry only says it would', () => {
    const a = deps({ list: { code: 0, stdout: '' } });
    expect(homebrewPostgres(a.d, { db: 'command_center' })).toMatchObject({ ok: true, created: true });
    expect(a.calls.at(-1)).toBe('createdb -h localhost -p 5432 command_center');
    const b = deps({ list: { code: 0, stdout: '' } });
    expect(homebrewPostgres(b.d, { db: 'command_center', dry: true })).toMatchObject({ ok: true, state: 'no_database', message: expect.stringContaining('would be created') });
    expect(b.calls.some((c) => c.startsWith('createdb'))).toBe(false);
    expect(homebrewPostgres(deps({ list: { code: 0, stdout: '' }, createOk: false }).d)).toMatchObject({ ok: false, state: 'no_database' });
  });

  it('refuses a database name it cannot pass to createdb safely', () => {
    expect(homebrewPostgres(deps().d, { db: "x'; drop" })).toMatchObject({ ok: false, state: 'bad_name' });
  });
});

describe('ensureDatabase picks the database (D-98)', () => {
  let state: string;
  let env: Record<string, string>;
  const V1 = 'postgresql://localhost:5432/command_center';
  beforeEach(() => {
    state = mkdtempSync(join(tmpdir(), 'cc-ensure-db-'));
    env = { HOME: state, CC_STATE_DIR: state, CC_LOG_DIR: join(state, 'logs') };
  });
  afterEach(() => rmSync(state, { recursive: true, force: true }));

  const fakeBundled = (o: { prepare?: { ok: boolean; message?: string; state?: string; command?: string } } = {}) => {
    const calls: string[] = [];
    return {
      calls,
      b: {
        prepare: async () => (calls.push('prepare'), o.prepare ?? { ok: true, created: true, message: 'created' }),
        ensureDb: async () => (calls.push('createdb'), { created: true }),
        switchEnv: () => calls.push('env'),
      },
    };
  };

  it('a fresh Mac (no DATABASE_URL anywhere): the bundled cluster, no Homebrew step at all', async () => {
    const f = fakeBundled();
    const h = deps({ installed: false });
    const r = await ensureDatabase({ env, fileEnv: {}, homebrew: h.d, bundled: f.b });
    expect(r).toMatchObject({ ok: true, state: 'ok', engine: 'bundled-pg17', created: true });
    expect(f.calls).toEqual(['prepare', 'createdb', 'env']);
    expect(h.calls).toEqual([]);
  });

  it('--dry plans it and touches nothing', async () => {
    const f = fakeBundled();
    const r = await ensureDatabase({ env, fileEnv: {}, bundled: f.b }, { dry: true });
    expect(r).toMatchObject({ ok: true, state: 'planned', engine: 'bundled-pg17' });
    expect(r.message).toContain('initdb once');
    expect(f.calls).toEqual([]);
  });

  it('a 1.x install with its data in Homebrew: `move` (the caller moves it after the backup), nothing created', async () => {
    const f = fakeBundled();
    const h = deps();
    const r = await ensureDatabase({ env, fileEnv: { DATABASE_URL: V1 }, homebrew: h.d, bundled: f.b });
    expect(r).toMatchObject({ ok: true, state: 'move', move: true, engine: 'homebrew-pg17' });
    expect(f.calls).toEqual([]);
    expect(h.calls.some((c) => c.startsWith('createdb'))).toBe(false);
  });

  it('1.x with Homebrew stopped: stops with the start command (the data is there; nothing switches)', async () => {
    const f = fakeBundled();
    const r = await ensureDatabase({ env, fileEnv: { DATABASE_URL: V1 }, homebrew: deps({ ready: false }).d, bundled: f.b });
    expect(r).toMatchObject({ ok: false, state: 'stopped', command: BREW_START_PG });
    expect(r.message).toContain('so it can be moved');
    expect(f.calls).toEqual([]);
  });

  it('1.x default URL but no Homebrew Postgres (or no database in it): nothing to move, the bundled one takes over', async () => {
    const a = fakeBundled();
    expect(await ensureDatabase({ env, fileEnv: { DATABASE_URL: V1 }, homebrew: deps({ installed: false }).d, bundled: a.b })).toMatchObject({ ok: true, engine: 'bundled-pg17' });
    const b = fakeBundled();
    expect(await ensureDatabase({ env, fileEnv: { DATABASE_URL: V1 }, homebrew: deps({ list: { code: 0, stdout: '' } }).d, bundled: b.b })).toMatchObject({ ok: true, engine: 'bundled-pg17' });
    expect(b.calls).toEqual(['prepare', 'createdb', 'env']);
  });

  it('CC_DB_ENGINE=homebrew keeps Homebrew exactly as 1.x did', async () => {
    const f = fakeBundled();
    const h = deps({ list: { code: 0, stdout: '' } });
    const r = await ensureDatabase({ env, fileEnv: { DATABASE_URL: V1, CC_DB_ENGINE: 'homebrew' }, homebrew: h.d, bundled: f.b });
    expect(r).toMatchObject({ ok: true, engine: 'homebrew-pg17', created: true });
    expect(f.calls).toEqual([]);
  });

  it('a DATABASE_URL you set (environment, or any other value in the env file) is left alone', async () => {
    const f = fakeBundled();
    const h = deps();
    expect(await ensureDatabase({ env: { ...env, DATABASE_URL: V1 }, fileEnv: {}, homebrew: h.d, bundled: f.b })).toMatchObject({ ok: true, state: 'user_url', engine: 'user' });
    expect(await ensureDatabase({ env, fileEnv: { DATABASE_URL: 'postgres://db.example:6543/cc_other' }, homebrew: h.d, bundled: f.b })).toMatchObject({ ok: true, state: 'user_url', message: expect.stringContaining('cc_other') });
    expect([...f.calls, ...h.calls]).toEqual([]);
  });

  it('the bundled one already set up (its URL in the env file): ensured again, idempotent', async () => {
    const f = fakeBundled();
    const r = await ensureDatabase({ env, fileEnv: { DATABASE_URL: bundledDatabaseUrl(env) }, bundled: f.b });
    expect(r).toMatchObject({ ok: true, engine: 'bundled-pg17' });
  });

  it('a cluster that cannot start: not ok, the reason and its command, the env file untouched', async () => {
    const f = fakeBundled({ prepare: { ok: false, state: 'not_ready', message: 'com.commandcenter.db did not answer within 90 s', command: 'launchctl kickstart -k gui/$UID/com.commandcenter.db' } });
    const r = await bundledPostgres(f.b);
    expect(r).toMatchObject({ ok: false, state: 'not_ready', command: 'launchctl kickstart -k gui/$UID/com.commandcenter.db' });
    expect(f.calls).toEqual(['prepare']);
  });

  it('switchEnvToBundled: the socket URL and CC_DB_ENGINE=bundled; the 1.x line stays as a comment; mode 600', () => {
    mkdirSync(state, { recursive: true });
    const file = join(state, 'env');
    writeFileSync(file, `# mine\nDATABASE_URL=${V1}\nPORT=4327\nCC_DATA=db\n`, { mode: 0o644 });
    switchEnvToBundled(file, { env, note: '(moved)' });
    const text = readFileSync(file, 'utf8');
    expect(text).toBe(`# mine\n# DATABASE_URL=${V1}  (moved)\nPORT=4327\nCC_DATA=db\nDATABASE_URL=${bundledDatabaseUrl(env)}\nCC_DB_ENGINE=bundled\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    switchEnvToBundled(file, { env }); // twice: nothing new
    expect(readFileSync(file, 'utf8')).toBe(text);
  });
});
