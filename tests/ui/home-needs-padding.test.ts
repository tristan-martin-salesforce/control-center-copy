/**
 * 24-visual-qa, surface 5: Home's Needs-you panel pads its foot like its head. The folded groups ("▸ This week 11 ·
 * Deals 3 · Admin 10") sat on the panel's bottom border (px-4 pt-3, no bottom padding). jsdom has no layout, so this
 * reads the classes the page passes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Home ▸ Needs you panel', () => {
  it('pads top and bottom alike', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/components/home/HomePage.tsx'), 'utf8');
    const cls = /<HomeNeeds className="([^"]+)"/.exec(src)?.[1] ?? '';
    expect(cls.split(' ')).toContain('py-3');
  });
});
