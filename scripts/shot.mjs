#!/usr/bin/env node
// Playwright screenshot tool. It starts nothing: it expects a running dev server.
//
//   npm run shot -- <route> [--widths 1280,1440,1920,2560] [--height 900] [--port 4327]
//                           [--scenario <seconds>] [--wait <selector>] [--out .shots]
//                           [--full] [--delay <ms>] [--scale <n>] [--open-panel]
//
// `--open-panel` opens the right panel (presses `]`, the shell's panel toggle, and waits for #cc-main[data-panel="open"])
// so pages that switch on the panel (Activity's LanePage: two columns closed, one column open) can be seen both ways;
// the file is named <slug>-panel-<width>.png.
// `--scale N` is for a mock server started at that scale (C9, src/mock/scale.ts):
//   CC_SEED_SCALE=N CC_DATA=mock PORT=4372 npm run dev:web   then   npm run shot -- /activity --port 4372 --scale N
// shot starts nothing, so the flag only names the files <slug>-x<N>-<width>.png and the start hint; the seed's scale
// is the server's.
//
// Writes <out>/<slug>-<width>.png and prints each path. `--scenario N` fast-forwards the mock
// scenario clock to N seconds (POST /api/v1/dev/scenario {action:"seek"}) before shooting.
// Works against CC_DATA=mock and CC_DATA=db: liveness is GET /api/v1/health; the server is in mock mode
// when GET /api/v1/dev/scenario answers 200 (db mode answers 404: dev routes are mock-only), and only then
// is --scenario applied (otherwise it is skipped with a warning).
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

/** Playwright's bundled Chromium, else the system Chrome (the shared browser cache can be cleared by other tools). */
async function launchBrowser() {
  if (process.env.CC_SHOT_CHANNEL) return chromium.launch({ channel: process.env.CC_SHOT_CHANNEL });
  try {
    return await chromium.launch();
  } catch (err) {
    if (!/Executable doesn't exist|browserType\.launch/i.test(String(err?.message ?? err))) throw err;
    console.warn('shot: bundled Chromium missing; using the system Chrome');
    return chromium.launch({ channel: 'chrome' });
  }
}

function parseArgs(argv) {
  const opts = { route: '/', widths: [1280, 1440, 1920, 2560], height: 900, port: Number(process.env.PORT) || 4327, out: '.shots', delay: 400 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--widths') opts.widths = next().split(',').map((w) => Number(w.trim())).filter(Boolean);
    else if (a === '--height') opts.height = Number(next());
    else if (a === '--port') opts.port = Number(next());
    else if (a === '--scenario') opts.scenario = Number(next());
    else if (a === '--wait') opts.wait = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--delay') opts.delay = Number(next());
    else if (a === '--full') opts.full = true;
    else if (a === '--scale') opts.scale = Number(next());
    else if (a === '--open-panel') opts.openPanel = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else rest.push(a);
  }
  if (rest[0]) opts.route = rest[0].startsWith('/') ? rest[0] : `/${rest[0]}`;
  return opts;
}

function slugFor(route) {
  const clean = route.split('?')[0].replace(/^\/+|\/+$/g, '');
  return clean ? clean.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() : 'today';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('usage: npm run shot -- <route> [--widths 1280,1440] [--height 900] [--port 4327] [--scenario s] [--wait sel] [--out .shots] [--full] [--delay ms] [--scale n] [--open-panel]');
    return;
  }
  const base = `http://localhost:${opts.port}`;

  try {
    const res = await fetch(`${base}/api/v1/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // ON-24: a fresh install answers /health with no user yet; every page then shows Getting started
    if ((await res.json().catch(() => null))?.reason === 'no_user') console.log('[shot] no user in this database yet: pages show Getting started (/onboarding)');
  } catch (err) {
    console.error(`[shot] no dev server answering at ${base} (${err.message}). Start one with: ${opts.scale ? `CC_SEED_SCALE=${opts.scale} CC_DATA=mock ` : ''}PORT=${opts.port} npm run dev:web`);
    process.exit(2);
  }
  const mockMode = await fetch(`${base}/api/v1/dev/scenario`).then((r) => r.ok, () => false);
  if (!mockMode) console.log('[shot] server is not in mock mode (CC_DATA=db?): dev routes are off');

  if (opts.scenario !== undefined && !mockMode) {
    console.warn(`[shot] --scenario ${opts.scenario} skipped: the scenario clock exists only in mock mode`);
  } else if (opts.scenario !== undefined) {
    const res = await fetch(`${base}/api/v1/dev/scenario`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'seek', seconds: opts.scenario }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[shot] scenario seek failed:', JSON.stringify(body));
      process.exit(1);
    }
    console.log(`[shot] scenario at ${body.t ?? opts.scenario}s (${(body.fired ?? []).length} events fired)`);
  }

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const slug = `${slugFor(opts.route)}${opts.scale > 1 ? `-x${opts.scale}` : ''}${opts.openPanel ? '-panel' : ''}`;
  const browser = await launchBrowser();
  const consoleErrors = [];
  try {
    for (const width of opts.widths) {
      const page = await browser.newPage({ viewport: { width, height: opts.height }, deviceScaleFactor: 1 });
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(`[${width}] ${msg.text()}`);
      });
      page.on('pageerror', (err) => consoleErrors.push(`[${width}] pageerror: ${err.message}`));
      await page.goto(`${base}${opts.route}`, { waitUntil: 'networkidle', timeout: 60_000 }).catch(async () => {
        // SSE keeps a connection open, so networkidle may never settle; fall back to load.
        await page.goto(`${base}${opts.route}`, { waitUntil: 'load', timeout: 60_000 });
      });
      if (opts.wait) await page.waitForSelector(opts.wait, { timeout: 20_000 });
      if (opts.openPanel) {
        await page.waitForSelector('#cc-main[data-panel]', { timeout: 20_000 });
        if ((await page.getAttribute('#cc-main', 'data-panel')) !== 'open') {
          await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => {});
          await page.keyboard.press(']');
        }
        await page.waitForSelector('#cc-main[data-panel="open"]', { timeout: 10_000 });
      }
      await page.waitForTimeout(opts.delay);
      const file = join(outDir, `${slug}-${width}.png`);
      await page.screenshot({ path: file, fullPage: Boolean(opts.full) });
      console.log(file);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (consoleErrors.length) {
    console.warn(`[shot] ${consoleErrors.length} console error(s):`);
    for (const e of consoleErrors.slice(0, 20)) console.warn('  ', e);
  }
}

main().catch((err) => {
  console.error('[shot] failed:', err);
  process.exit(1);
});
