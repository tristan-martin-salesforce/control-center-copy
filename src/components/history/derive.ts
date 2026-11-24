/**
 * History page helpers (pure): labels, the head sentence, the rows in display order and what each row opens.
 * The payloads come from GET /history and GET /history/:day (src/contract/history.ts).
 */
import type { AgentRunKind, HistoryDay, HistoryDaySummary, RunState, WorkKind } from '@/contract';
import type { PanelEntity } from '@/components/shell/panel';

/** "6.5 h", "0.25 h" */
export const fmtH = (h: number) => `${Math.round(h * 100) / 100} h`;

/** "45m", "1h 30m" */
export function fmtMin(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The calendar cell's accessible name: "Tuesday 3 November: 3 h yours, 2 finished, 1 meeting". */
export function cellLabel(s: HistoryDaySummary, long: string): string {
  if (s.future) return `${long}: not yet`;
  const bits = summaryBits(s);
  return `${long}${s.isToday ? ' (today)' : ''}: ${bits.length ? bits.join(', ') : 'nothing recorded'}`;
}

export function summaryBits(s: Pick<HistoryDaySummary, 'finished' | 'yourH' | 'meetings' | 'sent' | 'dryRuns' | 'agentRuns' | 'org62' | 'arrived'>): string[] {
  const out: string[] = [];
  if (s.finished) out.push(`${s.finished} finished`);
  if (s.yourH) out.push(`${fmtH(s.yourH)} yours`);
  if (s.meetings) out.push(plural(s.meetings, 'meeting'));
  if (s.sent) out.push(`${s.sent} sent`);
  if (s.dryRuns) out.push(plural(s.dryRuns, 'dry run'));
  if (s.agentRuns) out.push(plural(s.agentRuns, 'agent run'));
  if (s.org62) out.push(`${s.org62} logged to Org62`);
  if (s.arrived) out.push(`${s.arrived} new`);
  return out;
}

/** The head sentence for the selected day. */
export function daySentence(d: HistoryDay): string {
  if (d.future) return `${d.label} hasn't happened yet.`;
  const s = d.summary;
  const parts: string[] = [d.isToday ? `Today so far, ${d.label}` : d.label];
  if (s.finished) parts.push(`${s.finished} finished`);
  if (s.meetings) parts.push(plural(s.meetings, 'meeting'));
  if (s.sent || s.dryRuns) parts.push([s.sent ? `${s.sent} sent` : '', s.dryRuns ? plural(s.dryRuns, 'dry run') : ''].filter(Boolean).join(', '));
  if (s.agentRuns) parts.push(`${plural(s.agentRuns, 'agent run')} in the background`);
  if (parts.length === 1) return `${parts[0]} · nothing recorded`;
  return `${parts.join(' · ')} · agent time never counts as yours`;
}

const KIND: Record<WorkKind, string> = { task: 'Task', commitment: 'Commitment', ask: 'Ask', training: 'Training', follow_up: 'Follow-up', travel: 'Travel', deliverable: 'Deliverable' };
export const kindLabel = (k: WorkKind) => KIND[k];

const RUN_KIND: Record<AgentRunKind, string> = { claude_session: 'Claude session', app_run: 'App run', tool_run: 'Tool run' };
export const runKindLabel = (k: AgentRunKind) => RUN_KIND[k];

const RUN_STATE: Record<RunState, string> = { queued: 'Queued', running: 'Running', waiting_on_you: 'Waiting on you', done_review: 'Done, review', done: 'Done', failed: 'Failed', stale: 'Stale' };
export const runStateLabel = (s: RunState) => RUN_STATE[s];

const ACTIVITY: Record<string, string> = {
  upcoming: 'Upcoming',
  needs_input: 'Needs input',
  proposed: 'Proposed',
  approved: 'Approved',
  synced_to_canvas: 'Synced to canvas',
  logged: 'Logged',
  verified: 'Verified',
  verify_failed: 'Verify failed',
  dismissed: 'Dismissed',
};
export const activityStatusLabel = (s: string) => ACTIVITY[s] ?? s;

// ── Rows ───────────────────────────────────────────────────────────────────────────────────

export type SectionId = 'finished' | 'time' | 'meetings' | 'sent' | 'runs' | 'org62' | 'arrived';

export interface RowRef {
  /** Unique across the day ("fin:<itemId>"). */
  rowId: string;
  section: SectionId;
  entity: PanelEntity;
}

/** Every clickable row of the day, in section order, with what it opens in Details. */
export function dayRows(d: HistoryDay, order: SectionId[] = SECTION_ORDER): RowRef[] {
  const out: RowRef[] = [];
  for (const sec of order) {
    if (sec === 'finished') for (const f of d.finished) out.push({ rowId: `fin:${f.itemId}:${f.at}`, section: sec, entity: { kind: 'work_item', id: f.itemId, label: f.title } });
    if (sec === 'time') for (const a of d.time.entries) out.push({ rowId: `act:${a.id}`, section: sec, entity: { kind: 'activity_entry', id: a.id, label: a.description || 'Activity row' } });
    if (sec === 'meetings') for (const m of d.meetings) out.push({ rowId: `mtg:${m.id}`, section: sec, entity: { kind: 'calendar_event', id: m.id, label: m.title } });
    if (sec === 'sent') for (const s of d.sent) out.push({ rowId: `snd:${s.attemptId}`, section: sec, entity: { kind: 'draft', id: s.draftId, label: s.title } });
    if (sec === 'runs')
      for (const r of d.runs) out.push({ rowId: `run:${r.id}`, section: sec, entity: r.kind === 'tool_run' && r.toolRunId ? { kind: 'tool_run', id: r.toolRunId, label: r.title } : { kind: 'agent_run', id: r.id, label: r.title } });
    if (sec === 'org62') for (const o of d.org62) out.push({ rowId: `o62:${o.activityId}`, section: sec, entity: { kind: 'activity_entry', id: o.activityId, label: o.description || 'Activity row' } });
    if (sec === 'arrived') for (const a of d.arrived) out.push({ rowId: `new:${a.itemId}`, section: sec, entity: { kind: 'work_item', id: a.itemId, label: a.title } });
  }
  return out;
}

/** One column: what was done first, then time, meetings, runs, and what arrived. */
export const SECTION_ORDER: SectionId[] = ['finished', 'sent', 'time', 'meetings', 'runs', 'org62', 'arrived'];
/** Two columns (wide): outcomes on the left, time and its context on the right. */
export const SPLIT_LEFT: SectionId[] = ['finished', 'sent', 'org62', 'arrived'];
export const SPLIT_RIGHT: SectionId[] = ['time', 'meetings', 'runs'];

/** True when the day has anything to list. */
export function dayHasRows(d: HistoryDay): boolean {
  return d.finished.length + d.time.entries.length + d.meetings.length + d.sent.length + d.runs.length + d.org62.length + d.arrived.length > 0;
}

/** Month key of a day. */
export const monthOfDay = (day: string) => day.slice(0, 7);

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** "Tuesday 3 November" for a local day string (calendar arithmetic only, no zone needed). */
export function longDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return `${WD[t.getUTCDay()]} ${d} ${MON[m - 1]}`;
}

/** A day `n` days after `day`. */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The Monday of the week holding `day` (the Time page's week key). */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return shiftDay(day, -wd);
}
