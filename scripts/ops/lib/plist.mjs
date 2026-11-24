// Renders ops/launchd/*.plist.tmpl. Pure functions so tests can check output without touching launchd.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { brewPrefix, pg17BinFor } from './brew.mjs';

export const WEB_LABEL = 'com.commandcenter.web';
export const WORKER_LABEL = 'com.commandcenter.worker';
/** The bundled Postgres 17 cluster (D-98): web and worker wait for its socket (run-service.mjs, pgwait.mjs). */
export const DB_LABEL = 'com.commandcenter.db';

export const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderTemplate(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`plist template placeholder {{${key}}} has no value`);
    return vars[key];
  });
}

const arrayXml = (items) => items.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');

/** `prefix` is the Homebrew prefix (Apple Silicon or Intel); defaults to this machine's. */
export function defaultPath({ home, nodeDir, prefix = brewPrefix() }) {
  return [nodeDir, join(prefix, 'bin'), pg17BinFor(prefix), `${home}/.local/bin`, `${home}/.devbar/bin`, '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter(Boolean)
    .filter((p, i, a) => a.indexOf(p) === i)
    .join(':');
}

/**
 * A compiled release (D-90, PKG-2): `repo` is the `current` symlink, so a later install or rollback only repoints it.
 * The web is Next's standalone server (scripts/ops/start-web.mjs binds it to 127.0.0.1, D-76); the worker is the
 * esbuild bundle. Neither needs npm, tsx or devDependencies.
 */
export function releaseCommand(kind, repo, node) {
  return kind === 'web' ? [node, join(repo, 'scripts', 'ops', 'start-web.mjs')] : [node, join(repo, 'dist', 'worker', 'index.mjs')];
}

/**
 * Substitution map for one agent. `repo` is the absolute checkout path resolved at install time.
 * Values are XML-escaped; ProgramArguments are pre-rendered as <string> lines.
 */
export function buildVars({ kind, repo, home, node, npm, logDir, stateDir, envFile, port = 4327, release = false }) {
  const wrapper = join(repo, 'scripts', 'ops', 'run-service.mjs');
  const cmd = release ? releaseCommand(kind, repo, node) : kind === 'web' ? [join(repo, 'node_modules', '.bin', 'next'), 'start', '-H', '127.0.0.1', '-p', String(port)] : [npm, 'run', 'worker:start'];
  const programArgs = [node, wrapper, '--name', kind, '--env-file', envFile, '--log-dir', logDir, '--', ...cmd];
  const raw = {
    LABEL: kind === 'web' ? WEB_LABEL : WORKER_LABEL,
    REPO: repo,
    HOME: home,
    PATH: defaultPath({ home, nodeDir: node.replace(/\/[^/]+$/, '') }),
    PORT: String(port),
    LOG_DIR: logDir,
    STATE_DIR: stateDir,
    ENV_FILE: envFile,
  };
  const vars = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, xmlEscape(v)]));
  vars.PROGRAM_ARGS = arrayXml(programArgs);
  return vars;
}

export function renderAgent({ kind, templateDir, ...rest }) {
  const file = join(templateDir, `${kind === 'web' ? WEB_LABEL : WORKER_LABEL}.plist.tmpl`);
  return renderTemplate(readFileSync(file, 'utf8'), buildVars({ kind, ...rest }));
}

/**
 * com.commandcenter.db (D-98): runs the engine copy's `postgres -D <data>` itself, no Node parent (12-pglite-spike.md
 * §7: killing a wrapper would leave postgres running). KeepAlive restarts it after a crash. launchd's SIGTERM on
 * bootout is Postgres's smart shutdown, so callers stop web and worker first (their sessions end, it exits at once);
 * ExitTimeOut gives it a minute before SIGKILL, after which Postgres recovers from its WAL on the next start.
 * No template file: everything in it is a path.
 */
export function renderDbAgent({ bin, dataDir, logDir, home }) {
  const v = (s) => xmlEscape(s);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  Command Center database (bundled Postgres 17, D-98). Rendered by scripts/ops/lib/plist.mjs renderDbAgent.
  Unix socket only (listen_addresses = ''): nothing listens on the network. No secrets here.
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DB_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${arrayXml([join(bin, 'postgres'), '-D', dataDir])}
  </array>

  <key>WorkingDirectory</key>
  <string>${v(dataDir)}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${v(home)}</string>
    <key>LC_ALL</key>
    <string>C</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>60</integer>

  <key>StandardOutPath</key>
  <string>${v(join(logDir, 'db.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${v(join(logDir, 'db.log'))}</string>
</dict>
</plist>
`;
}

/** The engine bin folder an installed db plist runs (null when there is none or it can't be read). */
export function dbAgentBin(plistText) {
  const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plistText ?? '');
  if (!m) return null;
  return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\/postgres$/, '');
}
