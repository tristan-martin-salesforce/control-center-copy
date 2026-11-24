/**
 * The accessibility smoke: axe-core (WCAG 2.1 A + AA, plus the landmark and heading rules) on every page, in dark and
 * light, against the mock app. Fails on a violation the baseline (tests/a11y/baseline.json) does not list, so a new
 * one never lands; a page that gets better only prints a note (run with --update to shrink the baseline).
 *
 *   npm run test:a11y -- [--only /triage] [--theme dark|light] [--update] [--json out.json]
 *
 * Pages: every route in src/components/shell/routes.ts (a `:param` route with a real id from the mock API), every
 * Settings section, every Activity view, every Health tab, the onboarding steps, and the opened states a still page
 * can't show: the Details panel, the composer, the Review prompt dialog, the command palette, an Undo toast.
 * Per page it also checks what axe leaves to a person: one <h1>, a <main>, the skip link as the first tab stop.
 *
 * Needs a running mock server (`npm run build`, then `PORT=4434 CC_DATA=mock npm run start`; a later `--port`
 * wins): reads only, nothing is sent. axe-core comes
 * from node_modules (a devDependency, pinned at the version the lint plugin brings); exit 77 when it or a browser is
 * missing, 0 clean against the baseline, 1 a new violation or a scan that did not finish (timed out, error, nothing
 * to open), 2 bad usage.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { SECTIONS } from '../../src/components/settings/derive';
import { ROUTES } from '../../src/components/shell/routes';
import { ACTIVITY_VIEWS } from '../../src/components/time/views';

import { countsOf, tagOf, verdict, type Baseline, type Found, type PageResult } from './compare';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, 'baseline.json');
const argv = process.argv.slice(2);
const arg = (k: string, d?: string): string | undefined => {
  const i = argv.lastIndexOf(`--${k}`); // the last wins: `npm run test:a11y -- --port N` overrides the script's
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : d;
};

const PORT = arg('port');
if (!PORT) {
  console.error('a11y: pass --port <the mock server>');
  process.exit(2);
}
const BASE = `http://127.0.0.1:${PORT}`;
const THEMES = (arg('theme') ? [arg('theme')!] : ['dark', 'light']) as Array<'dark' | 'light'>;
const ONLY = arg('only');

/** WCAG 2.1 A + AA, and the best-practice rules this app holds itself to (landmarks, one h1, heading order). */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const EXTRA_RULES = ['landmark-one-main', 'page-has-heading-one', 'heading-order', 'region', 'landmark-unique', 'landmark-no-duplicate-main', 'aria-allowed-role', 'empty-heading', 'label-title-only'];

interface Target {
  /** The key in the baseline. */
  id: string;
  path: string;
  /** Opens a state on the loaded page (a panel, a dialog); returns false when the mock has nothing to open. */
  open?: (page: Page) => Promise<boolean>;
}

async function sample(api: string, keys: string[]): Promise<string | null> {
  const first = (v: unknown): string | null => {
    if (Array.isArray(v)) {
      for (const x of v) {
        const r = first(x);
        if (r) return r;
      }
    } else if (v && typeof v === 'object') {
      for (const k of keys) {
        const val = (v as Record<string, unknown>)[k];
        if (typeof val === 'string' && val) return val;
      }
      for (const x of Object.values(v)) {
        const r = first(x);
        if (r) return r;
      }
    }
    return null;
  };
  try {
    const r = await fetch(`${BASE}/api/v1${api}`, { signal: AbortSignal.timeout(30_000) });
    return r.ok ? first(await r.json()) : null;
  } catch {
    return null;
  }
}

const press = async (page: Page, key: string) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(500);
};

/** Click the first visible match; false when there is none. */
async function clickFirst(page: Page, selector: string): Promise<boolean> {
  const el = page.locator(selector).first();
  if (!(await el.isVisible({ timeout: 4000 }).catch(() => false))) return false;
  await el.click();
  await page.waitForTimeout(700);
  return true;
}

