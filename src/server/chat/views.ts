/**
 * The Assistant's curated views (Assistant v2, lane 05 §5.1 `query`; README §8 "traverse the data model efficiently").
 *
 * One typed read over the app's data model: each view is a flat table built from the DataSource read methods the UI
 * uses (through `appReadRaw`, so route schemas and persona gates apply), with a one-line description the model sees,
 * its fields, and a test query (tests/llm/chat/views.test.ts runs every one). The `query` tool filters, sorts, picks
 * fields and pages any view; joins the model would otherwise do in its head (an opp's logged hours, an account's last
 * meeting) are columns here.
 *
 * Read only: no view writes, and nothing here calls a connector. Strings are never clipped: a page holds as many rows
 * as fit the read page (`READ_PAGE_CHARS`, the SDK's tool-output size) and says `nextOffset` for the rest.
 */
import type { ActivityEntry, DealsPayload, Settings, WorkItem } from '@/contract';
import { redactPayload } from '@/llm/redact';
import { allows, type Gate, type ResolvedPersona } from '@/personas';

import type { DataSource } from '../datasource/types';
import { appReadRaw } from './app-routes';
import { READ_PAGE_CHARS } from './read';

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;

export interface ViewField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'list';
}

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'null' | 'notnull';
export interface Filter {
  field: string;
  op?: FilterOp;
  value?: Cell | Cell[];
}

export interface QueryArgs {
  view: string;
  where?: Filter[];
  /** Words anywhere in the row's text fields. */
  q?: string;
  /** "field" ascending, "-field" descending. */
  sort?: string;
  fields?: string[];
  offset?: number;
  limit?: number;
  /** View arguments some views need (closure_checks: itemId; work_items: tab; meetings: from/to). */
  args?: Record<string, string>;
}

export interface QueryResult {
  view: string;
  total: number;
  offset: number;
  count: number;
  nextOffset: number | null;
  fields: string[];
  rows: Cell[][];
}

export interface ViewCtx {
  ds: DataSource;
  persona: ResolvedPersona | null;
  args: Record<string, string>;
  /** One turn's cache: two views over the same payload read it once. */
  cache: Map<string, Promise<unknown>>;
}

export interface ViewDef {
  name: string;
  /** One line the model sees (the `query` tool lists every view with it). */
  description: string;
  fields: readonly ViewField[];
  /** View arguments, with what they mean ("itemId (required)"). */
  args?: string;
  /** Persona gate: the view is listed and read only when the feature / connector is active (D-55). */
  gate?: Gate;
  defaultSort?: string;
  rows(ctx: ViewCtx): Promise<Row[]>;
  /** A query that must return without error (the registry test runs it on the mock). */
  test: Omit<QueryArgs, 'view'>;
}

const f = (name: string, type: ViewField['type'] = 'string'): ViewField => ({ name, type });

const read = <T>(c: ViewCtx, route: string, raw: { params?: Record<string, unknown>; query?: Record<string, unknown> } = {}): Promise<T> => {
  const key = `${route}:${JSON.stringify(raw)}`;
  let p = c.cache.get(key);
  if (!p) {
    p = appReadRaw(c.ds, route, c.persona, raw);
    c.cache.set(key, p);
  }
  return p as Promise<T>;
};

