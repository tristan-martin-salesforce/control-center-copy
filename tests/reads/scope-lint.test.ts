/**
 * p4-page-scoped-reads: nothing loads the read model without naming what it is for. Over src/ and scripts/ (tests
 * are exempt: older helpers use loadModel's documented default):
 *   - every `loadModel(…)` call passes `{ scope: … }`;
 *   - every DataSource `model(…)` call passes a scope (no bare `this.model()` / `ds.model()` / `this.ctx.model()`);
 *   - the engine hosts that call a bound `host.model()` get it bound to a named scope (db/index.ts, db/ctx.ts and
 *     the domain files under db/domains/, R7).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The argument text of each call `name(` in `src` (balanced parentheses; strings are not special-cased). */
function calls(src: string, re: RegExp): Array<{ args: string; line: number }> {
  const out: Array<{ args: string; line: number }> = [];
  for (const m of src.matchAll(re)) {
    const lineStart = src.lastIndexOf('\n', m.index!) + 1;
    const before = src.slice(lineStart, m.index!);
    if (/^\s*(\*|\/\*|\/\/)/.test(before) || before.includes('//')) continue; // a comment
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    out.push({ args: src.slice(start, i - 1).trim(), line: src.slice(0, m.index!).split('\n').length });
  }
  return out;
}

const sources = [...files(path.join(root, 'src')), ...files(path.join(root, 'scripts'))].map((f) => ({ file: path.relative(root, f), text: readFileSync(f, 'utf8') }));

describe('every read-model load names its scope', () => {
  it('loadModel(…) always passes { scope }', () => {
    const bad: string[] = [];
    let seen = 0;
    for (const { file, text } of sources) {
      for (const c of calls(text, /(?<![\w.])loadModel\(/g)) {
        if (/^db: Db, userId/.test(c.args)) continue; // the definition
        seen++;
        if (!/[{,]\s*scope\s*[:,}]/.test(c.args)) bad.push(`${file}:${c.line}`);
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });

  it('DataSource model(…) calls pass a scope (no bare this.model() / ds.model() / ctx.model())', () => {
    const bad: string[] = [];
    let seen = 0;
    for (const { file, text } of sources) {
      for (const c of calls(text, /\b(?:this|ds|db|source|ctx)\.model\(/g)) {
        seen++;
        if (!c.args) bad.push(`${file}:${c.line}`);
      }
    }
    expect(seen).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });

  it('engine hosts get model() bound to a named scope', () => {
    const dbDir = path.join('src', 'server', 'datasource', 'db');
    const wiring = sources.filter((s) => s.file === path.join(dbDir, 'index.ts') || s.file === path.join(dbDir, 'ctx.ts') || s.file.startsWith(path.join(dbDir, 'domains') + path.sep));
    const bindings = wiring.flatMap((s) => [...s.text.matchAll(/\bmodel: \(\) => this\.(?:ctx\.)?model\(([^)]*)\)/g)].map((m) => m[1]!.trim()));
    expect(bindings.length).toBeGreaterThanOrEqual(4);
    for (const b of bindings) expect(b).not.toBe('');
  });
});
