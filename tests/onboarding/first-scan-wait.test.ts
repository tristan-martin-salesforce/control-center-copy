/**
 * B-079 / B-080: the wait for the first scan, made clear. The worker's first-scan config (the onboarding choice, env
 * over it), the catch-up bridge (worker → catch-up.json → Health's connectors: `catching_up` + `catchUpPct`, so the
 * sidebar pulse and Today's "Catching up" line work), and the banner and <FillingIn> while it runs. Placeholders only.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { queryKey } from '@/client/api';
import { durationText, firstScanMinutes, type Connector, type FirstScanProgress, type HealthPayload } from '@/contract';
import { FillingIn, FillingInView } from '@/components/shell/FillingIn';
import { FirstScanBanner } from '@/components/shell/FirstScanBanner';
import { firstScanView } from '@/components/shell/first-scan';
import { pulseFor } from '@/components/shell/ScannerPulse';
import { FakeClock } from '@/scanner/runtime/clock';
import { slackSpec } from '@/scanner/runtime/connectors';
import { FirstScan, MemoryFirstScanLedger } from '@/scanner/runtime/first-scan';
import { ScannerRuntime } from '@/scanner/runtime/scanner-runtime';
import { InMemoryScannerStore } from '@/scanner/store-memory';
import { applyCatchUp, CATCH_UP_FRESH_MS, readCatchUpFile, writeCatchUpFile } from '@/server/datasource/db/catch-up';
import { firstScanConfigFrom, onboardingDraftPending } from '@/worker/first-scan-config';
import { ScriptedSkillRunner } from '../scanner/runtime/helpers/scripted-runner';
import { PROFILE } from '../scanner/runtime/helpers/world';

// vitest compiles the components' JSX with the classic runtime (Next uses the automatic one)
(globalThis as { React?: typeof React }).React = React;

const NOW = new Date('2026-11-06T15:00:00.000Z');
const MIN = 60_000;

const progress = (o: Partial<FirstScanProgress> = {}, scopes: Array<[string, 'pending' | 'done', number | null]> = []): FirstScanProgress => ({
  status: 'active',
  lookbackDays: 30,
  startedAt: NOW.toISOString(),
  floorAt: new Date(NOW.getTime() - 30 * 86_400_000).toISOString(),
  budgetUsd: 100,
  spentUsd: 3,
  doneAt: null,
  scopes: scopes.map(([scope, status, coveredPct]) => ({ scope, connector: scope.split(':')[0]!, status, floorAt: NOW.toISOString(), coveredPct, replans: 0, joinedAt: null, spentUsd: 0 })),
  ...o,
});

const conn = (id: string, name: string, state: Connector['state'] = 'ok'): Connector => ({
  id,
  label: name === 'gemini_notes' ? 'Gemini notes' : name[0]!.toUpperCase() + name.slice(1),
  source: 'slack',
  state,
  since: NOW.toISOString(),
  lastSuccessAt: NOW.toISOString(),
  cursor: { label: name, at: NOW.toISOString() },
  backlog: 0,
  itemsToday: 0,
  catchUpPct: null,
  lastError: null,
  impact: null,
  reauth: null,
  affects: [],
});

describe('the worker reads the onboarding choice (env and flags still override)', () => {
  it('lookback and budget from onboarding; each env field over its own; flags over env; 0 = off; nothing = 30 days, $25', () => {
    const choice = { lookbackDays: 7, budgetUsd: 25 };
    expect(firstScanConfigFrom(choice, {}, [])).toMatchObject({ lookbackDays: 7, budgetUsd: 25, connectors: ['slack', 'gmail', 'drive', 'gemini_notes', 'org62', 'calendar'] });
    expect(firstScanConfigFrom(choice, { CC_FIRST_SCAN_LOOKBACK_DAYS: '14' }, [])).toMatchObject({ lookbackDays: 14, budgetUsd: 25 });
    expect(firstScanConfigFrom(choice, { CC_FIRST_SCAN_BUDGET_USD: '60' }, [])).toMatchObject({ lookbackDays: 7, budgetUsd: 60 });
    expect(firstScanConfigFrom(choice, { CC_FIRST_SCAN_LOOKBACK_DAYS: '14' }, ['--lookback-days=2'])).toMatchObject({ lookbackDays: 2 });
    expect(firstScanConfigFrom(choice, { CC_FIRST_SCAN_CONNECTORS: 'slack,gmail' }, [])).toMatchObject({ lookbackDays: 7, connectors: ['slack', 'gmail'] });
    expect(firstScanConfigFrom(choice, { CC_FIRST_SCAN_LOOKBACK_DAYS: '0' }, [])).toBeUndefined();
    expect(firstScanConfigFrom({ lookbackDays: 0, budgetUsd: 25 }, {}, [])).toBeUndefined();
    expect(firstScanConfigFrom(null, {}, [])).toMatchObject({ lookbackDays: 30, budgetUsd: 25 });
    // a blank env line is unset, not 0
    expect(firstScanConfigFrom(choice, { CC_FIRST_SCAN_LOOKBACK_DAYS: '' }, [])).toMatchObject({ lookbackDays: 7 });
  });

  it("waits for the record only while this database's onboarding draft is on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-fsw-'));
    try {
      const file = join(dir, 'onboarding.json');
      expect(onboardingDraftPending('db_a', file)).toBe(false);
      writeFileSync(file, JSON.stringify({ version: 1, database: 'db_a' }));
      expect(onboardingDraftPending('db_a', file)).toBe(true);
      expect(onboardingDraftPending('db_b', file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('catch-up: worker → catch-up.json → connectors', () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'cc-cu-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('the worker writes 0600 JSON; the web reads it only from its state folder (never the real one under vitest)', () => {
    const file = join(dir, 'catch-up.json');
    writeCatchUpFile({ slack: 41.6, gmail: 100, bogus: Number.NaN }, NOW, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, at: NOW.toISOString(), connectors: { slack: 42, gmail: 100 } });
    expect(readCatchUpFile({ VITEST: 'true', CC_STATE_DIR: dir })).toMatchObject({ connectors: { slack: 42 } });
    expect(readCatchUpFile({ VITEST: 'true' })).toBeNull();
  });

  it('a healthy connector with a plan under way reads catching_up with its percent; broken ones keep their state; stale or done = nothing', () => {
    const list = [conn('c1', 'slack'), conn('c2', 'gmail'), conn('c3', 'org62', 'auth_needed'), conn('c4', 'drive')];
    const names = ['slack', 'gmail', 'org62', 'drive'];
    const file = { v: 1 as const, at: NOW.toISOString(), connectors: { slack: 40, gmail: 100, org62: 10 } };
    const out = applyCatchUp(list, names, file, new Date(NOW.getTime() + 30_000));
    expect(out.map((c) => [c.state, c.catchUpPct])).toEqual([
      ['catching_up', 40],
      ['ok', null],
      ['auth_needed', null],
      ['ok', null],
    ]);
    expect(applyCatchUp(list, names, file, new Date(NOW.getTime() + CATCH_UP_FRESH_MS + 1))).toBe(list);
    expect(applyCatchUp(list, names, null, NOW)).toBe(list);
    // a row named by its label falls back to its kind (Claude sessions: kind claude)
    const byKind = applyCatchUp([conn('c5', 'Claude sessions')], [['Claude sessions', 'claude']], { ...file, connectors: { claude_sessions: 30 } }, NOW);
    expect(byKind[0]).toMatchObject({ state: 'catching_up', catchUpPct: 30 });
    // the sidebar pulse reads it
    expect(pulseFor(out, NOW, 'open')).toMatchObject({ tone: 'catching', label: expect.stringMatching(/Catching up · Slack 40%/) });
  });

  it('catching_up is set during a first scan: the runtime reports the plan, the overlay marks the connector', async () => {
    const clock = new FakeClock(NOW.toISOString());
    const store = new InMemoryScannerStore({ clock, profile: structuredClone(PROFILE) });
    const fs = new FirstScan({ lookbackDays: 7, budgetUsd: 25, connectors: ['slack'] }, new MemoryFirstScanLedger());
    const spec = slackSpec({ mcpServers: () => ({}), autoRecord: undefined, triage: undefined, scopes: () => ['inbox'] });
    const runtime = new ScannerRuntime({ store, runner: new ScriptedSkillRunner(async () => {}), specs: [spec], clock, reevaluate: async () => {}, firstScan: fs });
    const jobs = await runtime.planJobs(NOW);
    expect(jobs.some((j) => j.kind === 'scan' && j.budget === 'first_scan')).toBe(true);
    const pct = await runtime.catchUpProgress();
    expect(pct.slack).toBe(0);
    const file = join(dir, 'catch-up.json');
    writeCatchUpFile(pct, NOW, file);
    const back = readCatchUpFile({ VITEST: 'true', CC_STATE_DIR: dir });
    const [slack] = applyCatchUp([conn('c1', 'slack')], ['slack'], back, NOW);
    expect(slack).toMatchObject({ state: 'catching_up', catchUpPct: 0 });
  });
});

describe('the first scan as the shell shows it', () => {
  const scopes: Array<[string, 'pending' | 'done', number | null]> = [
    ['slack:inbox', 'pending', 25],
    ['org62:opps', 'pending', 60],
    ['org62:events', 'done', 100],
    ['calendar:primary', 'done', 100],
    ['gmail:inbox', 'pending', null],
  ];

  it('per source (scopes averaged), slowest first; nothing once done', () => {
    const v = firstScanView(progress({}, scopes), NOW.getTime() + 60 * MIN)!;
    expect(v.sources.map((s) => [s.label, s.pct, s.done])).toEqual([
      ['Gmail', 0, false],
      ['Slack', 25, false],
      ['Org62', 80, false],
      ['Calendar', 100, true],
    ]);
    expect(v.pct).toBe(57);
    expect(firstScanView(progress({ status: 'done' }, scopes), NOW.getTime())).toBeNull();
    expect(firstScanView(progress({}, scopes.map(([s]) => [s, 'done', 100])), NOW.getTime())).toBeNull();
    expect(firstScanView(null, NOW.getTime())).toBeNull();
  });

  it('time left: the slowest source on its own pace; before any pace, the measured duration of the lookback', () => {
    const early = firstScanView(progress({}, [['slack:inbox', 'pending', null]]), NOW.getTime() + 2 * MIN)!;
    expect(early.leftMs).toBe((firstScanMinutes(30) - 2) * MIN);
    expect(early.leftText).toBe(`${durationText(firstScanMinutes(30) - 2)} left`);
    // 25% in after an hour: three more hours
    const paced = firstScanView(progress({}, [['slack:inbox', 'pending', 25], ['gmail:inbox', 'pending', 90]]), NOW.getTime() + 60 * MIN)!;
    expect(paced.leftMs).toBe(180 * MIN);
    expect(paced.fillingText).toBe('Filling in, about 3 h left');
    const late = firstScanView(progress({ lookbackDays: 7 }, [['slack:inbox', 'pending', 5]]), NOW.getTime() + 120 * MIN)!;
    expect([late.leftMs, late.leftText]).toEqual([null, 'taking longer than usual']);
    const spent = firstScanView(progress({ status: 'exhausted' }, [['slack:inbox', 'pending', 50]]), NOW.getTime() + 60 * MIN)!;
    expect([spent.exhausted, spent.leftMs, spent.fillingText]).toEqual([true, null, 'Filling in, under your daily cap now']);
  });

  const health = (fs: FirstScanProgress | null): HealthPayload => ({
    connectors: [],
    summary: { ok: 0, total: 0, worst: 'ok', broken: [] },
    spend: { today: { usd: 0, softBudgetUsd: 5, hardCapUsd: 15, pct: 0 }, state: 'ok', last7d: [], byScanner: [], byModel: [] },
    worker: { alive: true, lastHeartbeatAt: NOW.toISOString(), queueDepth: 0 },
    dryRun: true,
    firstScan: fs,
  });
  const render = (fs: FirstScanProgress | null, el: ReturnType<typeof createElement>) => {
    const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
    qc.setQueryData(queryKey('getHealth'), health(fs));
    return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, el));
  };
  const running = () => progress({ startedAt: new Date(Date.now() - 60 * MIN).toISOString() }, [['slack:inbox', 'pending', 25], ['calendar:primary', 'done', 100]]);

  it('the banner shows while it runs: progress, per source, time left and why to wait; nothing otherwise', () => {
    const html = render(running(), createElement(FirstScanBanner));
    expect(html).toContain('data-testid="first-scan-banner"');
    expect(html).toMatch(/First scan 63% · about 3 h left\./);
    expect(html).toContain('Items may be missing or look undone until it finishes.');
    expect(html).toMatch(/data-source="slack"/);
    // the slowest unfinished sources by name, the finished ones counted
    expect(html).not.toMatch(/data-source="calendar"/);
    expect(html).toMatch(/data-testid="first-scan-done"[^>]*>.*1 done/);
    expect(render(null, createElement(FirstScanBanner))).toBe('');
    expect(render(progress({ status: 'done' }, [['slack:inbox', 'done', 100]]), createElement(FirstScanBanner))).toBe('');
  });

  it('<FillingIn> replaces the empty state while it runs, and is the page’s own empty state otherwise', () => {
    const empty = createElement('p', null, 'Nothing needs you right now.');
    const filling = render(running(), createElement(FillingIn, { variant: 'panel' }, empty));
    expect(filling).toContain('Filling in, about 3 h left');
    expect(filling).toContain('reading 30 days of history (63% so far)');
    expect(filling).not.toContain('Nothing needs you');
    expect(render(null, createElement(FillingIn, { variant: 'panel' }, empty))).toBe('<p>Nothing needs you right now.</p>');
    const v = firstScanView(running(), Date.now())!;
    expect(renderToStaticMarkup(createElement(FillingInView, { v, variant: 'note' }))).toContain('Filling in, about 3 h left.');
    expect(renderToStaticMarkup(createElement(FillingInView, { v, variant: 'line' }))).toContain('Items may be missing');
  });
});
