// @vitest-environment jsdom
/**
 * 24-visual-qa, surface 6 (Settings ▸ Sending ▸ Trusted sites for asset links, and every ListEditor):
 * removing a site takes its × with it, so focus moves to the chip that took its place (else the one before, else
 * the add field) instead of falling to the page. The row's label sits at the top beside the tall chip list.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement as h, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { $, cleanup, click, render, waitFor } from '@/components/composer/__tests__/dom';
import { ListEditor } from '@/components/settings/ClosingSection';

function Harness({ start }: { start: string[] }) {
  const [values, setValues] = useState(start);
  return h(ListEditor, { label: 'Trusted sites', values, saved: start, placeholder: 'A site', empty: 'No sites', normalise: (v: string) => v.trim() || null, onChange: setValues });
}

const remove = (host: string) => $(`[aria-label="Remove ${host}"]`);

afterEach(async () => {
  await cleanup();
});

describe('ListEditor: focus after Remove', () => {
  it('goes to the next chip, then the one before, then the add field', async () => {
    await render(h(Harness, { start: ['a.com', 'b.com', 'c.com'] }));
    remove('a.com')!.focus();
    await click(remove('a.com'));
    await waitFor(() => (document.activeElement === remove('b.com') ? true : null));

    remove('c.com')!.focus();
    await click(remove('c.com'));
    await waitFor(() => (document.activeElement === remove('b.com') ? true : null));

    await click(remove('b.com'));
    await waitFor(() => (document.activeElement === $('input[aria-label="Add to Trusted sites"]') ? true : null));
  });

  it('has no count bound: a 51st entry is added (post-contract-bounds; the lists were held at 50)', async () => {
    const start = Array.from({ length: 50 }, (_, i) => `s${i}.com`);
    await render(h(Harness, { start }));
    const input = $('input[aria-label="Add to Trusted sites"]') as HTMLInputElement;
    expect(input.disabled).toBe(false);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'new.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Add'));
    await waitFor(() => remove('new.com'));
    expect(document.body.textContent).not.toContain('the most this list holds');
  });

  it('the trusted sites row aligns its label to the top', () => {
    const src = readFileSync(path.join(__dirname, '..', 'BasicSections.tsx'), 'utf8');
    expect(src).toMatch(/<Row top label="Trusted sites for asset links"/);
    expect(src).not.toMatch(/Apply or push/);
  });
});
