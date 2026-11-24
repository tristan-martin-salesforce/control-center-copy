/**
 * Today v2 sections (pure): Run of day (today-scoped hands-on work, in the stable model order), Fit-ins
 * (today's few-minute items: approvals, sessions waiting on you, broken connectors, small shelf items),
 * Pull forward (not due today) and Promises. One row shape for all of them so the page, keys and ⌘K treat
 * every row the same way.
 */
import type { NowCard, RailEntry, ShelfEntry, SpineSlot, TodayPayload, WorkItem } from '@/contract';
import type { PanelEntity } from '@/components/shell/panel';
import type { PullRef } from './capacity';
import { dueLabel, hhmm, hm, minuteOfDay, msOf, zoned } from './time';
import { offsetMin } from '@/engines/home/time';
import { whyLine, whyOfItem, type WhyParts } from '@/engines/priority/why';

export type Section = 'run' | 'fit' | 'pull' | 'promise';
export type RowTone = 'blocked' | 'overdue' | 'risk' | null;

export type PrimaryKind =
  | { kind: 'card' } // the NOW card's own primary (send, Claude, tool, answer…)
  | { kind: 'open' } // open details
  | { kind: 'outbox' }
  | { kind: 'rail'; entry: RailEntry }
  | { kind: 'reauth'; connectorId: string }
  | { kind: 'pull' }
  | { kind: 'shelf'; entry: ShelfEntry };

export interface DayRow {
  key: string;
  section: Section;
  item: WorkItem | null;
  card: NowCard | null;
  entity: PanelEntity;
  title: string;
  /** Run rows: the ranking's why (why now, then why it matters; lane 07 R7). Other rows: their own line. */
  why: string;
  /** The extractor's (or the NBA's) sentence and reasoning: the detail under the ranking's why. */
  whyDetail: string | null;
  /** Run rows: the two parts behind `why` (null when neither says anything; the sentence shows instead). */
  whyParts?: WhyParts | null;
  /** Neutral context: account, source or kind ("Acme", "Outbox", "Org62"). */
  context: string | null;
  meta: string;
  when: { main: string; sub: string };
  tone: RowTone;
  badge: { tone: 'danger' | 'warning' | 'success' | 'ai' | 'neutral'; label: string } | null;
  verb: string;
  primary: PrimaryKind;
  youMin: number;
  /** Runs an agent in the background while you do your part. */
  agentBg: { minutes: number } | null;
  /** Hover / selection actions besides the verb. */
  extras: Array<'snooze' | 'done' | 'nudge' | 'renegotiate' | 'let_go'>;
}

export interface RowsInput {
  data: TodayPayload;
  cards: NowCard[];
  rows: WorkItem[];
  extras?: WorkItem[];
  nowIso: string;
  tz?: string;
  /** Work slots after the local plan (server slots minus rejected changes, plus pulled-in items). */
  slots: SpineSlot[];
  /** Item ids the user pulled into today (local plan). */
  pinned: ReadonlySet<string>;
  /** Engine pull-forward list (null = derive here). */
  pullForward: PullRef[] | null;
  /** Every open item the page knows (GET /items?tab=all_open), so engine refs outside the payload resolve. */
  catalog?: ReadonlyMap<string, WorkItem>;
  /** Settings ▸ Profile working hours: a late item's grace is one working day (lane 07 R1). */
  workingHours?: { start: string; end: string; days: number[] };
}

const DEFAULT_HOURS = { start: '08:00', end: '17:30', days: [1, 2, 3, 4, 5] };

/** Lane 07 R7: the ranking's two-part why for a run row, recomputed at render time ("2 d late" stays true). */
function rankWhy(item: WorkItem, input: RowsInput): WhyParts | null {
  const now = msOf(input.nowIso);
  const wh = input.workingHours ?? DEFAULT_HOURS;
  const m = item.refs.meeting;
  const parts = whyOfItem({ ...item, meeting: m ? { label: m.label, start: m.start } : null }, now, { ...wh, utcOffsetMinutes: input.tz ? offsetMin(now, input.tz) : 0, ...(input.tz ? { timeZone: input.tz } : {}) });
  return parts.matters || parts.now ? parts : null;
}