async function targets(): Promise<Target[]> {
  const out: Target[] = [];
  for (const r of ROUTES) {
    if (!r.pattern.includes(':')) {
      if (r.pattern !== '/time') out.push({ id: r.pattern, path: r.pattern });
      continue;
    }
    let id: string | null = null;
    if (r.key === 'workItem') id = await sample('/items', ['id']);
    else if (r.key === 'account') id = await sample('/deals', ['accountId', 'id']);
    else if (r.key === 'initiative') id = await sample('/items', ['initiativeId']);
    if (id) out.push({ id: r.pattern, path: r.pattern.replace(/:\w+/, encodeURIComponent(id)) });
  }
  for (const s of SECTIONS) out.push({ id: `/settings?section=${s.id}`, path: `/settings?section=${s.id}` });
  for (const v of ACTIVITY_VIEWS) out.push({ id: `/activity?view=${v.value}`, path: `/activity?view=${v.value}` });
  out.push({ id: '/activity?view=log&show=week', path: '/activity?view=log&show=week' }, { id: '/activity?view=log&review=1', path: '/activity?view=log&review=1' });
  for (const t of ['setup', 'ledger', 'jobs', 'errors', 'spend']) out.push({ id: `/health?tab=${t}`, path: `/health?tab=${t}` });
  for (const step of ['role', 'you', 'priorities', 'sources', 'history', 'review']) {
    // The mock keeps the onboarding draft in memory and resumes on the last step: a reached step is a click in the
    // step list; one not reached yet (disabled) is walked to with Next.
    const open = async (p: Page) => {
      const here = () => p.locator(`[data-testid="step-${step}"][aria-current="step"]`).count();
      for (let k = 0; k < 7 && !(await here()); k++) {
        const tab = p.locator(`[data-testid="step-${step}"]`);
        if (await tab.isEnabled({ timeout: 4000 }).catch(() => false)) await tab.click();
        else if (!(await clickFirst(p, '[data-frame="onboarding"] button:has-text("Next")'))) return false;
        await settle(p);
      }
      return (await here()) > 0;
    };
    out.push({ id: `/onboarding#${step}`, path: '/onboarding', open });
  }
  // Opened states
  out.push({ id: 'state:details-panel', path: '/work', open: (p) => clickFirst(p, '#cc-main [data-row]').then(async (ok) => ok && (await p.locator('#cc-main[data-panel="open"]').count()) > 0) });
  out.push({ id: 'state:palette', path: '/', open: async (p) => (await press(p, 'Meta+k'), (await p.locator('[role="dialog"]').count()) > 0) });
  out.push({ id: 'state:cheatsheet', path: '/', open: async (p) => (await press(p, 'Shift+?'), (await p.locator('[role="dialog"]').count()) > 0) });
  out.push({ id: 'state:assistant-dock', path: '/', open: async (p) => (await press(p, 'Meta+j'), (await p.locator('textarea').count()) > 0) });
  // a row's verbs show once it is selected (the click also opens it in the panel)
  const onRow = async (p: Page, verb: string) => {
    const row = p.locator('#cc-main [data-row]', { has: p.locator(`[data-testid="${verb}"]`) }).first();
    if (!(await row.isVisible({ timeout: 4000 }).catch(() => false))) return false;
    await row.click();
    await row.hover();
    return clickFirst(p, `#cc-main [data-row] [data-testid="${verb}"]:visible`);
  };
  out.push({ id: 'state:composer', path: '/outbox', open: async (p) => (await onRow(p, 'edit')) && (await p.locator('textarea, [contenteditable="true"]').count()) > 0 });
  out.push({ id: 'state:review-prompt', path: '/agents', open: (p) => clickFirst(p, 'button:has-text("Start in Claude")').then(async (ok) => ok && clickFirst(p, 'button:has-text("Review prompt")')) });
  // dismisses one guess in the mock's memory (a server restart puts it back); the toast carries Undo
  out.push({ id: 'state:undo-toast', path: '/triage', open: async (p) => (await onRow(p, 'triage-dismiss')) && (await p.locator('button:has-text("Undo"):visible').count()) > 0 });
  out.push({ id: 'state:review-queue', path: '/triage', open: (p) => clickFirst(p, 'button:has-text("Review")') });
  return ONLY ? out.filter((t) => t.id === ONLY || t.path === ONLY || t.id.startsWith(ONLY)) : out;
}

