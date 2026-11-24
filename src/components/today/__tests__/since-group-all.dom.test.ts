// @vitest-environment jsdom
/**
 * Caps audit F-13 (26-caps-audit.md): a "Since you left" digest group lists eight entries, then "Show all N" lists
 * every one (it stopped at eight while its heading counted all).
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SinceEntry } from '@/contract';
import { $, cleanup, click, render } from '@/components/composer/__tests__/dom';

vi.mock('../ctx', () => ({ useToday: () => ({ tz: 'UTC', openDetails: vi.fn(), actions: { undoAudit: vi.fn() } }) }));

const { SinceGroup } = await import('../AgentPlan');

afterEach(async () => {
  await cleanup();
});

const entries = Array.from({ length: 12 }, (_, i) => ({ kind: 'new', at: `2026-11-21T09:${String(i).padStart(2, '0')}:00.000Z`, title: `Entry ${i}`, ref: { type: 'work_item', id: `wi_${i}` }, auditId: null })) as unknown as SinceEntry[];
const rows = () => document.querySelectorAll('li').length;

describe('Since you left ▸ a group', () => {
  it('eight of twelve, then Show all 12', async () => {
    await render(h(SinceGroup, { label: 'New', entries }));
    expect(document.body.textContent).toContain('New · 12');
    expect(rows()).toBe(8);
    const all = $('[data-since-all]')!;
    expect(all.textContent).toBe('Show all 12');
    await click(all);
    expect(rows()).toBe(12);
    expect(document.body.textContent).toContain('Entry 11');
  });
});
