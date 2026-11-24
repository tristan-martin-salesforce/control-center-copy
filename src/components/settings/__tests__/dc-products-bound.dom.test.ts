// @vitest-environment jsdom
/**
 * Post-contract-bounds (26-caps-audit.md, "Contract bounds"): Settings ▸ Time ▸ "Products a DC counts for" has no count
 * bound (the contract's `.max(30)` is lifted), so the row quotes none and every typed product is set.
 */
import { act, createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { $, cleanup, render } from '@/components/composer/__tests__/dom';

const { DcSettings } = await import('../TimeSection');

afterEach(async () => {
  await cleanup();
});

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Settings ▸ Time ▸ DC products', () => {
  it('quotes no bound and sets every product typed, past the old 30', async () => {
    const set = vi.fn();
    const f = { draft: { dcProducts: ['Data 360'] }, changed: () => false, set } as never;
    await render(h(DcSettings, { f, persona: null }));
    expect(document.body.textContent).not.toContain('Up to');

    await type($('[data-testid="t-dc-products"]') as HTMLInputElement, Array.from({ length: 33 }, (_, i) => `Product ${i}`).join(', '));
    expect($('[data-testid="t-dc-products-over"]')).toBeNull();
    expect(document.body.textContent).not.toContain('won’t be saved');
    expect(set).toHaveBeenLastCalledWith('dcProducts', expect.arrayContaining(['Product 32']));
    expect((set.mock.lastCall![1] as string[]).length).toBe(33);
  });
});