const list = (v: unknown[] | null | undefined): string | null => (v && v.length ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ') : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

type Deals = DealsPayload;
type Pipeline = NonNullable<Deals['pipeline']>;
type PipelineRow = Pipeline['rows'][number];

/** Hours and the last row per opportunity from the activity log (the opp's engagement). */
async function engagement(c: ViewCtx): Promise<Map<string, { hours: number; rows: number; last: string | null; loggedH: number }>> {
  const log = await read<{ entries: ActivityEntry[] }>(c, 'getActivityLog');
  const m = new Map<string, { hours: number; rows: number; last: string | null; loggedH: number }>();
  for (const e of log.entries) {
    if (!e.oppId || e.status === 'dismissed') continue;
    const cur = m.get(e.oppId) ?? { hours: 0, rows: 0, last: null, loggedH: 0 };
    cur.hours += e.durationH ?? 0;
    cur.rows += 1;
    if (e.loggedAt) cur.loggedH += e.durationH ?? 0;
    if (!cur.last || e.date > cur.last) cur.last = e.date;
    m.set(e.oppId, cur);
  }
  return m;
}

export const VIEWS: readonly ViewDef[] = [
  {
    name: 'work_items',
    description: 'Your work items (the to-do list): rank, state, due, start-by, account, why it ranks. args.tab: all_open (default), said_by_me, asked_of_me, promises, trainings, snoozed, done.',
    args: 'tab',
    fields: [f('id'), f('title'), f('kind'), f('state'), f('rank', 'number'), f('score', 'number'), f('priority'), f('due', 'date'), f('startBy', 'date'), f('snoozedUntil', 'date'), f('accountId'), f('account'), f('oppId'), f('opp'), f('why'), f('effortMin', 'number'), f('ageDays', 'number'), f('newEvidence', 'number'), f('notes'), f('version', 'number'), f('updatedAt', 'date')],
    defaultSort: 'rank',
    async rows(c) {
      const r = await read<{ items: WorkItem[] }>(c, 'listItems', { query: { tab: c.args.tab ?? 'all_open' } });
      return r.items.map((w) => {
        const refs = (w as unknown as { refs?: { account?: { label?: string }; opp?: { label?: string } } }).refs;
        return {
          id: w.id,
          title: w.title,
          kind: w.kind,
          state: w.state,
          rank: num(w.rank),
          score: num((w as unknown as { score?: number }).score),
          priority: str((w as unknown as { priority?: string }).priority),
          due: str(w.due),
          startBy: str(w.startBy),
          snoozedUntil: str(w.snoozedUntil),
          accountId: str(w.accountId),
          account: str(refs?.account?.label),
          oppId: str(w.oppId),
          opp: str(refs?.opp?.label),
          why: str(w.why),
          effortMin: num(w.effort?.youMin),
          ageDays: num((w as unknown as { ageDays?: number }).ageDays),
          newEvidence: num((w as unknown as { newEvidenceCount?: number }).newEvidenceCount),
          notes: str(w.notes),
          version: w.version,
          updatedAt: str(w.updatedAt),
        };
      });
    },
    test: { limit: 5 },
  },
  {
    name: 'needs',
    description: 'What your deals need from you (Deals ▸ Needs): a missing DC, a VDP, a next step; with the verb that fixes it.',
    fields: [f('id'), f('section'), f('accountId'), f('account'), f('title'), f('why'), f('badge'), f('verb'), f('href'), f('rank', 'number')],
    async rows(c) {
      const d = await read<Deals>(c, 'getDeals');
      return (d.needs ?? []).map((n) => ({ id: n.id, section: n.section, accountId: str(n.accountId), account: str(n.accountName), title: n.title, why: str(n.why), badge: str(n.badge), verb: str(n.verb?.label), href: str(n.verb?.href), rank: num(n.rank) }));
    },
    test: { limit: 5 },
  },
  {
    name: 'people',
    description: 'People the app knows (customers, teammates): name, email, role, account, external or not.',
    fields: [f('id'), f('name'), f('email'), f('role'), f('title'), f('accountId'), f('account'), f('isExternal', 'boolean'), f('isManager', 'boolean'), f('slackId')],
    async rows(c) {
      const r = await read<{ people: Array<{ id: string; name: string; email: string | null; slackId: string | null; role: string | null; title: string | null; account: { id: string; label: string } | null; isExternal: boolean; isManager: boolean }> }>(c, 'getPeople', { query: { q: c.args.q ?? '', limit: '100' } });
      return r.people.map((p) => ({ id: p.id, name: p.name, email: str(p.email), role: str(p.role), title: str(p.title), accountId: p.account?.id ?? null, account: p.account?.label ?? null, isExternal: p.isExternal, isManager: p.isManager, slackId: str(p.slackId) }));
    },
    test: { limit: 5 },
  },
  {
    name: 'accounts',
    description: 'Your accounts with engagement: DC and VDP status, hours this quarter, open opps and tasks, pipeline, next close.',
    fields: [f('id'), f('name'), f('industry'), f('dcStatus'), f('vdpStatus'), f('hoursQtd', 'number'), f('openOpps', 'number'), f('openTasks', 'number'), f('pipelineAmount', 'number'), f('nextCloseDate', 'date'), f('myDcs', 'number'), f('org62Url')],
    defaultSort: '-hoursQtd',
    async rows(c) {
      const d = await read<Deals>(c, 'getDeals');
      return d.accounts.map((a) => ({ id: a.id, name: a.name, industry: str(a.industry), dcStatus: str(a.dcStatus), vdpStatus: str(a.vdpStatus), hoursQtd: num(a.hoursQtd), openOpps: num(a.openOpps), openTasks: num(a.openTasks), pipelineAmount: num(a.pipelineAmount), nextCloseDate: str(a.nextCloseDate), myDcs: Array.isArray(a.myDcs) ? a.myDcs.length : null, org62Url: str(a.org62Url) }));
    },
    test: { sort: '-hoursQtd', limit: 3 },
  },
  {
    name: 'opps',
    description: 'Opportunities on your pipeline with engagement: stage, amount, close, forecast, your DC split, and the hours and last day logged against each (from Time).',
    fields: [f('id'), f('accountId'), f('account'), f('name'), f('stage'), f('amount', 'number'), f('closeDate', 'date'), f('quarter'), f('forecast'), f('category'), f('isOpen', 'boolean'), f('isWon', 'boolean'), f('nextStep'), f('via'), f('dcSplit', 'number'), f('hours', 'number'), f('loggedHours', 'number'), f('timeRows', 'number'), f('lastActivity', 'date'), f('attention', 'list'), f('url')],
    defaultSort: 'closeDate',
    async rows(c) {
      const [d, eng] = await Promise.all([read<Deals>(c, 'getDeals'), engagement(c)]);
      return (d.pipeline?.rows ?? []).map((o: PipelineRow) => {
        const e = eng.get(o.oppId ?? o.id);
        return { id: o.oppId ?? o.id, accountId: str(o.accountId), account: str(o.accountName), name: o.name, stage: str(o.stage), amount: num(o.amount), closeDate: str(o.closeDate), quarter: str(o.quarter), forecast: str(o.forecastLabel), category: str(o.category), isOpen: !!o.isOpen, isWon: !!o.isWon, nextStep: str(o.nextStep), via: str(o.via), dcSplit: num(o.dcSplit), hours: e ? Math.round(e.hours * 100) / 100 : 0, loggedHours: e ? Math.round(e.loggedH * 100) / 100 : 0, timeRows: e?.rows ?? 0, lastActivity: e?.last ?? null, attention: list(o.attention as unknown[]), url: str(o.url) };
      });
    },
    test: { where: [{ field: 'isOpen', value: true }], limit: 5 },
  },
  {
    name: 'my_dcs',
    description: 'Your deal contributions (DCs) as Org62 has them: opp, account, split, role, open or not; and DC requests waiting.',
    gate: { feature: 'dealContributions' },
    fields: [f('oppId'), f('opp'), f('accountId'), f('account'), f('split', 'number'), f('role'), f('isOpen', 'boolean'), f('org62DcId'), f('lastSeenAt', 'date')],
    async rows(c) {
      const r = await read<{ myDcs: Array<{ split: number; role: string | null; org62DcId: string | null; lastSeenAt: string | null; oppId: string | null; oppName: string | null; accountId: string | null; accountName: string | null; isOpen: boolean }> }>(c, 'listDcRequests');
      return r.myDcs.map((d) => ({ oppId: d.oppId, opp: d.oppName, accountId: d.accountId, account: d.accountName, split: d.split, role: d.role, isOpen: d.isOpen, org62DcId: d.org62DcId, lastSeenAt: d.lastSeenAt }));
    },
    test: { limit: 5 },
  },
  {
    name: 'time_entries',
    description: 'Time rows (Activity ▸ To log and History): day, hours, task type, opp, status (proposed, approved, handed_off, logged …), logged when. args.from / args.to: YYYY-MM-DD.',
    args: 'from, to',
    fields: [f('id'), f('date', 'date'), f('start', 'date'), f('end', 'date'), f('hours', 'number'), f('taskType'), f('meetingType'), f('oppId'), f('opp'), f('account'), f('description'), f('status'), f('confidence'), f('loggedAt', 'date'), f('issues', 'list'), f('version', 'number')],
    defaultSort: '-date',
    async rows(c) {
      const q: Record<string, string> = {};
      if (c.args.from) q.from = c.args.from;
      if (c.args.to) q.to = c.args.to;
      const r = await read<{ entries: ActivityEntry[] }>(c, 'getActivityLog', { query: q });
      return r.entries.map((e) => ({ id: e.id, date: e.date, start: str(e.start), end: str(e.end), hours: num(e.durationH), taskType: str(e.taskType), meetingType: str(e.meetingType), oppId: str(e.oppId), opp: str(e.oppName), account: str(e.accountName), description: str(e.description), status: e.status, confidence: str(e.confidence), loggedAt: str(e.loggedAt), issues: list(e.issues as unknown[]), version: e.version }));
    },
    test: { sort: '-date', limit: 5 },
  },
  {
    name: 'canvases',
    description: 'Logging canvases and other admin items in the Outbox (waiting for your Apply, applied, failed).',
    fields: [f('id'), f('kind'), f('title'), f('state'), f('at', 'date'), f('href')],
    async rows(c) {
      const o = await read<{ admin?: { items?: Array<Record<string, unknown>>; applied?: Array<Record<string, unknown>> } }>(c, 'getOutbox');
      const rows = [...(o.admin?.items ?? []), ...(o.admin?.applied ?? [])];
      return rows.map((x) => ({ id: String(x.id ?? x.draftId ?? ''), kind: str(x.kind), title: str(x.title ?? x.label), state: str(x.state ?? x.status), at: str(x.at ?? x.appliedAt ?? x.updatedAt), href: str(x.href) }));
    },
    test: { limit: 5 },
  },
  {
    name: 'meetings',
    description: 'Your calendar as the app has it (default today): title, time, account, opp, customer-facing, attendance. args.from / args.to: ISO instants.',
    args: 'from, to',
    fields: [f('id'), f('title'), f('start', 'date'), f('end', 'date'), f('accountId'), f('oppId'), f('customerFacing', 'boolean'), f('attendance'), f('organizer'), f('attendees', 'number')],
    defaultSort: 'start',
    async rows(c) {
      const q: Record<string, string> = {};
      if (c.args.from) q.from = c.args.from;
      if (c.args.to) q.to = c.args.to;
      const r = await read<{ events: Array<{ id: string; title: string; start: string; end: string; accountId: string | null; oppId: string | null; isCustomerFacing: boolean; attendance: string | null; organizer: { name: string } | null; attendees: unknown[] }> }>(c, 'getCalendar', { query: q });
      return r.events.map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, accountId: e.accountId, oppId: e.oppId, customerFacing: e.isCustomerFacing, attendance: e.attendance, organizer: e.organizer?.name ?? null, attendees: e.attendees?.length ?? 0 }));
    },
    test: { limit: 5 },
  },
  {
    name: 'vdp_records',
    description: 'Your VDPs (Activity ▸ VDP): company, fiscal period, opp, use cases, assets, open steps and what the app can fix.',
    gate: { feature: 'vdp' },
    fields: [f('vdpSlug'), f('company'), f('accountId'), f('fiscalYear', 'number'), f('fiscalQuarter', 'number'), f('opp'), f('useCases', 'number'), f('useCasesWithAi', 'number'), f('assets', 'number'), f('hasAe', 'boolean'), f('hasTa', 'boolean'), f('status'), f('open', 'number'), f('appCanFix', 'number'), f('lastActivityAt', 'date'), f('url')],
    async rows(c) {
      const r = await read<{ vdps: Array<Record<string, unknown> & { status?: { label?: string; open?: number; appCanFix?: number } }> }>(c, 'getVdpCoverage');
      return r.vdps.map((v) => ({ vdpSlug: str(v.vdpSlug), company: str(v.companyName), accountId: str(v.accountId), fiscalYear: num(v.fiscalYear), fiscalQuarter: num(v.fiscalQuarter), opp: str(v.opportunityName), useCases: num(v.useCaseCount), useCasesWithAi: num(v.useCaseWithAiCount), assets: num(v.assetCount), hasAe: !!v.hasAe, hasTa: !!v.hasTa, status: str(v.status?.label), open: num(v.status?.open), appCanFix: num(v.status?.appCanFix), lastActivityAt: str(v.lastActivityAt), url: str(v.url) }));
    },
    test: { limit: 5 },
  },
  {
    name: 'use_cases',
    description: 'Use cases across VDP and Org62 (create, update, in a canvas, in Org62, drift): company, title, track, opp, state, why.',
    gate: { feature: 'vdp' },
    fields: [f('key'), f('company'), f('title'), f('track'), f('opp'), f('state'), f('why'), f('org62UseCaseId'), f('vdpSlug'), f('drift', 'list')],
    async rows(c) {
      const r = await read<{ items: Array<Record<string, unknown>> }>(c, 'getUseCaseSync');
      return r.items.map((u) => ({ key: String(u.key), company: str(u.companyName), title: str(u.title), track: str(u.track), opp: str(u.oppName), state: str(u.state), why: str(u.why), org62UseCaseId: str(u.org62UseCaseId), vdpSlug: str(u.vdpSlug), drift: list(u.drift as unknown[]) }));
    },
    test: { limit: 5 },
  },
  {
    name: 'closure_checks',
    description: "One item's resolution checks (\"why is this still open?\"): verdict, basis, rule, model, when; and what triggers the next. args.itemId (required).",
    args: 'itemId (required)',
    fields: [f('itemId'), f('at', 'date'), f('trigger'), f('outcome'), f('verdict'), f('basis'), f('rule'), f('decidedBy'), f('confidence', 'number'), f('mode'), f('nextCheck')],
    async rows(c) {
      if (!c.args.itemId) throw new ViewArgsError('closure_checks needs args.itemId');
      const r = await read<{ itemId: string; mode: string; last: Record<string, unknown> | null; history: Array<Record<string, unknown>>; nextCheck: string }>(c, 'getResolutionCheck', { params: { id: c.args.itemId } });
      const all = [...(r.last ? [r.last] : []), ...r.history];
      const row = (x: Record<string, unknown> | null): Row => ({ itemId: r.itemId, at: str(x?.at), trigger: str(x?.trigger), outcome: str(x?.outcome), verdict: str(x?.verdict), basis: str(x?.basis), rule: str(x?.ruleHit ?? x?.rule), decidedBy: str(x?.decidedBy), confidence: num(x?.confidence), mode: r.mode, nextCheck: r.nextCheck });
      return all.length ? all.map(row) : [row(null)];
    },
    test: { args: { itemId: 'w_acme_build' } },
  },
  {
    name: 'spend_holds',
    description: "The spend governor's holds (every model run's estimate, what it held, spent, asked): scope, state, $.",
    fields: [f('id'), f('scope'), f('jobKey'), f('state'), f('p50', 'number'), f('p90', 'number'), f('heldUsd', 'number'), f('spentUsd', 'number'), f('askedAt', 'date'), f('createdAt', 'date')],
    defaultSort: '-createdAt',
    async rows(c) {
      const r = await read<{ holds: Array<{ id: string; scope: string; jobKey: string; state: string; estimate: { p50: number; p90: number }; heldUsd: number; spentUsd: number; askedAt: string | null; createdAt: string }> }>(c, 'listSpendHolds');
      return r.holds.map((h) => ({ id: h.id, scope: h.scope, jobKey: h.jobKey, state: h.state, p50: h.estimate?.p50 ?? null, p90: h.estimate?.p90 ?? null, heldUsd: h.heldUsd, spentUsd: h.spentUsd, askedAt: h.askedAt, createdAt: h.createdAt }));
    },
    test: { limit: 5 },
  },
  {
    name: 'settings',
    description: 'Your settings, one row per value: section, key, value (JSON). The sending and budgets sections are read-only to the Assistant.',
    fields: [f('section'), f('key'), f('value')],
    async rows(c) {
      const s = await read<Settings>(c, 'getSettings');
      const out: Row[] = [];
      for (const [section, v] of Object.entries(s)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          out.push({ section, key: '', value: JSON.stringify(v) });
          continue;
        }
        for (const [key, val] of Object.entries(v as Record<string, unknown>)) out.push({ section, key, value: typeof val === 'string' ? val : JSON.stringify(redactPayload(val).value) });
      }
      return out;
    },
    test: { where: [{ field: 'section', value: 'chat' }] },
  },
];

