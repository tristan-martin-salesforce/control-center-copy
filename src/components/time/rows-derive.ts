/**
 * Time ▸ Needs you, Log it and a row's details: what a row may change and why not, what the app suggests and the
 * patch that accepts it, and each logging canvas as a run with its own status. Pure (tested in ./rows.test.ts).
 *
 *   rowLock        a row is editable, or read only with the reason ("On “Activity log · Nov 3–Nov 12”, waiting for
 *                  your Apply: edit it in that canvas’s review", "In Org62 since Nov 12: change it there")
 *   acceptPatch    the patch that takes a row's suggestion (an opp, or internal work), through fixPatch: a held row the
 *                  pick completes is approved with it, so it moves to To log ▸ Ready to log
 *   canvasRun      a logging canvas as a run: staged → applied → Slackbot told → in Org62, its status word and tone,
 *                  what to do next, and why its rows are read only
 */
import type { ActivityEntry, ActivitySuggestion, LogCanvas } from '@/contract';
import { LOG_AGAIN_FLAG } from '@/engines/activity/org62-check';
import { EXCLUDED_REASON_SHORT } from './log-derive';
import { fixPatch, type FixPatch } from './path-derive';
import { fmtH } from './derive';

const fmtDay = (iso: string, tz?: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Read only, and why ───────────────────────────────────────────────────────────────────────

export type LockKind = 'from_org62' | 'in_org62' | 'handed_off' | 'on_canvas' | 'dismissed' | 'relog';

export interface RowLock {
  kind: LockKind;
  /** One sentence: what holds the row, and where to change it. */
  why: string;
  /** The canvas that holds it (on_canvas, handed_off). */
  canvas: Pick<LogCanvas, 'draftId' | 'title' | 'url'> | null;
}

/** The canvas a row is on: the one waiting for Apply that holds it, else the newest applied one that lists it. */
export function canvasOf(e: Pick<ActivityEntry, 'id' | 'canvasDraftId'>, canvases: readonly LogCanvas[] | undefined): LogCanvas | null {
  const list = canvases ?? [];
  if (e.canvasDraftId) return list.find((c) => c.draftId === e.canvasDraftId) ?? null;
  return list.find((c) => c.rowIds.includes(e.id)) ?? null;
}

/** Null: every field of the row is yours to change here. */
export function rowLock(e: ActivityEntry, canvases?: readonly LogCanvas[], tz?: string): RowLock | null {
  const c = canvasOf(e, canvases);
  const ref = c ? { draftId: c.draftId, title: c.title, url: c.url } : null;
  if (e.fromOrg62) return { kind: 'from_org62', why: 'Read from an Org62 Event: change it in Org62, the app follows', canvas: null };
  if (e.status === 'logged' || e.status === 'verified') return { kind: 'in_org62', why: `In Org62${e.verifiedAt ? ` (checked ${fmtDay(e.verifiedAt, tz)})` : e.loggedAt ? ` since ${fmtDay(e.loggedAt, tz)}` : ''}: change it in Org62, the app follows`, canvas: ref };
  if (e.canvasDraftId) return { kind: 'on_canvas', why: `On ${c ? `“${c.title}”` : 'a batch'}, waiting for your Apply: edit or remove it in that batch’s review`, canvas: ref };
  if (e.status === 'verify_failed') return { kind: 'relog', why: 'Not in Org62 after its batch ran: Log again puts it in the next batch, Leave out drops it', canvas: ref };
  // D-65: a row you put back with Log again is yours again (it goes on the next canvas)
  if (e.status === 'synced_to_canvas' || (c && c.state !== 'pending' && c.state !== 'retry' && (e.status === 'approved' || e.status === 'proposed') && !e.issues.includes(LOG_AGAIN_FLAG))) return { kind: 'handed_off', why: `Handed to Slackbot on ${c ? `“${c.title}”` : 'a batch'}: it can’t change here now. Org62 has the last word once Slackbot runs it`, canvas: ref };
  if (e.status === 'dismissed') return { kind: 'dismissed', why: `${EXCLUDED_REASON_SHORT[e.excludedReason ?? 'dismissed']}: not logged. Restore it from History`, canvas: null };
  return null;
}

// ── Suggestions ──────────────────────────────────────────────────────────────────────────────

/** "ACME · Headless Phase 2 (ACME Corp)" or "Internal (no opportunity)". */
export function suggestionLabel(s: Pick<ActivitySuggestion, 'kind' | 'oppName' | 'accountName'>): string {
  if (s.kind === 'internal') return 'Internal (no opportunity)';
  const acct = s.accountName && !(s.oppName ?? '').toLowerCase().includes(s.accountName.toLowerCase().split(' ')[0]!) ? ` (${s.accountName})` : '';
  return `${s.oppName ?? 'An opportunity'}${acct}`;
}

/** "86%" */
export const pct = (c: number) => `${Math.round(c * 100)}%`;

/** How sure, in a word (the tone stays the AI color; the word says how much to trust it). */
export function sureWord(c: number): 'sure' | 'likely' | 'a guess' {
  return c >= 0.85 ? 'sure' : c >= 0.65 ? 'likely' : 'a guess';
}

/** The row's confidence chip (ActionRow `confidence`, Sure / Likely / Guess): the same cut-offs as sureWord. */
export function confidenceOf(c: number): 'sure' | 'likely' | 'guess' {
  return c >= 0.85 ? 'sure' : c >= 0.65 ? 'likely' : 'guess';
}

/** The patch that takes the row's suggestion (null when it has none). */
export function acceptPatch(e: ActivityEntry, taskTypeRequired = true): FixPatch | null {
  const s = e.suggestion;
  if (!s) return null;
  if (s.kind === 'internal') return fixPatch(e, { internal: true, ...(s.taskType ? { taskType: s.taskType } : {}) }, taskTypeRequired);
  return s.oppId ? fixPatch(e, { oppId: s.oppId }, taskTypeRequired) : null;
}

/** What the row shows at once when its suggestion is accepted (the opp's name and account). */
export function acceptShown(s: ActivitySuggestion): { oppName: string | null; accountName: string | null } {
  return s.kind === 'internal' ? { oppName: null, accountName: null } : { oppName: s.oppName, accountName: s.accountName };
}

/** A row that has everything it needs once approved (Approve in bulk only touches these). */
export function completeForApprove(e: ActivityEntry, taskTypeRequired = true): boolean {
  return (e.status === 'needs_input' || e.status === 'proposed') && (!!e.oppId || e.internal) && (!taskTypeRequired || !!e.taskType) && e.durationH > 0;
}

// ── Logging canvases as runs ─────────────────────────────────────────────────────────────────

export type RunStepId = 'staged' | 'applied' | 'told' | 'org62';
export type RunStepState = 'done' | 'current' | 'todo' | 'problem';

export interface RunStep {
  id: RunStepId;
  label: string;
  state: RunStepState;
}

export type RunNext = 'apply' | 'check_slack' | 'wait_apply' | 'tell' | 'check' | 'relog' | 'none';

export interface CanvasRun {
  canvas: LogCanvas;
  steps: RunStep[];
  /** "Waiting for your Apply", "Created: tell Slackbot", "Slackbot told: checking Org62", "In Org62" */
  status: string;
  tone: 'act' | 'waiting' | 'danger' | 'warning' | 'done';
  /** What the run waits on next. */
  next: RunNext;
  /** "Waiting for your Apply: you can still edit or remove rows" / "Applied Nov 12: its rows can’t change here now" */
  rowsNote: string;
  /** "3 rows · 4.5 h · 2 DCs" */
  counts: string;
}

const CREATED: ReadonlySet<LogCanvas['state']> = new Set(['applied', 'verified', 'unverified']);

export function runCounts(c: Pick<LogCanvas, 'rows' | 'hours' | 'dcs' | 'updates' | 'useCases'>): string {
  return [c.rows ? `${plural(c.rows, 'row')} · ${fmtH(c.hours)}` : null, c.dcs ? plural(c.dcs, 'DC request') : null, c.useCases ? plural(c.useCases, 'use case') : null, c.updates ? plural(c.updates, 'Event update') : null].filter(Boolean).join(' · ') || 'work order';
}

/** A canvas everything of which is in Org62 (Events, DCs, use cases), as its progress (or its row check) says. */
export function runFinished(c: LogCanvas): boolean {
  if (!CREATED.has(c.state)) return false;
  if (c.progress) return c.progress.state === 'in_org62';
  return !!c.org62 && c.rows > 0 && c.org62.logged === c.rows && !c.dcs && !c.useCases;
}

export function canvasRun(c: LogCanvas, tz?: string): CanvasRun {
  const created = CREATED.has(c.state);
  const p = c.progress;
  const told = !!p && (p.state === 'checking' || p.state === 'in_org62' || p.state === 'missing' || !!p.toldAt);
  const finished = runFinished(c);
  const missing = p?.state === 'missing' || (!!c.org62 && c.org62.missing > 0);
  // a step done reads in the past ("Applied"), the one it waits on as what happens next ("Apply", "Tell Slackbot")
  const applyState: RunStepState = created ? 'done' : c.state === 'retry' ? 'problem' : 'current';
  const tellState: RunStepState = !created ? 'todo' : told ? 'done' : 'current';
  const org62State: RunStepState = finished ? 'done' : missing ? 'problem' : told ? 'current' : 'todo';
  const steps: RunStep[] = [
    { id: 'staged', label: 'Staged', state: 'done' },
    { id: 'applied', label: applyState === 'done' ? 'Applied' : c.state === 'applying' ? 'Applying' : c.state === 'retry' ? 'Apply again' : 'Apply', state: applyState },
    { id: 'told', label: tellState === 'done' ? 'Slackbot told' : 'Send to Org62 via Slackbot', state: tellState },
    { id: 'org62', label: org62State === 'done' ? 'In Org62' : org62State === 'problem' ? 'Missing in Org62' : org62State === 'current' ? 'Checking Org62' : 'In Org62', state: org62State },
  ];
  const applied = c.appliedAt ? `Applied ${fmtDay(c.appliedAt, tz)}` : 'Applied';
  const lockedNote = `${applied}: its rows can’t change here now`;
  let status: string;
  let tone: CanvasRun['tone'];
  let next: RunNext;
  if (c.state === 'pending') [status, tone, next] = ['Waiting for your Apply', 'act', 'apply'];
  else if (c.state === 'retry') [status, tone, next] = c.maybeCreated ? ['Apply got no answer: check Slack first', 'warning', 'check_slack'] : ['Apply failed: apply again', 'warning', 'apply'];
  else if (c.state === 'applying') [status, tone, next] = ['Applying: on its way to Slack', 'waiting', 'wait_apply'];
  else if (finished) [status, tone, next] = ['In Org62', 'done', 'none'];
  else if (missing) [status, tone, next] = [`Missing in Org62${p?.events.missing ? `: ${plural(p.events.missing, 'Event')}` : c.org62?.missing ? `: ${plural(c.org62.missing, 'row')}` : ''}`, 'danger', 'relog'];
  else if (told) [status, tone, next] = ['Slackbot told: checking Org62', 'waiting', 'check'];
  else if (c.state === 'unverified') [status, tone, next] = ['Created, not read back: open it, then send it to Org62 via Slackbot', 'warning', 'tell'];
  else [status, tone, next] = ['Created: send it to Org62 via Slackbot', 'act', 'tell'];
  const rowsNote = c.state === 'pending' || (c.state === 'retry' && !c.maybeCreated) ? 'Waiting for your Apply: edit or remove its rows in the review' : c.state === 'retry' ? 'The last Apply may have made it already: its rows can’t change until you check Slack' : lockedNote;
  return { canvas: c, steps, status, tone, next, rowsNote, counts: runCounts(c) };
}
