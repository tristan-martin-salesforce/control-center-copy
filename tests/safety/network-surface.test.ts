/**
 * Static safety: where the app may reach the outside world (2026-11-20 review, 10 R10a; *tenet: Nothing leaves without
 * approval*, CLAUDE.md invariants 1 and 2). Source is scanned (comments and strings stripped) for
 *
 *   - `fetch(` calls (global fetch; method calls like `x.fetch(` and declarations are not network calls),
 *   - `child_process` (a spawned process can do anything: the claude CLI, devbar, brew, a terminal),
 *   - node network clients (`net`, `http`, `https`, `tls`, `dgram`, `http2`) and client packages (`undici`, `axios`,
 *     `node-fetch`, `got`, `ws`, the MCP SDK's client, `pg`).
 *
 * Each may appear only in the ALLOWED places below, each with why. A new file that reaches out fails here, so adding
 * one is a decision made in review (the allowlist line, with its reason), never an accident. An entry that no file
 * uses any more fails too, so the list cannot rot. Scanned: `src/**`, `app/**`, `ops/**`, `scripts/**` (tests excluded).
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src', 'app', 'ops', 'scripts'];

type Kind = 'fetch' | 'child_process' | 'net';

/** Path prefixes (a directory ends with `/`, anything else is one file) → why it may do this. */
const ALLOWED: Record<Kind, Record<string, string>> = {
  fetch: {
    'src/client/': 'browser code: same-origin calls to the app\'s own /api/v1 (the typed api client, the chat SSE stream); never another origin',
    'src/connectors/vdp/http.ts': 'connector: the one VDP HTTP client (read tools; its writes are only the Outbox ops, called through ./write.ts after Apply)',
    'src/tools/adapters/base.ts': 'tools: the local tool servers the user starts from the Tools page (localhost health and API calls)',
    'src/components/composer/': 'browser: the Composer autosave PATCHes the app\'s own /api/v1 on unload (keepalive)',
    'src/components/feedback/': 'browser: the feedback panel reads the app\'s own /api/v1/version',    'src/ops/doctor.ts': 'doctor: probes the app\'s own localhost ports (web, worker) for the health report; reads only',
    'scripts/': 'developer and operator scripts (screenshots, crawl, stress, updater): run by hand or by launchd, never by the app at runtime',
  },
  child_process: {
    'src/connectors/claude/sessions.ts': 'connector: lists local Claude Code sessions (read only, local files and ps)',
    'src/connectors/google/client.ts': 'connector: the devbar stdio bridge for Google read tools (read allowlist enforced in the same file)',
    'src/tools/claude-launch.ts': 'a user-clicked "Launch" of Claude Code in a terminal (route launchAgent is denied for the Assistant)',
    'src/tools/adapters/afd360-estimator.ts': 'tool adapter: runs the local estimator the user started from the Tools page',
    'src/reauth/terminal.ts': 'reauth: opens the user\'s terminal for a login (Okta cookie, Google, Slack) the user completes',
    'src/ops/': 'ops: doctor, brew, update helpers: shell out to local tools (never an external system)',
    'scripts/': 'developer and operator scripts: setup, update, LaunchAgents, backups, release',
  },
  net: {
    'src/ops/doctor.ts': 'doctor: a TCP connect to localhost to test whether a port is in use',
    'src/ops/pg-cluster.ts': 'doctor: a startup packet on the bundled database\'s own unix socket (D-98; pg_isready without the binary), local only',
    'src/connectors/google/client.ts': 'connector: the MCP SDK client over the devbar stdio transport (read allowlist enforced in the same file)',
    'src/db/': 'the Postgres pool (pg) to the local database',
    'src/server/datasource/db/events.ts': 'LISTEN/NOTIFY client (pg) on the local database',
    'src/server/events/pg-bus.ts': 'the live-event bus (pg) on the local database',
    'src/worker/': 'the worker\'s LISTEN client (pg) and its own wiring, on the local database',
    'src/llm/chat/fake.ts': 'test double: the MCP SDK client over an in-memory transport (no socket)',
    'scripts/': 'developer and operator scripts: db bootstrap, readiness probes, local servers',
  },
};

