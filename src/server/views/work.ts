/**
 * Work items, read side (R7 step 3): the Work lists (tabs, filters, order, counts), one item hydrated with its links,
 * and its NOW card. Both DataSources render these from their read source (views/source.ts). The lists were the last
 * read twin (docs/reviews/2026-11-20-holistic/19-read-twins.md, "Work lists"): what SQL can narrow comes in as
 * `WorkReads`, and the view still applies every filter, so the candidates only ever save work.
 */
import type { AgentRun, Asset, Initiative, InitiativeDetail, ItemsPayload, ItemsQuery, NowCard, WorkItem, WorkItemRecord, WorkTab } from '@/contract';
import { personaOf, staleFor } from '@/personas';
import { uuidFor } from '@/server/datasource/db/ids';

import { hrefFor, isLive } from './refs';
import type { ReadSource } from './source';

// ---------------------------------------------------------------------------
// Work lists
// ---------------------------------------------------------------------------

/** Every tab, in the order the counts carry them. */
export const WORK_TABS: readonly WorkTab[] = ['all_open', 'said_by_me', 'asked_of_me', 'promises', 'trainings', 'snoozed', 'done'];

/** Which tab an item belongs to. "Open" is a live state (refs.ts `isLive`): a suggestion is in Triage, not here. */
export function tabMatch(tab: WorkTab, i: WorkItemRecord): boolean {
  switch (tab) {
    case 'all_open':
      return isLive(i);
    case 'said_by_me':
      return isLive(i) && i.kind === 'commitment';
    case 'asked_of_me':
      return isLive(i) && i.kind === 'ask';
    case 'promises':
      return isLive(i) && i.kind === 'commitment' && i.isBackground;
    case 'trainings':
      return isLive(i) && i.kind === 'training';
    case 'snoozed':
      return i.state === 'snoozed';
    case 'done':
      return i.state === 'done';
  }
}

/** What only the store knows about a list query, computed by its DataSource before the view runs. */
export interface WorkReads {
  /**
   * The ids of the items the store already narrowed to by the structural filters (account, opp, initiative), e.g.
   * one indexed SQL query; null = no narrowing (the mock, a list without those filters, or the query failed). It must
   * be a superset of the answer: the view applies every filter itself (WL-3).
   */
  candidates: ReadonlySet<string> | null;
}

export type WorkListQuery = Pick<ItemsQuery, 'tab' | 'account' | 'opp' | 'initiative' | 'source' | 'kind' | 'q'>;

/**
 * A reference filter compares database keys (WL-2, the db rule: SQL matched the column to `uuidFor(id)`), so a seed
 * id and its uuid name the same record in either store.
 */
function refIs(want: string | undefined): (v: string | null) => boolean {
  if (!want) return () => true;
  const key = uuidFor(want);
  return (v) => v === want || (v !== null && uuidFor(v) === key);
}

