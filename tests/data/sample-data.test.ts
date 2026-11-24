/**
 * The sample dataset (sample-data/tables/*.json) must load into a read model. One row that fails its contract used to
 * take every page down (tool_adapters keys with underscores and semver versions), so validate each table that has a
 * contract: today the tool adapters, through the exact mapping the database read uses.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ToolAdapter } from '@/contract';
import { adapterFromRow } from '@/server/datasource/db/store/agents';

const DIR = path.resolve(__dirname, '../../sample-data/tables');
const table = (t: string) => JSON.parse(readFileSync(path.join(DIR, `${t}.json`), 'utf8')) as Array<Record<string, unknown>>;
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

describe('sample-data tables', () => {
  it('every table file is a JSON array of rows', () => {
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
      const rows = JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as unknown;
      expect(Array.isArray(rows), f).toBe(true);
    }
  });

  it('every tool_adapters row maps to a valid ToolAdapter', () => {
    const rows = table('tool_adapters');
    expect(rows.length).toBeGreaterThan(0);
    const rc = { kv: new Map() };
    for (const r of rows) {
      const row = Object.fromEntries(Object.entries(r).map(([k, v]) => [camel(k), k.endsWith('_at') && typeof v === 'string' ? new Date(v) : v]));
      let view: ToolAdapter;
      try {
        view = adapterFromRow(rc as never, row as never);
      } catch (e) {
        throw new Error(`tool_adapters ${String(r.key)}: ${(e as Error).message}`);
      }
      expect(ToolAdapter.safeParse(view).success, String(r.key)).toBe(true);
    }
  });
});
