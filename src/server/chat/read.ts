/**
 * The Assistant's read pages (BE-CHAT, D-58): one page name maps to one GET route of the contract; its args are checked
 * with that route's own params/query schemas, the DataSource method the UI uses answers, and the payload is shaped
 * for the model (credential-redacted, UI-only keys gone) and PAGED, never cut: a list longer than one page comes back
 * with `total` and `nextOffset`, and the model reads on with `offset` until `nextOffset` is null (2026-11-13: no row
 * cap below the cost cap; the old 40 → 3 row levels are gone).
 *
 * The page names are aliases `read` takes as its `route`. Left out on purpose: chat, onboarding, the SSE
 * stream and dev routes.
 */
import { z } from 'zod';
import { allows, READ_PAGE_GATES, type ResolvedPersona } from '@/personas';
import { adminHrefFor, ItemsQuery, OPEN_CANDIDATE_STATUSES, routes, vdpHrefFor, WorkTab, type ActivityEntry, type ActivityStatus, type CalendarPayload, type HealthPayload, type ItemsPayload, type OutboxPayload, type RouteKey, type Settings, type TimeWeek, type TodayPayload, type TriagePayload, type VdpCoveragePayload, type VdpDetailPayload, type WorkItem, type WorkItemDetail } from '@/contract';
import { redactText } from '@/llm/redact';
import type { ChatItemHit } from '@/llm/chat/types';

import type { DataSource } from '../datasource/types';
import { buildContextPack, compactCalendar, compactDetail, compactHealth, compactOutbox, itemHit } from './compact';

interface PageDef {
  route: RouteKey;
  /** The tool row's area (`<area>.read`). */
  area: string;
  /** Args, as the model should pass them. */
  args?: string;
  what: string;
}

export const CHAT_READ_PAGES = {
  // A9 (2026-11-13): the reads that used to be their own tools (chat_get_context, chat_search_items, chat_get_item,
  // chat_get_calendar, chat_get_outbox, chat_get_health) are pages of the one generic read
  today: { route: 'getToday', area: 'today', what: 'the context pack again (only after something changed this turn)' },
  find_items: { route: 'listItems', area: 'work', args: 'q, tab (default: the open tabs, then done), limit', what: 'work items by words (title, purpose, why, account, notes): their ids' },
  item: { route: 'getItem', area: 'work', args: 'id', what: 'one work item: fields and version, NBA, draft, initiative, siblings, pending proposals, assets, account/opp, meeting' },
  calendar: { route: 'getCalendar', area: 'calendar', args: 'from, to (ISO instants with offset; omit = today)', what: 'events: attendance, customer-facing, prep' },
  outbox: { route: 'getOutbox', area: 'outbox', what: 'drafts by status; dry run; applied (canvases, VDP changes, feedback posts with status and link: listed = created); waitingOnTime (still waiting for Apply on Time; lastDryRunAt = applied as a dry run)' },
  health: { route: 'getHealth', area: 'health', what: 'connectors (state, last error, impact, re-auth), worker, dry run, spend vs budget' },
  home: { route: 'getHome', area: 'home', args: "day (next = the next working day: its meetings, capacity, what is due or starts, today's open work carried over; omit = today)", what: 'Do now, Chase, Looks done, Closed for you, capacity, the 14-day strip' },
  work: { route: 'listItems', area: 'work', args: 'tab (all_open | said_by_me | asked_of_me | promises | trainings | snoozed | done), account, opp, initiative, source, kind', what: 'the Work list of a tab, with counts per tab' },
  item_evidence: { route: 'getItemEvidence', area: 'work', args: 'id', what: "an item's evidence timeline: the messages, mails and notes behind it" },
  item_trace: { route: 'getItemTrace', area: 'work', args: 'id', what: 'why an item exists: evidence → source → scan run → triage verdict' },
  item_history: { route: 'getItemHistory', area: 'work', args: 'id', what: "an item's change log: who changed what and when, auto-closes and their reasons" },
  item_nba: { route: 'getItemNba', area: 'work', args: 'id', what: "an item's next best action, draft and pending proposals" },
  initiative: { route: 'getInitiative', area: 'work', args: 'id', what: 'one initiative and its items' },
  draft: { route: 'getDraft', area: 'outbox', args: 'id', what: 'one composer draft' },
  time: { route: 'getTime', area: 'time', args: 'week (any YYYY-MM-DD in it; omit = this week plus sinceLastLogged: everything not logged since the last logged activity)', what: 'the week: entries by status, hours, onsite days, the quarter vs target, logging canvases, Org62 read-back' },
  time_log: { route: 'getActivityLog', area: 'time', args: 'from, to (YYYY-MM-DD; omit = all history), status (comma list: needs_input, proposed, approved, handed_off, logged, verified, excluded, upcoming), q, account (name; none = no account), opp (id; none = no opportunity, internal = internal work), type (task type; none = no type)', what: 'the whole activity log, past quarters included: every row in a range, filtered, with totals per week, month and fiscal quarter (logged vs target), and why excluded rows were excluded' },
  time_ledger: { route: 'getTimeLedger', area: 'time', args: 'quarter (a fiscal quarter label like "Q3 FY27", or all; omit = the current quarter)', what: 'the Ledger: one quarter as a report: hours in Org62 (verified), on their way, suggested and needing input against the target; hours by account and opportunity, internal, by task type and by week (or by quarter for all)' },
  history: { route: 'getHistoryMonth', area: 'history', args: 'month (YYYY-MM; omit = this month)', what: 'one line per day of a month: finished, hours, meetings, sent, runs, Org62' },
  history_day: { route: 'getHistoryDay', area: 'history', args: 'day (YYYY-MM-DD)', what: 'what was done on one day: transitions, activity, calendar, outbox, runs' },
  deals: { route: 'getDeals', area: 'deals', what: 'the accounts list with opportunities, what needs me (needs: DC gaps naming each opp and why, think ahead, chase, each with how to set it aside), and my pipeline: open, this quarter by forecast category, won, closing in 30 days, needs attention, and per fiscal quarter (pipeline.rows are my deals)' },
  account: { route: 'getAccount', area: 'deals', args: 'accountId', what: 'one account: opportunities, people, open work, recent activity' },
  vdp: { route: 'getVdpCoverage', area: 'vdp', what: 'every VDP with its status and open items (who: app = an itemKey for propose kind vdp, you = a link and the text to paste), and the accounts and opps not in VDP yet' },
  vdp_detail: { route: 'getVdpDetail', area: 'vdp', args: 'key (a VDP slug, or account:<accountId>; the "Looking at" vdp id as is)', what: 'one VDP in full: ordered steps, use cases and their fields, assets, owners, stakeholders, assets to add, the last Find assets run' },
  missed_opps: { route: 'getMissed', area: 'deals', what: 'missed-opportunity findings' },
  briefs: { route: 'getBriefs', area: 'briefs', what: 'watched and my-opportunity brief lists (titles, unread)' },
  watches: { route: 'listWatches', area: 'briefs', what: 'watch subscriptions' },
  triage: { route: 'getTriage', area: 'triage', what: 'asks & promises to confirm, meeting takeaways, missed opps, mappings, closed for you' },
  since: { route: 'getSince', area: 'since', args: 'ts (ISO instant; omit = since the user was last active)', what: 'the "since you left" digest' },
  search: { route: 'search', area: 'work', args: 'q, limit', what: 'the ⌘K search across items, accounts, people, drafts' },
  people: { route: 'getPeople', area: 'people', args: 'q, account, limit', what: 'people: name, email, Slack id, role, account, external or not' },
  readin: { route: 'getReadIn', area: 'readin', args: 'type (work_item | calendar_event), id', what: 'the stored read-in for an item or event (null when none was requested)' },
  agents: { route: 'getAgents', area: 'agents', what: 'Claude sessions, app runs and tool runs' },
  tool_run: { route: 'getToolRun', area: 'agents', args: 'id', what: 'one tool run' },
  scans: { route: 'getScans', area: 'scans', args: 'limit', what: 'the scan ledger: recent scan runs per connector' },
  jobs: { route: 'getJobs', area: 'jobs', what: 'background jobs, including failed and dead-letter' },
  event_log: { route: 'getEventLog', area: 'events', what: 'the error and event log' },
  settings: { route: 'getSettings', area: 'settings', what: 'all settings sections (closing work, budgets, time, scanning…)' },
  policy_versions: { route: 'getPolicyVersions', area: 'policy', what: 'priority policy version history' },
} as const satisfies Record<string, PageDef>;