/** The tab's order: closed newest first, promises oldest first, the rest by rank, then due, then id (WL-4). */
function listOrder(tab: WorkTab): (a: WorkItemRecord, b: WorkItemRecord) => number {
  if (tab === 'done') return (a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? '') || a.createdAt.localeCompare(b.createdAt);
  if (tab === 'promises') return (a, b) => b.ageDays - a.ageDays || a.createdAt.localeCompare(b.createdAt);
  return (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || (a.due ?? '9').localeCompare(b.due ?? '9') || a.id.localeCompare(b.id);
}

/**
 * GET /items: the user's items narrowed by the filters, the tab's rows in the tab's order, and every tab's count
 * over the same filters (the tabs show what the filters leave). No paging: the list is the whole tab.
 */
export function workListView(src: ReadSource, q: WorkListQuery, reads: WorkReads = { candidates: null }): ItemsPayload {
  const account = refIs(q.account);
  const opp = refIs(q.opp);
  const initiative = refIs(q.initiative);
  const text = q.q?.toLowerCase();
  const filtered = src.all('workItems').filter((i) => {
    if (reads.candidates && !reads.candidates.has(i.id)) return false;
    if (!account(i.accountId) || !opp(i.oppId) || !initiative(i.initiativeId)) return false;
    if (q.source && !i.sources.some((s) => s.kind === q.source)) return false;
    if (q.kind && i.kind !== q.kind) return false;
    if (text && !`${i.title} ${i.purpose ?? ''} ${i.why}`.toLowerCase().includes(text)) return false;
    return true;
  });
  const counts = Object.fromEntries(WORK_TABS.map((t) => [t, filtered.filter((i) => tabMatch(t, i)).length])) as Record<WorkTab, number>;
  const items = filtered
    .filter((i) => tabMatch(q.tab, i))
    .sort(listOrder(q.tab))
    .map((i) => hydrateItem(src, i));
  return { tab: q.tab, items, counts, total: items.length };
}

// ---------------------------------------------------------------------------
// One item
// ---------------------------------------------------------------------------

export function hydrateItem(src: ReadSource, rec: WorkItemRecord): WorkItem {
  const ini = rec.initiativeId ? src.get('initiatives', rec.initiativeId) : undefined;
  const acc = rec.accountId ? src.get('accounts', rec.accountId) : undefined;
  const opp = rec.oppId ? src.get('opps', rec.oppId) : undefined;
  const ev = rec.servesEventId ? src.get('events', rec.servesEventId) : undefined;
  return {
    ...rec,
    // D-55: a broken source the persona hasn't activated (VDP for an AE) never marks an item stale
    stale: rec.stale ? staleFor(rec.stale, src.all('connectors'), personaOf(src.settings())) : rec.stale,
    refs: {
      initiative: ini ? { type: 'initiative', id: ini.id, label: ini.title, href: hrefFor({ type: 'initiative', id: ini.id }) } : null,
      account: acc ? { type: 'account', id: acc.id, label: acc.name, href: hrefFor({ type: 'account', id: acc.id }) } : null,
      opp: opp ? { type: 'opportunity', id: opp.id, label: opp.name, href: hrefFor({ type: 'opportunity', id: opp.id }) } : null,
      meeting: ev ? { type: 'calendar_event', id: ev.id, label: ev.title, start: ev.start } : null,
    },
  };
}

function runForItem(src: ReadSource, item: WorkItemRecord): AgentRun | null {
  const runs = item.runIds.map((id) => src.get('agentRuns', id)).filter((r): r is AgentRun => !!r);
  const order = ['waiting_on_you', 'running', 'failed', 'done_review', 'queued', 'stale', 'done'];
  runs.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  return runs[0] ?? null;
}

export function nowCardFor(src: ReadSource, rec: WorkItemRecord): NowCard {
  const nba = rec.nbaId ? (src.get('nbas', rec.nbaId) ?? null) : null;
  const draft = nba?.draftId ? (src.get('drafts', nba.draftId) ?? null) : null;
  const proposals = src
    .all('proposals')
    .filter((p) => p.status === 'pending' && ((p.entity.type === 'work_item' && p.entity.id === rec.id) || (draft && p.entity.type === 'draft' && p.entity.id === draft.id)));
  return { item: hydrateItem(src, rec), nba, draft, run: runForItem(src, rec), proposals };
}

/** GET /initiatives/:id: its items in rank order, assets, runs, account, opp and people. */
export function initiativeView(src: ReadSource, ini: Initiative): InitiativeDetail {
  const items = src.all('workItems').filter((w) => w.initiativeId === ini.id);
  return {
    initiative: ini,
    items: items.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)).map((w) => hydrateItem(src, w)),
    assets: ini.assetIds.map((a) => src.get('assets', a)).filter((a): a is Asset => !!a),
    runs: src.all('agentRuns').filter((r) => items.some((w) => w.id === r.workItemId)),
    account: ini.accountId ? (src.get('accounts', ini.accountId) ?? null) : null,
    opp: ini.oppId ? (src.get('opps', ini.oppId) ?? null) : null,
    people: ini.people.map((p) => src.get('people', p.id) ?? { ...p, accountId: null }),
  };
}
