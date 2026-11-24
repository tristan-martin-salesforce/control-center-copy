/**
 * D-98: which database the app uses. resolveDatabaseUrl's order (environment → env file → the bundled socket), the
 * socket URL itself (a space in "Application Support"), and the twins in src/ and scripts/ that must agree.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as mjs from '../../scripts/ops/lib/pg.mjs';
import { STATE_FOLDER_NAME as MJS_STATE_FOLDER } from '../../scripts/ops/lib/paths.mjs';
import { readyCheckFor } from '../../scripts/ops/lib/pgwait.mjs';
import { bundledDatabaseUrl, resolveDatabaseUrl } from '../../src/db/client';
import { STATE_FOLDER_NAME as SHARED_FOLDER } from '../../src/lib/state-folder';
import { STATE_FOLDER_NAME } from '../../src/ops/paths';
import * as ts from '../../src/ops/pg-cluster';

let state: string;
beforeEach(() => void (state = mkdtempSync(join(tmpdir(), 'cc-pg-url-'))));
afterEach(() => rmSync(state, { recursive: true, force: true }));

const V1 = 'postgresql://localhost:5432/command_center';
const user = userInfo().username;

describe('resolveDatabaseUrl', () => {
  it('environment → env file → the bundled socket, and an explicit url first of all', () => {
    const env = { HOME: '/Users/someone', CC_STATE_DIR: state };
    const socket = `postgresql:///command_center?host=${encodeURIComponent(join(state, 'pg', 'run'))}&user=${encodeURIComponent(user)}`;
    expect(resolveDatabaseUrl(undefined, env)).toBe(socket);
    writeFileSync(join(state, 'env'), `PORT=4327\nDATABASE_URL=${V1}\n`);
    expect(resolveDatabaseUrl(undefined, env)).toBe(V1); // a source checkout on Homebrew keeps working through it
    expect(resolveDatabaseUrl(undefined, { ...env, DATABASE_URL: 'postgres://x/y' })).toBe('postgres://x/y');
    expect(resolveDatabaseUrl('postgres://explicit/z', { ...env, DATABASE_URL: 'postgres://x/y' })).toBe('postgres://explicit/z');
    // a commented-out line is not a URL; an empty one falls through
    writeFileSync(join(state, 'env'), `# DATABASE_URL=${V1}\nDATABASE_URL=\n`);
    expect(resolveDatabaseUrl(undefined, env)).toBe(socket);
  });

  it('the .mjs twin (ops scripts, run-service) answers the same for every case', () => {
    const env = { HOME: '/Users/someone', CC_STATE_DIR: state };
    const cases: Array<[Record<string, string>, string | null]> = [
      [env, null],
      [env, `DATABASE_URL=${V1}\n`],
      [{ ...env, DATABASE_URL: 'postgres://x/y' }, `DATABASE_URL=${V1}\n`],
      [{ ...env, CC_PG_SOCKET_DIR: '/tmp/cc pg' }, null],
      [env, `DATABASE_URL="${V1}"\nDATABASE_URL=postgres://later/one\n`],
    ];
    for (const [e, file] of cases) {
      if (file === null) rmSync(join(state, 'env'), { force: true });
      else writeFileSync(join(state, 'env'), file);
      expect(mjs.resolveDatabaseUrl(e), JSON.stringify(e)).toBe(resolveDatabaseUrl(undefined, e));
    }
    expect(mjs.bundledDatabaseUrl({ CC_STATE_DIR: state })).toBe(bundledDatabaseUrl({ CC_STATE_DIR: state }));
  });

  it('the socket URL parses back to its folder (a space in it), and node-postgres reads it as a socket host', async () => {
    const env = { CC_STATE_DIR: '/Users/a b/Library/Application Support/command-center' };
    const url = mjs.bundledDatabaseUrl(env);
    expect(url).toContain('Application%20Support');
    expect(mjs.socketDirOf(url)).toBe('/Users/a b/Library/Application Support/command-center/pg/run');
    expect(mjs.isBundledUrl(url, env)).toBe(true);
    expect(ts.isBundledUrl(url, env)).toBe(true);
    expect(mjs.dbNameOf(url)).toBe('command_center');
    const { parse } = await import('pg-connection-string');
    expect(parse(url)).toMatchObject({ host: '/Users/a b/Library/Application Support/command-center/pg/run', database: 'command_center', user });
    expect(mjs.urlForDb(url, 'postgres')).toContain('postgresql:///postgres?host=');
  });

  it('the state folder name is one constant in src/lib/state-folder.ts (ops and db import it) and its .mjs twin', () => {
    expect(MJS_STATE_FOLDER).toBe(STATE_FOLDER_NAME);
    expect(STATE_FOLDER_NAME).toBe(SHARED_FOLDER);
    expect(readFileSync(join(__dirname, '../../src/db/client.ts'), 'utf8')).toContain("import { STATE_FOLDER_NAME } from '../lib/state-folder';");
    expect(readFileSync(join(__dirname, '../../src/ops/paths.ts'), 'utf8')).toContain("from '../lib/state-folder'");
  });
});

describe('which database this install runs on (dbEngine)', () => {
  const env = () => ({ CC_STATE_DIR: state });
  it('bundled, homebrew (the 1.x default), user; the twins agree', () => {
    const socket = mjs.bundledDatabaseUrl(env());
    const cases: Array<[Record<string, string>, Record<string, string>, string]> = [
      [env(), {}, 'bundled'],
      [env(), { DATABASE_URL: socket }, 'bundled'],
      [env(), { DATABASE_URL: V1 }, 'homebrew'],
      [env(), { DATABASE_URL: 'postgres://localhost/command_center' }, 'homebrew'],
      [env(), { DATABASE_URL: 'postgresql:///command_center?host=/tmp' }, 'homebrew'],
      [env(), { DATABASE_URL: 'postgresql://localhost:5432/control_center_sample' }, 'user'], // a rehearsal database
      [env(), { DATABASE_URL: 'postgresql://me:secret@localhost:5432/command_center' }, 'user'], // a password: set on purpose
      [env(), { DATABASE_URL: 'postgresql://db.example:5432/command_center' }, 'user'],
      [{ ...env(), DATABASE_URL: V1 }, {}, 'user'], // the environment: you set it
      [{ ...env(), DATABASE_URL: socket }, {}, 'bundled'],
    ];
    for (const [e, f, want] of cases) {
      expect(mjs.dbEngine(e, f).engine, JSON.stringify([e, f])).toBe(want);
      expect(ts.dbEngine(e, f).engine, JSON.stringify([e, f])).toBe(want);
    }
    expect(mjs.dbEngine(env(), { DATABASE_URL: V1, CC_DB_ENGINE: 'homebrew' })).toMatchObject({ engine: 'homebrew', keep: true });
  });
});

describe('the socket path', () => {
  it('fits the 103-byte macOS limit for a normal home folder, and is refused when it does not', () => {
    expect(mjs.socketTooLong('/Users/someone/Library/Application Support/command-center/pg/run')).toBe(false);
    expect(mjs.socketTooLong(`/Users/${'x'.repeat(40)}/Library/Application Support/command-center/pg/run`)).toBe(true);
    expect(mjs.initCluster({ env: { CC_STATE_DIR: state, CC_PG_SOCKET_DIR: join(state, 'y'.repeat(120)) } })).toMatchObject({ ok: false, state: 'socket_too_long' });
  });

  it('run-service waits on the socket for the bundled URL and on TCP for Homebrew', async () => {
    const pings: string[] = [];
    const tcp: string[] = [];
    const deps = { ping: async (s: string) => (pings.push(s), 'ready' as const), isReady: async (h?: string, p?: number) => (tcp.push(`${h}:${p}`), true) };
    expect(await readyCheckFor(mjs.bundledDatabaseUrl({ CC_STATE_DIR: '/S p' }), deps)()).toBe(true);
    expect(await readyCheckFor(V1, deps)()).toBe(true);
    expect(await readyCheckFor('postgres://127.0.0.1:6543/x', deps)()).toBe(true);
    expect(pings).toEqual(['/S p/pg/run/.s.PGSQL.5432']);
    expect(tcp).toEqual(['localhost:5432', '127.0.0.1:6543']);
  });
});
