/**
 * Private stress-campaign storage (never in git): recordings, answer keys, raw run outputs, the private report.
 * Directories are chmod 700 and files chmod 600. Override the root with CC_STRESS_DIR (tests use a tmp dir).
 */
import fs from 'node:fs';
import path from 'node:path';
import { inStateDir } from '../../../src/lib/state-folder';

export function stressRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CC_STRESS_DIR ?? inStateDir('stress');
}

export function privDir(...parts: string[]): string {
  const root = stressRoot();
  const dir = path.join(root, ...parts);
  // Create every level with 0700 (mkdir -p would leave intermediate dirs at the umask default).
  let cur = root;
  for (const p of ['', ...parts]) {
    cur = p ? path.join(cur, p) : cur;
    if (!fs.existsSync(cur)) fs.mkdirSync(cur, { mode: 0o700 });
    fs.chmodSync(cur, 0o700);
  }
  return dir;
}

export function writePriv(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function appendPriv(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, line.endsWith('\n') ? line : `${line}\n`);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export function readJson<T>(file: string, dflt?: T): T {
  if (!fs.existsSync(file)) {
    if (dflt !== undefined) return dflt;
    throw new Error(`missing ${path.basename(file)}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}
