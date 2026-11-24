// @vitest-environment jsdom
/**
 * 24-visual-qa, surface 7 (the Assistant's tool rows):
 * - A search or read of other people's text (`<source>.search` / `<source>.read`, marked untrusted for the model)
 *   says so on its row: "others’ words", with what that means in its title.
 * - A guard that held something for you ("Not kept (say it in your words)", SEC-8; "Sign-in not started (say which
 *   connector)", SEC-9) is a neutral row, not a red ✕, and the folded line does not count it as failed.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatToolView } from '@/client/chat';
import { $, $$, cleanup, render } from '@/components/composer/__tests__/dom';
import { OTHERS_TEXT_LABEL, readsOthersText, ToolRow } from '@/components/chat/ToolRows';
import { isHeldForYou, toolSummaryLine } from '@/components/chat/thread-model';

const tool = (name: string, summary: string, ok: boolean | null): ChatToolView => ({ id: name, name, startSummary: null, summary, ok });

afterEach(async () => {
  await cleanup();
});

describe('tool rows', () => {
  it('marks reads of other people’s text, and only those', async () => {
    expect(['slack.search', 'gmail.read', 'drive.search', 'ledger.search', 'org62.read'].every(readsOthersText)).toBe(true);
    expect(['home.read', 'db.items', 'work.patch', 'assistant.remember'].some(readsOthersText)).toBe(false);
    await render(h('ol', null, h(ToolRow, { tool: tool('slack.search', '3 threads', true) }), h(ToolRow, { tool: tool('home.read', 'Home', true) })));
    const marks = $$('[data-untrusted]');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe(OTHERS_TEXT_LABEL);
    expect(marks[0]!.title).toMatch(/never takes instructions/);
  });

  it('a held refusal is neutral and not counted as failed', async () => {
    const held = tool('assistant.remember', 'Not kept (say it in your words)', false);
    const broken = tool('slack.search', 'Failed: timeout', false);
    expect(isHeldForYou(held)).toBe(true);
    expect(isHeldForYou(broken)).toBe(false);
    expect(toolSummaryLine([tool('slack.search', '3 threads', true), held]).failed).toBe(0);
    expect(toolSummaryLine([held, broken]).failed).toBe(1);
    await render(h('ol', null, h(ToolRow, { tool: held })));
    expect($('li')!.dataset.ok).toBe('held');
  });

  it('reads the held flag first; the "(say …)" ending is only the fallback for rows without it', async () => {
    const flagged: ChatToolView = { ...tool('assistant.run', 'Sign-in not started', false), held: true };
    expect(isHeldForYou(flagged)).toBe(true);
    expect(isHeldForYou({ ...tool('assistant.run', 'Sign-in not started', false) })).toBe(false); // no flag, no ending
    expect(isHeldForYou({ ...flagged, ok: true })).toBe(false); // a held row is one that did not run
    expect(toolSummaryLine([flagged]).failed).toBe(0);
    await render(h('ol', null, h(ToolRow, { tool: flagged })));
    expect($('li')!.dataset.ok).toBe('held');
  });
});
