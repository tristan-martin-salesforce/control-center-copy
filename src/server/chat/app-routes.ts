/**
 * The Assistant's general abilities over the app's own API (D-58): any `read` route through `read`, any
 * `stage` route staged through `propose kind calls` (one proposal card of `route_call` changes, applied only by the
 * user's Apply). Every route in src/contract/routes.ts says which it is (`assistant`); `deny` routes (send, dispatch,
 * apply, undo, re-auth, launch, scan, dev, GETs that write) are never called.
 *
 * Inputs are checked with the route's own params / query / body schemas, exactly as the HTTP handler does
 * (src/server/http.ts), and the persona's gates (ROUTE_GATES) hide routes of inactive features. Shared by both
 * DataSources: reads and applies go through the public DataSource methods, the same the UI calls.
 */
import { z } from 'zod';

import { ChatChange, routes, ROUTE_KEYS, type AddOrg62OppsResult, type AssistantUse, type EntityRef, type EntityType, type FieldChange, type ReceiptChange, type ReceiptFailure, type RouteDef, type RouteKey } from '@/contract';
import { redactText } from '@/llm/redact';
import { allows, ROUTE_GATES, type ResolvedPersona } from '@/personas';

import type { DataSource } from '../datasource/types';
import { cleanForModel, pageForModel, READ_PAGE_CHARS, type ReadPageArgs, type ReadPageInfo } from './read';
import { ORG62_OPPS_BY_IDS_MAX } from './org62';

export type RouteCall = Extract<ChatChange, { op: 'route_call' }>;

export class AppRouteError extends Error {}

const defOf = (k: RouteKey) => routes[k] as RouteDef;
export const assistantUseOf = (k: RouteKey): AssistantUse | undefined => defOf(k).assistant;
const isRouteKey = (k: string): k is RouteKey => (ROUTE_KEYS as string[]).includes(k);

/**
 * Routes of one kind the persona sees (ROUTE_GATES hides inactive features), in route-table order. A read is a GET, or
 * a POST the route table marks read (it only computes or reads: previewPolicy, searchOrg62Opps).
 */
export function appRoutes(use: 'read' | 'stage', persona: ResolvedPersona | null): RouteKey[] {
  return ROUTE_KEYS.filter((k) => {
    const d = defOf(k);
    if (d.assistant !== use || d.dev || d.stream) return false;
    return allows(persona, ROUTE_GATES[k]);
  });
}

/** The object schema under defaults, optionals and refinements (null when the part is not an object). */
function objectOf(s: z.ZodTypeAny | undefined): z.AnyZodObject | null {
  let x: z.ZodTypeAny | undefined = s;
  for (let i = 0; i < 8 && x; i++) {
    if (x instanceof z.ZodObject) return x;
    if (x instanceof z.ZodEffects) x = x.innerType();
    else if (x instanceof z.ZodDefault || x instanceof z.ZodOptional || x instanceof z.ZodNullable) x = x._def.innerType as z.ZodTypeAny;
    else return null;
  }
  return null;
}
const keysOf = (s: z.ZodTypeAny | undefined): string[] => Object.keys(objectOf(s)?.shape ?? {});

/**
 * One line per route: `key METHOD /path {params; query; body keys}: summary`. Deterministic (the tool description).
 * `skip`: routes left out of the list (a page covers them); they still work.
 */
export function appRouteCatalog(use: 'read' | 'stage', persona: ResolvedPersona | null, skip: ReadonlySet<RouteKey> = new Set()): string {
  return appRoutes(use, persona)
    .filter((k) => !skip.has(k))
    .map((k) => {
      const d = defOf(k);
      const parts = [
        keysOf(d.params).length ? `params ${keysOf(d.params).join(', ')}` : '',
        keysOf(d.query).length ? `query ${keysOf(d.query).join(', ')}` : '',
        keysOf(d.body).length ? `body ${keysOf(d.body).join(', ')}` : '',
      ].filter(Boolean);
      return `${k} ${d.method} ${d.path}${parts.length ? ` {${parts.join('; ')}}` : ''}${d.undoable ? ' [undoable]' : ''}: ${d.summary}`;
    })
    .join('\n');
}

