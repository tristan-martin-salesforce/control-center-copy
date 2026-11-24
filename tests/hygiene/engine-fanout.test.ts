/**
 * ENG-5 (docs/reviews/2026-11-20-holistic/21-engine-fanout.md): how many test files `vitest related <leaf>` selects
 * for a leaf engine file. A static import walk, the same graph vitest's `related` walks (type-only imports erased, the
 * way the TS transform erases them; dynamic `import()` counted; node_modules not followed), over the unit + ui test
 * files. It never runs vitest.
 *
 * Two numbers per leaf:
 *   - `direct`: test files that reach the leaf without going through the mock DataSource (src/server/datasource/mock/
 *     index.ts). This is what barrels and import paths control; the R7 step-5 target is under 40.
 *   - `total`: every test file `vitest related` selects. ~100 test files build the whole mock DataSource, which
 *     composes every domain and so every engine it renders with; that hub is real use, not a barrel, so `total` is a
 *     ratchet (it may not grow past its bound) until the mock can be built per domain (21-engine-fanout.md §4).
 *
 * The other guard: inside the layers this fix covers, nothing imports an engine barrel (`src/engines/**\/index.ts`);
 * import the leaf by path. The barrels stay as re-export shims for the callers outside those layers.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');
const MOCK_HUB = path.join(ROOT, 'src/server/datasource/mock/index.ts');
const GOAL = 40;

/**
 * Leaf → its bounds. `direct` is under GOAL where the goal is met; where it is not yet (two leaves, reached through
 * component barrels and projections this chunk could not edit), the bound is a ratchet just above today's count.
 * `total` is a ratchet over the mock DataSource's integration tests. Measured 2026-11-21 after the fix (before → after
 * in 21-engine-fanout.md). Lower a bound when the count drops; never raise one without saying why in that report.
 */
const LEAVES: Record<string, { direct: number; total: number }> = {
  'src/engines/activity/overlap-flags.ts': { direct: 55, total: 140 }, // 50 / 128 (goal not met: components/domain, components/kit barrels; projections)
  'src/engines/priority/hash.ts': { direct: 50, total: 140 }, // 45 / 129 (goal not met: the priority and home tests, db/policy-map)
  'src/engines/resolution/escalation.ts': { direct: GOAL - 1, total: GOAL - 1 }, // 11 / 11
  'src/engines/needs/providers/triage.ts': { direct: GOAL - 1, total: 125 }, // 10 / 110
  'src/db/queue.ts': { direct: GOAL - 1, total: 145 }, // 36 / 132 (the mock reaches it through health-setup -> ops/doctor-service)
};

const SKIP = new Set(['node_modules', '.next', '.git', '.claude', '.shots']);
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), out); } else out.push(path.join(dir, e.name));
  }
  return out;
}

/** The unit + ui projects' files (vitest.config.ts): every *.test.ts outside db/evals/smoke, and the jsdom *.test.tsx. */
function testFiles(): string[] {
  return [...walk(path.join(ROOT, 'tests')), ...walk(path.join(ROOT, 'src'))].filter((abs) => {
    const r = rel(abs);
    if (/^tests\/(db|evals|smoke)\//.test(r)) return false;
    if (r.endsWith('.test.ts')) return true;
    return r.endsWith('.test.tsx') && (/\.dom\.test\.tsx$/.test(r) || /@vitest-environment\s+jsdom/.test(readFileSync(abs, 'utf8').slice(0, 600)));
  });
}

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

const depsCache = new Map<string, string[]>();
/** A file's runtime imports: transpiled first, so type-only imports and unused-as-value bindings are gone. */
function deps(file: string): string[] {
  const hit = depsCache.get(file);
  if (hit) return hit;
  const out: string[] = [];
  if (/\.(tsx?|m?js)$/.test(file)) {
    const js = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, isolatedModules: true },
    }).outputText;
    for (const i of ts.preProcessFile(js, true, true).importedFiles) {
      const r = resolveSpec(file, i.fileName);
      if (r) out.push(r);
    }
  }
  depsCache.set(file, out);
  return out;
}

function reaches(test: string, target: string, avoid?: string): boolean {
  if (test === target) return true;
  const seen = new Set([test]);
  const queue = [test];
  while (queue.length) {
    for (const d of deps(queue.shift()!)) {
      if (d === target) return true;
      if (seen.has(d) || d === avoid) continue;
      seen.add(d);
      queue.push(d);
    }
  }
  return false;
}

describe('engine fan-out (ENG-5): a leaf engine file is reached by few test files', () => {
  const tests = testFiles();
  const rows = Object.entries(LEAVES).map(([leaf, bound]) => {
    const abs = path.join(ROOT, leaf);
    const total = tests.filter((t) => reaches(t, abs));
    const direct = total.filter((t) => reaches(t, abs, MOCK_HUB));
    return { leaf, bound, total: total.length, direct: direct.length, directFiles: direct.map(rel) };
  });

  it('finds the unit and ui test files', () => {
    expect(tests.length).toBeGreaterThan(300);
  });

  for (const r of Object.keys(LEAVES)) {
    it(`${r}: within its bounds (outside the mock DataSource, and overall)`, () => {
      const row = rows.find((x) => x.leaf === r)!;
      expect(existsSync(path.join(ROOT, r)), `${r} moved: update LEAVES in this file`).toBe(true);
      expect(
        row.direct,
        `${r} is reached by ${row.direct} test files outside the mock DataSource (bound ${row.bound.direct}, goal < ${GOAL}). A barrel or a hub import pulls it in: import leaves by path (CONTRIBUTING.md "Barrels stay thin"). Files: ${row.directFiles.slice(0, 15).join(', ')}`,
      ).toBeLessThanOrEqual(row.bound.direct);
      expect(
        row.total,
        `${r} is reached by ${row.total} test files in all (ratchet ${row.bound.total}). Something new pulls it into many tests: see docs/reviews/2026-11-20-holistic/21-engine-fanout.md`,
      ).toBeLessThanOrEqual(row.bound.total);
    });
  }

  it('the covered layers import engine leaves by path, never an engine barrel', () => {
    const scope = /^src\/(engines|server\/datasource\/(mock|db)|server\/views)\//;
    const barrel = /^src\/engines\/.*\/index\.tsx?$/;
    const bad: string[] = [];
    for (const abs of walk(path.join(ROOT, 'src'))) {
      const r = rel(abs);
      if (!scope.test(r) || barrel.test(r) || !/\.tsx?$/.test(r)) continue;
      for (const d of deps(abs)) if (barrel.test(rel(d))) bad.push(`${r} -> ${rel(d)}`);
    }
    expect(bad, 'import the engine leaf by path (the barrel re-exports every module of the engine)').toEqual([]);
  });
});
