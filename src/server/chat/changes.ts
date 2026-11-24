/**
 * Chat change lists (BE-CHAT): preview (display lines + validation) over the public DataSource reads, so
 * the mock and db hosts share one implementation. Nothing here writes; staging and apply are per
 * DataSource (one change set, actor `chat`).
 */
import type { ActivityEntry, ChatChange, EntityRef, FieldChange, PolicyWeights, ReceiptChange, Settings, WorkItem } from '@/contract';
import { lockableActivityFields, WorkItemPatch } from '@/contract';
import type { ChangePreview } from '@/llm/chat/types';

import { personaOf } from '@/personas';

import type { DataSource } from '../datasource/types';
import { previewRouteCall, type ReadCache } from './app-routes';

/** Live (closable) states: the views' LIVE_STATES plus snoozed and suggested (done / resolve accept them). */
const LIVE = new Set(['open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done', 'reopened', 'snoozed', 'suggested']);
const CLOSED = new Set(['done', 'dismissed']);

const FIELD: Record<string, string> = {
  title: 'Title',
  purpose: 'Purpose',
  due: 'Due',
  startBy: 'Start by',
  effort: 'Estimate',
  notes: 'Note',
  initiativeId: 'Initiative',
  accountId: 'Account',
  oppId: 'Opportunity',
  kind: 'Kind',
};

const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const RESOLUTION_LABEL: Record<string, string> = {
  done_by_me: 'Done',
  handed_off: 'Handed off',
  done_by_other: 'Done by someone else',
  not_needed: 'No longer needed',
  duplicate: 'Duplicate',
  declined: 'Declined',
  superseded: 'Superseded',
};

/** Ops that need a re-rank when applied (pin, rerank, policy). */
export function needsRerank(changes: ChatChange[]): boolean {
  return changes.some((c) => c.op === 'pin' || c.op === 'rerank' || c.op === 'policy_weights' || c.op === 'policy_rule');
}

/** Weights after deltas, each clamped to 0–10. */
export function weightsWith(cur: PolicyWeights, deltas: Partial<Record<keyof PolicyWeights, number>>): PolicyWeights {
  const out = { ...cur };
  for (const [k, d] of Object.entries(deltas)) {
    const key = k as keyof PolicyWeights;
    if (key in out) out[key] = Math.max(0, Math.min(10, (out[key] ?? 0) + (d ?? 0)));
  }
  return out;
}