const issues = (e: z.ZodError, part: string) => e.issues.slice(0, 5).map((i) => `${part}.${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

/**
 * The route, its use checked (and the persona's gate), and its input parsed by its own schemas: params and query as
 * the URL would carry them (strings), the body as JSON. Unknown keys in params or query are refused.
 */
export function appRouteInput(route: string, use: 'read' | 'stage', persona: ResolvedPersona | null, raw: { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown }): { key: RouteKey; input: Record<string, unknown> } {
  if (!isRouteKey(route)) throw new AppRouteError(`no route "${route}" (pick one from the list in the tool description)`);
  const d = defOf(route);
  if (d.assistant !== use) {
    const why = d.assistant === 'deny' || !d.assistant ? 'the Assistant may never call it (it sends, applies a proposal, re-auths, scans, launches, or raises its own budget)' : d.assistant === 'read' ? 'it is a read: use read' : 'it changes the app: stage it with propose';
    throw new AppRouteError(`${route}: ${why}`);
  }
  if (!allows(persona, ROUTE_GATES[route])) throw new AppRouteError(`${route}: not active for your role (Settings ▸ Role & rules lists it as available)`);
  const input: Record<string, unknown> = {};
  for (const part of ['params', 'query'] as const) {
    const schema = d[part];
    const given = Object.fromEntries(Object.entries(raw[part] ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
    if (!schema) {
      if (Object.keys(given).length) throw new AppRouteError(`${route} takes no ${part}`);
      continue;
    }
    const allowed = keysOf(schema);
    const extra = Object.keys(given).filter((k) => !allowed.includes(k));
    if (extra.length) throw new AppRouteError(`${route}: unknown ${part} ${extra.join(', ')} (it takes ${allowed.join(', ') || 'none'})`);
    const r = schema.safeParse(given);
    if (!r.success) throw new AppRouteError(`${route}: ${issues(r.error, part)}`);
    input[part] = r.data;
  }
  if (d.body) {
    const r = d.body.safeParse(raw.body ?? undefined);
    if (!r.success) throw new AppRouteError(`${route}: ${issues(r.error, 'body')}`);
    input.body = r.data;
  } else if (raw.body !== undefined && raw.body !== null && !(typeof raw.body === 'object' && !Object.keys(raw.body as object).length)) throw new AppRouteError(`${route} takes no body`);
  guardInput(route, input);
  return { key: route, input };
}

/**
 * Settings keys the Assistant never stages, even for the user's Apply (SEC-5, 17-security-review): what program the
 * app runs on this Mac (VDP's refresh script and its interpreter, which `run reauth` then starts) and where a live
 * post goes (the feedback channel and its Post live switch). Untrusted Slack/Gmail/Drive text reaches the model, so a
 * card that changes these could be a planted one; they are changed in Settings only.
 */
export const ASSISTANT_LOCKED_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  scanning: ['vdpRefreshScript', 'vdpPython'],
  feedback: ['channelId', 'channelName', 'postLive'],
};

/**
 * Changes a stage route must not carry even with the user's Apply: the sending section (dry run, channel modes), the
 * locked keys above and a settings confirm are the user's alone, in Settings (tenet: nothing leaves without approval,
 * and dry run is theirs).
 */
function guardInput(key: RouteKey, input: Record<string, unknown>) {
  if (key !== 'patchSettings') return;
  const section = (input.params as { section?: string } | undefined)?.section;
  const body = input.body as { confirm?: boolean; value?: Record<string, unknown> } | undefined;
  if (section === 'sending') throw new AppRouteError('patchSettings: the sending settings (dry run, send modes) are yours to change in Settings ▸ Sending; the Assistant never stages them');
  const locked = (section && ASSISTANT_LOCKED_SETTINGS[section]?.filter((k) => body?.value && Object.hasOwn(body.value, k))) || [];
  if (locked.length) throw new AppRouteError(`patchSettings: ${section}.${locked.join(', ')} ${locked.length === 1 ? 'is' : 'are'} yours to change in Settings; the Assistant never stages ${locked.length === 1 ? 'it' : 'them'}`);
  if (body?.confirm) throw new AppRouteError('patchSettings: a confirmed save is yours to make in Settings');
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

type Call = (input: unknown) => Promise<unknown>;
const methodOf = (ds: DataSource, key: RouteKey): Call => {
  const fn = (ds as unknown as Record<string, Call | undefined>)[key];
  if (typeof fn !== 'function') throw new AppRouteError(`${key} is not available here`);
  return fn.bind(ds);
};

/** One read of a route, whole (Assistant v2 views, src/server/chat/views.ts: they page their own rows). */
export async function appReadRaw(ds: DataSource, route: string, persona: ResolvedPersona | null, raw: { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown } = {}): Promise<unknown> {
  const { key, input } = appRouteInput(route, 'read', persona, raw);
  return methodOf(ds, key)(input);
}

/** One read of a route, paged (A1): `paging` picks the page; the result says `page.total` and `page.nextOffset`. */
export async function appRead(ds: DataSource, route: string, persona: ResolvedPersona | null, raw: { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown }, paging: ReadPageArgs = {}, budget = READ_PAGE_CHARS): Promise<{ route: RouteKey; data: unknown; paging: ReadPageInfo | null; more?: Record<string, { shown: number; total: number; nextOffset: number }>; summary: string }> {
  const { key, input } = appRouteInput(route, 'read', persona, raw);
  const data = await methodOf(ds, key)(input);
  const p = pageForModel(data, paging, budget);
  const first = data && typeof data === 'object' ? Object.entries(data as Record<string, unknown>).find(([, v]) => Array.isArray(v)) : undefined;
  const at = p.paging && (p.paging.offset > 0 || p.paging.nextOffset !== null) ? ` · rows ${p.paging.offset + 1}–${p.paging.offset + p.paging.count} of ${p.paging.total}` : '';
  return { route: key, data: p.value, paging: p.paging, ...(p.more ? { more: p.more } : {}), summary: first ? `Read ${key} (${(first[1] as unknown[]).length} ${first[0]})${at}` : `Read ${key}${at}` };
}

// ---------------------------------------------------------------------------
// Stage: the preview (best-effort before → after, read through the entity's GET first)
// ---------------------------------------------------------------------------

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const show = (v: unknown): unknown => (v === undefined ? null : typeof v === 'string' ? short(redactText(v), 160) : v !== null && typeof v === 'object' ? short(JSON.stringify(cleanForModel(v, 0, 60, null) ?? null), 160) : v);

/** Route → the entity type its receipt line names. */
const ENTITY: Partial<Record<RouteKey, EntityType>> = {
  captureItem: 'work_item',
  patchItem: 'work_item',
  itemAction: 'work_item',
  regenerateNba: 'nba',
  rejectProposal: 'proposal',
  patchDraft: 'draft',
  queueDraft: 'draft',
  rejectDraft: 'draft',
  draftVdpUpdate: 'draft',
  stageLogBatch: 'draft',
  patchActivity: 'activity_entry',
  pickOrg62Opp: 'activity_entry',
  resolveActivity: 'activity_entry',
  correctOnsiteDay: 'activity_entry',
  markTrip: 'activity_entry',
  dismissFromSource: 'activity_entry',
  removeTimeDismissRule: 'activity_entry',
  addOrg62Opps: 'opportunity',
  createDcRequest: 'opportunity',
  patchDcRequest: 'opportunity',
  withdrawDcRequest: 'opportunity',
  claimMissed: 'missed_opp',
  dismissMissed: 'missed_opp',
  setVdpCandidate: 'vdp',
  promoteHighlight: 'brief_highlight',
  taskFromHighlight: 'brief_highlight',
  dismissHighlight: 'brief_highlight',
  createWatch: 'watch',
  patchWatch: 'watch',
  acceptTriage: 'triage_mapping',
  dismissTriage: 'triage_mapping',
  mergeTriage: 'triage_mapping',
  ackEvent: 'event_log',
  patchSettings: 'settings',
  revertPolicy: 'policy',
  rerankToday: 'policy',
  answerAgent: 'agent_run',
  cancelAgent: 'agent_run',
  requestReadIn: 'work_item',
  // A9 (2026-11-13): every stage route names its entity
  markItemSeen: 'work_item',
  setVdpIdentity: 'vdp',
  clearVdpIdentity: 'vdp',
  decideNeed: 'opportunity',
  clearNeedDecision: 'opportunity',
  syncForecast: 'specialist_forecast',
  patchForecast: 'specialist_forecast',
  stageForecast: 'draft',
  checkMissingForecast: 'opportunity',
  retryJob: 'job',
  undoAudit: 'event_log',
};

const labelOf = (v: unknown): string | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  for (const k of ['title', 'name', 'oppName', 'label', 'description', 'subject']) if (typeof o[k] === 'string' && o[k]) return short(redactText(o[k] as string));
  for (const k of ['item', 'draft', 'entity']) {
    const x = labelOf(o[k]);
    if (x) return x;
  }
  return null;
};

/** What the DC routes' previews read: my DCs and my requests (listDcRequests). */
type DcList = {
  requests: Array<{ id: string; oppId: string; oppName: string; org62OpportunityId: string | null; kind: string; fromSplit: number | null; splitPercent: number; role: string; comment: string | null; status: string; stage: string; lockedReason: string | null; dc: { split: number | null; role: string | null } | null }>;
  myDcs?: Array<{ oppId: string; oppName: string; org62OpportunityId: string | null; split: number | null; role: string | null }>;
};

/** A DC route's receipt line: add vs change, then where it goes. */
function dcReceipt(key: RouteKey, ent: Record<string, unknown> | undefined): string {
  const e = (ent ?? {}) as { kind?: string; fromSplit?: number | null; splitPercent?: number };
  if (key === 'withdrawDcRequest') return 'withdrawn';
  const what = e.kind === 'change' ? `change ${e.fromSplit ?? '?'}% → ${e.splitPercent ?? ''}%` : `${e.splitPercent ?? ''}%`;
  return `${what} · next logging canvas`;
}

/** Receipt line labels (short: the receipt's columns are narrow). */
const LINE_LABEL: Partial<Record<RouteKey, string>> = { addOrg62Opps: 'Added from Org62', createDcRequest: 'DC claim', patchDcRequest: 'DC request edited', withdrawDcRequest: 'DC request withdrawn', captureItem: 'Captured', stageLogBatch: 'Logging canvas', draftVdpUpdate: 'VDP change', queueDraft: 'Added to Outbox', rejectDraft: 'Rejected', stageForecast: 'Forecast canvas', decideNeed: 'Set aside', clearNeedDecision: 'Brought back', setVdpIdentity: 'VDP company', clearVdpIdentity: 'VDP company cleared', markItemSeen: 'Marked seen', retryJob: 'Job requeued', undoAudit: 'Undone', syncForecast: 'Forecast sync queued', checkMissingForecast: 'Forecast check queued' };

// ---------------------------------------------------------------------------
// A4: ifVersion. A staged PATCH needs the entity's version; when the model leaves it out, the app fills in the one
// the preview read (so a change between staging and Apply is still a real "changed since"), and at Apply the current
// one for a card staged without it. The user's Apply is the intent.
// ---------------------------------------------------------------------------

/** Reads shared by one preview or one Apply (each entity list read at most once). */
export type ReadCache = Map<string, Promise<unknown>>;
const cached = <T>(cache: ReadCache, key: string, f: () => Promise<T>): Promise<T | null> => {
  if (!cache.has(key)) cache.set(key, f().catch(() => null));
  return cache.get(key) as Promise<T | null>;
};
const readVia = (ds: DataSource, cache: ReadCache, k: RouteKey, input: unknown) => cached(cache, `${k}:${JSON.stringify(input)}`, () => methodOf(ds, k)(input));

/** The entity's current version for a route whose body takes `ifVersion` (null: no reader, or no such entity). */
async function currentVersion(ds: DataSource, cache: ReadCache, key: RouteKey, params: Record<string, unknown>): Promise<number | null> {
  const id = String(params.id ?? '');
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  switch (key) {
    case 'patchItem':
    case 'itemAction':
    case 'regenerateNba':
      return num(((await readVia(ds, cache, 'getItem', { params: { id } })) as { item?: { version?: unknown } } | null)?.item?.version);
    case 'patchDraft':
    case 'queueDraft':
    case 'rejectDraft':
      return num(((await readVia(ds, cache, 'getDraft', { params: { id } })) as { version?: unknown } | null)?.version);
    case 'patchActivity':
    case 'resolveActivity':
    case 'pickOrg62Opp':
      return num((await activityOf(ds, cache, id))?.version);
    case 'patchWatch':
      return num(((await readVia(ds, cache, 'listWatches', {})) as { watches?: Array<{ id: string; version?: unknown }> } | null)?.watches?.find((w) => w.id === id)?.version);
    case 'patchSettings':
      return num(((await readVia(ds, cache, 'getSettings', {})) as Record<string, { version?: unknown }> | null)?.[String(params.section ?? '')]?.version);
    case 'revertPolicy':
      return num(((await readVia(ds, cache, 'getSettings', {})) as { policy?: { version?: unknown } } | null)?.policy?.version);
    default:
      return null;
  }
}

/** One activity row by id (the whole log, read once per preview or Apply). */
async function activityOf(ds: DataSource, cache: ReadCache, id: string): Promise<{ id: string; version: number; status: string; description: string } | null> {
  const log = (await readVia(ds, cache, 'getActivityLog', { query: {} })) as { entries?: Array<{ id: string; version: number; status: string; description: string }> } | null;
  return log?.entries?.find((e) => e.id === id) ?? null;
}

/** Whether the route's body schema has an `ifVersion` key. */
const takesVersion = (k: RouteKey) => keysOf(defOf(k).body).includes('ifVersion');

/** The call's body with `ifVersion` filled in when the route takes one and the model left it out (A4). */
export async function withVersion(ds: DataSource, cache: ReadCache, c: Pick<RouteCall, 'route' | 'params' | 'body'>): Promise<{ body: unknown; filled: boolean }> {
  const body = c.body;
  if (!isRouteKey(c.route) || !takesVersion(c.route)) return { body, filled: false };
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : body === undefined || body === null ? {} : null;
  if (!b || (b.ifVersion !== undefined && b.ifVersion !== null)) return { body, filled: false };
  const v = await currentVersion(ds, cache, c.route, c.params ?? {});
  return v === null ? { body, filled: false } : { body: { ...b, ifVersion: v }, filled: true };
}

/** A human name for a route ("patchItem" → "patch item"). */
const routeWords = (k: RouteKey) => k.replace(/([A-Z])/g, ' $1').toLowerCase().trim();

/** What a staged call changes, as card lines: the entity's current values first (its GET), then the new ones. */
export async function previewRouteCall(ds: DataSource, c0: RouteCall, persona: ResolvedPersona | null, cache: ReadCache = new Map()): Promise<{ lines: FieldChange[]; error: string | null; call: RouteCall }> {
  let key: RouteKey;
  let input: Record<string, unknown>;
  // A4: the version the preview reads is the one the card stages (Apply then reports a real "changed since")
  const v = await withVersion(ds, cache, c0);
  const c: RouteCall = v.filled ? { ...c0, body: v.body as Record<string, unknown> } : c0;
  // what the route needs to be true first (the row exists, the item isn't claimed yet): the clearest error wins
  if (isRouteKey(c.route) && defOf(c.route).assistant === 'stage') {
    const pre = await precondition(ds, cache, c.route, Object.fromEntries(Object.entries(c.params ?? {}).map(([k, x]) => [k, String(x)])));
    if (pre) return { lines: [], error: pre, call: c };
  }
  try {
    ({ key, input } = appRouteInput(c.route, 'stage', persona, { params: c.params, body: c.body }));
  } catch (e) {
    return { lines: [], error: e instanceof AppRouteError ? e.message : String(e), call: c };
  }
  const params = (input.params ?? {}) as Record<string, string>;
  const body = (input.body ?? {}) as Record<string, unknown>;
  const read = async <T>(k: RouteKey, i: unknown): Promise<T | null> => (await readVia(ds, cache, k, i)) as T | null;
  const lines: FieldChange[] = [];
  let name: string | null = null;
  const diff = (before: Record<string, unknown> | null, patch: Record<string, unknown>, prefix = '') => {
    for (const [f, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      const b = before ? before[f] : undefined;
      if (before && JSON.stringify(b) === JSON.stringify(v)) continue;
      lines.push({ field: `${key}.${prefix}${f}`, label: `${name ? `${name} · ` : ''}${f}`, before: show(b), after: show(v) });
    }
  };
  switch (key) {
    case 'patchItem':
    case 'itemAction':
    case 'markItemSeen':
    case 'regenerateNba':
    case 'requestReadIn': {
      const d = params.id ? await read<{ item: Record<string, unknown> }>('getItem', { params: { id: params.id } }) : null;
      if (params.id && !d && key !== 'requestReadIn') return { lines: [], error: `${key}: no work item "${params.id}"`, call: c };
      name = d ? labelOf(d.item) : null;
      if (key === 'patchItem') diff(d?.item ?? null, (body.patch ?? {}) as Record<string, unknown>);
      else if (key === 'itemAction') lines.push({ field: `${key}.state`, label: `${name ?? params.id} · ${params.verb}`, before: show(d?.item.state), after: params.verb });
      break;
    }
    case 'patchDraft':
    case 'queueDraft':
    case 'rejectDraft': {
      const d = await read<Record<string, unknown>>('getDraft', { params: { id: params.id } });
      if (!d) return { lines: [], error: `${key}: no draft "${params.id}"`, call: c };
      name = labelOf(d) ?? `Draft ${params.id}`;
      // the route's own state rules (src/server/datasource/*: queueDraft, rejectDraft, patchDraft), so Apply never refuses
      const st = String(d.status ?? '');
      if (key === 'queueDraft' && st !== 'drafting' && st !== 'ready') return { lines: [], error: `queueDraft: ${name} is ${st}; only a drafting draft can be added to the Outbox`, call: c };
      if (key === 'rejectDraft' && !['drafting', 'ready', 'scheduled', 'failed', 'rejected'].includes(st)) return { lines: [], error: `rejectDraft: ${name} is ${st}; only a draft that hasn't been sent can be rejected`, call: c };
      if (key === 'patchDraft' && ['sending', 'sent', 'verified', 'staged'].includes(st)) return { lines: [], error: `patchDraft: ${name} is ${st}; it can no longer be edited`, call: c };
      if (key === 'patchDraft') diff(d, body);
      else lines.push({ field: `${key}.status`, label: `${name} · status`, before: show(d.status), after: key === 'queueDraft' ? 'ready (Outbox, waiting for your approval)' : 'rejected' });
      break;
    }
    case 'patchSettings': {
      const s = await read<Record<string, Record<string, unknown>>>('getSettings', {});
      name = `Settings ▸ ${params.section}`;
      diff(s?.[params.section!] ?? null, (body.value ?? {}) as Record<string, unknown>);
      break;
    }
    case 'patchWatch': {
      const w = await read<{ watches: Array<Record<string, unknown>> }>('listWatches', {});
      const cur = w?.watches.find((x) => x.id === params.id) ?? null;
      if (w && !cur) return { lines: [], error: `patchWatch: no watch "${params.id}"`, call: c };
      name = labelOf(cur);
      diff(cur, body);
      break;
    }
    case 'createDcRequest': {
      // the same rules the route applies (src/server/deals/dc-requests.ts planDcRequest), so the card never offers
      // what Apply would refuse: my DC with this split → nothing to stage; another split → a change of my DC
      const [opts, reqs] = await Promise.all([read<{ opps: Array<{ id: string; name: string; accountName: string | null; org62Id?: string | null }> }>('getOppOptions', { query: {} }), read<DcList>('listDcRequests', {})]);
      const want = String(body.opp ?? '').trim();
      const org62 = ORG62_OPP.test(want);
      const opp = opts?.opps.find((o) => o.id === want) ?? (org62 ? opts?.opps.find((o) => (o.org62Id ?? '').slice(0, 15) === want.slice(0, 15)) : undefined);
      if (opts && !opp && !org62) return { lines: [], error: `createDcRequest: no opportunity "${want}" in the app (pass an app opportunity id or an Org62 006… id)`, call: c };
      // an Org62 id the app doesn't track: Apply reads it from Org62 and adds it (and its account) with the claim
      const fromOrg62 = !!opts && !opp && org62;
      const same = (x: { oppId: string; org62OpportunityId: string | null }) => x.oppId === opp?.id || (org62 && (x.org62OpportunityId ?? '').slice(0, 15) === want.slice(0, 15));
      name = opp ? `${opp.name}${opp.accountName && !opp.name.includes(opp.accountName) ? ` (${opp.accountName})` : ''}` : (c.label?.trim() || want);
      const split = Number(body.split);
      const role = body.role ? String(body.role) : null;
      const dc = reqs?.myDcs?.find(same) ?? null;
      if (dc && dc.split === split) return { lines: [], error: `createDcRequest: you already hold a ${split}% DC on ${dc.oppName}${dc.role ? ` (${dc.role})` : ''}. Nothing to request: tell the user, don't stage it`, call: c };
      const live = reqs?.requests.find((r) => same(r) && r.status !== 'dismissed' && r.status !== 'verified');
      if (live) return { lines: [], error: `createDcRequest: ${name} already has a DC request (${live.kind === 'change' ? 'a change to ' : ''}${live.splitPercent}%, ${live.stage.replace('_', ' ')}): edit it (patchDcRequest) or withdraw it (withdrawDcRequest) instead`, call: c };
      // one line per claim, its comment on it: 40 claims read as 40 changes, not 80 (label · split · role · "comment")
      const asked = `${split}%${role ? ` · ${role}` : ''}${body.comment ? ` · “${short(redactText(String(body.comment)), 60)}”` : ''}`;
      if (dc) lines.push({ field: 'createDcRequest', label: `Change your DC · ${short(name, 40)}`, before: `${dc.split === null ? '?' : dc.split}%${dc.role ? ` · ${dc.role}` : ''}`, after: asked });
      else lines.push({ field: 'createDcRequest', label: fromOrg62 ? `DC claim · ${short(name, 60)} · added from Org62` : `DC claim · ${short(name, 60)}`, before: null, after: asked });
      break;
    }
    case 'addOrg62Opps': {
      const opts = await read<{ opps: Array<{ id: string; name: string; org62Id?: string | null }> }>('getOppOptions', { query: {} });
      const ids = [...new Set(((body.org62Ids ?? []) as string[]).map((v) => v.trim()))];
      const known = new Map((opts?.opps ?? []).flatMap((o) => (o.org62Id ? [[o.org62Id.slice(0, 15), o.name] as const] : [])));
      const fresh = ids.filter((v) => !known.has(v.slice(0, 15)));
      if (opts && !fresh.length) return { lines: [], error: `addOrg62Opps: the app already tracks ${ids.length === 1 ? `"${known.get(ids[0]!.slice(0, 15))}"` : `all ${ids.length} opps`}: nothing to add`, call: c };
      lines.push({ field: 'addOrg62Opps', label: 'Add from Org62', before: 'not in the app', after: `${fresh.length} ${fresh.length === 1 ? 'opp' : 'opps'} and their accounts (read on Apply)` });
      break;
    }
    case 'patchDcRequest':
    case 'withdrawDcRequest': {
      const reqs = await read<DcList>('listDcRequests', {});
      const cur = reqs?.requests.find((r) => r.id === params.id) ?? null;
      if (reqs && !cur) return { lines: [], error: `${key}: no DC request "${params.id}" (listDcRequests has the ids)`, call: c };
      if (cur?.lockedReason) return { lines: [], error: `${key}: can't ${key === 'patchDcRequest' ? 'edit' : 'withdraw'} the DC request for ${cur.oppName}: ${cur.lockedReason}`, call: c };
      name = cur?.oppName ?? params.id ?? null;
      const was = cur ? `${cur.kind === 'change' ? `change ${cur.fromSplit ?? '?'}% → ` : ''}${cur.splitPercent}% · ${cur.role}` : null;
      if (key === 'withdrawDcRequest') {
        lines.push({ field: 'withdrawDcRequest', label: `DC request · ${short(name ?? '', 44)}`, before: was, after: 'withdrawn (never goes to Slackbot)' });
        break;
      }
      const split = body.split === undefined ? (cur?.splitPercent ?? null) : Number(body.split);
      if (cur?.dc && split !== null && cur.dc.split === split) return { lines: [], error: `patchDcRequest: you already hold a ${split}% DC on ${cur.oppName}: withdraw the request instead (withdrawDcRequest)`, call: c };
      const kind = cur?.dc ? `change ${cur.dc.split ?? '?'}% → ` : '';
      lines.push({ field: 'patchDcRequest', label: `DC request · ${short(name ?? '', 44)}`, before: was, after: `${kind}${split ?? '?'}% · ${String(body.role ?? cur?.role ?? '')}` });
      if (body.comment) lines.push({ field: 'patchDcRequest.comment', label: 'DC comment', before: cur?.comment ? short(redactText(cur.comment), 40) : null, after: short(redactText(String(body.comment)), 60) });
      break;
    }
    default:
      break;
  }
  if (!lines.length) {
    const what = Object.keys(body).length ? body : params;
    lines.push({ field: key, label: `${routeWords(key)}${params.id ? ` · ${params.id}` : ''}`, before: null, after: show(what) });
  }
  return { lines, error: null, call: { op: 'route_call', route: key, ...(c.params ? { params: c.params } : {}), ...(c.body !== undefined ? { body: c.body } : {}), ...(c.label ? { label: c.label } : {}) } };
}