export class ViewArgsError extends Error {}

export const VIEW_NAMES = VIEWS.map((v) => v.name);
export const viewOf = (name: string) => VIEWS.find((v) => v.name === name);

/** The persona's views (D-55: a view of an inactive feature is not listed or read). */
export const viewsFor = (p: ResolvedPersona | null | undefined) => VIEWS.filter((v) => p === undefined || allows(p ?? null, v.gate));

/** The `query` tool's view index: one line each, deterministic per persona (cached prefix). */
export function viewCatalog(p: ResolvedPersona | null | undefined): string {
  return viewsFor(p)
    .map((v) => `- ${v.name}: ${v.description} Fields: ${v.fields.map((x) => x.name).join(', ')}.`)
    .join('\n');
}

const cmp = (a: Cell, b: Cell): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
};

function matches(row: Row, w: Filter): boolean {
  const v = row[w.field] ?? null;
  const op = w.op ?? (Array.isArray(w.value) ? 'in' : 'eq');
  const want = w.value ?? null;
  switch (op) {
    case 'eq':
      return typeof want === 'string' && typeof v === 'string' ? v.toLowerCase() === want.toLowerCase() : v === want;
    case 'ne':
      return typeof want === 'string' && typeof v === 'string' ? v.toLowerCase() !== want.toLowerCase() : v !== want;
    case 'gt':
      return v !== null && cmp(v, want as Cell) > 0;
    case 'gte':
      return v !== null && cmp(v, want as Cell) >= 0;
    case 'lt':
      return v !== null && cmp(v, want as Cell) < 0;
    case 'lte':
      return v !== null && cmp(v, want as Cell) <= 0;
    case 'in':
      return (Array.isArray(want) ? want : [want]).some((x) => (typeof x === 'string' && typeof v === 'string' ? x.toLowerCase() === v.toLowerCase() : x === v));
    case 'contains':
      return v !== null && String(v).toLowerCase().includes(String(want ?? '').toLowerCase());
    case 'null':
      return v === null;
    case 'notnull':
      return v !== null;
  }
}

