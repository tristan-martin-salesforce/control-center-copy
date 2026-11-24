/**
 * Settings' grid (18-ui-polish.md, 01-ui-audit UI-32): below the effect pane's threshold (EFFECT_RAIL_MIN, 1,360 px of
 * frame) the grid has two columns. A rule placed after the 1,360 one gave every frame from 1,180 px a third, empty
 * 380 px column, which squeezed the form at 1440 with the sidebar open (Connectors' actions clipped to "S").
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(__dirname, '../../src/components/settings/settings.module.css'), 'utf8');

/** Each `@container settings (…)` block's query and its `.grid` columns, in source order. */
function gridRules(): Array<{ query: string; cols: number }> {
  const out: Array<{ query: string; cols: number }> = [];
  const re = /@container settings ([^{]+)\{\s*\.grid\s*\{\s*grid-template-columns:\s*([^;]+);/g;
  for (let m = re.exec(css); m; m = re.exec(css)) out.push({ query: m[1]!.trim(), cols: m[2]!.trim().split(/\s+(?![^(]*\))/).length });
  return out;
}

describe('settings grid columns', () => {
  it('a three-column rule only applies from the effect pane threshold up', () => {
    const rules = gridRules();
    expect(rules.length).toBeGreaterThan(2);
    for (const r of rules) {
      const min = Number(/min-width:\s*(\d+)px/.exec(r.query)?.[1] ?? 0);
      const max = Number(/max-width:\s*(\d+)px/.exec(r.query)?.[1] ?? Infinity);
      if (r.cols === 3) expect(min, r.query).toBeGreaterThanOrEqual(1360);
      if (min < 1360) expect(max, r.query).toBeLessThan(1360);
    }
  });
});