/**
 * What a stage route needs to be true before it can land, checked at staging (A3: the card never offers what Apply
 * would refuse). The same rules the routes apply; a route without one here is checked by its schemas only.
 */
async function precondition(ds: DataSource, cache: ReadCache, key: RouteKey, params: Record<string, string>): Promise<string | null> {
  const id = params.id ?? '';
  switch (key) {
    case 'patchActivity':
    case 'pickOrg62Opp':
    case 'resolveActivity': {
      const log = await readVia(ds, cache, 'getActivityLog', { query: {} });
      if (!log) return null;
      const e = await activityOf(ds, cache, id);
      if (!e) return `${key}: no activity row "${id}" (read time or getActivityLog for the row ids)`;
      if (key === 'pickOrg62Opp' && (e.status === 'logged' || e.status === 'verified')) return `pickOrg62Opp: "${short(e.description, 60)}" is logged in Org62: its opportunity is fixed`;
      return null;
    }
    case 'claimMissed':
    case 'dismissMissed': {
      const m = (await readVia(ds, cache, 'getMissed', {})) as { missed?: Array<{ id: string; status: string; oppName?: string }> } | null;
      if (!m) return null;
      const cur = m.missed?.find((x) => x.id === id);
      if (!cur) return `${key}: no missed opportunity "${id}" (missed_opps has the ids)`;
      if (key === 'claimMissed' && cur.status !== 'new') return `claimMissed: ${cur.oppName ?? id} is already ${cur.status}`;
      return null;
    }
    case 'retryJob': {
      const j = (await readVia(ds, cache, 'getJobs', {})) as { jobs?: Array<{ id: string | number; status: string }> } | null;
      if (!j) return null;
      const cur = j.jobs?.find((x) => String(x.id) === id);
      if (!cur) return `retryJob: no job "${id}" (jobs has the ids)`;
      if (!['dead', 'cancelled', 'retrying', 'failed'].includes(cur.status)) return `retryJob: job ${id} is ${cur.status}; only a dead, cancelled or retrying job can be requeued`;
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Apply: run every call through the DataSource, in order; land what works and list what failed (A3)
// ---------------------------------------------------------------------------

interface MutationLike {
  entity?: unknown;
  auditId?: string | null;
  receipt?: { changes: ReceiptChange[] };
}

export interface AppliedCalls {
  /** Receipt lines (a call that left no audit entry, e.g. nothing changed, has none). */
  lines: ReceiptChange[];
  /** Audit ids of the calls that landed, in order (Undo all on the receipt reverts every one). */
  auditIds: string[];
  /** The calls that did not land, each with its card line and the reason (the rest landed). */
  failed: ReceiptFailure[];
  /** How many calls landed. */
  landed: number;
}

const reasonOf = (err: unknown) => redactText(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);

/**
 * Run the staged calls (re-validated: the route list or the persona may have changed since). Each lands as its own
 * change set; one that fails is listed with its reason and the others still land (owner decision 2026-11-13: Apply
 * lands what works, the receipt lists the failures, Undo all reverts every one that landed).
 */
export async function applyRouteCalls(ds: DataSource, calls: RouteCall[], persona: ResolvedPersona | null): Promise<AppliedCalls> {
  const done: Array<{ key: RouteKey; auditId: string | null }> = [];
  const lines: ReceiptChange[] = [];
  const failed: ReceiptFailure[] = [];
  const cache: ReadCache = new Map();
  // one Org62 read for the untracked opps a card claims; if it fails, each claim reads its own opp below
  await addUntrackedOpps(ds, calls, persona, done, lines).catch(() => undefined);
  let landed = 0;
  for (const c of calls) {
    try {
      // A4: a card staged without ifVersion takes the current one (the user's Apply is the intent)
      const v = await withVersion(ds, cache, c);
      const { key, input } = appRouteInput(c.route, 'stage', persona, { params: c.params, body: v.body });
      const r = ((await methodOf(ds, key)(input)) ?? {}) as MutationLike;
      landed += 1;
      const auditId = r.auditId ?? null;
      done.push({ key, auditId });
      const p = (input.params ?? {}) as Record<string, string>;
      const ent = r.entity as Record<string, unknown> | undefined;
      const dcRoute = key === 'createDcRequest' || key === 'patchDcRequest' || key === 'withdrawDcRequest';
      const entity: EntityRef = { type: ENTITY[key] ?? 'chat_thread', id: String((dcRoute ? ent?.oppId : ent?.id) ?? p.id ?? key), label: labelOf(ent) ?? c.label ?? routeWords(key) };
      const own = r.receipt?.changes?.filter((x) => x.auditId) ?? [];
      if (own.length) lines.push(...own);
      else if (auditId) lines.push({ auditId, entity, field: key, label: LINE_LABEL[key] ?? routeWords(key), before: null, after: dcRoute ? dcReceipt(key, ent) : 'applied' });
    } catch (err) {
      failed.push({ label: c.label ? redactText(c.label) : `${routeWords(c.route as RouteKey)}${c.params?.id ? ` · ${c.params.id}` : ''}`, reason: reasonOf(err), route: c.route });
    }
  }
  return { lines, auditIds: done.flatMap((d) => (d.auditId ? [d.auditId] : [])), failed, landed };
}

/** "Applied 54 of 55 · 1 failed: <reason>" (the receipt and the card say how an Apply went). */
export function appliedSummary(landed: number, total: number, failed: ReceiptFailure[]): string {
  if (!failed.length) return `Applied ${total} change${total === 1 ? '' : 's'}`;
  const reasons = [...new Set(failed.map((f) => f.reason))];
  return `Applied ${landed} of ${total} · ${failed.length} failed: ${reasons.length === 1 ? reasons[0] : `${reasons[0]} (and ${reasons.length - 1} other reason${reasons.length === 2 ? '' : 's'})`}`;
}

/** An Opportunity's Org62 id (15 or 18 characters). */
const ORG62_OPP = /^006[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;

/**
 * A card that claims DCs on several opps by Org62 id reads the ones the app doesn't track from Org62 once, up front
 * (addOrg62Opps, its own change set: Undo all reverts it with the claims), instead of one read per claim. A single
 * claim reads its own opp (createDcRequest).
 */
async function addUntrackedOpps(ds: DataSource, calls: RouteCall[], persona: ResolvedPersona | null, done: Array<{ key: RouteKey; auditId: string | null }>, lines: ReceiptChange[]): Promise<void> {
  const ids = [...new Set(calls.filter((c) => c.route === 'createDcRequest').map((c) => String((c.body as { opp?: unknown } | undefined)?.opp ?? '').trim()).filter((v) => ORG62_OPP.test(v)))];
  if (ids.length < 2 || !appRoutes('stage', persona).includes('addOrg62Opps')) return;
  for (let at = 0; at < ids.length; at += ORG62_OPPS_BY_IDS_MAX) {
    const { input } = appRouteInput('addOrg62Opps', 'stage', persona, { body: { org62Ids: ids.slice(at, at + ORG62_OPPS_BY_IDS_MAX) } });
    const r = (await methodOf(ds, 'addOrg62Opps')(input)) as { entity: AddOrg62OppsResult; auditId: string | null };
    if (!r.auditId) continue;
    done.push({ key: 'addOrg62Opps', auditId: r.auditId });
    const first = r.entity.added[0];
    const n = r.entity.added.length;
    lines.push({ auditId: r.auditId, entity: { type: 'opportunity', id: first?.oppId ?? 'addOrg62Opps', label: n === 1 && first ? first.name : `${n} opportunities` }, field: 'addOrg62Opps', label: 'Added from Org62', before: 'not in the app', after: `${n} ${n === 1 ? 'opp' : 'opps'} and their accounts` });
  }
}

// ---------------------------------------------------------------------------
// Assistant v2 `act`: the safe mutations the UI has, classified allow | stage | deny (lane 05 §5.1)
// ---------------------------------------------------------------------------

/**
 * What `act` may do and how:
 *  - allow: a local, undoable work-item action the user asked for in this message (snooze, pin, done, not mine, reopen,
 *    re-rank). It runs at once through the same change-set path as an applied card (actor `chat`, Undo on the receipt).
 *    Asked by the router's reading only when the turn is an `act`; otherwise it is staged instead.
 *  - stage: a settings patch of an allowed section: one card the user applies (never runs from chat).
 *  - deny: everything else, and the sections that are the user's alone (sending, budgets).
 * Nothing here reaches an external system (*tenet: Nothing leaves without approval*).
 */
export const ACT_OPS = ['snooze', 'pin', 'done', 'not_mine', 'reopen', 'rerank', 'settings'] as const;
export type ActOp = (typeof ACT_OPS)[number];
export type ActClass = 'allow' | 'stage' | 'deny';

/** Settings sections `act` may stage (the user Applies). sending and budgets are the user's alone. */
export const ACT_SETTINGS_SECTIONS: ReadonlySet<string> = new Set(['display', 'chat', 'agentBehavior', 'time', 'closing', 'feedback']);

export function classifyAct(op: string, o: { section?: string; userAsked: boolean }): { class: ActClass; why: string } {
  if (!(ACT_OPS as readonly string[]).includes(op)) return { class: 'deny', why: `${op} is not an action the Assistant takes (it sends, applies, re-auths, scans or launches)` };
  if (op === 'settings') {
    if (!o.section) return { class: 'deny', why: 'settings needs a section' };
    if (o.section === 'sending') return { class: 'deny', why: 'the sending settings (dry run, send modes) are yours to change in Settings ▸ Sending' };
    if (o.section === 'budgets') return { class: 'deny', why: 'the Assistant never raises its own budget: Settings ▸ Budgets is yours' };
    if (!ACT_SETTINGS_SECTIONS.has(o.section)) return { class: 'deny', why: `the ${o.section} settings are changed in Settings only` };
    return { class: 'stage', why: 'a settings change waits for your Apply' };
  }
  return o.userAsked ? { class: 'allow', why: 'you asked for it; Undo on the receipt' } : { class: 'stage', why: 'not asked in this message: staged for your Apply' };
}
