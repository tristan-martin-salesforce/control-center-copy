// The real side of install-release.mjs: tar, launchctl, pg_dump, the new build's migrator and the version route.
// Shared by scripts/ops/install.mjs, scripts/ops/rollback.mjs and `npm run update -- --from`. Nothing here talks to an
// external system: it is this Mac's files, its LaunchAgents and its local database.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { planInstall } from '../install-agents.mjs';
import { dirs, ensureState, envTemplate, templatePort } from '../setup.mjs';
import { backupCopyDir, configuredDbName, defaultBackupDir, runBackup } from './backup.mjs';
import { ensureDatabase } from './ensure-db.mjs';
import { currentVersion } from './install-release.mjs';
import { launchctlBin } from './launchctl.mjs';
import { readEnvFile } from './envfile.mjs';
import { moveToBundled, realMoveDeps } from './migrate-cluster.mjs';
import { resolveDatabaseUrl } from './pg.mjs';
import { currentLink, envFilePath, launchAgentsDir, releasesDir } from './paths.mjs';
import { renderAgent, WEB_LABEL, WORKER_LABEL } from './plist.mjs';
import { compareVersions } from './release-manifest.mjs';

export const LABEL = { web: WEB_LABEL, worker: WORKER_LABEL };

const uid = () => process.getuid?.() ?? 0;

/** The LaunchAgents, by kind ('web' | 'worker'), written for releases/current. `port`: a number, or a function read when they are written. */
export function launchAgents({ env = process.env, say = console.log, port = Number(env.PORT) || 4327 } = {}) {
  const dir = launchAgentsDir(env);
  const file = (k) => join(dir, `${LABEL[k]}.plist`);
  return {
    running: () => ['web', 'worker'].filter((k) => existsSync(file(k)) && spawnSync(launchctlBin(env), ['print', `gui/${uid()}/${LABEL[k]}`], { stdio: 'ignore' }).status === 0),
    stop: async (k) => spawnSync(launchctlBin(env), ['bootout', `gui/${uid()}/${LABEL[k]}`], { stdio: 'ignore' }).status === 0,
    start: async (k) => spawnSync(launchctlBin(env), ['bootstrap', `gui/${uid()}`, file(k)], { stdio: 'ignore' }).status === 0,
    /** Both plists, pointing at the `current` link (so a later install or rollback only repoints it), linted. */
    render: async () => {
      const repo = currentLink(env);
      const plan = planInstall({ repo, env, port: typeof port === 'function' ? port() : port });
      plan.templateDir = join(repo, 'ops', 'launchd');
      try {
        mkdirSync(dir, { recursive: true });
        mkdirSync(plan.logDir, { recursive: true, mode: 0o700 });
        for (const k of ['web', 'worker']) {
          writeFileSync(file(k), renderAgent({ kind: k, ...plan, release: true }), { mode: 0o644 });
          execFileSync('/usr/bin/plutil', ['-lint', file(k)], { stdio: 'pipe' });
        }
        return true;
      } catch (e) {
        say(`writing the LaunchAgents failed (${e.message?.split('\n')[0]})`);
        return false;
      }
    },
  };
}

/** Does the web answer GET /api/v1/onboarding with "no user yet" (a fresh database, before Getting started)? */
export async function firstRunAnswers(port, fetchFn = fetch) {
  try {
    const o = await fetchFn(`http://127.0.0.1:${port}/api/v1/onboarding`, { signal: AbortSignal.timeout(2500) });
    if (!o.ok) return false;
    const j = await o.json();
    return j?.reason === 'no_user';
  } catch {
    return false;
  }
}

/**
 * ON-23: the identity the web reports on /version (`instance`; src/server/version.ts `instanceId`, keep the two in
 * step): the first 16 hex of sha256 of the folder it runs from. The web's working directory is `current`, so this is
 * `current`'s real path, read when the poll starts (after the install or rollback repointed it).
 */
