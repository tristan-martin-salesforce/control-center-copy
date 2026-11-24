/**
 * 2026-11-13 audit C9: find what the app computes and nobody reads. For every pure derive / model module of the UI
 * (`src/components/**\/{derive,*-derive,model,*-model}.ts`):
 *
 *   exports   an exported function / const with no reader outside its own file (tests don't count)
 *   fields    a field of an exported interface that no file importing the module (directly, or through one module
 *             that imports it) reads: `.field`, `{ field }`, `field:` in a pattern
 *
 * Static and regex-based (no type checker: this Mac is memory-tight), so it errs toward "read": a name that appears in a
 * reader counts. The intentional ones are allow-listed in ./unread-fields.test.ts with why.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const isTest = (f: string) => /\.test\.tsx?$/.test(f) || f.includes(`${path.sep}__tests__${path.sep}`);
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

export interface Unread {
  module: string;
  kind: 'export' | 'field';
  name: string;
}

export function derivedModules(): string[] {
  return walk(path.join(ROOT, 'src/components'))
    .filter((f) => !isTest(f))
    .filter((f) => /(^|[-/])(derive|model)\.ts$/.test(rel(f)) || /-(derive|model)\.ts$/.test(rel(f)));
}

/** Resolve an import specifier to a repo file (without extension), or null for a package. */
function resolveSpec(from: string, spec: string): string | null {
  if (spec.startsWith('@/')) return path.join(ROOT, 'src', spec.slice(2));
  if (spec.startsWith('.')) return path.resolve(path.dirname(from), spec);
  return null;
}

const stripExt = (f: string) => f.replace(/\.(ts|tsx)$/, '').replace(/\/index$/, '');

export function findUnread(): Unread[] {
  const sources = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'app'))].filter((f) => !isTest(f));
  const text = new Map(sources.map((f) => [f, readFileSync(f, 'utf8')] as const));
  const importsOf = new Map<string, Set<string>>();
  for (const [f, s] of text) {
    const set = new Set<string>();
    for (const m of s.matchAll(/from\s+'([^']+)'/g)) {
      const r = resolveSpec(f, m[1]!);
      if (r) set.add(stripExt(r));
    }
    importsOf.set(f, set);
  }
  const importers = (mod: string) => sources.filter((f) => importsOf.get(f)!.has(stripExt(mod)));
  const out: Unread[] = [];
  for (const mod of derivedModules()) {
    const src = text.get(mod) ?? readFileSync(mod, 'utf8');
    const others = sources.filter((f) => f !== mod);
    // exports
    for (const m of src.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)) {
      const name = m[1]!;
      const re = new RegExp(`\\b${name}\\b`);
      // read in its own module (beyond its declaration), or anywhere else outside tests
      const ownUses = (src.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
      if (ownUses < 2 && !others.some((f) => re.test(text.get(f)!))) out.push({ module: rel(mod), kind: 'export', name });
    }
    // fields of exported interfaces, read by the module's importers (and theirs)
    const direct = importers(mod);
    const readers = [...new Set([...direct, ...direct.flatMap((f) => importers(f))])].filter((f) => f !== mod);
    const body = readers.map((f) => text.get(f)!).join('\n');
    for (const m of src.matchAll(/^export interface (\w+)[^{]*\{([\s\S]*?)^\}/gm)) {
      for (const f of m[2]!.matchAll(/^ {2}(?:readonly )?(\w+)\??:/gm)) {
        const name = f[1]!;
        const re = new RegExp(`(\\.${name}\\b|[{,]\\s*${name}\\s*[,}:=]|\\b${name}\\s*=|\\[['"]${name}['"]\\])`);
        // a property read in the module itself counts too (a helper that formats it), never the producer's write
        if (!re.test(body) && !new RegExp(`\\.${name}\\b`).test(src)) out.push({ module: rel(mod), kind: 'field', name: `${m[1]}.${name}` });
      }
    }
  }
  return out;
}