const walk = (dir: string, out: string[] = []): string[] => {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name) && !/\.(test|spec)\.[a-z]+$/.test(e.name) && !/(^|\/)__tests__\//.test(rel)) out.push(rel);
  }
  return out;
};

/** Source with comments and string/template contents blanked (imports are read before this, from the raw text). */
function code(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      out += '""';
    } else if (c === '`') {
      i++;
      while (i < src.length && src[i] !== '`') i += src[i] === '\\' ? 2 : 1;
      i++;
      out += '""';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const NET_MODULES = /^(?:node:)?(?:net|http|https|tls|dgram|http2)$|^(?:undici|axios|node-fetch|got|ws|pg)$|^@modelcontextprotocol\/sdk\/client\//;
const specifiers = (raw: string) => [...raw.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*|^import\s+)['"]([^'"]+)['"]/gm)].map((m) => m[1]!);

export function usesOf(raw: string): Set<Kind> {
  const found = new Set<Kind>();
  const body = code(raw);
  // a global call: not `x.fetch(`, not `async fetch(` / `function fetch(` / a method declaration at line start
  if (/(?<![.\w$])(?<!async\s)(?<!function\s)fetch\s*\(/.test(body.replace(/^\s*fetch\s*\(/gm, ''))) found.add('fetch');
  // the global used as a value: `(o.fetch ?? fetch)(url)`, `globalThis.fetch`
  if (/\?\?\s*fetch\b(?!\s*:)|(?:globalThis|window|self)\.fetch\b/.test(body)) found.add('fetch');
  for (const s of specifiers(raw)) {
    if (/^(?:node:)?child_process$/.test(s)) found.add('child_process');
    else if (NET_MODULES.test(s)) found.add('net');
  }
  return found;
}

const files = SCAN_DIRS.flatMap((d) => walk(d));
const allowedBy = (kind: Kind, file: string) => Object.keys(ALLOWED[kind]).find((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

describe('the detector', () => {
  it('sees real calls and ignores methods, declarations, strings and comments', () => {
    expect(usesOf("const r = await fetch('/x');").has('fetch')).toBe(true);
    expect(usesOf("void fetch(url, { method: 'PATCH' });").has('fetch')).toBe(true);
    expect(usesOf('const r = await (o.fetch ?? fetch)(url);').has('fetch')).toBe(true);
    expect(usesOf('const r = await (opts.fetch ?? globalThis.fetch)(url);').has('fetch')).toBe(true);
    expect(usesOf('interface C { fetch: typeof fetch; }').has('fetch')).toBe(false);
    expect(usesOf('const r = await ds.fetch(a, b);').has('fetch')).toBe(false);
    expect(usesOf('class A { async fetch(a: string) { return 1; } }').has('fetch')).toBe(false);
    expect(usesOf('interface F {\n  fetch(\n    a: string,\n  ): void;\n}').has('fetch')).toBe(false);
    expect(usesOf("// fetch(url)\nconst s = 'fetch(url)';").has('fetch')).toBe(false);
    expect(usesOf("import { execFile } from 'node:child_process';").has('child_process')).toBe(true);
    expect(usesOf("import net from 'node:net';").has('net')).toBe(true);
    expect(usesOf("import { Pool } from 'pg';").has('net')).toBe(true);
    expect(usesOf("import fs from 'node:fs';").size).toBe(0);
  });
});

describe('outside-world access is confined to the allowlisted places', () => {
  it('found some files to scan (the walk is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  for (const kind of ['fetch', 'child_process', 'net'] as const) {
    it(`${kind}: only where ALLOWED says, each with a reason`, () => {
      const offenders = files.filter((f) => usesOf(fs.readFileSync(path.join(ROOT, f), 'utf8')).has(kind) && !allowedBy(kind, f));
      expect(offenders, `${kind} used outside the allowlist in tests/safety/network-surface.test.ts (add it there with why, or remove it):\n${offenders.join('\n')}`).toEqual([]);
    });

    it(`${kind}: every allowlist entry is still used (no stale entries)`, () => {
      const used = files.filter((f) => usesOf(fs.readFileSync(path.join(ROOT, f), 'utf8')).has(kind));
      const stale = Object.keys(ALLOWED[kind]).filter((p) => !used.some((f) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
      expect(stale, `no file under these uses ${kind} any more: remove them`).toEqual([]);
    });
  }
});