/** What axe leaves to a person: one h1, a main landmark, the skip link first in the tab order. */
async function ownChecks(page: Page, id: string): Promise<Found[]> {
  const out: Found[] = [];
  const h1 = await page.locator('h1').count();
  if (h1 !== 1) out.push({ rule: 'cc-one-h1', impact: 'moderate', help: `a page has exactly one h1 (found ${h1})`, nodes: ['h1'] });
  if (id.startsWith('/onboarding')) return out; // its own frame: no sidebar, no skip link to pass
  if (!id.startsWith('state:')) {
    // the first tab stop in document order (a page that moved focus on load would make a real Tab start there)
    const first = await page.evaluate(() => {
      const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]';
      const el = Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.tabIndex >= 0 && !e.closest('[hidden],[inert]') && e.getClientRects().length > 0);
      return el ? `${el.tagName.toLowerCase()}${el.getAttribute('href') ?? ''}` : '';
    });
    if (first !== 'a#cc-main') out.push({ rule: 'cc-skip-link', impact: 'serious', help: `the first tab stop is the skip link to #cc-main (got ${first || 'nothing'})`, nodes: ['body'] });
  }
  return out;
}

/** Requests in flight per page (the live-events stream never ends, so it is not counted). */
const inflight = new WeakMap<Page, Set<unknown>>();
function track(page: Page): void {
  const open = new Set<unknown>();
  inflight.set(page, open);
  const counted = (url: string) => url.startsWith(BASE) && !url.includes('/api/v1/events') && !url.includes('/_next/webpack-hmr');
  page.on('request', (r) => counted(r.url()) && open.add(r));
  page.on('requestfinished', (r) => open.delete(r));
  page.on('requestfailed', (r) => open.delete(r));
}

/**
 * The page has painted its data: an h1, no route skeleton, no "Loading…" line, no request in flight and the page's
 * text unchanged for 1.5 s (the mock answers slowly under load; a pulsing live dot never settles a selector).
 */
async function settle(page: Page): Promise<void> {
  await page.waitForSelector('h1', { timeout: 30_000 }).catch(() => undefined);
  const t0 = Date.now();
  let last = '';
  let stableSince = Date.now();
  while (Date.now() - t0 < 45_000) {
    const text = await page
      .evaluate(() => {
        if (document.querySelector('[data-route-skeleton], [data-testid="onboarding-skeleton"]')) return null;
        const t = (document.querySelector('#cc-main, [data-frame="onboarding"]') as HTMLElement | null)?.innerText ?? '';
        return /^\s*Loading\b/m.test(t) ? null : t;
      })
      .catch(() => null);
    if (text === null || text !== last || (inflight.get(page)?.size ?? 0) > 0) {
      last = text ?? '';
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 1500) return;
    await page.waitForTimeout(250);
  }
}

