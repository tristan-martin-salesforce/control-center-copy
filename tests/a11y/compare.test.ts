import { describe, expect, it } from 'vitest';

import { tagOf, verdict, type PageResult } from './compare';

const ok = (id: string, theme = 'dark'): PageResult => ({ id, theme, violations: [] });
const viol = (id: string, rule: string, n: number): PageResult => ({ id, theme: 'dark', violations: [{ rule, impact: 'serious', help: '', nodes: Array.from({ length: n }, (_, i) => `#n${i}`) }] });

describe('axe verdict (P35-1)', () => {
  it('a clean run against the baseline exits 0', () => {
    const v = verdict([ok('/'), viol('/work', 'region', 2)], { 'dark /work': { region: 2 } });
    expect(v.code).toBe(0);
    expect(v.worse).toEqual([]);
    expect(v.stalled).toEqual([]);
  });

  it('a new violation exits 1', () => {
    const v = verdict([viol('/work', 'region', 3)], { 'dark /work': { region: 2 } });
    expect(v.code).toBe(1);
    expect(v.worse).toEqual(['dark /work: region 3 (baseline 2)']);
  });

  it('a timed-out scan is a failure: listed, counted in the summary, exit 1', () => {
    const tout: PageResult = { id: '/', theme: 'dark', skipped: 'timed out: / dark (150s)', violations: [] };
    expect(tagOf(tout)).toBe('tout');
    const v = verdict([tout, ok('/work')], {});
    expect(v.code).toBe(1);
    expect(v.worse).toEqual([]);
    expect(v.stalled).toEqual(['dark /: not scanned (timed out: / dark (150s))']);
    expect(v.summary).toContain('1 not scanned');
  });

  it('every page timing out never reads as a pass', () => {
    const all = ['/', '/work', '/triage'].map((id): PageResult => ({ id, theme: 'light', skipped: `timed out: ${id} light (1s)`, violations: [] }));
    const v = verdict(all, {});
    expect(v.code).toBe(1);
    expect(v.stalled).toHaveLength(3);
    expect(v.summary).toBe('a11y: 3 scans, 0 violating nodes, 0 new, 3 not scanned');
  });

  it('an error or nothing-to-open skip fails too (there is no deliberate skip list)', () => {
    const err: PageResult = { id: '/x', theme: 'dark', skipped: 'error: net::ERR', violations: [] };
    const none: PageResult = { id: 'state:palette', theme: 'dark', skipped: 'nothing to open in the mock', violations: [] };
    expect(tagOf(err)).toBe('skip');
    expect(verdict([err], {}).code).toBe(1);
    expect(verdict([none], {}).code).toBe(1);
  });
});
