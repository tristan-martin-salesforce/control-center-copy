// Home build: reply, ahead, chase and initiative rows. Split from build.ts (max-lines).
import type { Draft, HomeRow, HomeState, WorkItem } from '@/contract';
import { clip, corePhrase, firstName, lowerFirst, plural, shortAccount } from './text';
import { addLocalDays, daysBetween, dur, hm, md, toMs, wd, whenLabel } from './time';
import { latePhrase, lateState } from '@/engines/priority/why';
import type { Gap } from './build.gaps';
import {
  type Ctx, HOME_CAPS, REPLY_TITLE, msOrNull, byRank, row, itemHref, workEntity, isBusyEvent, LIVE, verb, usdShort,
  isToday, PROMISE_MIN_AGE_D, FOLD_AT, PROMISE_RISK_AGE_D,
} from './build.ctx';
import { itemVerb, engineHours } from './build.cards';

export type Need = { kind: 'item'; item: WorkItem } | { kind: 'outbox'; drafts: Draft[] } | { kind: 'gap'; gap: Gap };
// ---------------------------------------------------------------------------
// Rows for sections
// ---------------------------------------------------------------------------

export function replyRows(c: Ctx, taken: Set<string>, outboxDraftIds: Set<string>): HomeRow[] {
  const horizon = addLocalDays(c.nowMs, HOME_CAPS.aheadDays + 1, c.tz);
  const rows = c.live
    .filter((w) => !taken.has(w.id) && !w.isBackground && w.state !== 'waiting_on_others')
    .filter((w) => {
      const n = c.nbaOf(w);
      const d = c.draftOf(w);
      if (d && outboxDraftIds.has(d.id)) return false;
      const replyish = ['send', 'answer', 'review', 'review_deliverable'].includes(n?.verb ?? '') || w.kind === 'ask' || !!d || REPLY_TITLE.test(w.title);
      const due = msOrNull(w.due);
      return replyish && (due === null || due < horizon);
    })
    .sort((a, b) => {
      const ba = c.blockedBy(a) ? 0 : 1;
      const bb = c.blockedBy(b) ? 0 : 1;
      return (a.due ?? '9').localeCompare(b.due ?? '9') || ba - bb || byRank(a, b);
    });
  return rows.map((w) => {
    const blocker = c.blockedBy(w);
    const d = c.draftOf(w);
    const due = msOrNull(w.due);
    const overdue = due !== null && due < c.nowMs;
    let state: HomeState | null = null;
    let stateLabel: string | null = null;
    let why = due !== null ? `Due ${whenLabel(due, c.nowMs, c.tz)}` : clip(w.why, 60);
    if (blocker) {
      state = 'blocked';
      stateLabel = 'Blocked';
      why = `~${dur(c.handsOn(w))} once ${firstName(blocker.waiting?.who?.name) || 'they'} answers`;
    } else if (overdue) {
      state = 'overdue';
      stateLabel = 'Overdue';
    } else if (d?.status === 'ready') {
      state = 'ai';
      stateLabel = 'Drafted';
    }
    return row({
      id: w.id,
      kind: d ? 'draft' : 'item',
      title: w.title,
      why,
      state,
      stateLabel,
      due: w.due,
      youMin: c.handsOn(w),
      verb: itemVerb(c, w),
      href: itemHref(w.id),
      entity: workEntity(w),
      item: { id: w.id, version: w.version },
    });
  });
}
export interface Dated {
  row: HomeRow;
  at: number;
  cf: boolean;
  /** A meeting whose prep is not ready yet. */
  prepMissing?: boolean;
}
export function aheadRows(c: Ctx, taken: Set<string>, outboxDraftIds: Set<string>): Dated[] {
  const { tz, nowMs } = c;
  const winEnd = addLocalDays(nowMs, HOME_CAPS.aheadDays + 1, tz);
  const out: Dated[] = [];
  const merged = new Set<string>();
  const notStarted = (w: WorkItem) => (w.state === 'open' || w.state === 'reopened') && (w.deliverable?.judgment?.verdict ?? 'not_started') === 'not_started';

  // Meetings that matter in the next 14 days (linked: prep, a served item, or an initiative's target).
  const targets = new Set(c.input.initiatives.map((i) => i.targetEventId).filter(Boolean));
  const servedBy = new Map<string, WorkItem[]>();
  for (const w of c.live) if (w.servesEventId) servedBy.set(w.servesEventId, [...(servedBy.get(w.servesEventId) ?? []), w]);
  for (const e of c.input.events) {
    const s = toMs(e.start);
    if (s < c.todayEnd || s >= winEnd || !isBusyEvent(e)) continue;
    const linked = [...(e.prep?.workItemId ? [c.byId.get(e.prep.workItemId)] : []), ...(servedBy.get(e.id) ?? [])].filter((w): w is WorkItem => !!w && LIVE.has(w.state));
    if (!e.prep && !targets.has(e.id) && !linked.length) continue;
    if (linked.length && linked.every((w) => taken.has(w.id)) && !e.isCustomerFacing && !targets.has(e.id)) continue;
    const prepItem = linked.find((w) => !taken.has(w.id)) ?? linked[0] ?? null;
    for (const w of linked) if (!taken.has(w.id)) merged.add(w.id);
    const days = daysBetween(nowMs, s, tz);
    let state: HomeState | null = null;
    let stateLabel: string | null = null;
    let note = e.prep?.label?.replace(/\s*›\s*$/, '') ?? '';
    if (prepItem?.state === 'waiting_on_others') note = `${note ? `${note}, ` : ''}waiting on ${firstName(prepItem.waiting?.who?.name) || 'others'}`;
    else if (prepItem && !taken.has(prepItem.id) && notStarted(prepItem) && !e.prep?.ready && days <= 7) {
      state = 'risk';
      stateLabel = 'Not started';
    }
    out.push({
      at: s,
      cf: e.isCustomerFacing,
      prepMissing: !!e.prep && !e.prep.ready,
      row: row({
        id: `event:${e.id}`,
        kind: 'event',
        title: e.title,
        why: [`${wd(s, tz)} ${md(s, tz)}`, note].filter(Boolean).join(' · '),
        state,
        stateLabel,
        due: e.start,
        youMin: prepItem ? c.handsOn(prepItem) : null,
        verb: prepItem ? (state === 'risk' ? verb(c.nbaOf(prepItem)?.primaryLabel || 'Start prep', prepItem && c.nbaOf(prepItem)?.verb === 'start_in_claude' ? 'open_in_claude' : 'plan', itemHref(prepItem.id), prepItem.id) : verb('Open', 'open', itemHref(prepItem.id), prepItem.id)) : verb('Open', 'open', '/today'),
        href: prepItem ? itemHref(prepItem.id) : '/today',
        entity: prepItem ? workEntity(prepItem) : { kind: 'calendar_event', id: e.id, label: e.title },
        item: prepItem && prepItem.state !== 'waiting_on_others' ? { id: prepItem.id, version: prepItem.version } : null,
      }),
    });
  }

  // Dated work (and overdue work) not listed anywhere else.
  for (const w of c.live) {
    if (taken.has(w.id) || merged.has(w.id) || w.isBackground || w.state === 'waiting_on_others') continue;
    const d = c.draftOf(w);
    if (d && outboxDraftIds.has(d.id)) continue;
    const due = msOrNull(w.due);
    if (due === null || due >= winEnd || (due >= c.todayStart && due < c.todayEnd)) continue;
    const overdue = due < c.todayStart;
    const days = daysBetween(nowMs, due, tz);
    const risky = !overdue && notStarted(w) && days <= 7 && (w.kind === 'deliverable' || !!w.servesEventId || c.handsOn(w) >= 30);
    const ini = w.initiativeId ? c.iniById.get(w.initiativeId) : undefined;
    const ctxLabel = shortAccount(w.refs.account?.label) || (ini ? clip(ini.title.replace(/\s*\([^)]*\)/g, ''), 30) : '');
    out.push({
      at: due,
      cf: w.signals.customerFacing,
      row: row({
        id: w.id,
        kind: 'item',
        title: w.title,
        // R1: a late row says how late and what to do ("2 d late · re-date or drop"), never "start by Mon"
        why: [overdue ? latePhrase(lateState(due, nowMs, w.dueKind ?? null, engineHours(c))!) : whenLabel(due, nowMs, tz), ctxLabel].filter(Boolean).join(' · '),
        state: overdue ? 'overdue' : risky ? 'risk' : null,
        stateLabel: overdue ? 'Overdue' : risky ? 'Not started' : null,
        due: w.due,
        youMin: c.handsOn(w),
        verb: risky && w.kind === 'deliverable' ? verb('Plan', 'plan', itemHref(w.id), w.id) : itemVerb(c, w),
        href: itemHref(w.id),
        entity: workEntity(w),
        item: { id: w.id, version: w.version },
      }),
    });
  }

  // Deals closing in the window.
  for (const o of c.input.opps) {
    if (!o.isOpen || !(o.isMine || o.dcAssigned) || !o.closeDate) continue; // mine: on the team or holding a DC
    const at = toMs(`${o.closeDate}T12:00:00Z`);
    if (at < c.todayEnd || at >= winEnd) continue;
    const stage = /^(\d{2})/.exec(o.stage)?.[1];
    out.push({
      at,
      cf: true,
      row: row({
        id: `opp:${o.id}`,
        kind: 'event',
        title: o.name.replace(/\s+-\s+/, ': '),
        why: [`Closes ${wd(at, 'UTC')} ${md(at, 'UTC')}`, o.amount ? usdShort(o.amount) : null, stage ? `stage ${stage}` : null].filter(Boolean).join(' · '),
        state: null,
        stateLabel: null,
        due: new Date(at).toISOString(),
        youMin: null,
        verb: verb('Open deal', 'open', `/deals/${o.accountId}`),
        href: `/deals/${o.accountId}`,
        entity: { kind: 'opportunity', id: o.id, label: o.name },
      }),
    });
  }

  const rank = (r: HomeRow) => (r.state === 'overdue' ? 0 : r.state === 'risk' ? 1 : 2);
  return out.sort((a, b) => rank(a.row) - rank(b.row) || a.at - b.at || a.row.id.localeCompare(b.row.id));
}
export function chaseRows(c: Ctx, taken: Set<string>, blocks: Map<string, WorkItem>): { rows: HomeRow[]; count: number; names: string[] } {
  const { tz, nowMs } = c;
  const rows: HomeRow[] = [];
  const names: string[] = [];
  let count = 0;
  const waiting = c.live.filter((w) => w.state === 'waiting_on_others' && !taken.has(w.id)).sort((a, b) => (a.waiting?.since ?? a.updatedAt).localeCompare(b.waiting?.since ?? b.updatedAt));
  for (const w of waiting) {
    count++;
    const who = firstName(w.waiting?.who?.name ?? w.counterparty?.name);
    if (who && !names.includes(who)) names.push(who);
    const since = msOrNull(w.waiting?.since ?? null);
    const blocked = blocks.get(w.id);
    const due = msOrNull(w.due);
    const parts = [since !== null ? `Asked ${daysBetween(since, nowMs, tz) === 0 ? hm(since, tz) : `${wd(since, tz)} ${md(since, tz)}`}` : null];
    if (blocked) parts.push(blocked.counterparty ? `blocks your ${firstName(blocked.counterparty.name)} answer` : `blocks ${lowerFirst(clip(corePhrase(blocked.title), 32))}`);
    else if (due !== null && isToday(due, c)) parts.push('due today');
    else if (due !== null) parts.push(`due ${whenLabel(due, nowMs, tz)}`);
    const n = c.nbaOf(w);
    const d = c.draftOf(w);
    rows.push(
      row({
        id: w.id,
        kind: 'waiting',
        title: w.title,
        why: parts.filter(Boolean).join(' · ') || clip(w.waiting?.reason ?? w.why, 60),
        state: due !== null && due < nowMs ? 'overdue' : null,
        stateLabel: due !== null && due < nowMs ? 'Late' : null,
        due: w.due,
        youMin: d ? 2 : null,
        verb: d ? verb('Nudge', 'nudge', d.status === 'ready' ? `/outbox?draft=${d.id}` : itemHref(w.id), d.id) : verb(n?.verb === 'nudge' ? n.primaryLabel || 'Nudge' : 'Nudge', 'nudge', itemHref(w.id), w.id),
        href: itemHref(w.id),
        entity: workEntity(w),
        item: { id: w.id, version: w.version },
      }),
    );
  }

  // Promises going stale: undated commitments, oldest first; ≥ FOLD_AT in one initiative fold into one row.
  const promises = c.live
    .filter((w) => !taken.has(w.id) && w.kind === 'commitment' && !w.due && w.state !== 'waiting_on_others' && (w.isBackground || w.ageDays >= PROMISE_MIN_AGE_D))
    .sort((a, b) => b.ageDays - a.ageDays || a.id.localeCompare(b.id));
  const byIni = new Map<string, WorkItem[]>();
  for (const w of promises) if (w.initiativeId && !w.isBackground) byIni.set(w.initiativeId, [...(byIni.get(w.initiativeId) ?? []), w]);
  const folded = new Set<string>();
  const promiseRows: Array<{ age: number; row: HomeRow }> = [];
  for (const [iniId, ws] of byIni) {
    if (ws.length < FOLD_AT) continue;
    const ini = c.iniById.get(iniId);
    for (const w of ws) folded.add(w.id);
    const acc = shortAccount(ws[0]!.refs.account?.label) || (ini ? clip(ini.title, 24) : '');
    promiseRows.push({
      age: Math.max(...ws.map((w) => w.ageDays)),
      row: row({
        id: `fold:${iniId}`,
        kind: 'promise',
        title: `${ws.length} ${acc ? `${acc} ` : ''}commitments, no dates`,
        why: clip(ws.map((w) => lowerFirst(clip(corePhrase(w.title), 32))).join(', '), 80),
        state: null,
        stateLabel: null,
        due: null,
        youMin: null,
        verb: verb('Set dates', 'open', ini ? `/initiatives/${iniId}` : '/work?tab=promises'),
        href: ini ? `/initiatives/${iniId}` : '/work?tab=promises',
        entity: ini ? { kind: 'initiative', id: ini.id, label: ini.title } : workEntity(ws[0]!),
        dateLabel: 'no dates',
      }),
    });
  }
  for (const w of promises) {
    if (folded.has(w.id)) continue;
    const to = firstName(w.counterparty?.name);
    promiseRows.push({
      age: w.ageDays,
      row: row({
        id: w.id,
        kind: 'promise',
        title: w.title,
        why: to ? `You said you would · to ${to}` : 'You said you would',
        state: w.ageDays >= PROMISE_RISK_AGE_D ? 'risk' : null,
        stateLabel: w.ageDays >= PROMISE_RISK_AGE_D ? `${w.ageDays} d` : null,
        due: null,
        youMin: c.handsOn(w),
        verb: verb('Do or drop', 'open', itemHref(w.id), w.id),
        href: itemHref(w.id),
        entity: workEntity(w),
        item: { id: w.id, version: w.version },
        dateLabel: `${w.ageDays} d`,
      }),
    });
  }
  promiseRows.sort((a, b) => b.age - a.age);
  for (const p of promiseRows) {
    rows.push(p.row);
    count += p.row.id.startsWith('fold:') ? Number(p.row.title.split(' ')[0]) || 1 : 1;
  }
  return { rows, count, names };
}
export function initiativeRows(c: Ctx, riskItems: Set<string>): HomeRow[] {
  const { tz, nowMs } = c;
  const out: Array<{ order: number; at: number; row: HomeRow }> = [];
  for (const ini of c.input.initiatives) {
    if (ini.status !== 'active' && ini.status !== 'paused') continue;
    const items = c.live.filter((w) => w.initiativeId === ini.id);
    const target = ini.targetEventId ? c.eventById.get(ini.targetEventId) : undefined;
    const todayItems = items.filter((w) => !w.isBackground && c.todayScoped(w) && !c.blockedBy(w) && !c.heldByMeeting(w));
    const targetToday = !!target && target.isCustomerFacing && isToday(toMs(target.start), c) && toMs(target.end) > nowMs;
    const undated = items.filter((w) => w.kind === 'commitment' && !w.due && !w.isBackground);
    const nextItem = items.filter((w) => w.due && !w.isBackground).sort((a, b) => a.due!.localeCompare(b.due!))[0] ?? null;
    let heat: HomeRow['heat'] = null;
    if (ini.status === 'paused') heat = 'paused';
    else if (todayItems.length || targetToday) heat = 'hot';
    else if (items.some((w) => riskItems.has(w.id))) heat = 'at_risk';
    else if (undated.length >= FOLD_AT) heat = 'drifting';
    const label = { hot: 'Today', at_risk: 'At risk', drifting: 'Drifting', paused: 'Paused' } as const;
    let dateLabel: string;
    let at = Number.MAX_SAFE_INTEGER;
    if (heat === 'hot') {
      const t = targetToday ? toMs(target!.start) : Math.min(...todayItems.map((w) => msOrNull(w.due) ?? msOrNull(w.startBy) ?? c.todayEnd));
      dateLabel = hm(t, tz);
      at = t;
    } else if (heat === 'paused') {
      const oldest = Math.max(0, ...items.map((w) => w.ageDays));
      dateLabel = oldest ? `${oldest} d` : 'paused';
    } else if (nextItem) {
      at = toMs(nextItem.due!);
      dateLabel = daysBetween(nowMs, at, tz) < 7 ? wd(at, tz) : md(at, tz);
      if (at < c.todayStart) dateLabel = md(at, tz);
    } else dateLabel = 'no date';
    const next = heat === 'paused' ? 'stale promise' : nextItem ? clip(lowerFirst(corePhrase(c.nbaOf(nextItem)?.title ?? nextItem.title)), 34) : undated.length ? `${plural(undated.length, 'undated commitment')}` : clip(ini.purpose, 34);
    const order = heat === 'hot' ? 0 : heat === 'at_risk' ? 1 : heat === 'drifting' ? 3 : heat === 'paused' ? 4 : 2;
    out.push({
      order,
      at,
      row: row({
        id: `ini:${ini.id}`,
        kind: 'initiative',
        title: ini.title.replace(/\s*\([^)]*\)/g, ''),
        why: next,
        state: heat === 'hot' ? 'now' : heat === 'at_risk' || heat === 'drifting' ? 'risk' : null,
        stateLabel: heat ? label[heat] : null,
        due: nextItem?.due ?? null,
        youMin: null,
        verb: verb('Open', 'open', `/initiatives/${ini.id}`),
        href: `/initiatives/${ini.id}`,
        entity: { kind: 'initiative', id: ini.id, label: ini.title },
        heat,
        dateLabel,
      }),
    });
  }
  return out.sort((a, b) => a.order - b.order || a.at - b.at || a.row.title.localeCompare(b.row.title)).map((x) => x.row);
}
