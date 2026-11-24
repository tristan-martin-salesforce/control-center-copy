/**
 * Crawl smoke (the `smoke` test project): start the app in mock mode, visit every page, fail on anything a user would
 * hit at first sight.
 *
 *   npm run smoke:crawl -- --mock [--port 4372] [--width 1440] [--persona se|ae] [--seed <file>] [--scale <n>] [--keep]
 *
 * Visits every route in src/components/shell/routes.ts (a `:param` route with a real id read from the mock API, skipped
 * with a note when the mock has none), every Settings section (`/settings?section=<id>`) and every Activity view
 * (`/activity?view=<v>`, plus To log's Week and Review pages). Per page it fails on: a console error, an uncaught page
 * error, a 5xx answer, a failed same-origin request, an error boundary / "page doesn't exist" screen, a missing `<h1>`
 * (the topbar title). Prints one line per page, then a summary line. Exit 0 all clear, 1 a failure, 2 bad usage, 77 no
 * browser here (the vitest wrapper turns that into a skip).
 *
 * `--persona se|ae` crawls as that persona (D-55): the mock's Settings ▸ Role is switched (PATCH /settings/persona, the
 * same in-memory change Settings ▸ Role & rules makes) before the first page and again before any page that finds it
 * changed back (a `next dev` memory restart reloads the seed). Without it the seed's persona (SE) is crawled.
 * A server the crawl starts loads that persona's world: for `ae` the Specialist AE seed overlay (src/mock/persona-seed.ts,
 * written to a temp file and passed as CC_SEED_PATH), so Home, Today and Time read an AE's week. `--seed <file>` loads
 * that seed instead. A reused server keeps the seed it was started with.
 *
 * `--scale N` starts the server with CC_SEED_SCALE=N (src/mock/scale.ts: the seed ×N at load, rows over six weeks, work and
 * inbox ×N/2, 60+ VDP items at N ≥ 4); a reused server keeps the scale it was started with.
 *
 * `--port N` uses that port: a server already answering /api/v1/health there is reused (and left running), otherwise
 * one is started there. Without it a free port in the lane range 4345-4399 (AGENTS.md) is used, never the app's
 * own 4327. Mock mode only, reads only: no connector, no external system, nothing is sent (the mock DataSource answers
 * everything). The deeper, link-following crawl with persona switching is `npm run crawl` (scripts/qa/crawl.mjs).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';

import { SECTIONS } from '../../src/components/settings/derive';
import { ROUTES } from '../../src/components/shell/routes';
import { ACTIVITY_VIEWS } from '../../src/components/time/views';
import { writePersonaSeed } from '../../src/mock/persona-seed';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (k: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : d;
};

if (!argv.includes('--mock')) {
  console.error('smoke:crawl runs against the mock app only: pass --mock');
  process.exit(2);
}

const WIDTH = Number(arg('width', '1440'));
const PERSONA = arg('persona');
if (PERSONA !== undefined && PERSONA !== 'se' && PERSONA !== 'ae') {
  console.error(`smoke:crawl: --persona takes se or ae, not ${PERSONA}`);
  process.exit(2);
}
const SCALE = arg('scale');
if (SCALE !== undefined && !(Number.isInteger(Number(SCALE)) && Number(SCALE) >= 1)) {
  console.error(`smoke:crawl: --scale takes a whole number ≥ 1, not ${SCALE}`);
  process.exit(2);
}
const NAV_TIMEOUT = 90_000; // legitimately long: the first hit of a route compiles it under `next dev`

const freePort = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

/** The worktree lane ports (AGENTS.md, CLAUDE.md): 4327 is the app's own. */
const LANE_PORTS = { from: 4345, to: 4399 };

async function pickPort(): Promise<number> {
  for (let p = LANE_PORTS.from; p <= LANE_PORTS.to; p++) if (await freePort(p)) return p;
  throw new Error(`no free port in the lane range ${LANE_PORTS.from}-${LANE_PORTS.to}: pass --port`);
}

async function healthy(base: string): Promise<boolean> {
  try {
    return (await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(3000) })).status < 500;
  } catch {
    return false;
  }
}

async function startServer(port: number, seedPath: string): Promise<ChildProcess> {
  const child = spawn('npx', ['next', 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CC_DATA: 'mock', CC_SCENARIO: '0', CC_SEED_PATH: seedPath, ...(SCALE ? { CC_SEED_SCALE: SCALE } : {}), NEXT_TELEMETRY_DISABLED: '1', PORT: String(port) },
  });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    if (child.exitCode !== null) throw new Error(`next dev exited (${child.exitCode}) before it answered on :${port}`);
    if (await healthy(base)) return child;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`next dev did not answer on :${port} within 180 s`);
}