/** Item-level check shared by preview and apply. Returns an error string, or null when the change can land. */
export function changeError(c: ChatChange, item: Pick<WorkItem, 'state' | 'title'> | null, now: Date): string | null {
  // Time-page rows are checked against their own entries (activityError).
  if (c.op === 'edit_activities') return Object.values(c.patch).some((v) => v !== undefined) ? null : 'edit_activities: empty patch';
  // App route calls are checked against the route's own schemas and the persona (previewRouteCall, app-routes.ts).
  if (c.op === 'route_call') return null;
  if (c.op === 'rerank' || c.op === 'create_item' || c.op === 'policy_weights' || c.op === 'policy_rule') {
    if (c.op === 'create_item' && c.snoozeUntil && Date.parse(c.snoozeUntil) <= now.getTime()) return `create_item: snoozeUntil ${c.snoozeUntil} is in the past`;
    return null;
  }
  if (!item) return `${c.op}: no work item with id "${c.itemId}" (use an id from read find_items or the context pack)`;
  const st = item.state;
  switch (c.op) {
    case 'snooze':
      if (CLOSED.has(st)) return `snooze: "${item.title}" is ${st}`;
      if (Date.parse(c.until) <= now.getTime()) return `snooze: until ${c.until} is in the past`;
      return null;
    case 'done':
      return LIVE.has(st) ? null : `done: "${item.title}" is already ${st}`;
    case 'resolve':
      if (c.resolution === 'handed_off' && !c.personName) return 'resolve: handed_off needs personName';
      return LIVE.has(st) || st === 'done' ? null : `resolve: "${item.title}" is ${st}`;
    case 'reopen':
      return CLOSED.has(st) ? null : `reopen: "${item.title}" is ${st}, not done or dismissed`;
    case 'pin':
      return CLOSED.has(st) ? `pin: "${item.title}" is ${st}` : null;
    case 'edit_fields': {
      const p = WorkItemPatch.safeParse(c.patch);
      if (!p.success) return `edit_fields: ${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
      return Object.keys(p.data).length ? null : 'edit_fields: empty patch';
    }
    case 'link_evidence':
      return null;
  }
}

/** Rows already in Org62 (or being verified there) are not edited from chat. */
const LOGGED_ROW = new Set(['logged', 'verified', 'verify_failed']);

/**
 * One Time-page row against an `edit_activities` change: null when it can land. `taskTypes` is the team pack's
 * vocabulary (empty = not known here): a new name would silently grow it, and an approved row needs a type (the
 * database refuses one without).
 */
export function activityError(
  entryId: string,
  e: Pick<ActivityEntry, 'status' | 'description' | 'taskType'> | null | undefined,
  oppKnown: boolean | null,
  patch: Partial<Pick<ActivityEntry, 'taskType' | 'status'>> = {},
  taskTypes: readonly string[] = [],
): string | null {
  if (!e) return `edit_activities: no activity entry with id "${entryId}" (use an id from read time)`;
  if (LOGGED_ROW.has(e.status)) return `edit_activities: "${short(e.description, 60)}" is already ${e.status} in Org62; change it there`;
  if (oppKnown === false) return 'edit_activities: unknown oppId (use an opportunity id from read deals / account, or search source org62 inApp.oppId)';
  if (patch.taskType && taskTypes.length && !taskTypes.includes(patch.taskType)) return `edit_activities: unknown task type "${patch.taskType}" (use one of: ${taskTypes.join(', ')})`;
  const type = patch.taskType !== undefined ? patch.taskType : e.taskType;
  if (patch.status === 'approved' && !type) return `edit_activities: "${short(e.description, 60)}" needs a task type before it can be approved${taskTypes.length ? ` (one of: ${taskTypes.join(', ')})` : ''}`;
  return null;
}

/** What previewChanges needs to show Time-page rows: the entries and the opportunity names. */
export type ActivityLookup = (entryIds: string[], oppIds: string[]) => Promise<{ entries: Map<string, ActivityEntry>; opps: Map<string, { name: string; accountName: string | null }>; taskTypes?: string[] }>;

type ActivityEdit = Extract<ChatChange, { op: 'edit_activities' }>;

/**
 * The row after an `edit_activities` patch, as the Time page's row editor would save it: the opportunity's name and
 * account fill in, an "needs opp" issue clears, and every patched field is locked so a later re-projection keeps it,
 * except `status`, which stays the logging pipeline's to move (lockableActivityFields).
 */
export function editedActivity<T extends ActivityEntry>(cur: T, patch: ActivityEdit['patch'], opp: { name: string; accountName: string | null } | undefined): { next: T; locked: ActivityEntry['userLockedFields'] } {
  const locked = lockableActivityFields((Object.keys(patch) as ActivityEntry['userLockedFields']).filter((k) => (patch as Record<string, unknown>)[k] !== undefined));
  const next = {
    ...cur,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    ...(opp ? { oppName: opp.name, accountName: opp.accountName ?? cur.accountName } : patch.oppId === null ? { oppName: null } : {}),
    userLockedFields: [...new Set([...lockableActivityFields(cur.userLockedFields), ...locked])],
    issues: patch.oppId ? cur.issues.filter((i) => !/opp/i.test(i)) : cur.issues,
  } as T;
  return { next, locked };
}

/** One receipt line per changed field of a Time-page row (the change set's Undo covers them all). */
export function activityReceiptLines(auditId: string, cur: ActivityEntry, next: ActivityEntry): ReceiptChange[] {
  const out: ReceiptChange[] = [];
  for (const f of ['oppName', 'taskType', 'meetingType', 'durationH', 'description', 'status'] as const) {
    if (cur[f] === next[f]) continue;
    out.push({ auditId, entity: { type: 'activity_entry', id: cur.id, label: `${cur.date} · ${short(cur.description, 36)}`, href: '/activity' }, field: f === 'oppName' ? 'oppId' : f, label: ACTIVITY_FIELD[f === 'oppName' ? 'oppId' : f], before: cur[f] ?? null, after: next[f] ?? null });
  }
  return out;
}

const ACTIVITY_FIELD: Record<string, string> = { oppId: 'Opportunity', taskType: 'Task type', meetingType: 'Meeting type', durationH: 'Hours', description: 'Description', status: 'Status' };

function itemIdOf(c: ChatChange): string | null {
  return 'itemId' in c ? c.itemId : null;
}

/**
 * Display lines for a change list, the entity the card names, and validation errors. Reads only
 * (getItem / getSettings), so a proposal never moves anything.
 */
export async function previewChanges(ds: DataSource, changes: ChatChange[], o: { now: Date; threadId?: string; settings?: Settings; activities?: ActivityLookup }): Promise<ChangePreview> {
  const items = new Map<string, WorkItem | null>();
  for (const c of changes) {
    const id = itemIdOf(c);
    if (!id || items.has(id)) continue;
    try {
      items.set(id, (await ds.getItem({ params: { id } } as never)).item);
    } catch {
      items.set(id, null);
    }
  }
  const actIds = [...new Set(changes.flatMap((c) => (c.op === 'edit_activities' ? c.entryIds : [])))];
  const oppIds = [...new Set(changes.flatMap((c) => (c.op === 'edit_activities' && c.patch.oppId ? [c.patch.oppId] : [])))];
  type Acts = Awaited<ReturnType<ActivityLookup>>;
  const none: Acts = { entries: new Map(), opps: new Map() };
  const acts: Acts = actIds.length ? await (o.activities ?? (async () => none))(actIds, oppIds) : none;
  const settings = o.settings ?? (await ds.getSettings({} as never));
  const persona = personaOf(settings);
  const pol = settings.policy;
  const lines: FieldChange[] = [];
  const errors: string[] = [];
  const out: ChatChange[] = [];
  const multi = new Set(changes.map((c) => itemIdOf(c) ?? (c.op.startsWith('policy') || c.op === 'rerank' ? 'policy' : `new:${c.op}`))).size > 1;
  const row = (e: ActivityEntry) => `${e.date} · ${short(e.description, 36)}`;
  const lbl = (w: WorkItem | null | undefined, field: string) => (multi && w ? `${short(w.title)} · ${field}` : field);
  let weights = pol.weights;
  const claimed = new Set<string>();
  /** Route calls already on the card: the same call twice (or two on one entity) would fail the second at Apply. */
  const staged = new Set<string>();
  const cache: ReadCache = new Map();
  for (const c of changes) {
    const id = itemIdOf(c);
    const w = id ? items.get(id) ?? null : null;
    const err = changeError(c, w, o.now);
    if (err) {
      errors.push(err);
      continue;
    }
    switch (c.op) {
      case 'edit_activities': {
        const opp = c.patch.oppId ? acts.opps.get(c.patch.oppId) : undefined;
        const errs = c.entryIds.map((id) => activityError(id, acts.entries.get(id), c.patch.oppId ? !!opp : null, c.patch, acts.taskTypes)).filter((x): x is string => !!x);
        if (errs.length) {
          errors.push(...[...new Set(errs)]);
          continue;
        }
        for (const id of c.entryIds) {
          const e = acts.entries.get(id)!;
          for (const [f, v] of Object.entries(c.patch)) {
            if (v === undefined) continue;
            const before = f === 'oppId' ? (e.oppName ?? null) : ((e as unknown as Record<string, unknown>)[f] ?? null);
            const after = f === 'oppId' ? (v === null ? null : opp?.name ?? v) : v;
            if (before === after) continue;
            lines.push({ field: `activity.${f}`, label: `${row(e)} · ${ACTIVITY_FIELD[f] ?? f}`, before, after });
          }
        }
        break;
      }
      case 'route_call': {
        // two claims on one opp in a card: Apply would refuse the second (one request in flight per opp)
        const dcOpp = c.route === 'createDcRequest' ? String((c.body as { opp?: unknown } | undefined)?.opp ?? '').trim() : '';
        const dcKey = /^006[A-Za-z0-9]{12}/.test(dcOpp) ? dcOpp.slice(0, 15) : dcOpp;
        if (dcKey && claimed.has(dcKey)) {
          errors.push(`createDcRequest: two claims on the same opp (${c.label ?? dcOpp}): stage one`);
          continue;
        }
        if (dcKey) claimed.add(dcKey);
        const params = c.params && Object.keys(c.params).length ? c.params : null;
        const same = `${c.route}|${params ? JSON.stringify(params) : JSON.stringify(c.body ?? null)}`;
        if (!dcKey && staged.has(same)) {
          errors.push(`${c.route}: ${params ? 'two changes to the same thing' : 'the same change twice'} in one card (${c.label ?? JSON.stringify(params ?? c.body ?? {}).slice(0, 80)}): stage it once${params ? ', with everything in one call' : ''}`);
          continue;
        }
        staged.add(same);
        const r = await previewRouteCall(ds, c, persona, cache);
        if (r.error) {
          errors.push(r.error);
          continue;
        }
        lines.push(...r.lines);
        out.push(r.call);
        continue;
      }
      case 'pin':
        lines.push({ field: 'rank', label: lbl(w, 'Rank'), before: w!.rank, after: 1 });
        break;
      case 'rerank':
        lines.push({ field: 'rank', label: 'Ranking', before: `as ranked ${o.now.toISOString().slice(11, 16)}`, after: `re-ranked (policy v${pol.version})` });
        break;
      case 'snooze':
        lines.push({ field: 'state', label: lbl(w, 'State'), before: w!.state, after: 'snoozed' });
        lines.push({ field: 'snoozedUntil', label: lbl(w, 'Snoozed until'), before: w!.snoozedUntil, after: c.until });
        break;
      case 'done':
        lines.push({ field: 'state', label: lbl(w, 'State'), before: w!.state, after: 'done' });
        break;
      case 'resolve':
        lines.push({ field: 'state', label: lbl(w, 'State'), before: w!.state, after: 'done' });
        lines.push({ field: 'resolution', label: lbl(w, 'Resolution'), before: w!.resolution, after: c.personName ? `${RESOLUTION_LABEL[c.resolution]} (${c.personName})` : RESOLUTION_LABEL[c.resolution] });
        break;
      case 'reopen':
        lines.push({ field: 'state', label: lbl(w, 'State'), before: w!.state, after: 'reopened' });
        break;
      case 'link_evidence':
        lines.push({ field: 'evidence', label: lbl(w, 'Evidence'), before: null, after: `${c.source.kind}: ${short(c.source.label, 60)}` });
        break;
      case 'create_item':
        lines.push({ field: 'title', label: 'New task', before: null, after: c.title });
        if (c.due) lines.push({ field: 'due', label: 'New task · Due', before: null, after: c.due });
        if (c.snoozeUntil) lines.push({ field: 'snoozedUntil', label: 'New task · Snoozed until', before: null, after: c.snoozeUntil });
        break;
      case 'edit_fields': {
        const patch = WorkItemPatch.parse(c.patch) as Record<string, unknown>;
        for (const [f, v] of Object.entries(patch)) {
          if (v === undefined) continue;
          lines.push({ field: f, label: lbl(w, FIELD[f] ?? f), before: (w as unknown as Record<string, unknown>)[f] ?? null, after: v });
        }
        break;
      }
      case 'policy_weights': {
        const next = weightsWith(weights, c.deltas);
        for (const k of Object.keys(c.deltas) as (keyof PolicyWeights)[]) {
          if (next[k] === weights[k]) continue;
          lines.push({ field: `weights.${k}`, before: weights[k], after: next[k] });
        }
        weights = next;
        const deltas = Object.fromEntries((Object.keys(c.deltas) as (keyof PolicyWeights)[]).map((k) => [k, next[k] - pol.weights[k]]));
        out.push({ ...c, deltas });
        continue;
      }
      case 'policy_rule': {
        const rule = c.ruleId ? pol.rules.find((r) => r.id === c.ruleId) : undefined;
        if (c.action !== 'add' && !rule) {
          errors.push(`policy_rule: no rule "${c.ruleId ?? ''}" (rules: ${pol.rules.map((r) => r.id).join(', ') || 'none'})`);
          continue;
        }
        if (c.action === 'add' && (!c.rule?.text || c.rule.boost === undefined)) {
          errors.push('policy_rule add: needs rule.text and rule.boost');
          continue;
        }
        const text = c.action === 'add' ? c.rule!.text! : rule!.text;
        lines.push({ field: 'rules', label: `Rule: ${short(text, 48)}`, before: c.action === 'add' ? null : rule!.enabled ? 'on' : 'off', after: c.action === 'remove' ? null : c.action === 'disable' ? 'off' : 'on' });
        break;
      }
    }
    out.push(c);
  }
  const ids = [...new Set(out.map(itemIdOf).filter((x): x is string => !!x))];
  const onlyActs = out.length > 0 && out.every((c) => c.op === 'edit_activities');
  const actOut = [...new Set(out.flatMap((c) => (c.op === 'edit_activities' ? c.entryIds : [])))];
  const policyOnly = out.length > 0 && out.every((c) => c.op === 'policy_weights' || c.op === 'policy_rule' || c.op === 'rerank');
  let entity: EntityRef;
  if (onlyActs && actOut.length === 1) {
    const e = acts.entries.get(actOut[0]!)!;
    entity = { type: 'activity_entry', id: e.id, label: row(e) };
  } else if (onlyActs) entity = { type: 'chat_thread', id: o.threadId ?? 'chat', label: `${actOut.length} time entries from chat` };
  else if (ids.length === 1 && out.every((c) => itemIdOf(c) === ids[0])) {
    const w = items.get(ids[0]!)!;
    entity = { type: 'work_item', id: w.id, label: w.title };
  } else if (policyOnly) entity = { type: 'policy', id: pol.id, label: pol.name };
  else entity = { type: 'chat_thread', id: o.threadId ?? 'chat', label: `${out.length} change${out.length === 1 ? '' : 's'} from chat` };
  return { lines, entity, errors, changes: out };
}
