// @vitest-environment jsdom
/**
 * Caps audit F-13 (26-caps-audit.md): the "Changed elsewhere" banner shows every differing span on each side before
 * Keep yours / Take theirs (it showed four a side).
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConflictBanner } from '../DraftProposal';
import { $$, cleanup, render } from './dom';

afterEach(async () => {
  await cleanup();
});

describe('ConflictBanner', () => {
  it('lists all seven of theirs and all six of yours', async () => {
    const diff = [
      ...Array.from({ length: 7 }, (_, i) => [{ op: 'equal', text: ' same ' }, { op: 'delete', text: `theirs-${i}` }]).flat(),
      ...Array.from({ length: 6 }, (_, i) => ({ op: 'insert', text: `yours-${i}` })),
    ];
    await render(h(ConflictBanner, { diff: diff as never, onKeepMine: () => {}, onTakeTheirs: () => {} }));
    const [theirs, yours] = $$('[data-conflict-spans]');
    expect(theirs!.querySelectorAll('li')).toHaveLength(7);
    expect(yours!.querySelectorAll('li')).toHaveLength(6);
    expect(theirs!.textContent).toContain('theirs-6');
  });
});
