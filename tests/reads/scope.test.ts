/**
 * p4-page-scoped-reads, the pure parts: what each scope loads, the briefing window (RD-1), the shared model's
 * coverage, the scope-miss retry, the kill switch, Deals paging (RD-3) and the query log's table parser.
 */
import { describe, expect, it } from 'vitest';

import { ReadModel, type CollectionName } from '../../src/server/datasource/db/model';
import { pageOf } from '../../src/server/datasource/db/reads/page';
import { tablesOf } from '../../src/server/datasource/db/reads/query-log';
import { briefingWindow } from '../../src/server/datasource/db/reads/rows';
import { accountScope, activityScope, AGENTS, BRIEFING, DEALS, everything, HEALTH, historyScope, itemScope, NEEDS, OUTBOX, planOf, ScopeMissError, scopesOff, scopeStrict, TRIAGE, VDP, type ReadScope } from '../../src/server/datasource/db/reads/scope';
import { covers, readScoped } from '../../src/server/datasource/db/reads/session';

const DAY = 86_400_000;
const cols = (s: ReadScope) => planOf(s).collections;

describe('scopes', () => {
  it('Home / Today load the briefing: open work, its meetings, cards and drafts, never the ledgers or chat', () => {
    const c = cols(BRIEFING)!;
    for (const x of ['workItems', 'evidence', 'nbas', 'events', 'drafts', 'proposals', 'activity', 'briefs', 'connectors'] as CollectionName[]) expect(c.has(x)).toBe(true);
    for (const x of ['jobs', 'scanRuns', 'eventLog', 'chatThreads', 'toolAdapters', 'policyVersions', 'watches'] as CollectionName[]) expect(c.has(x)).toBe(false);
    expect(planOf(BRIEFING).extras.has('spend')).toBe(true);
    expect(BRIEFING).toEqual({ kind: 'briefing', openWork: true, days: 14 });
  });

  it('every page scope leaves out what its page does not render', () => {
    expect([...cols(activityScope('ledger'))!].sort()).toEqual(['activity', 'people']);
    expect([...cols(HEALTH)!].sort()).toEqual(['connectors', 'people', 'workItems']);
    expect(cols(OUTBOX)!.has('events')).toBe(false);
    expect(cols(OUTBOX)!.has('activity')).toBe(false);
    expect(cols(DEALS)!.has('events')).toBe(false);
    expect(cols(VDP)!.has('workItems')).toBe(false);
    expect(cols(TRIAGE)!.has('drafts')).toBe(false);
    expect(cols(itemScope('x'))!.has('activity')).toBe(false);
    expect(cols(accountScope('x'))!.has('drafts')).toBe(false);
    expect(cols(historyScope({ month: '2026-11' }))!.has('nbas')).toBe(false);
    expect([...cols(AGENTS)!].sort()).toEqual(['agentRuns', 'people', 'toolAdapters', 'toolRuns']);
    for (const s of [TRIAGE, OUTBOX, DEALS, VDP, AGENTS, activityScope('log')]) expect(planOf(s).extras.has('spend')).toBe(false);
  });

  it('the Needs queue and writers load every collection (null), by name', () => {
    expect(cols(NEEDS)).toBeNull();
    expect(cols(everything('write: item.done'))).toBeNull();
  });

  it('history carries the month or the day it shows (its window), never both', () => {
    expect(historyScope({ month: '2026-10' })).toEqual({ kind: 'activity', view: 'history', month: '2026-10' });
    expect(historyScope({ day: '2026-10-03', month: '2026-10' })).toEqual({ kind: 'activity', view: 'history', day: '2026-10-03' });
  });
});

describe('briefing window (RD-1)', () => {
  const now = new Date('2026-11-20T15:00:00Z');
  it('± days around now', () => {
    const w = briefingWindow(now, 14, null);
    expect(w.from.getTime()).toBe(now.getTime() - 14 * DAY);
    expect(w.to.getTime()).toBe(now.getTime() + 14 * DAY);
  });
  it('starts at the last-active time when the user was away longer (closed since you left stays whole)', () => {
    const away = new Date(now.getTime() - 30 * DAY).toISOString();
    expect(briefingWindow(now, 14, away).from.toISOString()).toBe(away);
    // a recent return never narrows it
    expect(briefingWindow(now, 14, new Date(now.getTime() - DAY).toISOString()).from.getTime()).toBe(now.getTime() - 14 * DAY);
    expect(briefingWindow(now, 14, 'not a date').from.getTime()).toBe(now.getTime() - 14 * DAY);
  });
});

describe('the shared model of a composed read', () => {
  it('a Needs or every-collection model covers any page read; a page model covers only itself', () => {
    expect(covers(NEEDS, BRIEFING)).toBe(true);
    expect(covers(NEEDS, itemScope('a'))).toBe(true);
    expect(covers(everything('x'), TRIAGE)).toBe(true);
    expect(covers(BRIEFING, BRIEFING)).toBe(true);
    expect(covers(BRIEFING, TRIAGE)).toBe(false);
    expect(covers(itemScope('a'), itemScope('b'))).toBe(false);
  });
});

