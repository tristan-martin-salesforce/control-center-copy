// @vitest-environment jsdom
/**
 * Caps audit F-13 (26-caps-audit.md): a History entry shows its first four changed fields and "+N more fields", which
 * shows the rest (it showed four, with no way to the others).
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEntry } from '@/contract';
import { $, cleanup, click, render } from '@/components/composer/__tests__/dom';
import { HistoryRow } from '../tabs/HistoryRow';

afterEach(async () => {
  await cleanup();
});

const entry = (n: number): AuditEntry =>
  ({
    id: 'aud_1',
    at: '2026-11-21T09:00:00.000Z',
    actor: 'user',
    action: 'item.edit',
    summary: 'Edited the item',
    entity: { type: 'work_item', id: 'wi_1', label: 'x' },
    related: [],
    changes: [{ field: 'version', before: 1, after: 2 }, ...Array.from({ length: n }, (_, i) => ({ field: `f${i}`, label: `Field ${i}`, before: `a${i}`, after: `b${i}` }))],
    undoable: false,
    undoneAt: null,
    undoOf: null,
  }) as unknown as AuditEntry;

const fields = () => document.querySelectorAll('dt').length;

describe('History ▸ changed fields', () => {
  it('four of seven, then +3 more fields shows all seven (hidden bookkeeping fields stay hidden)', async () => {
    await render(h('ul', null, h(HistoryRow, { e: entry(7), now: '2026-11-21T10:00:00.000Z', tz: 'UTC', onUndo: () => {}, busy: false })));
    expect(fields()).toBe(4);
    const more = $('[data-more-fields]')!;
    expect(more.textContent).toBe('+3 more fields');
    await click(more);
    expect(fields()).toBe(7);
    expect(document.body.textContent).toContain('Field 6');
    expect($('[data-more-fields]')).toBeNull();
  });

  it('four or fewer: no control', async () => {
    await render(h('ul', null, h(HistoryRow, { e: entry(4), now: '2026-11-21T10:00:00.000Z', tz: 'UTC', onUndo: () => {}, busy: false })));
    expect(fields()).toBe(4);
    expect($('[data-more-fields]')).toBeNull();
  });
});
