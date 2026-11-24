/**
 * P25-8: the crawls name the lane range AGENTS.md and CLAUDE.md give (4345-4399), and the release crawl's default is
 * the app's port (PORT, else 4327), not one lane's.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(path.resolve(__dirname, '../..', p), 'utf8');

describe('crawl ports (P25-8)', () => {
  it('the smoke crawl picks a free port in 4345-4399', () => {
    const src = read('scripts/test/crawl.ts');
    expect(src).toMatch(/LANE_PORTS = \{ from: 4345, to: 4399 \}/);
    expect(src).not.toMatch(/4360/);
    expect(read('AGENTS.md') + read('CLAUDE.md')).toMatch(/4345[–-]4399/);
  });

  it('the release crawl defaults to PORT or 4327, and names no stale lane port', () => {
    const src = read('scripts/qa/crawl.mjs');
    expect(src).toContain("arg('base', `http://localhost:${process.env.PORT || 4327}`)");
    expect(src).not.toMatch(/4352|4360/);
  });
});