export type ChatReadPage = keyof typeof CHAT_READ_PAGES;
export const CHAT_READ_PAGE_NAMES = Object.keys(CHAT_READ_PAGES) as [ChatReadPage, ...ChatReadPage[]];

/** D-55: whether a page has a daily surface for this persona (READ_PAGE_GATES: vdp, vdp_detail, missed_opps). No persona: all. */
export function chatReadPageAllowed(page: ChatReadPage, persona?: ResolvedPersona | null): boolean {
  return persona === undefined || allows(persona, READ_PAGE_GATES[page]);
}

/** The pages this persona's Assistant reads, in catalog order (no persona: every page). */
export function chatReadPagesFor(persona?: ResolvedPersona | null): [ChatReadPage, ...ChatReadPage[]] {
  return CHAT_READ_PAGE_NAMES.filter((p) => chatReadPageAllowed(p, persona)) as [ChatReadPage, ...ChatReadPage[]];
}

/** Pages with a view of their own (the rest read their route's data as is, under a shorter name). */
const VIEW_PAGES: ReadonlySet<ChatReadPage> = new Set(['today', 'find_items', 'item', 'calendar', 'outbox', 'health', 'home', 'work', 'time', 'vdp', 'vdp_detail', 'triage']);

/**
 * The pages for read's description (a persona's own pages only: one stable description per persona). A page
 * with its own view gets a line; the plain aliases are one line of `name=route` (the route's line says what it holds).
 */
export function chatPageCatalog(persona?: ResolvedPersona | null): string {
  const pages = chatReadPagesFor(persona);
  const own = pages.filter((p) => VIEW_PAGES.has(p)).map((p) => {
    const d: PageDef = CHAT_READ_PAGES[p];
    return `${p}${d.args ? ` {${d.args}}` : ''}: ${d.what}`;
  });
  const alias = pages.filter((p) => !VIEW_PAGES.has(p)).map((p) => `${p}=${CHAT_READ_PAGES[p].route}`);
  return [...own, `Also names for routes (their args as listed there): ${alias.join(', ')}`].join('\n');
}

/** Read routes a page with its own view covers (the route catalog leaves them out: read the page). */
export function routesCoveredByPages(persona?: ResolvedPersona | null): Set<RouteKey> {
  return new Set(chatReadPagesFor(persona).filter((p) => VIEW_PAGES.has(p) && p !== 'find_items').map((p) => CHAT_READ_PAGES[p].route as RouteKey));
}

export interface ChatReadResult {
  page: ChatReadPage;
  data: unknown;
  /** Where this page sits in its list (null: everything fit on one page). */
  paging: ReadPageInfo | null;
  /** Other lists that only started on this page: read each with `list` and `offset` for the rest. */
  more?: Record<string, { shown: number; total: number; nextOffset: number }>;
  summary: string;
}

export class ChatReadArgsError extends Error {}

// ---------------------------------------------------------------------------
// The model's view: cleaned, then paged (never cut)
// ---------------------------------------------------------------------------

/**
 * Characters of JSON in one read page: generous (40 rows of 40 were the old cut), and under the Agent SDK's ~25k-token
 * limit on one tool result, the real limit here. Long lists come back in several pages, never shortened.
 */
export const READ_PAGE_CHARS = 40_000;

/** UI-only or bulky keys no answer needs. `version` stays: a PATCH's ifVersion comes from it (A4). */
const DROP = new Set(['userLockedFields', 'etag', 'html', 'bodyHtml', 'raw', 'avatar', 'avatarUrl', 'initials', 'icon', 'color', 'timeline', 'spine']);

/**
 * A string longer than this is a body, not a field: a list row shows its first MAX_STRING characters and the path to
 * read the whole of it with `field` (ASSIST-5, 2026-11-20: never a silent clip; the rest is a paged field read).
 */
const MAX_STRING = 2_000;
const MAX_DEPTH = 14;

