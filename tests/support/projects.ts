/**
 * Helpers for the vitest projects (vitest.config.ts): which test files are DOM (jsdom) tests.
 * A file is a DOM test when it is named `*.dom.test.ts(x)` or carries a `@vitest-environment jsdom` docblock in its
 * first lines (the docblock is what actually switches the environment; this list only decides which project runs it).
 * The `ui` project includes exactly these files and the `unit` project excludes them, so the split can never drift.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude', '.shots', 'db', 'evals', 'smoke', 'fixtures']);

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (/\.test\.tsx?$/.test(e.name)) out.push(path.join(dir, e.name));
  }
}

/** Repo-relative (posix) paths of every jsdom test under `tests/` and `src/`. */
export function domTestFiles(root: string): string[] {
  const found: string[] = [];
  for (const top of ['tests', 'src']) walk(path.join(root, top), found);
  const out: string[] = [];
  for (const abs of found) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (/\.dom\.test\.tsx?$/.test(rel)) out.push(rel);
    else if (/@vitest-environment\s+jsdom/.test(readFileSync(abs, 'utf8').slice(0, 600))) out.push(rel);
  }
  return out.sort();
}