const ACTIONABLE = new Set(['open', 'in_progress', 'waiting_on_me', 'likely_done', 'reopened']);
export const isActionableItem = (i: Pick<WorkItem, 'state' | 'isBackground'>) => ACTIONABLE.has(i.state) && !i.isBackground;

export function isBlocked(item: Pick<WorkItem, 'state' | 'waiting'>): boolean {
  return item.state === 'waiting_on_others' || item.waiting?.on === 'others';
}

/**
 * Today's load, mirroring the engine's rule (src/engines/priority/capacity.ts `todayScope`) so the list
 * matches `youMinToday`: pinned (a start-by you set to today) or planned today; due today (earlier today
 * still counts); or start-by today-or-earlier for work due later, tomorrow included (PRIO-3: work that must
 * start today is today's load). Overdue-from-earlier work is pull-forward, not load. Reopened / looped-back-in
 * items always show (they need you).
 */
export function isTodayScoped(item: WorkItem, nowIso: string, tz: string | undefined, planned: ReadonlySet<string>): boolean {
  if (item.state === 'likely_done') return false;
  if (planned.has(item.id)) return true;
  if (item.state === 'reopened' || item.loopedBackIn) return true;
  const today = zoned(nowIso, tz).ymd;
  const day = (iso: string) => zoned(iso, tz).ymd;
  if (item.startBy && item.userLockedFields.includes('startBy') && day(item.startBy) === today) return true;
  if (!item.due) return false;
  const dueDay = day(item.due);
  if (dueDay === today) return true;
  return dueDay > today && !!item.startBy && day(item.startBy) <= today;
}

/** The NBA runs an agent (Claude session or tool) alongside your hands-on part. */
export function backgroundAgent(card: NowCard | null, item: WorkItem): { minutes: number } | null {
  const nba = card?.nba;
  if (!nba || item.effort.agentMin <= 0) return null;
  if (nba.verb === 'start_in_claude' || nba.verb === 'run_tool' || nba.claudeLaunch) return { minutes: item.effort.agentMin };
  return null;
}

