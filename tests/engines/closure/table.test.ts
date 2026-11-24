/** Every state × signal cell of the closure transition table, and the doc stays in sync with it. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applySignal } from '@/engines/closure/machine';
import { describeDecision } from '@/engines/closure/apply';
import { ROWS, SIGNALS } from './fixtures';
import { COLUMNS, EXPECTED, renderTable } from './transition-table';

describe('closure transition table (DATA-MODEL §4.1 + R-UI-20/22)', () => {
  it('covers every row and column', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(ROWS).sort());
    expect([...COLUMNS].sort()).toEqual(Object.keys(SIGNALS).sort());
  });

  for (const [row, item] of Object.entries(ROWS)) {
    it(`${row}`, () => {
      const actual = Object.fromEntries(COLUMNS.map((c) => [c, describeDecision(applySignal(item, SIGNALS[c]!))]));
      expect(actual).toEqual(EXPECTED[row]);
    });
  }

  it('is rendered verbatim in docs/reference/ENGINES.md §3', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../../docs/reference/ENGINES.md', import.meta.url)), 'utf8');
    expect(doc).toContain(renderTable());
  });
});
