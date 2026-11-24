#!/usr/bin/env node
/**
 * The app crawl (release check): visits every page, records what a user would hit, and writes a report.
 *
 *   npm run crawl -- --base http://localhost:4345 --persona ae --mock     # mock: switches the persona, follows links
 *   npm run crawl -- --base http://localhost:4327 --live                  # live: top-level pages only, no clicks
 *
 * Without --base: http://localhost:$PORT, or :4327 (the app's port). A worktree lane serves on 4345-4399 (AGENTS.md).
 *
 * Per page: console errors, uncaught page errors, failed same-origin requests (status ≥ 400 or network failure,
 * the live event stream excepted), the "This page doesn't exist" screen, panels that failed to load, and buttons
 * with no accessible name. `--mock` follows internal links breadth-first (at most --per-route pages per route
 * pattern, --max pages in all); `--live` never follows links (detail pages can mark things read) and never patches.
 *
 * Writes `.shots/crawl-<label>.json` and prints a summary. Exit 1 when anything was found.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (k) => argv.includes(`--${k}`);

const base = arg('base', `http://localhost:${process.env.PORT || 4327}`).replace(/\/$/, '');
const live = has('live');
const mock = has('mock');
const persona = arg('persona', null);
const max = Number(arg('max', live ? '40' : '90'));
const perRoute = Number(arg('per-route', '2'));
const waitMs = Number(arg('wait', '2500'));
const width = Number(arg('width', '1440'));
const label = arg('label', `${live ? 'live' : 'mock'}-${persona ?? 'default'}`);

if (live && persona) {
  console.error('--live never changes settings: drop --persona (crawl the live app as it is)');
  process.exit(2);
}
if (!live && !mock) {
  console.error('say --mock (a mock server you can change) or --live (read-only, top-level pages)');
  process.exit(2);
}

const TOP = ['/', '/today', '/triage', '/outbox', '/assistant', '/work', '/work?tab=asked_of_me', '/deals', '/deals/missed', '/briefs', '/agents', '/agents/tools', '/time', '/time?view=week', '/time?view=log', '/time?view=vdp', '/time?view=forecast', '/health', '/settings', '/history'];

/** A path's route pattern, for sampling: /work/abc → /work/:id, /deals/123 → /deals/:id. */
function patternOf(href) {
  const u = new URL(href, base);
  const parts = u.pathname.split('/').filter(Boolean);
  const keep = new Set(['work', 'deals', 'briefs', 'agents', 'time', 'history', 'initiatives', 'triage', 'outbox', 'settings', 'missed', 'tools', 'health', 'today', 'assistant', 'onboarding']);
  const p = '/' + parts.map((x) => (keep.has(x) ? x : ':id')).join('/');
  const view = u.searchParams.get('view') ?? u.searchParams.get('tab');
  return view ? `${p}?${view}` : p;
}

