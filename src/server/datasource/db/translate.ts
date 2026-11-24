/**
 * Seed ids → database ids, applied to whole JSON trees.
 *
 * The seeder translates a Seed before writing it (so every nested reference — EntityRefs, PersonRefs,
 * runIds, chip refs — lands on the right row), and the parity tests translate mock responses the same
 * way before comparing them with db responses. Translation is key-based, never a blind string replace:
 * only `id`, `*Id` and `*Ids` / `ids` keys are rewritten, and only when the value is a known seed id
 * (so a SourceKind 'slack' is never confused with the connector id 'slack').
 */
import type { Seed } from '@/contract';

import { bigintFor, uuidFor } from './ids';

/** Keys ending in Id that hold external-system ids, never Command Center ids. */
const EXTERNAL_KEYS = new Set(['externalId', 'sessionId', 'channelId', 'adapterId', 'toolAdapterId', 'answerId', 'choiceId']);

export type IdMap = Map<string, string>;

export function buildIdMap(seed: Seed): IdMap {
  const m: IdMap = new Map();
  const u = (id: string | null | undefined) => {
    if (id) m.set(id, uuidFor(id));
  };
  const b = (id: string | null | undefined) => {
    if (id) m.set(id, String(bigintFor(id)));
  };
  u(seed.meta.user.id);
  for (const x of seed.people) u(x.id);
  for (const x of seed.accounts) u(x.id);
  for (const x of seed.opps) u(x.id);
  for (const x of seed.missedOpps) {
    u(x.id);
    u(x.oppId);
  }
  for (const x of seed.initiatives) u(x.id);
  for (const x of seed.workItems) u(x.id);
  for (const x of seed.evidence) u(x.id);
  for (const x of seed.nbas) u(x.id);
  for (const x of seed.drafts) {
    u(x.id);
    for (const a of x.attempts) b(a.id);
  }
  for (const x of seed.proposals) u(x.id);
  for (const x of seed.assets) u(x.id);
  for (const x of seed.calendar.events) u(x.id);
  for (const x of seed.agentRuns) u(x.id);
  for (const x of seed.toolRuns) u(x.id);
  for (const x of seed.activity) {
    u(x.id);
    u(x.oppId); // opps outside the book get anchor rows
  }
  for (const x of seed.timeBlocks) u(x.id);
  for (const x of seed.briefs) {
    u(x.id);
    for (const h of x.highlights) u(h.id);
  }
  for (const x of seed.watches) u(x.id);
  for (const x of seed.connectors) u(x.id);
  for (const x of seed.scanRuns) u(x.id);
  for (const x of seed.jobs) b(x.id);
  for (const x of seed.eventLog) b(x.id);
  for (const x of seed.chatThreads) {
    u(x.thread.id);
    for (const msg of x.messages) u(msg.id);
  }
  for (const x of seed.mappings) u(x.id);
  for (const x of seed.audit) u(x.id);
  u(seed.settings.policy.id);
  // PersonRefs embedded anywhere (attendees, owners, thread authors) become people rows (synthetic when
  // they are not in the directory), so their ids translate too
  const PERSON_KEYS = new Set(['id', 'name', 'role', 'isManager', 'isExternal']);
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.includes('id') && keys.includes('name') && keys.every((k) => PERSON_KEYS.has(k)) && typeof (v as { id: unknown }).id === 'string') u((v as { id: string }).id);
      else Object.values(v).forEach(walk);
    }
  };
  walk([seed.workItems, seed.initiatives, seed.calendar.events, seed.accounts, seed.opps, seed.drafts]);
  for (const v of seed.policyVersions) u(v.policy.id);
  return m;
}

const isIdKey = (k: string) => k === 'id' || (k.endsWith('Id') && !EXTERNAL_KEYS.has(k));
const isIdsKey = (k: string) => k === 'ids' || k.endsWith('Ids');

/**
 * Deep-copy `value`, rewriting id-valued keys through `map`. Timeline lanes ({id, label, blocks}) carry
 * fixed lane names ('slack', 'drive', 'claude') that collide with connector ids, so their id is kept.
 */
export function translateIds<T>(value: T, map: IdMap): T {
  const walk = (v: unknown, key: string | null, parent?: Record<string, unknown>): unknown => {
    if (key === 'id' && parent && 'blocks' in parent) return v;
    if (typeof v === 'string') return key && isIdKey(key) ? (map.get(v) ?? v) : v;
    if (Array.isArray(v)) {
      if (key && isIdsKey(key)) return v.map((x) => (typeof x === 'string' ? (map.get(x) ?? x) : walk(x, null)));
      return v.map((x) => walk(x, null));
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k, v as Record<string, unknown>);
      return out;
    }
    return v;
  };
  return walk(value, null) as T;
}

const LINK_KEYS = new Set(['href', 'deepLink']);
/** Query params whose values name a view or section, never a row ("/time?view=vdp" is Time ▸ VDP, not the vdp connector). */
const NAME_PARAMS = new Set(['view', 'section', 'tab', 'day']);

const translateTokens = (s: string, map: IdMap) => s.replace(/[A-Za-z0-9_:.-]+/g, (tok) => map.get(tok) ?? tok);

/** One in-app link: ids in the path and in id-carrying query values; view and section names stay as they are. */
function translateLink(v: string, map: IdMap): string {
  const q = v.indexOf('?');
  if (q < 0) return translateTokens(v, map);
  const hash = v.indexOf('#', q);
  const query = v.slice(q + 1, hash < 0 ? undefined : hash);
  const params = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const k = pair.slice(0, eq);
      return NAME_PARAMS.has(k) ? pair : `${k}=${translateTokens(pair.slice(eq + 1), map)}`;
    })
    .join('&');
  return `${translateTokens(v.slice(0, q), map)}?${params}${hash < 0 ? '' : translateTokens(v.slice(hash), map)}`;
}

/**
 * Rewrite seed ids inside in-app links ("/work/w_acme_build" → "/work/<uuid>", keys href / deepLink,
 * values starting with "/") and inside confirm tokens. The seeder applies it so links in db mode point
 * at real rows; the parity tests apply it to mock responses.
 */
export function translateHrefs<T>(value: T, map: IdMap): T {
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === 'string') {
      if (key && LINK_KEYS.has(key) && v.startsWith('/')) return translateLink(v, map);
      if (key === 'confirmToken') {
        const m = /^ct_(.+)_(\d+)_(draft|send)_([a-z0-9]+)$/.exec(v);
        if (m) return `ct_${map.get(m[1]!) ?? m[1]}_${m[2]}_${m[3]}_${m[4]}`;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value, null) as T;
}
