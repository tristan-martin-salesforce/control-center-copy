/**
 * Lane E (E1): Health ▸ Needs you says when the worker runs but waits for the database schema, with the command to
 * run, and nothing when it doesn't. Static render, placeholders only.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { HealthPayload } from '@/contract';
import { NeedsYou, waitingCommand } from '@/components/health/NeedsYou';

// the components use the automatic JSX runtime; vitest's transform needs React in scope
(globalThis as { React?: typeof React }).React = React;

const NOW = '2026-11-14T15:00:00.000Z';
const health = (worker: Partial<HealthPayload['worker']>): HealthPayload => ({
  connectors: [],
  summary: { ok: 0, total: 0, worst: 'ok', broken: [] },
  spend: { today: { usd: 0, softBudgetUsd: 5, hardCapUsd: 15, pct: 0 }, state: 'ok', last7d: [], byScanner: [], byModel: [] },
  worker: { alive: true, lastHeartbeatAt: NOW, queueDepth: 0, ...worker },
  dryRun: true,
  firstScan: null,
});
const render = (h: HealthPayload) =>
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(NeedsYou, { h, now: NOW, tz: 'America/Denver', actions: {} as never, onOpen: () => {} })),
  );

describe('Health: a worker waiting for the database (E1)', () => {
  it('shows the waiting card with the message and npm run update', () => {
    const html = render(health({ blocked: { message: 'The worker is waiting: the database is 1 migration behind this build (it has 0023_llm_audit, the build ships 0024_retention_rollups). It claims no jobs until they match.', fix: 'npm run update (or npm run db:migrate)', since: '2026-11-14T14:50:00.000Z' } }));
    expect(html).toContain('data-health-system="schema"');
    expect(html).toContain('The background worker is waiting for the database');
    expect(html).toContain('1 migration behind this build');
    expect(html).toContain('npm run update');
    expect(html).toContain('backs up the database, migrates and restarts both services');
  });

  it('a fix in words (a skipped migration) is shown as words, not a command', () => {
    const html = render(health({ blocked: { message: 'The worker is waiting: 0021_x was never applied.', fix: 'report it (Feedback): the release has to give that migration a newer journal time', since: NOW } }));
    expect(html).toContain('report it (Feedback)');
    expect(waitingCommand('report it (Feedback)')).toBeNull();
    expect(waitingCommand('npm run db:migrate')).toBe('npm run db:migrate');
  });

  it('shows nothing when the worker isn\'t waiting, and the "not running" card when it is down', () => {
    expect(render(health({ blocked: null }))).toBe('');
    expect(render(health({}))).toBe('');
    const down = render(health({ alive: false, blocked: { message: 'x', fix: null, since: NOW } }));
    expect(down).toContain('The background worker stopped');
    expect(down).not.toContain('waiting for the database');
  });
});