function stopServer(child: ChildProcess | null): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // the whole group: npx, next, its workers
  } catch {
    /* already gone */
  }
}

async function launchBrowser(): Promise<Browser | null> {
  const channel = process.env.CC_SHOT_CHANNEL;
  if (channel) return chromium.launch({ channel }).catch(() => null);
  return chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }).catch(() => null));
}

/** The first string value under one of `keys` anywhere in a JSON value. */
function firstString(v: unknown, keys: string[]): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = firstString(x, keys);
      if (r) return r;
    }
  } else if (v && typeof v === 'object') {
    for (const k of keys) {
      const val = (v as Record<string, unknown>)[k];
      if (typeof val === 'string' && val) return val;
    }
    for (const x of Object.values(v)) {
      const r = firstString(x, keys);
      if (r) return r;
    }
  }
  return null;
}

async function sample(base: string, api: string, keys: string[]): Promise<string | null> {
  try {
    const r = await fetch(`${base}/api/v1${api}`, { signal: AbortSignal.timeout(30_000) });
    return r.ok ? firstString(await r.json(), keys) : null;
  } catch {
    return null;
  }
}

/** Switch the mock's persona to `id` when it is another (Settings ▸ Role & rules' own PATCH). True when it is `id` now. */
async function ensurePersona(base: string, id: string): Promise<boolean> {
  try {
    const s = (await (await fetch(`${base}/api/v1/settings`, { signal: AbortSignal.timeout(30_000) })).json()) as { persona?: { id: string; version: number } };
    if (s.persona?.id === id) return true;
    const r = await fetch(`${base}/api/v1/settings/persona`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ifVersion: s.persona?.version ?? 1, value: { id } }), signal: AbortSignal.timeout(30_000) });
    return r.ok;
  } catch {
    return false;
  }
}

interface Target {
  path: string;
  skip?: string;
}

async function targets(base: string): Promise<Target[]> {
  const ids: Record<string, string | null> = {
    id: null,
    accountId: null,
    initiativeId: null,
  };
  const out: Target[] = [];
  for (const r of ROUTES) {
    if (!r.pattern.includes(':')) {
      out.push({ path: r.pattern });
      continue;
    }
    const param = r.pattern.split('/').find((s) => s.startsWith(':'))!.slice(1);
    let id: string | null = null;
    if (r.key === 'workItem') id = ids.id ??= await sample(base, '/items', ['id']);
    else if (r.key === 'account') id = ids.accountId ??= await sample(base, '/deals', ['accountId', 'id']);
    else if (r.key === 'initiative') id = ids.initiativeId ??= (await sample(base, '/items', ['initiativeId'])) ?? null;
    out.push(id ? { path: r.pattern.replace(`:${param}`, encodeURIComponent(id)) } : { path: r.pattern, skip: `no ${param} in the mock data` });
  }
  for (const s of SECTIONS) out.push({ path: `/settings?section=${s.id}` });
  for (const v of ACTIVITY_VIEWS) out.push({ path: `/activity?view=${v.value}` });
  out.push({ path: '/activity?view=log&show=week' }, { path: '/activity?view=log&review=1' });
  return [...new Map(out.map((t) => [t.path, t])).values()];
}

const BOUNDARY = /Something went wrong loading Command Center|Unhandled Runtime Error|Application error|This page doesn.t exist/i;

interface Result {
  path: string;
  skip?: string;
  h1: string;
  consoleErrors: string[];
  pageErrors: string[];
  serverErrors: string[];
  failed: string[];
  boundary: boolean;
  ms: number;
}

