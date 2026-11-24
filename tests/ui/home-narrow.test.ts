/**
 * Home with the Details panel open (01-ui-audit R11, 18-ui-polish.md): under ~900 px of content Home is one reading
 * column instead of three clipped columns. The layout is a `main` container query, so it depends on width only: a
 * background refresh can never switch it under the reader (UX.md "Live updates"). jsdom has no layout, so this reads
 * the rule the browser applies.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(__dirname, '../../src/components/home/home.css'), 'utf8');

/** The body of the `@container main (max-width: Npx)` block for the narrow layout. */
function narrowBlock(): { max: number; body: string } {
  const re = /@container main \(max-width: (\d+)px\) \{\n((?: {2}.*\n)+)\}/g;
  const blocks = [...css.matchAll(re)].map((x) => ({ max: Number(x[1]), body: x[2]! }));
  const narrow = blocks.find((b) => b.body.includes('.hm-lead > :first-child'));
  if (!narrow) throw new Error('no narrow layout block');
  return narrow;
}
const decl = (body: string, sel: string) => body.split('\n').find((l) => l.includes(`${sel} {`)) ?? '';

describe('Home narrow layout (panel open at 1440)', () => {
  it('applies below 900 px of content: the panel open at 1440 leaves ~690 px', () => {
    const { max } = narrowBlock();
    expect(max).toBeLessThan(900);
    expect(max).toBeGreaterThan(1440 - 232 - 520);
  });

  it('stacks: the first card takes the row, the others share the next; the verb columns become one', () => {
    const { body } = narrowBlock();
    expect(decl(body, '.hm-lead')).toMatch(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    expect(decl(body, '.hm-lead > :first-child')).toMatch(/grid-column: 1 \/ -1/);
    expect(decl(body, '.hm-sections')).toMatch(/grid-template-columns: minmax\(0, 1fr\);.*overflow: visible/);
    // the Do now head wraps (capacity on its own line) and a card's tags wrap instead of spilling out of the card
    expect(decl(body, '.hm-lead-head')).toMatch(/flex-wrap: wrap/);
    expect(decl(body, '.hm-card-top')).toMatch(/flex-wrap: wrap/);
    // the page scrolls instead of clipping; every section shows, Chase too
    expect(body).toMatch(/\.cc-home\.cc-home \{ height: auto;/);
    expect(decl(body, '.hm-sec.is-chase')).toMatch(/display: flex/);
  });

  it('outranks the panel-open rules (same id, one more class) and comes after them', () => {
    const panelOpen = css.indexOf('#cc-main[data-panel="open"] .cc-home .hm-sections');
    expect(panelOpen).toBeGreaterThan(0);
    expect(css.indexOf('#cc-main .cc-home.cc-home .hm-sections')).toBeGreaterThan(panelOpen);
  });

  it('reacts to width only: no data attribute in the narrow rules', () => {
    expect(narrowBlock().body).not.toMatch(/\[data-[a-z-]+/);
  });
});