const SOURCE_LABEL: Record<string, string> = { slack: 'Slack', gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', org62: 'Org62', vdp: 'VDP', gemini: 'Gemini', claude: 'Claude' };

function contextOf(item: WorkItem): string | null {
  if (item.refs.account?.label) return item.refs.account.label;
  if (item.kind === 'training' || item.training) return 'Training';
  const s = item.sources[0];
  return s ? SOURCE_LABEL[s.kind] ?? s.label ?? null : null;
}

function firstSlotStart(slots: SpineSlot[], itemId: string): string | null {
  const mine = slots.filter((s) => s.kind !== 'gap' && s.workItemId === itemId).sort((a, b) => msOf(a.start) - msOf(b.start));
  return mine[0]?.start ?? null;
}

const stripLabel = (s: string) => s.replace(/^\d{1,2}:\d{2}\s*/, '').replace(/^▶\s*/, '').trim();
export { stripLabel };

function cardVerb(card: NowCard | null): string {
  if (!card?.nba) return 'Open';
  return card.nba.primaryLabel || 'Open';
}

function runRow(item: WorkItem, card: NowCard | null, input: RowsInput): DayRow {
  const { nowIso, tz, slots } = input;
  const now = msOf(nowIso);
  const planned = firstSlotStart(slots, item.id) ?? item.startBy;
  const startMs = planned ? msOf(planned) : null;
  const sameDay = planned ? zoned(planned, tz).ymd === zoned(nowIso, tz).ymd : false;
  let main = planned && sameDay ? hhmm(minuteOfDay(planned, tz)) : 'Any';
  let sub = '';
  if (startMs !== null && sameDay && startMs > now && startMs - now <= 60 * 60_000) sub = `in ${hm((startMs - now) / 60_000)}`;
  else if (startMs !== null && sameDay && startMs <= now) sub = 'now';
  else if (item.refs.meeting) sub = `by ${hhmm(minuteOfDay(item.refs.meeting.start, tz))}`;
  else if (item.due) sub = `due ${dueLabel(item.due, nowIso, tz, { withTime: true })}`;
  if (main === 'Any' && item.due && msOf(item.due) < now) {
    main = 'Late';
    sub = `due ${dueLabel(item.due, nowIso, tz, { withTime: true })}`;
  }
  const blocked = isBlocked(item);
  const overdue = !blocked && !!item.due && msOf(item.due) < now;
  const bg = backgroundAgent(card, item);
  const context = contextOf(item);
  const effort = `you ~${hm(item.effort.youMin)}${bg ? ' · agent checks run alongside' : item.effort.agentMin > 0 ? ` · agent ~${hm(item.effort.agentMin)}` : ''}`;
  const who = item.waiting?.who?.name?.split(' ')[0];
  const sentence = card?.nba?.why ?? item.why;
  const reasoning = card?.nba?.whyDetail ?? item.whyDetail;
  const parts = rankWhy(item, input);
  return {
    key: `run:${item.id}`,
    section: 'run',
    item,
    card,
    entity: { kind: 'work_item', id: item.id, label: card?.nba?.title ?? item.title },
    title: card?.nba?.title ?? item.title,
    why: (parts && whyLine(parts)) || sentence,
    whyDetail: parts ? [sentence, reasoning].filter((x, i, xs): x is string => !!x && xs.indexOf(x) === i).join('\n\n') || null : reasoning,
    whyParts: parts,
    context,
    meta: [context, effort].filter(Boolean).join(' · '),
    when: { main, sub },
    tone: blocked ? 'blocked' : overdue ? 'overdue' : null,
    badge: blocked ? { tone: 'danger', label: '⏸ Blocked' } : item.state === 'reopened' ? { tone: 'warning', label: item.loopedBackIn ? '↺ Looped back in' : '↺ Reopened' } : item.state === 'likely_done' ? { tone: 'ai', label: '✦ Likely done' } : null,
    verb: item.state === 'likely_done' ? 'Confirm done' : cardVerb(card),
    primary: card ? { kind: 'card' } : { kind: 'open' },
    youMin: item.effort.youMin,
    agentBg: bg,
    extras: blocked ? ['nudge', 'snooze'] : who && item.waiting?.on === 'others' ? ['nudge', 'snooze', 'done'] : ['snooze', 'done'],
  };
}

function shelfFitRow(entry: ShelfEntry): DayRow {
  const item = entry.item;
  return {
    key: `fit:item:${item.id}`,
    section: 'fit',
    item,
    card: null,
    entity: { kind: 'work_item', id: item.id, label: item.title },
    title: item.title,
    why: item.why,
    whyDetail: item.whyDetail,
    context: contextOf(item),
    meta: '',
    when: { main: 'Any', sub: `~${hm(item.training?.minutes ?? item.effort.youMin)}` },
    tone: null,
    badge: null,
    verb: entry.action.label,
    primary: { kind: 'shelf', entry },
    youMin: item.training?.minutes ?? item.effort.youMin,
    agentBg: null,
    extras: ['snooze'],
  };
}

const cleanApprove = (t: string) => t.replace(/^Approve:\s*/i, '').trim();

function listPhrase(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Today's few-minute items: approvals, sessions waiting on you, broken connectors, small shelf items. */
export function fitRows(data: TodayPayload, usedItemIds: ReadonlySet<string>, nowIso: string, tz?: string): DayRow[] {
  const out: DayRow[] = [];
  const waiting = data.rail.find((l) => l.lane === 'waiting_on_you');
  const approvals = waiting?.entries.filter((e) => e.action?.kind === 'approve') ?? [];
  if (approvals.length) {
    const n = Math.max(approvals.length, Number(waiting?.summary.match(/(\d+) approvals?/)?.[1] ?? 0));
    const first = approvals[0]!;
    const youMin = Math.min(15, Math.max(2, n * 2));
    out.push({
      key: 'fit:approvals',
      section: 'fit',
      item: null,
      card: null,
      entity: { kind: first.ref.type, id: first.ref.id, label: cleanApprove(first.title) },
      title: n === 1 ? `Approve ${cleanApprove(first.title)}` : `Approve ${n} drafts`,
      why: listPhrase(approvals.map((a) => cleanApprove(a.title))),
      whyDetail: approvals.map((a) => `${cleanApprove(a.title)}: ${a.detail ?? ''}`).join('\n'),
      context: 'Outbox',
      meta: '',
      when: { main: 'Any', sub: `~${hm(youMin)}` },
      tone: null,
      badge: null,
      verb: 'Review',
      primary: { kind: 'outbox' },
      youMin,
      agentBg: null,
      extras: [],
    });
  }
  for (const e of waiting?.entries.filter((x) => x.action && x.action.kind !== 'approve') ?? []) {
    out.push({
      key: `fit:wait:${e.id}`,
      section: 'fit',
      item: null,
      card: null,
      entity: { kind: e.ref.type, id: e.ref.id, label: e.title },
      title: e.title,
      why: e.detail ?? '',
      whyDetail: null,
      context: e.ref.type === 'agent_run' ? 'Agents' : null,
      meta: '',
      when: { main: 'Any', sub: '~5m' },
      tone: null,
      badge: { tone: 'warning', label: '◐ Waiting on you' },
      verb: e.action!.label,
      primary: { kind: 'rail', entry: e },
      youMin: 5,
      agentBg: null,
      extras: [],
    });
  }
  const healthLane = data.rail.find((l) => l.lane === 'health');
  for (const c of data.health.broken) {
    const entry = healthLane?.entries.find((e) => e.ref.id === c.id);
    out.push({
      key: `fit:reauth:${c.id}`,
      section: 'fit',
      item: null,
      card: null,
      entity: { kind: 'connector', id: c.id, label: c.label },
      title: c.state === 'auth_needed' ? `Re-auth ${c.label}` : `Fix ${c.label}`,
      why: entry?.detail ?? `${c.label} is ${c.state.replace('_', ' ')}; its items may be stale.`,
      whyDetail: null,
      context: null,
      meta: '',
      when: { main: 'Any', sub: '~2m' },
      tone: 'overdue',
      badge: { tone: 'danger', label: c.state === 'auth_needed' ? '✕ Needs re-auth' : `✕ ${c.state === 'offline' ? 'Offline' : 'Broken'}` },
      verb: c.state === 'auth_needed' ? 'Re-auth' : 'Open',
      primary: { kind: 'reauth', connectorId: c.id },
      youMin: 2,
      agentBg: null,
      extras: [],
    });
  }
  for (const s of data.shelves.fitIns) {
    if (usedItemIds.has(s.item.id) || !isActionableItem(s.item)) continue;
    const mins = s.item.training?.minutes ?? s.item.effort.youMin;
    if (mins > 15 && !isTodayScoped(s.item, nowIso, tz, new Set())) continue;
    out.push(shelfFitRow(s));
  }
  return out;
}

function pullRowFor(item: WorkItem, ref: PullRef | null, nowIso: string, tz?: string): DayRow {
  const youMin = ref?.youMin ?? item.training?.minutes ?? item.effort.youMin;
  const due = ref?.due ?? item.due;
  const main = youMin <= 45 ? `~${hm(youMin)}` : item.training ? hm(youMin) : 'Start';
  return {
    key: `pull:${item.id}`,
    section: 'pull',
    item,
    card: null,
    entity: { kind: 'work_item', id: item.id, label: ref?.title ?? item.title },
    title: ref?.title ?? item.title,
    why: ref?.why ?? item.why,
    whyDetail: item.whyDetail,
    context: contextOf(item),
    meta: '',
    when: { main, sub: due ? `${msOf(due) < msOf(nowIso) ? 'overdue' : 'due'} ${dueLabel(due, nowIso, tz)}` : 'no date' },
    tone: null,
    badge: null,
    verb: 'Pull in',
    primary: { kind: 'pull' },
    youMin,
    agentBg: null,
    extras: ['snooze'],
  };
}

/** Not due today, worth doing if the day has room. The engine's list wins; otherwise derive it. */
export function pullRows(input: RowsInput, todayIds: ReadonlySet<string>, fitIds: ReadonlySet<string>, cap = 4): DayRow[] {
  const { data, nowIso, tz } = input;
  const known = new Map<string, WorkItem>(input.catalog ?? []);
  for (const c of input.cards) known.set(c.item.id, c.item);
  for (const r of input.rows) known.set(r.id, r);
  for (const r of input.extras ?? []) known.set(r.id, r);
  for (const s of [...data.shelves.fitIns, ...data.shelves.promises]) known.set(s.item.id, s.item);
  const skip = (id: string) => todayIds.has(id) || fitIds.has(id) || input.pinned.has(id);

  if (input.pullForward) {
    // The engine's list (rank order, at most 5; empty when the day is full).
    return input.pullForward
      .map((ref) => {
        const item = ref.itemId ? known.get(ref.itemId) : undefined;
        if (!item || skip(item.id) || !isActionableItem(item)) return null;
        return pullRowFor(item, ref, nowIso, tz);
      })
      .filter((r): r is DayRow => !!r);
  }

  const candidates = [...input.cards.map((c) => c.item), ...input.rows].filter((i) => isActionableItem(i) && !skip(i.id) && !isBlocked(i));
  candidates.sort((a, b) => (a.due ? msOf(a.due) : Infinity) - (b.due ? msOf(b.due) : Infinity) || (a.rank ?? 999) - (b.rank ?? 999));
  const shelf = data.shelves.fitIns.filter((s) => !skip(s.item.id) && isActionableItem(s.item));
  const fromShelf = shelf.slice(0, 1).map((s) => pullRowFor(s.item, null, nowIso, tz));
  const fromRows = candidates.slice(0, Math.max(0, cap - fromShelf.length)).map((i) => pullRowFor(i, null, nowIso, tz));
  return [...fromRows, ...fromShelf].slice(0, cap);
}

export function promiseRows(data: TodayPayload): DayRow[] {
  return data.shelves.promises.map((s) => ({
    key: `promise:${s.item.id}`,
    section: 'promise' as const,
    item: s.item,
    card: null,
    entity: { kind: 'work_item' as const, id: s.item.id, label: s.item.title },
    title: s.item.title,
    why: s.item.why,
    whyDetail: s.item.whyDetail,
    context: s.item.counterparty?.name ?? contextOf(s.item),
    meta: '',
    when: { main: 'Promise', sub: s.hint.replace(/^promised\s*/i, '') },
    tone: null,
    badge: null,
    verb: s.action.label,
    primary: { kind: 'shelf' as const, entry: s },
    youMin: s.item.effort.youMin,
    agentBg: null,
    extras: ['renegotiate' as const, 'let_go' as const],
  }));
}

export interface DaySections {
  run: DayRow[];
  fit: DayRow[];
  pull: DayRow[];
  promises: DayRow[];
  /** Ids planned today (slots + pinned): they count as today-scoped. */
  planned: Set<string>;
}

export function buildSections(input: RowsInput): DaySections {
  const { cards, rows, nowIso, tz, slots } = input;
  const planned = new Set<string>(input.pinned);
  const today = zoned(nowIso, tz).ymd;
  for (const s of slots) if (s.kind !== 'gap' && s.workItemId && zoned(s.start, tz).ymd === today) planned.add(s.workItemId);
  const cardById = new Map(cards.map((c) => [c.item.id, c]));
  const ordered: WorkItem[] = [];
  const seen = new Set<string>();
  for (const it of [...cards.map((c) => c.item), ...rows]) {
    if (seen.has(it.id) || !isActionableItem(it)) continue;
    seen.add(it.id);
    ordered.push(it);
  }
  // Today's load the payload's window leaves out (e.g. something you just pulled in): append by start time.
  const outside = [...(input.catalog?.values() ?? [])]
    .filter((it) => !seen.has(it.id) && isActionableItem(it) && isTodayScoped(it, nowIso, tz, planned))
    .sort((a, b) => msOf(a.startBy ?? a.due ?? nowIso) - msOf(b.startBy ?? b.due ?? nowIso));
  ordered.push(...outside);
  const run = ordered.filter((i) => isTodayScoped(i, nowIso, tz, planned)).map((i) => runRow(i, cardById.get(i.id) ?? null, input));
  const runIds = new Set(run.map((r) => r.item!.id));
  const fit = fitRows(input.data, runIds, nowIso, tz);
  const fitIds = new Set(fit.map((r) => r.item?.id).filter((x): x is string => !!x));
  const pull = pullRows(input, runIds, fitIds);
  const promiseList = promiseRows(input.data).filter((p) => !runIds.has(p.item!.id));
  return { run, fit, pull, promises: promiseList, planned };
}