/** A full WorkItem embedded in a payload (Home rows, Triage rows, Since, accounts) reads as the compact item hit. */
const isWorkItem = (v: object): v is WorkItem => 'id' in v && 'title' in v && 'state' in v && 'kind' in v && 'rankReasons' in v;

/** The note a long string ends with: how long it is and the `field` that reads the rest. */
export const fieldPointer = (len: number, path: string) => ` … [${len} characters; read the rest with field="${path}"]`;

/**
 * A payload as the model reads it: credential-redacted, whitespace collapsed, empty values and UI-only keys gone, an
 * embedded work item as its hit. Every row of every list stays (paging, not this, sizes a read). A string over
 * `clipAt` shows its start and the `field` path that reads all of it (`path` null: a display preview, no pointer).
 */
export function cleanForModel(v: unknown, d = 0, clipAt = MAX_STRING, path: string | null = ''): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'object' && !Array.isArray(v) && isWorkItem(v)) v = itemHit(v);
  if (typeof v === 'string') {
    const t = redactText(v.replace(/\s+/g, ' ').trim());
    if (!t) return undefined;
    if (/^https?:\/\/\S+$/.test(t)) return t.length > 2_000 ? undefined : t;
    if (t.length <= clipAt) return t;
    return path === null || !path ? `${t.slice(0, clipAt - 1)}…` : `${t.slice(0, clipAt)}${fieldPointer(t.length, path)}`;
  }
  if (typeof v !== 'object') return v;
  if (d >= MAX_DEPTH) return Array.isArray(v) ? `[${v.length} items]` : '{…}';
  const at = (k: string | number) => (path === null ? null : path ? `${path}.${k}` : String(k));
  if (Array.isArray(v)) {
    // the index is the row's place in the cleaned list (what `offset` and `field` count)
    const out: unknown[] = [];
    for (const x of v) {
      const y = cleanForModel(x, d + 1, clipAt, at(out.length));
      if (y !== undefined) out.push(y);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (DROP.has(k)) continue;
    const y = cleanForModel(x, d + 1, clipAt, at(k));
    if (y !== undefined) out[k] = y;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * ASSIST-5: one long string of a payload, whole, a page at a time: `field` is the path a clipped value named
 * (`item.notes`, `hits.3.body`), `offset`/`limit` count characters. Returns the text with `total` and `nextOffset`.
 */
export function fieldPage(raw: unknown, field: string, o: { offset?: number; limit?: number } = {}, budget = READ_PAGE_CHARS): { field: string; text: string; offset: number; total: number; nextOffset: number | null } {
  let v = cleanForModel(raw, 0, Number.POSITIVE_INFINITY);
  for (const k of field.split('.')) {
    if (Array.isArray(v) && /^\d+$/.test(k)) v = v[Number(k)];
    else if (isObj(v)) v = v[k];
    else v = undefined;
    if (v === undefined) throw new ChatReadArgsError(`no field "${field}" here (use the path a long value named)`);
  }
  if (typeof v !== 'string') throw new ChatReadArgsError(`"${field}" is not a text field: read it without field`);
  const offset = Math.max(0, Math.trunc(o.offset ?? 0));
  const size = Math.max(1, Math.min(budget - 400, Math.trunc(o.limit ?? budget - 400)));
  const text = v.slice(offset, offset + size);
  const end = offset + text.length;
  return { field, text, offset, total: v.length, nextOffset: end < v.length ? end : null };
}

/** Paging args every read takes (read `offset`, `limit`, `list`, `field`). */
export interface ReadPageArgs {
  /** The first row of the list to return (the last page's `nextOffset`); with `field`, the first character. */
  offset?: number;
  /** At most this many rows on the page (default: as many as fit); with `field`, characters. */
  limit?: number;
  /** Which list to page when the data has several (a top-level key, or `a.b` one level down). */
  list?: string;
  /** One long text whole, a page at a time: the path a clipped value named (ASSIST-5). */
  field?: string;
}

export interface ReadPageInfo {
  /** The paged list's key (null: the data is the list). */
  list: string | null;
  offset: number;
  count: number;
  total: number;
  /** Where the next page starts; null when this page holds the last row. */
  nextOffset: number | null;
}

const size = (v: unknown) => JSON.stringify(v ?? null).length;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The lists of a payload, top level and one level down, biggest first (the one to page by default). */
function listsOf(v: Record<string, unknown>): Array<{ key: string; path: [string] | [string, string]; arr: unknown[]; size: number }> {
  const out: Array<{ key: string; path: [string] | [string, string]; arr: unknown[]; size: number }> = [];
  for (const [k, x] of Object.entries(v)) {
    if (Array.isArray(x)) out.push({ key: k, path: [k], arr: x, size: size(x) });
    else if (isObj(x)) for (const [k2, y] of Object.entries(x)) if (Array.isArray(y)) out.push({ key: `${k}.${k2}`, path: [k, k2], arr: y, size: size(y) });
  }
  return out.sort((a, b) => b.size - a.size);
}

function setAt(v: Record<string, unknown>, path: string[], x: unknown): Record<string, unknown> {
  const [k, ...rest] = path;
  return { ...v, [k!]: rest.length ? setAt((v[k!] as Record<string, unknown>) ?? {}, rest, x) : x };
}

/** As many rows from `offset` as fit in `budget` characters (at least one), at most `limit`. */
function takeRows(arr: unknown[], offset: number, budget: number, limit?: number): unknown[] {
  const out: unknown[] = [];
  let used = 2;
  for (let i = offset; i < arr.length; i++) {
    if (limit !== undefined && out.length >= limit) break;
    const n = size(arr[i]) + 1;
    if (out.length && used + n > budget) break;
    out.push(arr[i]);
    used += n;
  }
  return out;
}

/** Lists a payload's first page leaves for later, in shrink order: the "needs you" rows go last (they answer "why N?"). */
const KEEP_LAST = new Set(['needs', 'missingOpp.rows']);

/**
 * One page of a payload for the model (A1): the data cleaned, then ONE list paged (`list`, default the biggest) from
 * `offset`, as many rows as fit in `budget` characters, with `total` and `nextOffset`. The first page also carries the
 * payload's other fields; when those hold other big lists, each shows its first rows and goes in `more` (read it with
 * `list`). A later page carries only its rows. Every row is reachable; nothing is cut mid-JSON.
 */
export function pageForModel(raw: unknown, a: ReadPageArgs = {}, budget = READ_PAGE_CHARS): { value: unknown; paging: ReadPageInfo | null; more?: Record<string, { shown: number; total: number; nextOffset: number }> } {
  if (a.field) {
    const f = fieldPage(raw, a.field, a, budget);
    return { value: f, paging: { list: `field:${f.field}`, offset: f.offset, count: f.text.length, total: f.total, nextOffset: f.nextOffset } };
  }
  const offset = Math.max(0, Math.trunc(a.offset ?? 0));
  const limit = a.limit !== undefined ? Math.max(1, Math.trunc(a.limit)) : undefined;
  let v = cleanForModel(raw) ?? null;
  const wantsPage = offset > 0 || limit !== undefined || !!a.list;
  if (Array.isArray(v)) {
    if (!wantsPage && size(v) <= budget) return { value: v, paging: null };
    const rows = takeRows(v, offset, budget, limit);
    const next = offset + rows.length;
    return { value: rows, paging: { list: null, offset, count: rows.length, total: v.length, nextOffset: next < v.length ? next : null } };
  }
  if (!isObj(v)) {
    if (a.list) throw new ChatReadArgsError(`no list "${a.list}" here (the data is not a list)`);
    return { value: v, paging: null };
  }
  const lists = listsOf(v);
  if (a.list && !lists.some((l) => l.key === a.list)) throw new ChatReadArgsError(`no list "${a.list}" here (lists: ${lists.map((l) => l.key).join(', ') || 'none'})`);
  if (!wantsPage && size(v) <= budget) return { value: v, paging: null };
  const target = a.list ? lists.find((l) => l.key === a.list)! : lists[0];
  if (!target) {
    // no list to page: one object too big for a page reads with its long strings clipped (never mid-JSON)
    return { value: size(v) <= budget ? v : (cleanForModel(raw, 0, 300) ?? null), paging: null };
  }
  const total = target.arr.length;
  if (offset > 0) {
    // a later page: only its rows (the other fields came with the first page)
    const rows = takeRows(target.arr, offset, budget - 200, limit);
    const next = offset + rows.length;
    return { value: setAt({}, target.path, rows), paging: { list: target.key, offset, count: rows.length, total, nextOffset: next < total ? next : null } };
  }
  // the first page: the other fields too; other big lists start here and continue with `list`
  let rest = setAt(v, target.path, []);
  const more: Record<string, { shown: number; total: number; nextOffset: number }> = {};
  const restCap = Math.floor(budget / 2);
  if (size(rest) > restCap) {
    const others = lists.filter((l) => l.key !== target.key && !target.key.startsWith(`${l.key}.`) && !l.key.startsWith(`${target.key}.`)).sort((x, y) => Number(KEEP_LAST.has(x.key)) - Number(KEEP_LAST.has(y.key)) || y.size - x.size);
    for (const o of others) {
      const over = size(rest) - restCap;
      if (over <= 0) break;
      const keep = takeRows(o.arr, 0, Math.max(400, o.size - over), undefined);
      if (keep.length >= o.arr.length) continue;
      rest = setAt(rest, o.path, keep);
      more[o.key] = { shown: keep.length, total: o.arr.length, nextOffset: keep.length };
    }
  }
  const rows = takeRows(target.arr, 0, Math.max(budget / 4, budget - size(rest)), limit);
  v = setAt(rest, target.path, rows);
  return { value: v, paging: { list: target.key, offset: 0, count: rows.length, total, nextOffset: rows.length < total ? rows.length : null }, ...(Object.keys(more).length ? { more } : {}) };
}

/** What the model is told about a paged read (the tool result's `page` and its note). */
export function pageNote(p: ReadPageInfo | null, more?: Record<string, { shown: number; total: number; nextOffset: number }>): { page?: ReadPageInfo; more?: typeof more; note?: string } {
  const notes: string[] = [];
  if (p?.list?.startsWith('field:')) {
    const f = p.list.slice(6);
    if (p.nextOffset !== null) notes.push(`Characters ${p.offset + 1}–${p.offset + p.count} of ${p.total} of ${f}: read again with field="${f}" and offset=${p.nextOffset} until nextOffset is null.`);
    return { page: p, ...(notes.length ? { note: notes.join(' ') } : {}) };
  }
  if (p && p.nextOffset !== null) notes.push(`Rows ${p.offset + 1}–${p.offset + p.count} of ${p.total}${p.list ? ` (${p.list})` : ''}: read again with offset=${p.nextOffset}${p.list ? ` and list="${p.list}"` : ''} until nextOffset is null, and count or answer only from every page.`);
  if (more) for (const [k, m] of Object.entries(more)) notes.push(`${k}: ${m.shown} of ${m.total} on this page; read it with list="${k}" and offset=${m.nextOffset}.`);
  return { ...(p ? { page: p } : {}), ...(more ? { more } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) };
}

// ---------------------------------------------------------------------------
// Time: the week, and everything not logged since the last logged activity
// ---------------------------------------------------------------------------

/** Not yet in Org62. `upcoming` hasn't happened; `dismissed` was excluded. */
export const UNLOGGED: ReadonlySet<ActivityStatus> = new Set(['needs_input', 'proposed', 'approved', 'synced_to_canvas']);
export const LOGGED: ReadonlySet<ActivityStatus> = new Set(['logged', 'verified', 'verify_failed']);

const h2 = (n: number) => Math.round(n * 100) / 100;

const entryRow = (e: ActivityEntry) => ({
  id: e.id,
  date: e.date,
  start: e.start,
  hours: e.durationH,
  status: e.status,
  account: e.accountName,
  opp: e.oppName,
  taskType: e.taskType,
  meetingType: e.meetingType,
  description: e.description,
  issues: e.issues,
});

function tally(entries: ActivityEntry[]) {
  const by: Record<string, { count: number; hours: number }> = {};
  for (const e of entries) {
    const t = (by[e.status] ??= { count: 0, hours: 0 });
    t.count += 1;
    t.hours = h2(t.hours + e.durationH);
  }
  return by;
}

/** Entries the app excluded (not loggable: internal or admin, overlaps, duplicates), by the reason it gives. */
function excludedSummary(entries: ActivityEntry[]) {
  const by = new Map<string, { count: number; hours: number }>();
  for (const e of entries) {
    const reason = (e.issues[e.issues.length - 1] ?? 'excluded').replace(/\s+/g, ' ').slice(0, 120);
    const t = by.get(reason) ?? { count: 0, hours: 0 };
    by.set(reason, { count: t.count + 1, hours: h2(t.hours + e.durationH) });
  }
  return {
    count: entries.length,
    hours: h2(entries.reduce((s, e) => s + e.durationH, 0)),
    byReason: [...by].sort((a, b) => b[1].hours - a[1].hours).map(([reason, t]) => ({ reason, ...t })),
  };
}

/**
 * An unlogged row without a real opportunity: no WhatId at all ("NEEDS WhatId"), or the account as a stand-in ("account
 * fallback (no single obvious opp)"). The question "which entries need an opp?" is answered from this, before any cut.
 */
export function oppGap(e: ActivityEntry): 'none' | 'account_fallback' | null {
  // D-64: internal-only work has no opportunity by design: it never needs one
  if (e.internal) return null;
  if (e.issues.some((i) => /account fallback|no single obvious opp/i.test(i))) return 'account_fallback';
  if (!e.oppId || e.issues.some((i) => /needs whatid|needs (an )?opp/i.test(i))) return 'none';
  return null;
}

const addDays = (isoDate: string, n: number) => {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Walk back week by week (at most `maxWeeks`) to the newest logged activity; everything unlogged after it, up to now,
 * is what is still open to log.
 */
export async function sinceLastLogged(getWeek: (week: string) => Promise<TimeWeek>, first: TimeWeek, now: Date, maxWeeks = 26) {
  const open: ActivityEntry[] = [];
  const excluded: ActivityEntry[] = [];
  let w = first;
  let last: ActivityEntry | null = null;
  for (let i = 0; i < maxWeeks; i++) {
    const logged = w.entries.filter((e) => LOGGED.has(e.status)).sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
    const after = logged ? Date.parse(logged.start) : -Infinity;
    const inRange = (e: ActivityEntry) => Date.parse(e.start) > after && Date.parse(e.start) <= now.getTime();
    open.push(...w.entries.filter((e) => UNLOGGED.has(e.status) && inRange(e)));
    excluded.push(...w.entries.filter((e) => e.status === 'dismissed' && inRange(e)));
    if (logged) {
      last = logged;
      break;
    }
    if (i < maxWeeks - 1) w = await getWeek(addDays(w.weekStart, -7));
  }
  open.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const byWeek = new Map<string, { count: number; hours: number }>();
  for (const e of open) {
    // Monday of the entry's local date.
    const d = new Date(`${e.date}T12:00:00Z`);
    const monday = addDays(e.date, -((d.getUTCDay() + 6) % 7));
    const t = byWeek.get(monday) ?? { count: 0, hours: 0 };
    byWeek.set(monday, { count: t.count + 1, hours: h2(t.hours + e.durationH) });
  }
  return {
    lastLogged: last ? { date: last.date, start: last.start, hours: last.durationH, status: last.status, account: last.accountName, description: last.description } : null,
    searchedBackTo: last ? null : w.weekStart,
    notLogged: {
      count: open.length,
      hours: h2(open.reduce((s, e) => s + e.durationH, 0)),
      from: open[0]?.date ?? null,
      to: open.at(-1)?.date ?? null,
      byStatus: tally(open),
      byWeek: [...byWeek].map(([weekStart, t]) => ({ weekStart, ...t })),
    },
    /** Counted above but already staged: rows in a canvas waiting for the user's Apply on Time (do not stage them again). */
    ...waitingForApply(open),
    /** Rows that still need a real opportunity (all of them, listed before `entries`, so a cut list never hides one). */
    missingOpp: missingOpp(open),
    /** Not counted above: what the app left out of the log over the same span, and why. */
    excluded: excludedSummary(excluded),
    // No row list here: `time {week}` has every row of a week. The totals above and missingOpp are complete.
  };
}

function waitingForApply(open: ActivityEntry[]) {
  const held = open.filter((e) => e.canvasDraftId);
  if (!held.length) return {};
  const items = [...new Set(held.map((e) => e.canvasDraftId!))];
  return { waitingForApply: { count: held.length, hours: h2(held.reduce((s, e) => s + e.durationH, 0)), items: items.map((id) => ({ draftId: id, href: adminHrefFor(id, false) })) } };
}

function missingOpp(open: ActivityEntry[]) {
  const rows = open.flatMap((e) => {
    const gap = oppGap(e);
    return gap ? [{ id: e.id, date: e.date, hours: e.durationH, status: e.status, gap, account: e.accountName, taskType: e.taskType, description: e.description.slice(0, 90) }] : [];
  });
  return { count: rows.length, hours: h2(rows.reduce((s, r) => s + r.hours, 0)), noOpp: rows.filter((r) => r.gap === 'none').length, accountFallback: rows.filter((r) => r.gap === 'account_fallback').length, rows };
}

function weekView(w: TimeWeek, o: { entries: boolean } = { entries: true }) {
  return {
    week: { start: w.weekStart, end: w.weekEnd },
    totals: w.totals,
    byStatus: tally(w.entries),
    quarter: w.quarter,
    org62: w.org62,
    // the logging canvases: waiting for Apply (pending / retry) or applied (created in Slack, with the link and the
    // rows' Org62 state); answers "was the canvas created?"
    logCanvases: (w.logCanvases ?? []).map(({ rowIds: _r, ...c }) => c),
    onsite: w.onsite,
    // With sinceLastLogged (no week asked) the week's rows are already in it; leave room for them there.
    ...(o.entries ? { entries: w.entries.filter((e) => e.status !== 'dismissed').map(entryRow) } : { upcomingCount: w.entries.filter((e) => e.status === 'upcoming').length }),
    excluded: excludedSummary(w.entries.filter((e) => e.status === 'dismissed')),
  };
}

// ---------------------------------------------------------------------------
// Triage: one short row per card (the full work item behind each is what made it 400 KB)
// ---------------------------------------------------------------------------

type TriageRow = TriagePayload['groups'][number]['items'][number];

const triageRow = (r: TriageRow) => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  why: r.why,
  confidence: r.confidence,
  at: r.createdAt,
  ...(r.workItem ? { workItemId: r.workItem.id, state: r.workItem.state, resolution: r.workItem.resolution, account: r.workItem.refs?.account?.label ?? null } : {}),
  link: r.sources?.[0]?.url ?? null,
  ...(r.missedOpp ? { missedOpp: r.missedOpp } : {}),
  ...(r.mapping ? { mapping: r.mapping } : {}),
});

function triageView(t: TriagePayload) {
  return { count: t.count, groups: t.groups.map((g) => ({ group: g.group, label: g.label, count: g.items.length, items: g.items.map(triageRow) })) };
}

// ---------------------------------------------------------------------------
// VDP: each VDP with its gaps, fix or handoff spelled out (the raw coverage is ~80 KB)
// ---------------------------------------------------------------------------

type VdpGap = VdpCoveragePayload['vdps'][number]['gaps'][number];

const gapRow = (g: VdpGap) => ({
  id: g.id,
  code: g.code,
  severity: g.severity,
  title: g.title,
  ...(g.useCaseId ? { useCaseId: g.useCaseId, useCase: g.useCaseTitle } : {}),
  fix:
    g.fix.kind === 'app'
      ? { kind: 'app', op: g.fix.op, field: g.fix.field, current: g.fix.current, suggested: g.fix.suggested, ...(g.fix.options?.length ? { options: g.fix.options } : {}), ...(g.fix.unsupported ? { disabled: g.fix.unsupported } : {}) }
      : g.fix.kind === 'in_app'
        ? { kind: 'in_app', action: g.fix.action, label: g.fix.label }
        : { kind: 'handoff', label: g.fix.label, url: g.fix.url, copyText: g.fix.copyText ?? '' },
});

/**
 * App-fixable gaps stay one per row (each becomes one Outbox item); handoffs that repeat (the same missing field on
 * many use cases) collapse to one line with a count and the use cases, so a VDP with 50 gaps still reads whole.
 */
function vdpGaps(gaps: VdpGap[]) {
  const app = gaps.filter((g) => g.fix.kind === 'app').map(gapRow);
  const groups = new Map<string, { code: string; label: string; url: string | null; copyText: string; count: number; useCases: string[]; severity: string }>();
  for (const g of gaps) {
    if (g.fix.kind !== 'handoff') continue;
    const key = `${g.code}|${g.fix.label}`;
    const cur = groups.get(key) ?? { code: g.code, label: g.fix.label, url: g.fix.url ?? null, copyText: g.fix.copyText ?? '', count: 0, useCases: [], severity: g.severity };
    cur.count += 1;
    if (g.useCaseTitle) cur.useCases.push(g.useCaseTitle);
    groups.set(key, cur);
  }
  return { appFixable: app, handoffs: [...groups.values()] };
}

type VdpItem = VdpCoveragePayload['vdps'][number]['steps'][number];

/** One open item as the Assistant reads it: who does it, its state, and how (the Apply's key and fields, or the handoff). */
const itemRow = (s: VdpItem) => ({
  kind: s.kind,
  title: s.title,
  who: s.who,
  state: s.state,
  ...(s.apply ? { apply: { itemKey: s.apply.key, op: s.apply.op, fields: s.apply.fields.map((f) => ({ field: f.field, suggested: f.suggested, ...(f.required ? { required: true } : {}), ...(f.fixed ? { fixed: true } : {}), ...(f.options.length ? { options: f.options } : {}) })) } } : {}),
  ...(s.handoff ? { handoff: { label: s.handoff.label, url: s.handoff.url, copyText: s.handoff.copyText } } : {}),
  ...(s.blockedReason ? { waitsBecause: s.blockedReason } : {}),
  // D-63: what it needs applied first, and why it can't be pushed yet
  ...(s.requires?.length ? { requires: s.requires } : {}),
  ...(s.disabled ? { disabled: s.disabled } : {}),
});

/** The coverage list stays short (every VDP must fit): each item's kind, words, who and state; vdp_detail has the rest. */
const itemLine = (s: VdpItem) => ({ kind: s.kind, title: s.title, who: s.who, state: s.state, ...(s.apply ? { itemKey: s.apply.key } : {}), ...(s.handoff ? { url: s.handoff.url } : {}) });

function vdpView(c: VdpCoveragePayload) {
  return {
    summary: c.summary,
    counts: c.counts,
    lastReadAt: c.lastReadAt,
    nextReadAt: c.nextReadAt,
    automation: c.automation,
    autopilot: c.autopilot.line,
    vdps: c.vdps.map((v) => ({
      vdpSlug: v.vdpSlug,
      company: v.companyName,
      fiscal: v.fiscalYear !== null ? `FY${v.fiscalYear}${v.fiscalQuarter ? ` Q${v.fiscalQuarter}` : ''}` : null,
      opportunities: v.opportunityNames,
      url: v.url,
      status: v.status.label,
      ...(v.scope === 'past' ? { past: true } : { useCases: v.useCaseCount, withAi: v.useCaseWithAiCount, assets: v.assetCount, hasAe: v.hasAe, hasTa: v.hasTa, open: v.steps.map(itemLine) }),
    })),
    // D-63: the company or VDP to create, and what comes under it (each requires the ones above it)
    notInVdp: c.notInVdp.map((r) => ({ key: r.key, ...itemLine(r.step), title: r.title, status: r.status.label, ...(r.children?.length ? { under: r.children.map(itemLine) } : {}) })),
  };
}

/**
 * One VDP: the steps in order (each with its fixes and handoffs), the use cases with every field, the assets VDP holds,
 * and the open candidates in full (closed ones only counted), so "what assets does X have / what's missing" reads whole.
 */
function vdpDetailView(d: VdpDetailPayload) {
  const open = d.candidates.filter((c) => OPEN_CANDIDATE_STATUSES.includes(c.status));
  return {
    key: d.key,
    href: vdpHrefFor(d.key),
    company: d.companyName,
    account: d.account,
    opportunity: d.opportunity,
    lastReadAt: d.lastReadAt,
    vdp: d.vdp
      ? {
          slug: d.vdp.slug,
          url: d.vdp.url,
          fiscal: d.vdp.fiscalYear ? `FY${d.vdp.fiscalYear}${d.vdp.fiscalQuarter ? ` Q${d.vdp.fiscalQuarter}` : ''}` : null,
          org62OpportunityIds: d.vdp.salesforceOpportunityIds.length ? d.vdp.salesforceOpportunityIds : d.vdp.salesforceOpportunityId ? [d.vdp.salesforceOpportunityId] : [],
          org62AccountId: d.vdp.salesforceAccountId,
          seed: d.vdp.isSeed || undefined,
          aes: d.vdp.aes.map((p) => p.name ?? p.email),
          tas: d.vdp.tas.map((p) => p.name ?? p.email),
          executiveSummary: d.vdp.executiveSummary,
          useCases: d.vdp.useCases.map((u) => ({ id: u.id, track: u.track, title: u.title, priority: u.priority, division: u.division, persona: u.persona, details: u.details, phase: u.executionPhase, start: u.executionStartDate, target: u.executionTargetDate, duration: u.duration, aiFields: u.hasAi ? u.aiFields : 'not generated', missing: u.missing, ...(u.detailLoaded ? {} : { detailNotRead: true }) })),
          assets: d.vdp.assets.map((a) => ({ title: a.title, url: a.url, type: a.type, description: a.description })),
          stakeholders: d.vdp.stakeholders,
        }
      : null,
    status: d.status.label,
    // D-60: the item the "Looking at" ref named, and autopilot's line (what it applies by itself, paused why)
    ...(d.focus ? { focus: d.focus } : {}),
    autopilot: d.autopilot.line,
    steps: d.steps.map((s, i) => ({ n: i + 1, ...itemRow(s), policy: s.policy, ...(s.check === 'wrong' ? { looksWrong: true } : {}), ...(s.suggestion ? { suggested: s.suggestion.values, why: s.suggestion.basis } : {}), ...(s.autopilot ? { autopilot: { state: s.autopilot.state, detail: s.autopilot.detail } } : {}), ...(s.blockedBy ? { waitsFor: s.blockedBy } : {}), detail: s.detail, ...(s.gaps.length ? vdpGaps(s.gaps) : {}), ...(s.candidateIds.length ? { candidates: s.candidateIds.length } : {}) })),
    assetsToAdd: open.map((c) => ({ id: c.id, status: c.status, title: c.title, url: c.url, kind: c.kind, why: c.why, confidence: c.confidence, foundBy: c.origin, sources: c.sources.map((s) => ({ label: s.label, url: s.url, at: s.at })), addIt: c.apply ? { itemKey: c.apply.key } : { waits: c.status === 'unsure' ? 'confirm it first' : c.vdpSlug ? 'not an http(s) link' : 'the VDP is created first' } })),
    closedCandidates: { inVdp: d.candidates.filter((c) => c.status === 'in_vdp').length, dismissed: d.candidates.filter((c) => c.status === 'dismissed').length },
    findAssets: { last: d.backfill.last, perRunUsd: d.backfill.perRunUsd, dayLeftUsd: d.backfill.dayLeftUsd },
  };
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

type Call = (input: unknown) => Promise<unknown>;

function inputFor(key: RouteKey, args: Record<string, unknown>) {
  const def = routes[key] as { params?: z.ZodTypeAny; query?: z.ZodTypeAny };
  const input: { params?: unknown; query?: unknown } = {};
  const str = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
  const used = new Set<string>();
  for (const part of ['params', 'query'] as const) {
    const schema = def[part];
    if (!schema) continue;
    const shape = schema instanceof z.ZodObject ? Object.keys(schema.shape as object) : [];
    const mine = Object.fromEntries(Object.entries(str).filter(([k]) => shape.includes(k)));
    for (const k of Object.keys(mine)) used.add(k);
    const r = schema.safeParse(mine);
    if (!r.success) throw new ChatReadArgsError(r.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || part}: ${i.message}`).join('; '));
    input[part] = r.data;
  }
  const extra = Object.keys(str).filter((k) => !used.has(k));
  if (extra.length) throw new ChatReadArgsError(`unknown arg${extra.length > 1 ? 's' : ''} ${extra.join(', ')}`);
  return input;
}

const plural = (n: number, w: string) => `${n} ${n === 1 ? w : w.endsWith('y') ? `${w.slice(0, -1)}ies` : `${w}s`}`;

/** A short human line for the tool row. */
function summaryOf(page: ChatReadPage, raw: unknown, shaped: unknown, paging: ReadPageInfo | null): string {
  const r = raw as Record<string, unknown> | null;
  if (r === null || r === undefined) return 'Nothing stored';
  const at = paging && (paging.offset > 0 || paging.nextOffset !== null) ? ` · rows ${paging.offset + 1}–${paging.offset + paging.count} of ${paging.total}` : '';
  if (page === 'find_items') {
    const hits = (shaped as { hits: ChatItemHit[] }).hits;
    return hits.length ? `${plural(hits.length, 'item')}: ${hits.slice(0, 2).map((h) => h.title).join(' · ')}` : 'No matching items';
  }
  if (page === 'item') return `Read "${(r as unknown as WorkItemDetail).item.title.slice(0, 60)}"`;
  if (page === 'calendar') return plural((r as unknown as CalendarPayload).events.length, 'event') + at;
  if (page === 'outbox') return `${(r as unknown as OutboxPayload).counts.pending_approval} pending approval · ${(r as unknown as OutboxPayload).counts.scheduled} scheduled`;
  if (page === 'health') {
    const broken = (r as unknown as HealthPayload).connectors.filter((c) => c.state !== 'ok');
    return broken.length ? `${plural(broken.length, 'connector')} need attention: ${broken.map((c) => c.label).join(', ')}` : 'All connectors healthy';
  }
  if (page === 'today') return `Read today (${plural((r as unknown as TodayPayload).nowStack.cards.length, 'top item')})`;
  if (page === 'time') {
    const s = (shaped as { sinceLastLogged?: Awaited<ReturnType<typeof sinceLastLogged>> }).sinceLastLogged;
    if (s) return s.lastLogged ? `Last logged ${s.lastLogged.date} · ${plural(s.notLogged.count, 'entry')} (${s.notLogged.hours} h) not logged since` : `Nothing logged since ${s.searchedBackTo}`;
    return `Week of ${(r as unknown as TimeWeek).weekStart}`;
  }
  if (page === 'work') return `${plural((r as unknown as ItemsPayload).items.length, 'item')} in ${(r as unknown as ItemsPayload).tab}${at}`;
  if (page === 'vdp_detail') {
    const d = r as unknown as VdpDetailPayload;
    const open = d.candidates.filter((c) => OPEN_CANDIDATE_STATUSES.includes(c.status)).length;
    return `${d.companyName}: ${plural(d.steps.length, 'step')}${d.vdp ? ` · ${plural(d.vdp.useCases.length, 'use case')} · ${plural(d.vdp.assets.length, 'asset')} in VDP` : ' · no VDP yet'}${open ? ` · ${open} to add` : ''}`;
  }
  const firstList = Object.values(r).find((v) => Array.isArray(v)) as unknown[] | undefined;
  return firstList ? `Read ${page.replace(/_/g, ' ')} (${plural(firstList.length, 'row')})${at}` : `Read ${page.replace(/_/g, ' ')}${at}`;
}

// ---------------------------------------------------------------------------
// find_items: work items by free text (the old chat_search_items)
// ---------------------------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'my', 'to', 'of', 'for', 'and', 'on', 'in', 'at', 'it', 'is', 'task', 'item', 'thing', 'this', 'that', 'me', 'i', 'until', 'till', 'please']);

export function tokensOf(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/** Token score of an item for a free-text query (title counts double). 0 = no match. */
export function itemScore(w: WorkItem, tokens: string[]): number {
  if (!tokens.length) return 0;
  const title = w.title.toLowerCase();
  const rest = `${w.purpose ?? ''} ${w.why} ${w.refs?.account?.label ?? ''} ${w.stale?.reason ?? ''} ${w.notes}`.toLowerCase();
  let s = 0;
  for (const t of tokens) s += title.includes(t) ? 2 : rest.includes(t) ? 1 : 0;
  return s / tokens.length;
}

/** Items matching the words, best first: the open tabs, then done when nothing open matches (no tab given). */
export async function findItems(ds: DataSource, query: string, opts: { tab?: WorkTab; limit?: number } = {}): Promise<ChatItemHit[]> {
  const listTab = async (tab: WorkTab) => (await ds.listItems({ query: ItemsQuery.parse({ tab }) } as never)).items;
  const tabs: WorkTab[] = opts.tab ? [opts.tab] : ['all_open', 'snoozed', 'promises', 'trainings'];
  const seen = new Map<string, WorkItem>();
  for (const list of await Promise.all(tabs.map(listTab))) for (const w of list) if (!seen.has(w.id)) seen.set(w.id, w);
  const tokens = tokensOf(query);
  let pool = [...seen.values()];
  if (tokens.length) {
    let scored = pool.map((w) => ({ w, s: itemScore(w, tokens) })).filter((x) => x.s > 0);
    if (!scored.length && !opts.tab) scored = (await listTab('done')).map((w) => ({ w, s: itemScore(w, tokens) })).filter((x) => x.s > 0);
    scored.sort((a, b) => b.s - a.s || (a.w.rank ?? 1e9) - (b.w.rank ?? 1e9));
    pool = scored.map((x) => x.w);
  } else pool.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  return (opts.limit ? pool.slice(0, opts.limit) : pool).map(itemHit);
}

const FindArgs = z.object({ q: z.string().trim().min(1).max(200), tab: WorkTab.optional(), limit: z.coerce.number().int().min(1).optional() }).strict();

/** The page's own view of the route's payload (null: the payload as is). */
async function shapedView(ds: DataSource, page: ChatReadPage, raw: unknown, args: Record<string, unknown>, now: Date, call: Call): Promise<unknown> {
  if (!raw) return raw;
  switch (page) {
    case 'time': {
      const w = raw as TimeWeek;
      return { ...weekView(w, { entries: !!args.week }), ...(args.week ? {} : { sinceLastLogged: await sinceLastLogged((week) => call({ query: { week } }) as Promise<TimeWeek>, w, now) }) };
    }
    case 'vdp':
      return vdpView(raw as VdpCoveragePayload);
    case 'vdp_detail':
      return vdpDetailView(raw as VdpDetailPayload);
    case 'triage':
      return triageView(raw as TriagePayload);
    case 'work': {
      const p = raw as ItemsPayload;
      return { tab: p.tab, counts: p.counts, total: p.total, items: p.items.map(itemHit) };
    }
    case 'item':
      return compactDetail(raw as WorkItemDetail);
    case 'calendar':
      return compactCalendar(raw as CalendarPayload);
    case 'outbox':
      return compactOutbox(raw as OutboxPayload);
    case 'health':
      return compactHealth(raw as HealthPayload);
    case 'today': {
      const [settings, outbox, health] = await Promise.all([ds.getSettings({} as never) as Promise<Settings>, ds.getOutbox({} as never) as Promise<OutboxPayload>, ds.getHealth({} as never) as Promise<HealthPayload>]);
      return buildContextPack({ now, timezone: settings.profile.timezone, today: raw as TodayPayload, settings, outbox, health });
    }
    default:
      return raw;
  }
}

/** One read page: its route called with the args (checked by the route's own schemas), shaped, then paged. */
export async function readPage(ds: DataSource, page: ChatReadPage, args: Record<string, unknown>, o: { now: Date; budget?: number; paging?: ReadPageArgs }): Promise<ChatReadResult> {
  const def: PageDef = CHAT_READ_PAGES[page];
  let raw: unknown;
  let shaped: unknown;
  if (page === 'find_items') {
    const f = FindArgs.safeParse(Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '')));
    if (!f.success) throw new ChatReadArgsError(f.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; '));
    const hits = await findItems(ds, f.data.q, { ...(f.data.tab ? { tab: f.data.tab } : {}), ...(f.data.limit ? { limit: f.data.limit } : {}) });
    raw = shaped = { query: f.data.q, total: hits.length, hits };
  } else {
    const call = (ds as unknown as Record<string, Call>)[def.route]!.bind(ds);
    raw = await call(inputFor(def.route, args));
    shaped = await shapedView(ds, page, raw, args, o.now, call);
  }
  const p = pageForModel(shaped, o.paging, o.budget);
  return { page, data: p.value, paging: p.paging, ...(p.more ? { more: p.more } : {}), summary: summaryOf(page, raw, shaped, p.paging) };
}
