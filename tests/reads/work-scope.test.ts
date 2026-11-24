/**
 * The Work list scope, the pure parts (post-2.0, 15-page-reads.md "Work list scope"): what the `work` scope loads,
 * which path a list query takes (counts in SQL, the Closed page in SQL), the additive paging of the payload, and WL-3
 * (a failed window query reads every item instead of failing the page).
 */
import { describe, expect, it } from 'vitest';

import type { ItemsPayload } from '../../src/contract';
import type { CollectionName } from '../../src/server/datasource/db/model';
import { pageList } from '../../src/server/datasource/db/reads/page';
import { planOf, scopeLabel, workScope } from '../../src/server/datasource/db/reads/scope';
import { countsInSql, pagedInSql, workListIds } from '../../src/server/datasource/db/reads/work-list';

describe('the work scope', () => {
  it('loads the items and what their rows show (refs, meetings, stale marks), never drafts, evidence or the ledgers', () => {
    const c = planOf(workScope({ tab: 'all_open' })).collections!;
    for (const x of ['workItems', 'accounts', 'opps', 'initiatives', 'events', 'connectors', 'people'] as CollectionName[]) expect(c.has(x)).toBe(true);
    for (const x of ['drafts', 'evidence', 'nbas', 'activity', 'jobs', 'scanRuns', 'chatThreads', 'agentRuns'] as CollectionName[]) expect(c.has(x)).toBe(false);
    expect(planOf(workScope({ tab: 'all_open' })).extras.size).toBe(0);
    expect(scopeLabel(workScope({ tab: 'done', q: 'x' }))).toBe('work');
  });

  it('equal queries make equal scopes (undefined fields dropped)', () => {
    expect(workScope({ tab: 'done', account: undefined })).toEqual({ kind: 'work', list: { tab: 'done' } });
  });

  it('text and source take the superset path; the Closed tab pages in SQL only on the exact path', () => {
    expect(countsInSql({ tab: 'all_open', account: 'a', kind: 'ask' })).toBe(true);
    expect(countsInSql({ tab: 'all_open', q: '' })).toBe(true);
    expect(countsInSql({ tab: 'all_open', q: 'x' })).toBe(false);
    expect(countsInSql({ tab: 'all_open', source: 'slack' })).toBe(false);
    expect(pagedInSql({ tab: 'done', limit: 50 })).toBe(true);
    expect(pagedInSql({ tab: 'done' })).toBe(false);
    expect(pagedInSql({ tab: 'all_open', limit: 50 })).toBe(false);
    expect(pagedInSql({ tab: 'done', limit: 50, q: 'x' })).toBe(false);
  });

  it('WL-3: a failed window query is null (the model reads every item), never an empty list', async () => {
    const db = { execute: () => Promise.reject(new Error('boom')) } as never;
    await expect(workListIds(db, 'u', { tab: 'all_open' })).resolves.toBeNull();
  });
});

describe('Work list paging (additive)', () => {
  const view: ItemsPayload = {
    tab: 'done',
    items: [1, 2, 3, 4, 5].map((n) => ({ id: `w${n}` })) as never,
    counts: { all_open: 0, said_by_me: 0, asked_of_me: 0, promises: 0, trainings: 0, snoozed: 0, done: 5 },
    total: 5,
  };

  it('no limit: the payload as it was (no nextCursor)', () => {
    expect(pageList(view, {})).toBe(view);
  });

  it('limit pages through every row; counts and total stay whole', () => {
    const a = pageList(view, { limit: 2 });
    expect(a.items.map((i) => i.id)).toEqual(['w1', 'w2']);
    expect(a.total).toBe(5);
    const b = pageList(view, { limit: 2, cursor: a.nextCursor! });
    const c = pageList(view, { limit: 2, cursor: b.nextCursor! });
    expect([...b.items, ...c.items].map((i) => i.id)).toEqual(['w3', 'w4', 'w5']);
    expect(c.nextCursor).toBeNull();
    expect(c.counts).toEqual(view.counts);
  });
});