export function instanceId(dir) {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    /* the folder as given */
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

/** The plain line for a port another app holds (ON-23). */
export const foreignPortMessage = (port) =>
  `another app answers on port ${port}, not this install's web: see what holds it with lsof -i :${port}, quit it (or set another PORT in the env file), then run this again`;

/**
 * Poll /api/v1/version until it answers `version` (default 90 s). `instance`: this install's `instanceId`; a reply
 * with the version but another `instance` is another app (or another install) on the port, so the poll stops at once
 * and says so (ON-23). `requireInstance` (P35-2): a reply with no `instance` is foreign too: true for a build being
 * installed or updated to (every build from a94dffd on reports it), false for a rollback to an older build from
 * before the field.
 */
export async function waitForVersion(version, { port = Number(process.env.PORT) || 4327, timeoutMs = 90_000, everyMs = 2000, instance, requireInstance = false, say = console.log } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/version`, { signal: AbortSignal.timeout(2500) });
      const j = r.ok ? await r.json() : null;
      if (j && instance && (typeof j.instance === 'string' ? j.instance !== instance : requireInstance && j.version === version)) {
        say(foreignPortMessage(port));
        return false;
      }
      if (j?.version === version) return true;
      // A first install has no user until Getting started runs, and /version needs one (ON-3): the web answering
      // Getting started's own route ("no user yet") is the new release up and waiting for the person.
      if (r.status >= 500 && (await firstRunAnswers(port))) return true;
    } catch {
      /* still starting */
    }
    await new Promise((res) => setTimeout(res, everyMs));
  }
  return false;
}

/**
 * The environment the services actually run with: the env file over the shell, exactly as run-service.mjs starts
 * them (`{ ...process.env, ...fileEnv }`). The installer reads PORT and the database name from this, so a PORT in
 * someone's shell (`.zshrc`) can't make it poll a port the web never listens on (ON-14).
 * @param {Record<string, string | undefined>} [env] @param {Record<string, string> | null} [file]
 */
export function effectiveEnv(env = process.env, file = readEnvFile(envFilePath(env))) {
  return { ...env, ...(file ?? {}) };
}

/** The port the web listens on (the env file's PORT, else the shell's, else 4327). */
export const servicePort = (env = process.env, file) => Number(effectiveEnv(env, file).PORT) || 4327;

/**
 * Whether the health poll for `version` must see `instance` (P35-2), given the release `current` pointed at before
 * this run (`prior`). A build newer than that one (a fresh install, an update) is from a94dffd on and reports it; the
 * prior build itself (the installer's own rollback, a reinstall) and an older one (ops:rollback, a downgrade) may be
 * from before the field.
 */
export const instanceRequiredFor = (version, prior) => !prior || (version !== prior && compareVersions(version, prior) > 0);

/**
 * Everything installRelease / rollbackRelease need, for this Mac. `requireInstance`: true, false, or a function of
 * the version polled for; by default `instanceRequiredFor` against the release current pointed at when this ran.
 */
export function realDeps({ env = process.env, say = console.log, dry = false, requireInstance } = {}) {
  const fileEnv = () => readEnvFile(envFilePath(env)) ?? {};
  const prior = currentVersion(releasesDir(env));
  const needsInstance = (v) => (typeof requireInstance === 'function' ? requireInstance(v) : (requireInstance ?? instanceRequiredFor(v, prior)));
  const merged = () => effectiveEnv(env, fileEnv());
  return {
    say,
    nodeVersion: process.version,
    arch: process.arch,
    now: () => new Date(),
    releasesDir: releasesDir(env),
    /** manifest.json out of the archive without unpacking it (the dry run's plan). */
    peekManifest: async (artifact) => {
      // the build's own manifest is <top folder>/manifest.json (packages inside node_modules have their own)
      const list = spawnSync('/usr/bin/tar', ['-tzf', artifact], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      const top = list.status === 0 ? list.stdout.split('\n').find(Boolean)?.split('/')[0] : null;
      if (!top) return null;
      const r = spawnSync('/usr/bin/tar', ['-xzOf', artifact, `${top}/manifest.json`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return r.status === 0 ? JSON.parse(r.stdout) : null;
    },
    extract: async (artifact, into) => {
      // runs after the sha256 matched the feed: /usr/bin/tar would copy macOS's "downloaded from the internet" flag
      // onto every unpacked file (the database server among them), so it comes off the archive first
      spawnSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', artifact], { stdio: 'ignore' });
      return spawnSync('/usr/bin/tar', ['-xzf', artifact, '-C', into], { stdio: ['ignore', 'ignore', 'inherit'] }).status === 0;
    },
    ensureDatabase: async () => ensureDatabase({ env }, { db: configuredDbName(merged()), dry }),
    // D-98: the 1.x Homebrew data into the bundled cluster, checked with the NEW build's migrator
    moveDatabase: async (releaseDir) => moveToBundled(await realMoveDeps({ env, say, migrator: { cmd: process.execPath, args: [join(releaseDir, 'dist', 'db', 'migrate.mjs')], cwd: releaseDir, env: { ...env, CC_MIGRATIONS_DIR: join(releaseDir, 'src', 'db', 'migrations') } } })),
    ensureEnv: async () => {
      try {
        const created = ensureState(dirs(env), envTemplate(undefined, '', templatePort(env)));
        if (created.length) say(`created ${created.length} state item(s) (the env file is chmod 600, no credentials in it)`);
        return true;
      } catch (e) {
        say(`state folder: ${e.message}`);
        return false;
      }
    },
    port: () => servicePort(env, fileEnv()),
    // read when they are written: on a first install the env file (and its PORT) appears only at the env step
    agents: launchAgents({ env, say, port: () => servicePort(env, fileEnv()) }),
    backup: async () => {
      const e = merged();
      const r = await runBackup({ db: configuredDbName(e), dir: defaultBackupDir(e), url: resolveDatabaseUrl(env, fileEnv()) });
      if (r.copy?.error) say(r.copy.error === 'refused_cloud_synced' ? `not copied: ${backupCopyDir(e).refused}` : `the copy to ${r.copy.dir} failed (${r.copy.error}); the backup itself is fine`);
      return { name: r.file.split('/').pop() };
    },
    migrate: async (releaseDir) => {
      const bin = join(releaseDir, 'dist', 'db', 'migrate.mjs');
      if (!existsSync(bin)) {
        say(`no migrator in the build (${bin})`);
        return false;
      }
      return spawnSync(process.execPath, [bin], { cwd: releaseDir, stdio: 'inherit', env: { ...process.env, ...fileEnv(), CC_MIGRATIONS_DIR: join(releaseDir, 'src', 'db', 'migrations') } }).status === 0;
    },
    health: (version) => waitForVersion(version, { port: servicePort(env, fileEnv()), instance: instanceId(currentLink(env)), requireInstance: needsInstance(version), say }),
  };
}
