// Home build: the Now card, item and Outbox cards. Split from build.ts (max-lines).
import type { CalendarEvent, Draft, HomeCard, HomeDraftLine, HomeState, HomeVerb, NowCard, WorkItem } from '@/contract';
import { agentMin, approveMin } from './estimate';
import { clip, corePhrase, firstName, plural, shortAccount, shortEvent } from './text';
import { hm, offsetMin, toMs, whenLabel } from './time';
import { whyOfItem } from '@/engines/priority/why';
import { actionApp, actionSource } from '@/lib/actions';
import {
  type Ctx, PREP_DONE_WINDOW_MS, verb, itemHref, TIME_WEEK, REPLY_TITLE, msOrNull, isToday, workEntity,
} from './build.ctx';

// ---------------------------------------------------------------------------
// Do now
// ---------------------------------------------------------------------------

function draftLine(d: Draft): HomeDraftLine {
  const dest = d.destination;
  let who: string;
  let text: string;
  if (dest.kind === 'email') {
    who = firstName(dest.to[0]?.name ?? dest.to[0]?.email.split('@')[0] ?? 'Email');
    text = dest.subject;
  } else if (dest.kind === 'action') {
    who = actionApp(dest.action);
    text = dest.target.label;
  } else {
    const name = dest.channelName;
    who = name.startsWith('#') ? name : firstName(name.replace(/^Group DM\s*·\s*/i, '').split(',')[0] ?? name);
    text = (d.plainText.split('\n').find((l) => l.trim()) ?? '').replace(/^@[\w .'-]+?:\s*/, '');
  }
  return { draftId: d.id, who, source: dest.kind === 'email' ? 'gmail' : dest.kind === 'action' ? actionSource(dest.action) : 'slack', text: clip(text, 90), at: d.createdAt, ready: d.status === 'ready' };
}
export function eventNoun(title: string): string {
  const m = /\b(QBR|review|demo|workshop|presentation|readout|walkthrough|kickoff|onsite|call|sync|session|meeting)\b/i.exec(title);
  if (!m) return 'meeting';
  return m[1] === 'QBR' ? 'QBR' : m[1]!.toLowerCase();
}
export function accountOfEvent(c: Ctx, e: CalendarEvent): string {
  const acc = e.accountId ? c.input.accounts.find((a) => a.id === e.accountId) : undefined;
  if (acc) return shortAccount(acc.name);
  const ini = c.input.initiatives.find((i) => i.targetEventId === e.id);
  const iacc = ini?.accountId ? c.input.accounts.find((a) => a.id === ini.accountId) : undefined;
  return iacc ? shortAccount(iacc.name) : '';
}
function prepFor(c: Ctx, w: WorkItem): HomeCard['prep'] {
  const e = w.servesEventId ? c.eventById.get(w.servesEventId) : undefined;
  if (!e) return null;
  const ini = w.initiativeId ? c.iniById.get(w.initiativeId) : undefined;
  const done = c.input.items
    .filter((x) => x.id !== w.id && x.state === 'done' && x.doneAt && (x.servesEventId === e.id || (ini && x.initiativeId === ini.id)) && c.nowMs - toMs(x.doneAt) <= PREP_DONE_WINDOW_MS)
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
    .slice(0, 2);
  const steps = [...done.map((x) => ({ label: corePhrase(x.title), done: true })), { label: corePhrase(c.nbaOf(w)?.title ?? w.title), done: false }];
  const noun = eventNoun(e.title);
  return { label: `${noun === 'QBR' ? 'QBR' : noun.charAt(0).toUpperCase() + noun.slice(1)} prep`, steps };
}
export function itemVerb(c: Ctx, w: WorkItem): HomeVerb {
  const n = c.nbaOf(w);
  const d = c.draftOf(w);
  if (n?.verb === 'start_in_claude') return verb(n.primaryLabel || 'Open in Claude', 'open_in_claude', null, w.id);
  if (d) return d.status === 'ready' ? verb('Review draft', 'review', `/outbox?draft=${d.id}`, d.id) : verb('Send draft', 'send', itemHref(w.id), d.id);
  if (n?.verb === 'nudge') return verb('Nudge', 'nudge', itemHref(w.id), w.id);
  if (n?.verb === 'review' || n?.verb === 'review_deliverable') return verb(n.primaryLabel || 'Review', 'open', itemHref(w.id), w.id);
  if (n?.verb === 'log') return verb(n.primaryLabel || 'Log', 'confirm', TIME_WEEK, w.id);
  if (n?.verb === 'run_tool') return verb(n.primaryLabel || 'Run tool', 'open', itemHref(w.id), w.id);
  if (n?.verb === 'schedule') return verb(n.primaryLabel || 'Schedule', 'plan', itemHref(w.id), w.id);
  if (w.kind === 'ask' || REPLY_TITLE.test(w.title)) return verb('Draft reply', 'draft', itemHref(w.id), w.id);
  return verb('Open', 'open', itemHref(w.id), w.id);
}
function nowCard(c: Ctx, w: WorkItem): NowCard {
  const runs = w.runIds.map((id) => c.input.agentRuns.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r);
  const order = ['waiting_on_you', 'running', 'failed', 'done_review', 'queued', 'stale', 'done'];
  runs.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  const draft = c.draftOf(w);
  return {
    item: w,
    nba: c.nbaOf(w),
    draft,
    run: runs[0] ?? null,
    proposals: c.input.proposals.filter((p) => p.status === 'pending' && ((p.entity.type === 'work_item' && p.entity.id === w.id) || (draft && p.entity.type === 'draft' && p.entity.id === draft.id))),
  };
}
/** The persona's working hours in the engine's shape (fixed offset at now): the late grace counts working days. */
export function engineHours(c: Ctx) {
  const wh = c.input.workingHours;
  return { start: wh.start, end: wh.end, days: wh.days, utcOffsetMinutes: offsetMin(c.nowMs, c.tz), timeZone: c.tz };
}
/** Lane 07 R7: the card's why is the ranking's why (matters + now); the extractor's sentence stays as the detail. */
function rankWhy(c: Ctx, w: WorkItem): { whyMatters: string | null; whyNow: string | null } {
  const m = w.refs.meeting;
  const p = whyOfItem({ ...w, meeting: m ? { label: shortEvent(m.label), start: m.start } : null }, c.nowMs, engineHours(c));
  return { whyMatters: p.matters, whyNow: p.now };
}
export function itemCard(c: Ctx, w: WorkItem, rank: number): HomeCard {
  const n = c.nbaOf(w);
  const d = c.draftOf(w);
  const sb = msOrNull(w.startBy);
  const due = msOrNull(w.due);
  const prep = prepFor(c, w);
  const ini = w.initiativeId ? c.iniById.get(w.initiativeId) : undefined;
  let state: HomeState | null = null;
  let stateLabel: string | null = null;
  // At most one color signal per card: an AI-drafted card keeps its violet marker unless it is late.
  if (sb !== null && isToday(sb, c) && w.state !== 'in_progress' && (!d || sb <= c.nowMs)) {
    state = sb > c.nowMs ? 'risk' : 'overdue';
    stateLabel = sb > c.nowMs ? `Start by ${hm(sb, c.tz)}` : `Start now (${hm(sb, c.tz)})`;
  } else if (due !== null && due < c.nowMs) {
    state = 'overdue';
    stateLabel = `Due ${whenLabel(due, c.nowMs, c.tz)}`;
  }
  return {
    rank,
    kind: 'item',
    id: w.id,
    entity: workEntity(w),
    tag: shortAccount(w.refs.account?.label) || (ini ? clip(ini.title.replace(/\s*\([^)]*\)/g, ''), 28) : null),
    title: n?.status === 'ready' ? n.title : w.title,
    why: n?.why ?? w.why ?? null,
    ...rankWhy(c, w),
    state,
    stateLabel,
    aiLabel: d ? (d.status === 'ready' ? 'Drafted for you' : 'Draft ready') : null,
    prep,
    context: prep ? null : ini ? `Initiative: ${ini.title.replace(/\s*\([^)]*\)/g, '')}` : null,
    drafts: [],
    draftIds: [],
    youMin: c.handsOn(w),
    agentMin: agentMin(w),
    due: w.due,
    foot: due !== null ? `Due ${whenLabel(due, c.nowMs, c.tz)}` : null,
    verb: itemVerb(c, w),
    now: nowCard(c, w),
    carried: c.carried.get(w.id) ?? null,
  };
}
export function outboxCard(drafts: Draft[], rank: number): HomeCard {
  const n = drafts.length;
  return {
    rank,
    kind: 'outbox',
    id: 'outbox',
    entity: { kind: 'draft', id: drafts[0]!.id, label: `Approve ${plural(n, 'draft')}` },
    tag: 'Outbox',
    title: `Approve ${plural(n, 'draft')}`,
    why: null,
    whyMatters: null,
    whyNow: null,
    state: null,
    stateLabel: null,
    aiLabel: 'Drafted for you',
    prep: null,
    context: null,
    drafts: drafts.slice(0, 3).map(draftLine),
    draftIds: drafts.map((d) => d.id),
    youMin: approveMin(n),
    agentMin: 0,
    due: null,
    foot: 'Nothing sends until you approve',
    verb: verb(`Review ${n}`, 'review', '/outbox'),
    now: null,
    carried: null,
  };
}
