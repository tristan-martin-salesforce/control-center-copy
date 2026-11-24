// @vitest-environment jsdom
/**
 * Caps audit F-13 (26-caps-audit.md): a Needs-you question with more than three answers showed three buttons, so
 * choices 4–9 were reachable only by key and past 9 not at all. Every choice renders: three buttons, then a
 * "More…" menu that lists the rest, and picking one runs the answer with that choice.
 */
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NeedRow } from '@/contract';
import { $, $$, cleanup, render } from '@/components/composer/__tests__/dom';
import { NeedActionRow } from '@/components/needs/NeedActionRow';
import type { QueueRowContext } from '@/components/kit/QueueSection';

afterEach(cleanup);

const choices = Array.from({ length: 11 }, (_, i) => ({ id: `opp${i + 1}`, label: `Opp ${i + 1}` }));
const answer = { id: 'answer', label: 'Answer', kbd: null, primary: true, call: { route: 'decideNeed', params: {}, body: {} }, href: null, choices, undoable: false, feature: null } as const;
const row = {
  id: 'mapping_question:q1',
  kind: 'mapping_question',
  title: 'Which opp is this meeting for?',
  why: 'Three or more opps match',
  who: null,
  account: null,
  opp: null,
  verbs: [answer],
  groupKey: 'today',
  urgency: 0.5,
  since: '2026-11-18T17:00:00.000Z',
  source: null,
  confidence: null,
  estimateMin: null,
} as unknown as NeedRow;
const ctx = { selected: false, live: undefined, liveTone: undefined, rowProps: {}, checked: false, toggle: () => {} } as unknown as QueueRowContext;

describe('NeedActionRow: every answer choice', () => {
  it('three buttons, then a More… menu with the other eight; picking one runs the answer with it', async () => {
    const onRun = vi.fn();
    const { container } = await render(h(NeedActionRow, { row, ctx, onRun, onOpen: () => {} }));
    expect($$('[data-testid="need-choice"]', container).map((b) => b.textContent)).toEqual(['Opp 1', 'Opp 2', 'Opp 3']);
    const more = $('[data-testid="need-choice-more"]', container) as HTMLSelectElement;
    const opts = [...more.options].map((o) => o.textContent);
    expect(opts[0]).toBe('More… (8)');
    expect(opts.slice(1)).toEqual(['4. Opp 4', '5. Opp 5', '6. Opp 6', '7. Opp 7', '8. Opp 8', '9. Opp 9', 'Opp 10', 'Opp 11']);
    await act(async () => {
      more.value = 'opp11';
      more.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onRun).toHaveBeenCalledWith(row, answer, { choiceId: 'opp11', choiceLabel: 'Opp 11' });
  });

  it('three choices or fewer: buttons only, no menu', async () => {
    const few = { ...row, verbs: [{ ...answer, choices: choices.slice(0, 3) }] } as unknown as NeedRow;
    const { container } = await render(h(NeedActionRow, { row: few, ctx, onRun: () => {}, onOpen: () => {} }));
    expect($$('[data-testid="need-choice"]', container)).toHaveLength(3);
    expect($('[data-testid="need-choice-more"]', container)).toBeNull();
  });
});