async function scan(ctx: BrowserContext, axeSource: string, t: Target, theme: string): Promise<PageResult> {
  const page = await ctx.newPage();
  track(page);
  try {
    await page.goto(`${BASE}${t.path}${t.path.includes('?') ? '&' : '?'}theme=${theme}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await settle(page);
    if (t.open && !(await t.open(page).catch(() => false))) return { id: t.id, theme, skipped: 'nothing to open in the mock', violations: [] };
    await page.addScriptTag({ content: axeSource });
    const res = await page.evaluate(
      async ({ tags, extra }) => {
        // @ts-expect-error axe is the injected global
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, rules: Object.fromEntries(extra.map((x: string) => [x, { enabled: true }])), resultTypes: ['violations'] });
        // axe's runOnly-by-tag ignores `rules` for rules outside the tags: run those separately
        // @ts-expect-error axe is the injected global
        const r2 = await window.axe.run(document, { runOnly: { type: 'rule', values: extra }, resultTypes: ['violations'] });
        const seen = new Set<string>();
        return [...r.violations, ...r2.violations]
          .filter((v: { id: string }) => (seen.has(v.id) ? false : (seen.add(v.id), true)))
          .map((v: { id: string; impact: string; help: string; nodes: Array<{ target: string[] }> }) => ({ rule: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(' ')) }));
      },
      { tags: TAGS, extra: EXTRA_RULES },
    );
    return { id: t.id, theme, violations: [...res, ...(await ownChecks(page, t.id))] };
  } finally {
    await withTimeout(page.close(), CLOSE_MS).catch(() => undefined);
  }
}

/** One scan's hard bound (load, settle, open, axe); closing a page or context gets its own. */
const SCAN_MS = Number(arg('scan-timeout', '150000'));
const CLOSE_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** One target in its own context, bounded: a hang becomes a "timed out: <target> <theme>" row, never a stalled run. */
async function bounded(browser: Browser, axeSource: string, t: Target, theme: 'dark' | 'light'): Promise<PageResult> {
  let ctx: BrowserContext | undefined;
  try {
    ctx = await withTimeout(browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme }), CLOSE_MS * 3);
    ctx.setDefaultTimeout(20_000); // Playwright's action default is no timeout: a click under an overlay would wait forever
    const work = scan(ctx, axeSource, t, theme);
    work.catch(() => undefined); // a timed-out scan rejects later, once its context is gone
    return await withTimeout(work, SCAN_MS);
  } catch (e) {
    const msg = (e as Error).message;
    const skipped = msg.startsWith('timeout after') ? `timed out: ${t.id} ${theme} (${SCAN_MS / 1000}s)` : `error: ${msg.slice(0, 120)}`;
    return { id: t.id, theme, skipped, violations: [] };
  } finally {
    if (ctx) await withTimeout(ctx.close(), CLOSE_MS).catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const require = createRequire(import.meta.url);
  let axePath: string;
  try {
    axePath = require.resolve('axe-core/axe.min.js');
  } catch {
    console.log('a11y: axe-core is not in node_modules: skipped');
    return 77;
  }
  const axeSource = readFileSync(axePath, 'utf8');
  const browser: Browser | null = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }).catch(() => null));
  if (!browser) {
    console.log('a11y: no browser here: skipped');
    return 77;
  }
  const results: PageResult[] = [];
  const started = Date.now();
  try {
    const list = await targets();
    for (const theme of THEMES) {
      // A fresh context per scan: no storage, open overlay, focus or live poll carries from one page, state or theme
      // into the next. Each scan is bounded; one that runs over is a "timed out" row and the run goes on.
      for (const t of list) {
        const t0 = Date.now();
        const r = await bounded(browser, axeSource, t, theme);
        results.push(r);
        const secs = `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6);
        const tag = tagOf(r);
        console.log(`${tag}  ${theme.padEnd(5)} ${secs} ${t.id.padEnd(40)} ${r.skipped ?? r.violations.map((v) => `${v.rule}×${v.nodes.length}`).join(' ')}`);
      }
    }
  } finally {
    await withTimeout(browser.close(), CLOSE_MS).catch(() => undefined);
  }
  console.log(`a11y: done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  const json = arg('json');
  if (json) writeFileSync(json, JSON.stringify(results, null, 2));

  const now: Baseline = countsOf(results);
  if (argv.includes('--update')) {
    const prev: Baseline = existsSync(BASELINE) && (ONLY || arg('theme')) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
    const merged = Object.fromEntries(Object.entries({ ...prev, ...now }).filter(([, v]) => Object.keys(v).length).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE, `${JSON.stringify(merged, null, 2)}\n`);
    console.log(`a11y: baseline written (${Object.keys(merged).length} pages with a known violation)`);
    return 0;
  }
  const base: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
  // P35-1: a scan that did not finish (timed out, error, nothing to open) fails the run, never drops out of it
  const v = verdict(results, base);
  console.log(v.summary);
  for (const w of v.worse) console.error(`  ✗ ${w}`);
  for (const w of v.stalled) console.error(`  ✗ ${w}`);
  return v.code;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`a11y: ${String((e as Error).message ?? e)}`);
    process.exit(2);
  },
);