async function api(method, path, body) {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function setPersona(id) {
  const s = await api('GET', '/settings');
  if (s.persona?.id === id) return;
  await api('PATCH', '/settings/persona', { ifVersion: s.persona?.version ?? 1, value: { id } });
}

async function main() {
  if (mock && persona) await setPersona(persona);
  // the bundled browser when installed, else the system Chrome (as scripts/shot.mjs does)
  const browser = process.env.CC_SHOT_CHANNEL ? await chromium.launch({ channel: process.env.CC_SHOT_CHANNEL }) : await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark' });
  // first-visit tips stay off for automated browsers anyway; make the panels deterministic
  const page = await ctx.newPage();
  const pages = [];
  const seen = new Set();
  const perPattern = new Map();
  const queue = [...TOP];
  let current = null;
  const sink = { console: [], pageErrors: [], failed: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') sink.console.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => sink.pageErrors.push(String(e?.message ?? e).slice(0, 300)));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (!u.startsWith(base) || u.includes('/api/v1/events') || /ERR_ABORTED|net::ERR_ABORTED/.test(r.failure()?.errorText ?? '')) return;
    sink.failed.push(`${r.method()} ${u.slice(base.length)} · ${r.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', (r) => {
    const u = r.url();
    if (!u.startsWith(base) || r.status() < 400) return;
    sink.failed.push(`${r.request().method()} ${u.slice(base.length)} · ${r.status()}`);
  });

  while (queue.length && pages.length < max) {
    const path = queue.shift();
    const key = new URL(path, base).pathname + new URL(path, base).search;
    if (seen.has(key)) continue;
    seen.add(key);
    const pat = patternOf(path);
    const n = perPattern.get(pat) ?? 0;
    if (n >= perRoute && !TOP.includes(path)) continue;
    perPattern.set(pat, n + 1);

    sink.console = [];
    sink.pageErrors = [];
    sink.failed = [];
    current = { path, pattern: pat };
    const t0 = Date.now();
    let navError = null;
    try {
      await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(waitMs);
    } catch (e) {
      navError = String(e?.message ?? e).slice(0, 200);
    }
    const facts = navError
      ? { notFound: false, panelErrors: [], unnamedButtons: 0, links: [] }
      : await page.evaluate(() => {
          const text = document.body?.innerText ?? '';
          const notFound = /This page doesn.t exist/.test(text);
          const panelErrors = [...document.querySelectorAll('[role="alert"], [data-state="error"]')]
            .map((e) => (e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 140))
            .filter((t) => t && /fail|couldn|error|went wrong/i.test(t));
          const unnamedButtons = [...document.querySelectorAll('button')].filter((b) => {
            if (b.offsetParent === null) return false;
            const name = (b.getAttribute('aria-label') ?? '') + (b.textContent ?? '') + (b.getAttribute('title') ?? '') + (b.getAttribute('aria-labelledby') ?? '');
            return !name.trim();
          }).length;
          const links = [...document.querySelectorAll('a[href]')]
            .map((a) => a.getAttribute('href') ?? '')
            .filter((h) => h.startsWith('/') && !h.startsWith('//') && !/^\/(api|dev|_next)\b/.test(h));
          return { notFound, panelErrors, unnamedButtons, links: [...new Set(links)] };
        });
    const rec = {
      path,
      pattern: pat,
      ms: Date.now() - t0,
      navError,
      notFound: facts.notFound,
      panelErrors: facts.panelErrors,
      unnamedButtons: facts.unnamedButtons,
      consoleErrors: [...new Set(sink.console)],
      pageErrors: [...new Set(sink.pageErrors)],
      failedRequests: [...new Set(sink.failed)],
    };
    pages.push(rec);
    if (mock) for (const l of facts.links) if (!seen.has(l)) queue.push(l);
  }
  await browser.close();
  void current;

  const problems = pages.filter((p) => p.navError || p.notFound || p.panelErrors.length || p.consoleErrors.length || p.pageErrors.length || p.failedRequests.length);
  const out = resolve(process.cwd(), '.shots');
  mkdirSync(out, { recursive: true });
  const file = join(out, `crawl-${label}.json`);
  writeFileSync(file, JSON.stringify({ base, live, persona, at: new Date().toISOString(), pages }, null, 2));
  console.log(`crawl ${label}: ${pages.length} pages, ${problems.length} with problems → ${file}`);
  for (const p of problems) {
    console.log(`\n${p.path}${p.navError ? `\n  nav: ${p.navError}` : ''}${p.notFound ? '\n  not found screen' : ''}`);
    for (const e of p.panelErrors) console.log(`  panel: ${e}`);
    for (const e of p.pageErrors) console.log(`  page error: ${e}`);
    for (const e of p.consoleErrors.slice(0, 5)) console.log(`  console: ${e}`);
    for (const e of p.failedRequests.slice(0, 8)) console.log(`  request: ${e}`);
  }
  const unnamed = pages.filter((p) => p.unnamedButtons).map((p) => `${p.path} (${p.unnamedButtons})`);
  if (unnamed.length) console.log(`\nbuttons with no accessible name: ${unnamed.join(', ')}`);
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
