#!/usr/bin/env node
// node scripts/release/smoke.mjs <dist/command-center-X.Y.Z-ARCH.tgz> [--port 4361]   (also: build:release --smoke)
//
// Proves a built artifact runs on its own, outside the repo (D-90):
//   1. unpack it into a temp folder and verify every file against its manifest; the bundled Postgres engine is there
//      (initdb, pg_ctl, postgres) or the release is labelled NO-ENGINE.txt (--allow-no-engine), and it says which
//   2. web: `node scripts/ops/start-web.mjs` with CC_DATA=mock on 127.0.0.1:<port>; GET / and GET /api/v1/version
//      must answer 200, the version must be the manifest's (startup time measured to the first 200 on /)
//   3. worker: the bundled migrator on a throwaway database (control_center_smoke_<CC_TEST_DB_SUFFIX>), then the
//      bundled worker against it with CC_LIVE=0, CC_SCAN_LLM=0, CC_NOTIFY=0 (no scans, no model, no external reads)
//      until it writes its heartbeat; then SIGTERM. Skipped (said so) when Postgres 17 is not running here.
//   4. stop everything, drop the database, remove the folder
// The state and log folders are temp folders, so the real install is never touched.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pg17Bin } from '../ops/lib/brew.mjs';
import { releaseRootIn } from '../ops/lib/install-release.mjs';
import { readManifest, verifyTree } from '../ops/lib/release-manifest.mjs';
import { engineInRelease } from './lib/engine.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status === 200) return { ok: true, ms: Date.now() - t0, res: r };
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  return { ok: false, ms: Date.now() - t0 };
}

function stop(child) {
  return new Promise((res) => {
    if (!child || child.exitCode !== null) return res(child?.exitCode ?? null);
    const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', (code) => (clearTimeout(t), res(code)));
    child.kill('SIGTERM');
  });
}

