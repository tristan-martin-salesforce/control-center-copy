// KEY=VALUE env file reader (mirror of src/ops/envfile.ts, dependency-free so launchd can use it).
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function readEnvFile(path) {
  try {
    return parseEnv(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function fileMode(path) {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

const SECRET_KEY = /(TOKEN|SECRET|PASSWORD|COOKIE|API_?KEY|\bPAT\b|PASS)/i;

/**
 * Change the env file in place, keeping every other line and comment as it is: `set` replaces a key's line (or
 * appends it), `comment` turns a key's line into a comment (`# KEY=…  <note>`), so what it was stays readable.
 * Written to a temp file and renamed (mode 600): a crash leaves the old file or the new one, never half of one.
 * Creates the file (600) when it is missing. Values are never logged.
 * @param {string} path
 * @param {{ set?: Record<string, string>, comment?: string[], note?: string }} change
 */
export function updateEnvFile(path, { set = {}, comment = [], note = '' } = {}) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    /* a new file */
  }
  const lines = text.length ? text.replace(/\n$/, '').split('\n') : [];
  const keyOf = (line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? null;
  const done = new Set();
  const out = lines.map((line) => {
    const k = keyOf(line);
    if (!k) return line;
    if (comment.includes(k)) return `# ${line.trim()}${note ? `  ${note}` : ''}`;
    if (k in set) {
      done.add(k);
      return `${k}=${set[k]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(set)) if (!done.has(k)) out.push(`${k}=${v}`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${out.join('\n')}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Values of secret-looking keys (8+ chars), used to scrub child output before it hits a log file. */
export function secretValues(env) {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_KEY.test(k) && v.length >= 8)
    .map(([, v]) => v);
}