/** Run one query over a view: filter → sort → fields → page (never a cut string; rows that don't fit go to the next page). */
export async function runQuery(ds: DataSource, persona: ResolvedPersona | null, a: QueryArgs, o: { cache?: Map<string, Promise<unknown>>; pageChars?: number } = {}): Promise<QueryResult> {
  const v = viewOf(a.view);
  if (!v) throw new ViewArgsError(`no view "${a.view}" (views: ${VIEW_NAMES.join(', ')})`);
  if (!allows(persona, v.gate)) throw new ViewArgsError(`${a.view} is not active for your role (Settings ▸ Role & rules)`);
  const known = new Set(v.fields.map((x) => x.name));
  const bad = [...(a.where ?? []).map((w) => w.field), ...(a.fields ?? []), ...(a.sort ? [a.sort.replace(/^-/, '')] : [])].filter((x) => !known.has(x));
  if (bad.length) throw new ViewArgsError(`${a.view} has no field ${[...new Set(bad)].join(', ')} (fields: ${[...known].join(', ')})`);
  let rows = await v.rows({ ds, persona, args: a.args ?? {}, cache: o.cache ?? new Map() });
  for (const w of a.where ?? []) rows = rows.filter((r) => matches(r, w));
  if (a.q) {
    const words = a.q.toLowerCase().split(/\s+/).filter(Boolean);
    rows = rows.filter((r) => {
      const t = Object.values(r).filter((x) => typeof x === 'string').join(' ').toLowerCase();
      return words.every((w) => t.includes(w));
    });
  }
  const sort = a.sort ?? v.defaultSort;
  if (sort) {
    const desc = sort.startsWith('-');
    const key = sort.replace(/^-/, '');
    rows = [...rows].sort((x, y) => (desc ? -1 : 1) * cmp(x[key] ?? null, y[key] ?? null));
  }
  const fields = a.fields?.length ? a.fields : v.fields.map((x) => x.name);
  const total = rows.length;
  const offset = Math.max(0, a.offset ?? 0);
  const budget = o.pageChars ?? READ_PAGE_CHARS;
  const out: Cell[][] = [];
  let used = 0;
  for (let i = offset; i < total; i++) {
    if (a.limit !== undefined && out.length >= a.limit) break;
    const cells = fields.map((k) => rows[i]![k] ?? null);
    const size = JSON.stringify(cells).length;
    if (out.length && used + size > budget) break;
    out.push(cells);
    used += size;
  }
  const end = offset + out.length;
  return { view: v.name, total, offset, count: out.length, nextOffset: end < total ? end : null, fields, rows: out };
}