export async function smokeArtifact({ artifact, port = 4361, say = console.log, keep = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-smoke-'));
  const state = join(tmp, 'state');
  const logs = join(tmp, 'logs');
  mkdirSync(state, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const out = { ok: false, reason: null, verifyMs: 0, webStartupMs: null, version: null, worker: null, engine: null };
  let web = null;
  let worker = null;
  const pg = pg17Bin();
  const db = `control_center_smoke_${(process.env.CC_TEST_DB_SUFFIX || 'local').replace(/[^A-Za-z0-9_]/g, '')}`;
  let dbCreated = false;
  try {
    // 1. unpack + verify
    const unpack = join(tmp, 'build');
    mkdirSync(unpack);
    if (spawnSync('/usr/bin/tar', ['-xzf', artifact, '-C', unpack]).status !== 0) throw new Error('unpack failed');
    const root = releaseRootIn(unpack);
    if (!root) throw new Error('no manifest.json in the artifact');
    const m = readManifest(join(root, 'manifest.json'));
    let t = Date.now();
    const v = await verifyTree(root, m, { deep: true });
    out.verifyMs = Date.now() - t;
    if (!v.ok) throw new Error(`manifest mismatch: ${v.missing.length} missing, ${v.changed.length} changed`);
    say(`[smoke] unpacked v${m.version} into a temp folder; ${v.checked} files verified in ${out.verifyMs} ms`);
    // the bundled Postgres engine: there, or the release says it was built without it (--allow-no-engine)
    const eng = engineInRelease(root, m.arch);
    out.engine = eng;
    if (eng.state === 'missing') throw new Error(`no bundled Postgres engine: ${eng.package} is missing ${eng.missing.join(', ')} and the release carries no NO-ENGINE label`);
    say(eng.state === 'present' ? `[smoke] engine: ${eng.package} ${eng.version} bundled (initdb, pg_ctl, postgres)` : `[smoke] engine: NONE, labelled engine-less (built with --allow-no-engine)`);

    // 2. web, mock data, loopback
    const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'production', CC_STATE_DIR: state, CC_LOG_DIR: logs, CC_NOTIFY: '0' };
    t = Date.now();
    web = spawn(process.execPath, [join(root, 'scripts', 'ops', 'start-web.mjs')], { cwd: root, env: { ...baseEnv, PORT: String(port), CC_DATA: 'mock' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let webLog = '';
    web.stdout.on('data', (d) => (webLog += d));
    web.stderr.on('data', (d) => (webLog += d));
    const home = await waitFor(`http://127.0.0.1:${port}/`, 60_000);
    if (!home.ok) throw new Error(`GET / did not answer 200 within 60 s:\n${webLog.slice(-1500)}`);
    out.webStartupMs = Date.now() - t;
    const vr = await fetch(`http://127.0.0.1:${port}/api/v1/version`);
    const vj = await vr.json();
    if (vr.status !== 200 || vj.version !== m.version) throw new Error(`GET /api/v1/version: ${vr.status} ${JSON.stringify(vj).slice(0, 200)}`);
    out.version = { version: vj.version, sha: vj.sha, channel: vj.channel, dataSource: vj.dataSource, release: vj.release ?? null };
    say(`[smoke] web: GET / 200 after ${out.webStartupMs} ms; /api/v1/version → v${vj.version} (${vj.channel}, ${vj.dataSource}${vj.release ? `, release ${vj.release.arch}` : ''})`);
    await stop(web);
    web = null;

    // 3. the compiled worker against a throwaway database
    const ready = spawnSync(join(pg, 'pg_isready'), ['-h', 'localhost', '-p', '5432']).status === 0;
    if (!ready) {
      out.worker = { skipped: 'Postgres 17 is not running here' };
      say('[smoke] worker: skipped (Postgres 17 is not running here)');
    } else {
      spawnSync(join(pg, 'dropdb'), ['--if-exists', '-h', 'localhost', db], { stdio: 'ignore' });
      if (spawnSync(join(pg, 'createdb'), ['-h', 'localhost', db]).status !== 0) throw new Error(`createdb ${db} failed`);
      dbCreated = true;
      const dbEnv = { ...baseEnv, DATABASE_URL: `postgresql://localhost:5432/${db}`, CC_LIVE: '0', CC_SCAN_LLM: '0', CC_WORKER_RUN_FOR: '40', NODE_ENV: 'development' };
      t = Date.now();
      const mig = spawnSync(process.execPath, [join(root, 'dist', 'db', 'migrate.mjs')], { cwd: root, env: dbEnv, encoding: 'utf8' });
      if (mig.status !== 0) throw new Error(`bundled migrate failed: ${(mig.stderr || mig.stdout).slice(-800)}`);
      const migrateMs = Date.now() - t;
      // a placeholder user (the worker waits for one); the database is dropped afterwards
      if (spawnSync(join(pg, 'psql'), ['-h', 'localhost', '-d', db, '-qc', "insert into users (email, display_name) values ('smoke@example.invalid', 'Smoke Test')"], { stdio: 'ignore' }).status !== 0) throw new Error('could not add the placeholder user');
      t = Date.now();
      worker = spawn(process.execPath, [join(root, 'dist', 'worker', 'index.mjs')], { cwd: root, env: dbEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let wlog = '';
      worker.stdout.on('data', (d) => (wlog += d));
      worker.stderr.on('data', (d) => (wlog += d));
      const hb = join(state, 'worker.heartbeat');
      // the first beat is "starting"; wait (up to 45 s) for it to get past start-up (idle/running/catching_up)
      let beatMs = null;
      let readyMs = null;
      let heartbeat = null;
      while (Date.now() - t < 45_000 && worker.exitCode === null) {
        if (existsSync(hb)) {
          beatMs ??= Date.now() - t;
          try {
            heartbeat = JSON.parse(readFileSync(hb, 'utf8'));
          } catch {
            /* mid-rename */
          }
          // past start-up: a later state, or connected and waiting for onboarding, which is where a fresh
          // install's worker sits until the user finishes /onboarding
          if (heartbeat && (heartbeat.state !== 'starting' || /"msg":"(waiting for onboarding|no user yet)/.test(wlog))) {
            readyMs = Date.now() - t;
            break;
          }
        }
        await sleep(200);
      }
      const code = await stop(worker);
      worker = null;
      if (beatMs === null) throw new Error(`the worker wrote no heartbeat (exit ${code}):\n${wlog.slice(-1500)}`);
      const waiting = /waiting for onboarding/.test(wlog) ? 'waiting for onboarding (a fresh install)' : null;
      out.worker = { migrateMs, heartbeatMs: beatMs, readyMs, state: heartbeat?.state ?? null, waiting, exit: code };
      say(`[smoke] worker: bundled migrate ${migrateMs} ms; first heartbeat after ${beatMs} ms, state ${out.worker.state}${waiting ? `, ${waiting}` : ''}${readyMs !== null ? ` after ${readyMs} ms` : ' (still starting after 45 s)'}; stopped with exit ${code}`);
      if (readyMs === null) throw new Error(`the worker never got past starting:\n${wlog.slice(-1500)}`);
    }
    out.ok = true;
  } catch (e) {
    out.reason = e.message;
    say(`[smoke] FAILED: ${e.message}`);
  } finally {
    await stop(web);
    await stop(worker);
    if (dbCreated) spawnSync(join(pg, 'dropdb'), ['--if-exists', '-h', 'localhost', db], { stdio: 'ignore' });
    if (!keep) rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const artifact = argv.find((a) => !a.startsWith('--'));
  if (!artifact) {
    console.error('usage: node scripts/release/smoke.mjs <artifact.tgz> [--port 4361]');
    process.exit(64);
  }
  const i = argv.indexOf('--port');
  const r = await smokeArtifact({ artifact: resolve(artifact), port: i >= 0 ? Number(argv[i + 1]) : 4361, keep: argv.includes('--keep') });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
