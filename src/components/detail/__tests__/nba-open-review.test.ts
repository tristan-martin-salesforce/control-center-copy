// @vitest-environment jsdom
/**
 * P25-4 (SEC-10): the detail's "Open in Claude" for a session waiting on you goes through `useLaunchReview`. A resume
 * link (claude://code/continue, needs-input) opens on the click; a claude://code/new link (a queued launch) shows Review
 * prompt first and opens only on its Open in Claude.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRun, NbaCard, WorkItem } from '@/contract';
import { createMockDataSource } from '@/server/datasource/mock';
import { $, $$, cleanup, click, render } from '../../composer/__tests__/dom';
import { NbaSection } from '../nba/NbaSection';

let opened: string[] = [];
beforeEach(() => {
  opened = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    opened.push(this.getAttribute('href') ?? '');
  });
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

async function seedItem(): Promise<{ item: WorkItem; nba: NbaCard }> {
  const ds = createMockDataSource({ autoplay: false });
  try {
    const d = await ds.getItem({ params: { id: 'w_dana_reply' } } as never);
    if (!d.nba) throw new Error('the seed item has no NBA');
    return { item: d.item, nba: d.nba };
  } finally {
    ds.dispose();
  }
}

function sessionRun(deepLink: string): AgentRun {
  return {
    id: 'run_p25_4',
    kind: 'claude_session',
    title: 'Refactor the importer',
    state: 'waiting_on_you',
    waiting: { question: 'Which folder?', reason: null, choices: [] },
    deepLink,
  } as unknown as AgentRun;
}

async function renderWith(deepLink: string) {
  const { item, nba } = await seedItem();
  const run = sessionRun(deepLink);
  const props = {
    item,
    nba: { ...nba, verb: 'answer', runId: run.id, confidence: 'sure', alternatives: [] } as NbaCard,
    draft: null,
    runs: [run],
    people: [],
    now: new Date().toISOString(),
    variant: 'sheet' as const,
    onConfirmDone: () => {},
    onSnoozeTomorrow: () => {},
    onOpenUrl: () => {},
    onAskChat: () => {},
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  await render(h(QueryClientProvider, { client: qc }, h(NbaSection, props)));
}

const openButton = () => $$('button').find((b) => b.textContent?.trim() === 'Open in Claude');

describe('NbaSection ▸ Open in Claude (P25-4)', () => {
  it('a resume link opens on the click, with no review', async () => {
    await renderWith('claude://code/continue?session=local_1');
    await click(openButton());
    expect(opened).toEqual(['claude://code/continue?session=local_1']);
    expect($('[data-launch-review]')).toBeNull();
  });

  it('a new-session link is reviewed first and opens only on the dialog’s Open in Claude', async () => {
    const url = `claude://code/new?q=${encodeURIComponent('Refactor the importer.\nFinally: run the tests.')}`;
    await renderWith(url);
    await click(openButton());
    expect(opened).toEqual([]);
    expect($('[data-launch-review]')).not.toBeNull();
    expect($('[data-prompt-whole]')!.textContent).toContain('Finally: run the tests.');
    const confirm = $$('button').filter((b) => b.textContent?.trim() === 'Open in Claude').at(-1);
    await click(confirm);
    expect(opened).toEqual([url]);
  });
});
