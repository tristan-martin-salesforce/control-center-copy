/**
 * D-101: the product is Command Center everywhere a user, installer, operator or the OS sees it. No source, script or
 * living doc may still spell the old name, except the migration code (which has to), the ADR and the history.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { databaseUrlCandidates } from '../../src/lib/private-scan';
import { listBackups } from '../../scripts/ops/lib/backup.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '..', '..');
const OLD_NAMES = /Control Center|control-center|com\.controlcenter/;
// a doc may name the old folder or services when the same line says it is the 1.x one (the migration's own docs)
const LABELLED = /1\.x|before the rename|were renamed|was renamed|old (folder|services?|name)/i;
const SCAN_DIRS = ['src', 'app', 'scripts', 'docs', 'ops', 'skills'];
const SCAN_FILES = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'package.json'];
// the sample dataset's prose; its tables are the fictional world (the user's own repo is named control-center there),
// so a markdown table row in sample-data/ (it mirrors a tables/*.json row) is data, not the product's name
const SAMPLE_DIR = 'sample-data';
const WORLD_ROW = (rel: string, line: string) => rel.startsWith(`${SAMPLE_DIR}/`) && line.trimStart().startsWith('|');
// history stays as written; the migration code and the ADR name the old folder on purpose
const EXEMPT = [/^docs\/(reviews|research|archive|decisions)\//, /^docs\/DECISIONS\.md$/, /(^|\/)migrate-state[^/]*\.mjs$/, /(^|\/)migrate-state\.test\.ts$/];
const TEXT = /\.(ts|tsx|mjs|js|json|md|sh|css|tmpl|yml|yaml|txt)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEXT.test(name)) out.push(p);
  }
  return out;
}

describe('the rename leaves no old name behind', () => {
  it('no src/, app/, scripts/, docs/ (non-history), ops/, skills/ or sample-data/*.md file spells Control Center, control-center or com.controlcenter', () => {
    const sampleDocs = walk(join(ROOT, SAMPLE_DIR)).filter((f) => f.endsWith('.md'));
    expect(sampleDocs.map((f) => relative(ROOT, f))).toEqual(expect.arrayContaining(['sample-data/README.md', 'sample-data/BRIEF.md']));
    const files = [...SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))), ...SCAN_FILES.map((f) => join(ROOT, f)), ...sampleDocs];
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f);
      if (EXEMPT.some((re) => re.test(rel))) continue;
      const lines = readFileSync(f, 'utf8').split('\n');
      const prose = /\.md$/.test(rel);
      lines.forEach((l, i) => {
        if (OLD_NAMES.test(l) && !(prose && LABELLED.test(l)) && !WORLD_ROW(rel, l)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no code spells the state folder path: src/lib/state-folder.ts and scripts/ops/lib/paths.mjs are the helpers', () => {
    const offenders: string[] = [];
    for (const f of ['src', 'app', 'scripts'].flatMap((d) => walk(join(ROOT, d)))) {
      const rel = relative(ROOT, f);
      if (!/\.(ts|tsx|mjs)$/.test(rel) || rel.startsWith('scripts/stress/') || EXEMPT.some((re) => re.test(rel)) || rel === 'src/mock/seed.example.json') continue;
      readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
        const code = l.trim();
        if (/^(\/\/|\*|\/\*)/.test(code)) return;
        if (/Application Support(\/|['"`],\s*['"`])command-center/.test(code)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the LaunchAgent templates carry the new labels', () => {
    const names = readdirSync(join(ROOT, 'ops', 'launchd')).sort();
    expect(names).toEqual(['com.commandcenter.web.plist.tmpl', 'com.commandcenter.worker.plist.tmpl']);
  });

  it('the package is command-center (package.json and the lockfile)', () => {
    expect(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name).toBe('command-center');
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
    expect(lock.name).toBe('command-center');
    expect(lock.packages[''].name).toBe('command-center');
  });
});

describe('scan:private reads the database under either name', () => {
  it('tries the resolved URL first, then the other name, for the two Command Center names only', () => {
    expect(databaseUrlCandidates('postgresql://localhost:5432/command_center')).toEqual(['postgresql://localhost:5432/command_center', 'postgresql://localhost:5432/control_center']);
    expect(databaseUrlCandidates('postgresql:///control_center?host=%2Fx&user=me')).toEqual(['postgresql:///control_center?host=%2Fx&user=me', 'postgresql:///command_center?host=%2Fx&user=me']);
    expect(databaseUrlCandidates('postgresql://localhost:5432/mine')).toEqual(['postgresql://localhost:5432/mine']);
    expect(databaseUrlCandidates('postgresql://localhost:5432/control_center_main')).toEqual(['postgresql://localhost:5432/control_center_main']);
  });
});

describe('backups made under the old name', () => {
  it('are listed with the new ones, oldest first by timestamp, and only for the default database', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-bk-'));
    try {
      mkdirSync(d, { recursive: true });
      for (const n of ['control_center-20261101-030000.dump', 'command_center-20261102-030000.dump', 'control_center-20261103-030000.dump', 'command_center-20261104-030000.base.tgz', 'other-20261105-030000.dump']) writeFileSync(join(d, n), 'x');
      expect(listBackups(d).map((b: { name: string }) => b.name)).toEqual(['control_center-20261101-030000.dump', 'command_center-20261102-030000.dump', 'control_center-20261103-030000.dump', 'command_center-20261104-030000.base.tgz']);
      expect(listBackups(d, 'other')).toHaveLength(1);
      expect(listBackups(d, 'control_center_x')).toHaveLength(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