async function visit(page: Page, base: string, t: Target): Promise<Result> {
  const r: Result = { path: t.path, h1: '', consoleErrors: [], pageErrors: [], serverErrors: [], failed: [], boundary: false, ms: 0 };
  const onConsole = (m: { type(): string; text(): string }) => m.type() === 'error' && r.consoleErrors.push(m.text().slice(0, 200));
  const onPageError = (e: Error) => r.pageErrors.push(String(e.message).slice(0, 200));
  const onResponse = (res: { url(): string; status(): number; request(): { method(): string } }) => {
    if (res.url().startsWith(base) && res.status() >= 500) r.serverErrors.push(`${res.request().method()} ${res.url().slice(base.length)} ${res.status()}`);
  };
  const onFailed = (req: { url(): string; method(): string; failure(): { errorText: string } | null }) => {
    const err = req.failure()?.errorText ?? 'failed';
    if (!req.url().startsWith(base) || req.url().includes('/api/v1/events') || /ERR_ABORTED/.test(err)) return;
    r.failed.push(`${req.method()} ${req.url().slice(base.length)} ${err}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  const t0 = Date.now();
  try {
    const nav = await page.goto(`${base}${t.path}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    if (nav && nav.status() >= 500) r.serverErrors.push(`GET ${t.path} ${nav.status()}`);
    await page.waitForSelector('h1', { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(800); // late client errors (a query that fails after the shell paints)
    r.h1 = ((await page.locator('h1').first().textContent({ timeout: 2000 }).catch(() => '')) ?? '').trim();
    r.boundary = BOUNDARY.test(await page.evaluate(() => document.body?.innerText ?? '')) || (await page.locator('[data-nextjs-dialog], [data-nextjs-dialog-overlay]').count()) > 0 /* the dev error overlay (an empty <nextjs-portal> is always there) */;
  } catch (e) {
    r.pageErrors.push(`navigation: ${String((e as Error).message).slice(0, 160)}`);
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
    page.off('requestfailed', onFailed);
  }
  r.ms = Date.now() - t0;
  return r;
}

const problemsOf = (r: Result): string[] => [
  ...(r.h1 ? [] : ['no <h1>']),
  ...(r.boundary ? ['error boundary or not-found screen'] : []),
  ...r.consoleErrors.map((e) => `console: ${e}`),
  ...r.pageErrors.map((e) => `page error: ${e}`),
  ...r.serverErrors.map((e) => `5xx: ${e}`),
  ...r.failed.map((e) => `request: ${e}`),
];

async function main(): Promise<number> {
  const portArg = arg('port');
  const port = portArg ? Number(portArg) : await pickPort();
  const base = `http://127.0.0.1:${port}`;
  const reuse = await healthy(base);
  let server: ChildProcess | null = null;
  const browser = await launchBrowser();
  if (!browser) {
    console.log('smoke:crawl: no browser here (bundled Chromium and system Chrome both failed to launch): skipped');
    return 77;
  }
  try {
    if (!reuse) server = await startServer(port, seedFile());
    if (PERSONA && !(await ensurePersona(base, PERSONA))) throw new Error(`could not switch the mock to the ${PERSONA} persona`);
    const list = await targets(base);
    const ctx = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, colorScheme: 'dark' });
    const results: Result[] = [];
    const pad = Math.max(...list.map((t) => t.path.length)) + 2;
    console.log(`smoke:crawl ${base} (${reuse ? 'reused server' : 'started mock server'}${PERSONA ? `, persona ${PERSONA}` : ''}${SCALE ? `, scale ${SCALE}` : ''}), ${list.length} pages`);
    for (const t of list) {
      if (t.skip) {
        console.log(`skip  ${t.path.padEnd(pad)} ${t.skip}`);
        results.push({ path: t.path, skip: t.skip, h1: '', consoleErrors: [], pageErrors: [], serverErrors: [], failed: [], boundary: false, ms: 0 });
        continue;
      }
      if (PERSONA) await ensurePersona(base, PERSONA);
      const page = await ctx.newPage();
      const r = await visit(page, base, t);
      await page.close();
      results.push(r);
      const p = problemsOf(r);
      console.log(`${p.length ? 'FAIL' : 'ok  '}  ${t.path.padEnd(pad)} h1=${JSON.stringify(r.h1).padEnd(28)} console=${r.consoleErrors.length} page=${r.pageErrors.length} 5xx=${r.serverErrors.length} ${String(r.ms).padStart(5)} ms${p.length ? `\n      ${p.join('\n      ')}` : ''}`);
    }
    const bad = results.filter((r) => !r.skip && problemsOf(r).length);
    const skipped = results.filter((r) => r.skip).length;
    console.log(`smoke:crawl: ${results.length - skipped - bad.length} ok, ${bad.length} failed, ${skipped} skipped of ${results.length}`);
    return bad.length ? 1 : 0;
  } finally {
    await browser.close().catch(() => undefined);
    if (!argv.includes('--keep')) stopServer(server);
    if (seedDir && !argv.includes('--keep')) rmSync(seedDir, { recursive: true, force: true });
  }
}

let seedDir: string | null = null;
/** The seed a started server loads: `--seed`, the AE overlay for `--persona ae`, else the committed example. */
function seedFile(): string {
  const explicit = arg('seed');
  if (explicit) return path.resolve(explicit);
  if (PERSONA !== 'ae') return path.join(ROOT, 'src/mock/seed.example.json');
  seedDir = mkdtempSync(path.join(os.tmpdir(), 'cc-crawl-seed-'));
  return writePersonaSeed('ae', path.join(seedDir, 'seed.ae.json'));
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`smoke:crawl: ${String((e as Error).message ?? e)}`);
    process.exit(2);
  },
);
