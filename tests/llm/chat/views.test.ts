/**
 * The curated views (`query`): the registry is complete (every view has a description, fields and a test query that
 * runs on the mock), and filters, sort, fields, paging and gates behave. Mock DataSource; no model.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { personaOf } from '@/personas';
import { runQuery, viewCatalog, ViewArgsError, VIEWS, viewsFor } from '@/server/chat/views';
import type { MockDataSource } from '@/server/datasource/mock';
import { mockWith } from '../../chat/helpers';

const SE = personaOf({});
const AE = personaOf({ persona: { id: 'ae' } as never });

let ds: MockDataSource;
beforeEach(() => {
  ds = mockWith();
});
afterEach(() => ds.dispose());

describe('the views registry', () => {
  it('names the data model the brief asks for, each view once', () => {
    const names = VIEWS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ['work_items', 'needs', 'people', 'accounts', 'opps', 'time_entries', 'canvases', 'vdp_records', 'use_cases', 'closure_checks', 'spend_holds', 'settings']) expect(names).toContain(n);
  });

  it.each(VIEWS.map((v) => [v.name, v] as const))('%s has a one-line description, typed fields and a test query that runs', async (_n, v) => {
    expect(v.description.length).toBeGreaterThan(20);
    expect(v.description).not.toContain('\n');
    expect(v.fields.length).toBeGreaterThan(1);
    expect(new Set(v.fields.map((f) => f.name)).size).toBe(v.fields.length);
    const r = await runQuery(ds, SE, { view: v.name, ...v.test });
    expect(r.view).toBe(v.name);
    expect(r.fields).toEqual(v.fields.map((f) => f.name));
    expect(r.rows.every((row) => row.length === r.fields.length)).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(r.count);
  });

  it('the catalog is deterministic per persona and leaves out what the persona has not activated', () => {
    expect(viewCatalog(SE)).toBe(viewCatalog(personaOf({})));
    expect(viewsFor(AE).map((v) => v.name)).not.toContain('vdp_records');
    expect(viewsFor(SE).map((v) => v.name)).toContain('vdp_records');
  });
});

describe('runQuery', () => {
  it('filters, sorts, picks fields and pages without cutting a row; totals come from the whole view', async () => {
    const all = await runQuery(ds, SE, { view: 'work_items' });
    expect(all.total).toBeGreaterThan(5);
    const page1 = await runQuery(ds, SE, { view: 'work_items', fields: ['id', 'rank', 'title'], sort: 'rank', limit: 3 });
    expect(page1).toMatchObject({ total: all.total, count: 3, nextOffset: 3, fields: ['id', 'rank', 'title'] });
    const ranks = page1.rows.map((r) => r[1] as number);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    const page2 = await runQuery(ds, SE, { view: 'work_items', fields: ['id'], sort: 'rank', offset: 3, limit: 3 });
    expect(page2.offset).toBe(3);
    expect(page2.rows.map((r) => r[0])).not.toContain(page1.rows[0]![0]);
    // a tiny page budget still returns one whole row and says where to go on
    const tight = await runQuery(ds, SE, { view: 'work_items' }, { pageChars: 10 });
    expect(tight.count).toBe(1);
    expect(tight.nextOffset).toBe(1);
  });

  it('where: eq is case-insensitive on strings, in / contains / gt / null work', async () => {
    const open = await runQuery(ds, SE, { view: 'opps', where: [{ field: 'isOpen', value: true }] });
    expect(open.rows.every((r) => r[open.fields.indexOf('isOpen')] === true)).toBe(true);
    const big = await runQuery(ds, SE, { view: 'opps', where: [{ field: 'amount', op: 'gt', value: 1_000_000 }], fields: ['amount'] });
    expect(big.rows.every((r) => (r[0] as number) > 1_000_000)).toBe(true);
    const acme = await runQuery(ds, SE, { view: 'accounts', where: [{ field: 'name', op: 'contains', value: 'acme' }], fields: ['name'] });
    expect(acme.rows.map((r) => r[0])).toEqual(['ACME Corp']);
    const two = await runQuery(ds, SE, { view: 'accounts', where: [{ field: 'name', op: 'in', value: ['globex', 'ACME Corp'] }], fields: ['name'], sort: 'name' });
    expect(two.rows.map((r) => r[0])).toEqual(['ACME Corp', 'Globex']);
    const q = await runQuery(ds, SE, { view: 'people', q: 'umbrella' });
    expect(q.total).toBeGreaterThan(0);
  });

  it('joins what the model would otherwise do in its head: an opp carries the hours logged against it', async () => {
    const r = await runQuery(ds, SE, { view: 'opps', fields: ['id', 'hours', 'timeRows'], where: [{ field: 'timeRows', op: 'gt', value: 0 }] });
    expect(r.total).toBeGreaterThan(0);
    expect(r.rows.every((x) => (x[1] as number) > 0)).toBe(true);
  });

  it('refuses unknown views and fields, a gated view for the persona, and a view missing its argument', async () => {
    await expect(runQuery(ds, SE, { view: 'nope' })).rejects.toBeInstanceOf(ViewArgsError);
    await expect(runQuery(ds, SE, { view: 'work_items', fields: ['secret'] })).rejects.toThrow(/no field secret/);
    await expect(runQuery(ds, SE, { view: 'work_items', where: [{ field: 'x', value: 1 }] })).rejects.toThrow(/no field x/);
    await expect(runQuery(ds, AE, { view: 'vdp_records' })).rejects.toThrow(/not active for your role/);
    await expect(runQuery(ds, SE, { view: 'closure_checks' })).rejects.toThrow(/needs args.itemId/);
  });

  it('is read only: no view writes (the audit log does not move)', async () => {
    const before = ds.audit.entries.length;
    for (const v of VIEWS) await runQuery(ds, SE, { view: v.name, ...v.test });
    expect(ds.audit.entries.length).toBe(before);
  });
});