/** A model holding nothing but the scope's own collections (an empty in-memory model is enough here). */
function modelOf(scope: ReadScope, outOfScope: CollectionName[]): ReadModel {
  const empty = Object.fromEntries((['people', 'accounts', 'opps', 'missedOpps', 'initiatives', 'workItems', 'evidence', 'nbas', 'drafts', 'proposals', 'assets', 'events', 'slots', 'agentRuns', 'toolAdapters', 'toolRuns', 'activity', 'timeBlocks', 'briefs', 'watches', 'connectors', 'scanRuns', 'jobs', 'eventLog', 'chatThreads', 'mappings', 'policyVersions'] as const).map((k) => [k, []]));
  return new ReadModel({} as never, empty as never, {} as never, {} as never, {} as never, {} as never, [], scope, outOfScope);
}

describe('scope misses', () => {
  it('reading a collection the scope left out is a ScopeMissError naming both', () => {
    const m = modelOf(OUTBOX, ['events']);
    expect(() => m.all('events')).toThrow(ScopeMissError);
    expect(() => m.all('events')).toThrow(/events is not in the outbox scope/);
    expect(m.has('events')).toBe(false);
    expect(m.has('drafts')).toBe(true);
    expect(m.all('drafts')).toEqual([]);
  });

  it('strict (tests): the miss throws; otherwise the read renders again from every collection', async () => {
    const loads: ReadScope[] = [];
    const load = async (s: ReadScope) => (loads.push(s), modelOf(s, s.kind === 'all' ? [] : ['events']));
    const render = (m: ReadModel) => m.all('events').length;
    await expect(readScoped(OUTBOX, load, render, true)).rejects.toThrow(ScopeMissError);
    loads.length = 0;
    expect(await readScoped(OUTBOX, load, render, false)).toBe(0);
    expect(loads.map((s) => s.kind)).toEqual(['outbox', 'all']);
    expect(loads[1]).toMatchObject({ kind: 'all', widenedFrom: OUTBOX });
  });

  it('other errors are never retried', async () => {
    let n = 0;
    const load = async (s: ReadScope) => (n++, modelOf(s, []));
    await expect(readScoped(OUTBOX, load, () => Promise.reject(new Error('boom')), false)).rejects.toThrow('boom');
    expect(n).toBe(1);
  });

  it('strict under vitest or CC_READ_SCOPE_STRICT=1; CC_READ_SCOPE_STRICT=0 turns it off', () => {
    expect(scopeStrict({ VITEST: 'true' })).toBe(true);
    expect(scopeStrict({ CC_READ_SCOPE_STRICT: '1' })).toBe(true);
    expect(scopeStrict({ VITEST: 'true', CC_READ_SCOPE_STRICT: '0' })).toBe(false);
    expect(scopeStrict({})).toBe(false);
  });

  it('CC_READ_SCOPES=off is the kill switch back to the 1.x reads', () => {
    expect(scopesOff({ CC_READ_SCOPES: 'off' })).toBe(true);
    expect(scopesOff({})).toBe(false);
  });
});

describe('paging (RD-3: pagination, never a cap)', () => {
  const rows = Array.from({ length: 2_503 }, (_, i) => i);
  it('no limit: every row, no cursor (the old payload)', () => {
    const p = pageOf(rows, {});
    expect(p.rows).toHaveLength(2_503);
    expect('nextCursor' in p).toBe(false);
  });
  it('with a limit the cursors walk every row once, in order, and end with null', () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const p = pageOf(rows, { limit: 500, cursor });
      seen.push(...p.rows);
      pages++;
      if (p.nextCursor === null) break;
      cursor = p.nextCursor!;
    }
    expect(pages).toBe(6);
    expect(seen).toEqual(rows);
  });
  it('a cursor it did not make reads from the start', () => {
    expect(pageOf(rows, { limit: 2, cursor: 'garbage' }).rows).toEqual([0, 1]);
    expect(pageOf(rows, { limit: 2, cursor: 'o:-4' }).rows).toEqual([0, 1]);
  });
});

describe('query log', () => {
  it('names the tables a statement reads or writes, quoted or not, never functions', () => {
    expect(tablesOf('select "work_items"."id" from "work_items" left join "priority_scores" on true')).toEqual(['priority_scores', 'work_items']);
    expect(tablesOf('select x from jsonb_array_elements(y) cross join lateral (select 1 from activity_entries a) z')).toEqual(['activity_entries']);
    expect(tablesOf('update user_settings set value = 1')).toEqual(['user_settings']);
    expect(tablesOf('insert into public."jobs" (a) values (1)')).toEqual(['jobs']);
  });
});
