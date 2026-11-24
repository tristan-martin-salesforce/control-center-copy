// @vitest-environment jsdom
/**
 * Caps audit F-13 (26-caps-audit.md, "the most serious one"): the tool-run form rendered only the first six schema
 * fields, so a required seventh was never shown and Run stayed disabled with no way to fill it. Every field renders:
 * a long form keeps its first six and every required field in view and folds the optional rest under "More".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NbaCard, ToolAdapter } from '@/contract';
import { $, $$, cleanup, render } from '@/components/composer/__tests__/dom';

const props = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i + 1}`, { type: 'string', title: `Field ${i + 1}` }]));
const adapter = { manifest: { id: 'big-tool', name: 'Big tool', description: 'Nine inputs', input: { schema: { properties: props, required: ['f1', 'f7'] } } }, health: { state: 'ok' } } as unknown as ToolAdapter;

vi.mock('@/components/today/useSheetQuery', () => ({ useSheetQuery: () => ({ data: { adapters: [adapter], recentRuns: [] }, isLoading: false }) }));

const { ToolRunForm, fieldsOf, splitFields } = await import('@/components/today/parts');

afterEach(cleanup);

describe('tool-run form: every field', () => {
  it('fieldsOf keeps every schema field (no cut at six)', () => {
    expect(fieldsOf(adapter, {}).map((f) => f.key)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9']);
  });

  it('a short form shows everything; seven fields is not worth a fold', () => {
    const seven = fieldsOf(adapter, {}).slice(0, 7);
    expect(splitFields(seven)).toEqual({ shown: seven, more: [] });
  });

  it('renders the required 7th field in view and the optional rest under More; Run waits for both required ones', async () => {
    const nba = { toolAdapterId: 'big-tool', toolInputs: { f1: 'set' } } as unknown as NbaCard;
    const { container } = await render(h(QueryClientProvider, { client: new QueryClient() }, h(ToolRunForm, { nba, onRun: async () => null, onCancel: () => {} })));
    const form = $('form', container)!;
    const more = $('[data-testid="tool-form-more"]', form)!;
    expect(more.textContent).toContain('More (2 optional)');
    expect($$('label', more).map((l) => l.textContent)).toEqual(['Field 8', 'Field 9']);
    const shown = $$('label', form)
      .filter((l) => !more.contains(l))
      .map((l) => l.textContent);
    expect(shown).toEqual(['Field 1 *', 'Field 2', 'Field 3', 'Field 4', 'Field 5', 'Field 6', 'Field 7 *']);
    const run = [...form.querySelectorAll('button')].find((b) => b.textContent?.includes('Run'))!;
    expect(run.disabled).toBe(true); // Field 7 is required and empty: it is on screen to fill
  });
});
