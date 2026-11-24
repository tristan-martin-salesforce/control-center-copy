// @vitest-environment jsdom
/**
 * Agents polish (18-ui-polish.md): the Runs tab carries no count (the waiting count lives on "All waiting · N" and the
 * sidebar, and "Runs 1" above "Running now 3" read as a mismatch, 01-ui-audit UI-3), and a running row's need line
 * ("✦ in the background · 2 sub-agents") truncates in its column instead of running under the next one (UI-23).
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@/contract';
import { $, $$, cleanup, render } from '@/components/composer/__tests__/dom';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(),
}));

const { AgentsHeader } = await import('@/components/agents/AgentsHeader');
const { RunRow } = await import('@/components/agents/RunRow');

afterEach(cleanup);

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'run_1',
  kind: 'claude_session',
  title: 'Placeholder demo-org build',
  workItemId: null,
  state: 'running',
  startedAt: '2026-11-20T15:00:00.000Z',
  updatedAt: '2026-11-20T15:10:00.000Z',
  finishedAt: null,
  lastEvent: 'Loading profiles (2/6 steps)',
  waiting: null,
  deepLink: 'claude://code/continue?session=s1',
  sessionId: 's1',
  cwd: null,
  bgAgents: 2,
  toolRunId: null,
  progress: null,
  resultUrl: null,
  error: null,
  costUsd: null,
  scheduled: false,
  ...over,
});

describe('Agents runs', () => {
  it('the Runs tab has no count; the tabs are Runs and Tools', async () => {
    const { container } = await render(h(AgentsHeader, { tab: 'runs', sentence: 'About 5m of your time.' }));
    const tabs = $$('[role="tab"]', container).map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Runs', 'Tools']);
  });

  it('a long need line truncates in its column (title shows it whole), beside the verb', async () => {
    const { container } = await render(h(RunRow, { run: run(), now: '2026-11-20T15:13:00.000Z' }));
    const need = $('[data-need]', container)!;
    expect(need.textContent).toContain('in the background · 2 sub-agents');
    expect(need.className).toMatch(/\btruncate\b/);
    expect(need.className).not.toMatch(/\bshrink-0\b/);
    expect(need.getAttribute('title')).toContain('2 sub-agents');
  });
});
