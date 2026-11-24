/**
 * Search, people and since-you-left, read side (R7 step 3). What only one store can say comes in as an argument: the
 * db's full-text matches (`stemmed`), the account filter as each store keys it, the audit entries after a time.
 */
import type { AuditEntry, EntityRef, PersonView, RouteInput, RouteOutput, SearchHit, SinceDigest, SinceEntry } from '@/contract';

import { hrefFor, itemRef } from './refs';
import type { ReadSource } from './source';

/** An audit entry as the since digest reads it (the db builds these from change_sets, the mock has them). */
export type SinceSource = Pick<AuditEntry, 'id' | 'at' | 'actor' | 'action' | 'summary' | 'entity' | 'undoable' | 'undoneAt'>;

export function buildSince(src: ReadSource, entriesAfter: readonly SinceSource[], sinceIso: string, now: Date): SinceDigest {
  const sinceMs = Date.parse(sinceIso);
  const entries: SinceEntry[] = [];
  for (const e of entriesAfter) {
    if (Date.parse(e.at) <= sinceMs || e.actor === 'user' || e.undoneAt) continue;
    const kind: SinceEntry['kind'] = e.action.includes('close')
      ? 'closed'
      : e.action.includes('reopen')
        ? 'reopened'
        : e.action.includes('create') || e.action.includes('capture')
          ? 'new'
          : e.action.includes('fail')
            ? 'failed'
            : e.action.includes('waiting')
              ? 'waiting'
              : e.action.startsWith('brief')
                ? 'brief'
                : 'changed';
    entries.push({ at: e.at, kind, title: e.summary, detail: e.entity.label, ref: e.entity, auditId: e.undoable ? e.id : null });
  }
  const isNew = new Set(entries.filter((x) => x.kind === 'new').map((x) => x.ref.id));
  for (const w of src.all('workItems')) {
    if (Date.parse(w.createdAt) > sinceMs && Date.parse(w.createdAt) <= now.getTime() && !isNew.has(w.id)) {
      entries.push({ at: w.createdAt, kind: 'new', title: `New: ${w.title}`, detail: w.why, ref: itemRef(w), auditId: null });
    }
  }
  entries.sort((a, b) => b.at.localeCompare(a.at));
  const awayMinutes = Math.max(0, Math.round((now.getTime() - sinceMs) / 60_000));
  return {
    since: new Date(sinceMs).toISOString(),
    until: now.toISOString(),
    awayMinutes,
    show: awayMinutes >= 120,
    counts: {
      changed: entries.filter((e) => e.kind === 'changed').length,
      closed: entries.filter((e) => e.kind === 'closed').length,
      new: entries.filter((e) => e.kind === 'new').length,
      reopened: entries.filter((e) => e.kind === 'reopened').length,
    },
    entries,
  };
}

/** GET /people: name prefix > word prefix > anywhere (name, email, Slack id, role, title, account). */
export function peopleView(src: ReadSource, query: RouteInput<'getPeople'>['query'], accountId: string | null): RouteOutput<'getPeople'> {
  const myDomain = src.meta().user.email.split('@')[1]?.toLowerCase() ?? '';
  const tokens = query.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = src
    .all('people')
    .filter((p) => (!accountId || p.accountId === accountId) && (query.slack === undefined || !!p.slackHandle === query.slack))
    .map((p) => {
      const account = p.accountId ? src.get('accounts', p.accountId) : undefined;
      const domain = p.email?.split('@')[1]?.toLowerCase() ?? '';
      const view: PersonView = {
        id: p.id,
        name: p.name,
        email: p.email ?? null,
        slackId: p.slackHandle ?? null,
        role: p.role ?? null,
        title: p.title ?? null,
        account: account ? { type: 'account', id: account.id, label: account.name, href: hrefFor({ type: 'account', id: account.id }) } : null,
        isExternal: p.isExternal ?? (!!domain && !!myDomain && domain !== myDomain),
        isManager: p.isManager ?? false,
      };
      const name = p.name.toLowerCase();
      const hay = `${name} ${p.email ?? ''} ${p.slackHandle ?? ''} ${p.role ?? ''} ${p.title ?? ''} ${account?.name ?? ''}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (name.startsWith(t)) score += 3;
        else if (name.split(/\s+/).some((x) => x.startsWith(t))) score += 2;
        else if (hay.includes(t)) score += 1;
        else return null;
      }
      return { view, score };
    })
    .filter((r): r is { view: PersonView; score: number } => !!r)
    .sort((a, b) => b.score - a.score || a.view.name.localeCompare(b.view.name));
  return { q: query.q, people: rows.slice(0, query.limit).map((r) => r.view), total: rows.length };
}

/**
 * GET /search over every collection a hit can name. `stemmed`: work items a full-text match found that the token
 * score missed (the db's tsvector; the mock has none); they score 0.5.
 */
export function searchView(src: ReadSource, query: RouteInput<'search'>['query'], stemmed: ReadonlySet<string> = new Set()): RouteOutput<'search'> {
  const q = query.q.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const hits: SearchHit[] = [];
  const score = (hay: string) => {
    const h = hay.toLowerCase();
    let s = 0;
    for (const t of tokens) if (h.includes(t)) s += h.startsWith(t) ? 2 : 1;
    return s === 0 ? 0 : s / tokens.length;
  };
  const add = (ref: EntityRef, title: string, subtitle: string | null, hay: string, extra: Partial<SearchHit> = {}, isStemmed = false) => {
    let s = score(hay);
    if (s === 0 && isStemmed) s = 0.5;
    if (s > 0) hits.push({ ref: { ...ref, href: ref.href ?? hrefFor(ref) }, title, subtitle, kind: null, state: null, ...extra, score: Math.round(s * 100) / 100 });
  };
  for (const w of src.all('workItems')) add(itemRef(w), w.title, w.purpose, `${w.title} ${w.purpose ?? ''} ${w.why}`, { kind: w.kind, state: w.state }, stemmed.has(w.id));
  for (const i of src.all('initiatives')) add({ type: 'initiative', id: i.id, label: i.title }, i.title, i.purpose, `${i.title} ${i.purpose} ${i.summary}`);
  for (const a of src.all('accounts')) add({ type: 'account', id: a.id, label: a.name }, a.name, a.industry, a.name);
  for (const o of src.all('opps')) add({ type: 'opportunity', id: o.id, label: o.name }, o.name, o.stage, o.name);
  for (const p of src.all('people')) add({ type: 'person', id: p.id, label: p.name }, p.name, p.role ?? null, `${p.name} ${p.role ?? ''} ${p.title ?? ''}`);
  for (const b of src.all('briefs')) add({ type: 'brief', id: b.id, label: b.title }, b.title, 'Brief', `${b.title} ${b.summary}`);
  for (const r of src.all('agentRuns')) add({ type: 'agent_run', id: r.id, label: r.title }, r.title, r.state.replace(/_/g, ' '), r.title);
  for (const a of src.all('assets')) add({ type: 'asset', id: a.id, label: a.title, href: a.url }, a.title, a.kind, a.title);
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return { q: query.q, hits: hits.slice(0, query.limit), total: hits.length };
}
