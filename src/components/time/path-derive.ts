/**
 * Time ▸ Log hours: the one path, as pure derivations (no React; tested in ./path.test.ts, design note
 * docs/archive/2026-build/time-redesign.md).
 *
 *   Suggested   what the app proposed for the selected week, and where those rows are now
 *   Needs you   open rows that cannot log without you, grouped by what is missing (opp → task type → hours → check),
 *               each row in exactly one group (lane 1 regroups them by suggestion: ./fix-derive.ts); an internal row
 *               (D-64: internal-only work, no opportunity by design) never asks for an opp
 *   Internal    the internal-only rows the app suggests (proposed): a quiet group on Log it, each with Log and Dismiss
 *   Log it      four stops with a count each: Ready to log (verb: Log to Slackbot) → Apply → Tell Slackbot → Verified,
 *               built on q4Steps (./derive.ts) so the handlers, the Outbox items and ⌘↵ stay the same
 *   Quarter     logged in Org62 against the target, what waits on you this quarter, pace, and where a canvas's hours
 *               went when its rows span quarters (LogCanvas.quarters)
 *
 * Human hours only: agent time is never in these rows, so it is never counted here.
 */
import type { ActivityEntry, LogCanvas } from '@/contract';
import { isOverlapInfo } from '@/engines/activity/overlap-flags';
import { countsAsLogged, needsRelog } from '@/engines/activity/org62-check';
import { hasTarget, isInternalEntry } from '@/lib/time-internal';
import { appliedRowIds, cannotLogYet, openNeedOf } from '@/engines/activity/to-log-count';
import { fixRowsOf } from './lanes-derive';
import { dcWord, fmtH, overlapCaption, q4Steps, ucWord, q4Tone, quarterBounds, quarterPace, weekSplit, type Q4Input, type Q4Step, type QuarterPace } from './derive';

const r2 = (n: number) => Math.round(n * 100) / 100;
const sumH = (xs: readonly Pick<ActivityEntry, 'durationH'>[]) => r2(xs.reduce((s, e) => s + e.durationH, 0));
export const rowsWord = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;
/** "3 rows · 4.5 h" */
export const rowsAndHours = (rows: number, hours: number) => `${rowsWord(rows)} · ${fmtH(hours)}`;

const APPLIED: ReadonlySet<LogCanvas['state']> = new Set(['applying', 'applied', 'verified', 'unverified']);

export interface PathInput extends Q4Input {
  tz?: string;
}

/** Rows on a canvas you applied (the shared rule, src/engines/activity/to-log-count.ts). */
export { appliedRowIds };

// ── Needs you ──────────────────────────────────────────────────────────────────────────────

/** D-65: `org62`: not in Org62 after all (its Event deleted there, or its canvas ran without it): Log again / Leave out. */
export type NeedKind = 'org62' | 'opp' | 'type' | 'hours' | 'check';

export interface NeedGroup {
  kind: NeedKind;
  title: string;
  /** One muted line: what to do. */
  why: string;
  rows: ActivityEntry[];
  ids: string[];
  hours: number;
}

export interface NeedsYou {
  groups: NeedGroup[];
  ids: string[];
  hours: number;
}

const OPPISH = /\bopp|whatid|related to/i;
const TYPEISH = /task type|\btype\b/i;
const HOURSISH = /\bhours?\b|duration/i;
/** The engine's own estimate note on a proposed row: it logs as estimated, it does not hold the row. */
const GUESS = /^GUESS:/;

/** A row's warnings: its issues, without the informational overlap notes (D-18) and estimate notes. */
export function rowWarnings(e: Pick<ActivityEntry, 'issues'>): string[] {
  return e.issues.filter((i) => !isOverlapInfo(i) && !GUESS.test(i));
}

/**
 * What a live row is missing before it can log, in fixing order (null: nothing; it is ready, or waits for time to
 * pass). `check`: the scan held it (needs_input) for a question its fields don't answer (time off, a placeholder, a
 * hold), or with every field filled: your Approve releases it.
 */
export function missingOf(e: ActivityEntry, taskTypeRequired = true): NeedKind | null {
  // C10: which rows need you is the shared rule (the sidebar's count reads it too); this names what is missing
  if (!cannotLogYet(e, taskTypeRequired)) return null;
  // D-64: internal-only work has no opportunity by design
  if (!hasTarget(e)) return 'opp'; // D-103 (c): the account itself is a target too
  if (taskTypeRequired && !e.taskType) return 'type';
  const warn = rowWarnings(e);
  if (e.durationH <= 0 || (e.status === 'needs_input' && warn.some((i) => HOURSISH.test(i) && !OPPISH.test(i) && !TYPEISH.test(i)))) return 'hours';
  if (e.status === 'needs_input') return 'check';
  return null;
}

const NEED_TITLE: Record<NeedKind, string> = { org62: 'Not in Org62', opp: 'No opportunity', type: 'No task type', hours: 'Hours to check', check: 'Check and approve' };

function needWhy(kind: NeedKind, recordTypeName: string): string {
  switch (kind) {
    case 'org62':
      return 'Handed to Slackbot, but Org62 has no Event for these: deleted there, or the batch ran without them. Log again puts one in the next batch; Leave out dismisses it.';
    case 'opp':
      return 'Pick the opportunity each row logs to, or Internal for work with no customer. Tick several to set them together.';
    case 'type':
      return `${recordTypeName.endsWith('s') ? recordTypeName : `${recordTypeName}s`} need a task type.`;
    case 'hours':
      return 'Zero hours, or a duration the scan could not settle. Set the hours.';
    case 'check':
      return 'The scan held these with a question. Fix what is off, then Approve.';
  }
}

/**
 * The open rows that need you (live, not in a canvas item or on an applied canvas), each in the group of its first
 * missing thing; groups in fixing order, rows oldest first. Rows whose meeting has not ended yet can be fixed early.
 */
export function needsYou(rows: readonly ActivityEntry[], o: { canvases?: readonly LogCanvas[]; taskTypeRequired?: boolean; recordTypeName?: string } = {}): NeedsYou {
  const applied = appliedRowIds(o.canvases as LogCanvas[] | undefined);
  const by = new Map<NeedKind, ActivityEntry[]>();
  for (const e of [...rows].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id))) {
    // D-65 (TL-14, TL-20): a row not in Org62 after all needs you even though a canvas carried it
    const n = openNeedOf(e, applied, o.taskTypeRequired ?? true);
    const k: NeedKind | null = n === 'org62' ? 'org62' : n ? missingOf(e, o.taskTypeRequired ?? true) : null;
    if (!k) continue;
    by.set(k, [...(by.get(k) ?? []), e]);
  }
  const order: NeedKind[] = ['org62', 'opp', 'type', 'hours', 'check'];
  const groups = order
    .filter((k) => by.has(k))
    .map((kind) => {
      const list = by.get(kind)!;
      return { kind, title: NEED_TITLE[kind], why: needWhy(kind, o.recordTypeName ?? 'Solutions Events'), rows: list, ids: list.map((e) => e.id), hours: sumH(list) };
    });
  const all = groups.flatMap((g) => g.rows);
  return { groups, ids: all.map((e) => e.id), hours: sumH(all) };
}

export type FixPatch = Partial<Pick<ActivityEntry, 'oppId' | 'taskType' | 'durationH' | 'meetingType' | 'description'>> & { status?: 'approved' | 'dismissed'; internal?: boolean; logNote?: string };

/**
 * The patch a Needs-you fix sends. A fix that completes a row the scan held (needs_input: now with its opp, its type
 * when needed, some hours, and no question left) also approves it: your input is the answer, so the row moves to
 * Ready in one click. Nothing leaves before Log to Slackbot, Apply and Slackbot.
 */
export function fixPatch(e: ActivityEntry, patch: FixPatch, taskTypeRequired = true): FixPatch {
  if ('status' in patch) return patch;
  // D-64: "Internal (no opportunity)" is your answer for the row: it completes it (no opp by design) and logs it
  if (patch.internal === true) return e.status === 'needs_input' || e.status === 'proposed' ? { ...patch, status: 'approved' } : patch;
  if (e.status !== 'needs_input') return patch;
  const next = { ...e, ...patch };
  const internal = !next.oppId && patch.internal !== false && isInternalEntry(next);
  if (!hasTarget({ ...next, internal }) || (taskTypeRequired && !next.taskType) || next.durationH <= 0) return patch;
  const left = rowWarnings(e).filter((i) => !(OPPISH.test(i) && hasTarget({ ...next, internal })) && !(TYPEISH.test(i) && next.taskType) && !(HOURSISH.test(i) && 'durationH' in patch));
  return left.length ? patch : { ...patch, status: 'approved' };
}

// ── Internal (no opportunity) ─────────────────────────────────────────────────────────────

export interface InternalGroup {
  rows: ActivityEntry[];
  ids: string[];
  hours: number;
}

/**
 * The internal-only rows the app suggests (D-64): proposed (complete, no opportunity by design), not held or applied,
 * oldest first. They never count in Needs you or the sidebar; Log approves one (it goes in the next batch like any
 * approved row), Dismiss sets it aside. An approved internal row is Ready to log like any other.
 */
export function internalGroup(rows: readonly ActivityEntry[], canvases?: readonly LogCanvas[]): InternalGroup {
  const applied = appliedRowIds(canvases as LogCanvas[] | undefined);
  const list = [...rows].filter((e) => e.internal && e.status === 'proposed' && !e.canvasDraftId && !applied.has(e.id)).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  return { rows: list, ids: list.map((e) => e.id), hours: sumH(list) };
}

// ── Log it: the stepper ────────────────────────────────────────────────────────────────────

export type StageId = 'ready' | 'apply' | 'tell' | 'verified';
export type StageState = 'current' | 'later' | 'waiting' | 'done';

export interface LogStage {
  id: StageId;
  /** "Ready to log", "Apply", "Tell Slackbot", "Verified" */
  title: string;
  rows: number;
  hours: number;
  /** "9 rows · 12 h" / "1 canvas · 6 rows" / "Nothing waiting" */
  count: string;
  /** One muted line under the count. */
  why: string;
  state: StageState;
  /** The step the stage's button runs (q4Steps: submit, outbox, confirm); null on Verified or when empty. */
  step: Q4Step | null;
  /** Quiet second verbs: Approve N now (Ready), Log DCs now (Ready). */
  secondary: Q4Step[];
  /** Ready only: DC requests waiting for a canvas (they ride on the next one with rows; Deals ▸ DCs lists them). */
  dcs?: number;
  /** Ready only: VDP use cases waiting for a canvas (D-70: rows of Ready to log, logged alone or with others). */
  useCases?: number;
}

export interface LogPath {
  steps: Q4Step[];
  stages: LogStage[];
  /** The stage with the page's one filled button (log, then apply, then tell); null when nothing waits on a click. */
  current: LogStage | null;
  needs: NeedsYou;
  /** Rows ready to log (the Ready stage's ids). */
  readyIds: string[];
  /** D-64: internal-only rows the app suggests, waiting for your Log or Dismiss (a quiet group, never counted as needs). */
  internal: InternalGroup;
}

const canvasesWord = (n: number) => (n === 1 ? '1 batch' : `${n} batches`);

/** In Org62 this quarter: logged and verified rows whose day falls in it (Verified's count). */
function inOrg62(rows: readonly ActivityEntry[], label: string): ActivityEntry[] {
  const b = quarterBounds(label);
  // TL-45: the one status → count map (a row whose fields differ is in Org62; a legacy one is not, until re-created)
  return rows.filter((e) => countsAsLogged(e) && (!b || (e.date >= b.start && e.date <= b.end)));
}

export function logPath(input: PathInput & { recordTypeName?: string }): LogPath {
  const taskTypeRequired = input.taskTypeRequired ?? true;
  const steps = q4Steps(input);
  const by = (id: Q4Step['id']) => steps.find((s) => s.id === id) ?? null;
  const submit = by('submit');
  const outbox = by('outbox');
  const confirm = by('confirm');
  const dcs = by('dcs');
  const byId = new Map(input.rows.map((r) => [r.id, r] as const));
  const readyIds = submit?.ids ?? [];
  const readyProposed = readyIds.filter((id) => byId.get(id)?.status === 'proposed');
  const approveNow: Q4Step | null = readyProposed.length
    ? { id: 'approve', state: 'later', title: `${rowsWord(readyProposed.length)} suggested`, why: 'Approved with the batch; approve now to keep them without logging yet', verb: `Approve ${readyProposed.length} now`, ids: readyProposed, hours: sumH(readyProposed.map((id) => byId.get(id)!)) }
    : null;

  // in Org62 and confirmed: a logged row the read-back has not confirmed yet is still on Tell Slackbot, never twice
  const telling = new Set(confirm?.ids ?? []);
  const verified = inOrg62(input.rows, input.week.quarter.label).filter((e) => !telling.has(e.id));
  const heldCanvases = outbox?.draftIds?.length ?? 0;
  const tellCanvases = confirm?.canvases?.length ?? 0;
  const missing = confirm ? confirm.ids.filter((id) => needsRelog(byId.get(id) ?? { status: '' })).length : 0;
  const typeWord = taskTypeRequired ? 'a task type and ' : '';
  // DC requests (claims from Deals, Missed or the Assistant) wait for a canvas: the Ready stop counts them, so 55
  // claims never hide behind "DC requests ride along"
  const dcN = Math.max(0, input.dcPending ?? 0);
  const ucN = Math.max(0, input.ucPending ?? 0);
  const dcShort = dcN === 1 ? '1 DC' : `${dcN} DCs`;
  const andList = (xs: Array<string | null>) => {
    const v = xs.filter((x): x is string => !!x);
    return v.length <= 1 ? (v[0] ?? '') : `${v.slice(0, -1).join(', ')} and ${v.at(-1)}`;
  };

  // 2026-11-13 audit C2: DCs and use cases waiting are work: the Ready stop is never a muted "done" while they wait.
  // With no rows ready, its button is Log DCs now (a canvas of only the DCs); D-70: use cases are rows of their own (Log
  // it lists them and its button takes them). It is the page's filled default only when nothing else waits on a click.
  const ucShort = ucN === 1 ? '1 VDP use case' : `${ucN} VDP use cases`;
  const queued = [dcN ? dcShort : null, ucN ? ucShort : null].filter(Boolean).join(' · ');
  const readyWhy = readyIds.length
    ? `Log to Slackbot puts ${andList(['them', dcN ? `your ${dcWord(dcN)}` : null, ucN ? `your ${ucWord(ucN)}` : null])} in a new batch`
    : dcN && ucN
      ? `Log to Slackbot puts your ${ucWord(ucN)} in a new batch, with your ${dcWord(dcN)}`
      : dcN
        ? `${dcN === 1 ? 'It rides' : 'They ride'} in your next batch with rows; Log DCs now puts ${dcN === 1 ? 'it' : 'them'} on one of ${dcN === 1 ? 'its' : 'their'} own`
        : ucN
          ? `Log to Slackbot puts ${ucN === 1 ? 'it' : 'them'} in a new batch: a use case logs on its own or with rows`
          : `Rows land here once they have ended, with ${typeWord}an opportunity`;

  const stages: LogStage[] = [
    {
      id: 'ready',
      title: 'Ready to log',
      rows: readyIds.length,
      hours: submit?.hours ?? 0,
      count: readyIds.length ? `${rowsAndHours(readyIds.length, submit!.hours)}${queued ? ` · ${queued}` : ''}` : queued ? `${queued} waiting` : 'Nothing ready',
      why: readyWhy,
      state: readyIds.length || dcN || ucN ? 'later' : 'done',
      step: readyIds.length ? submit : dcN ? dcs : null,
      secondary: [approveNow].filter((s): s is Q4Step => !!s),
      dcs: dcN,
      useCases: ucN,
    },
    {
      id: 'apply',
      title: 'Apply',
      rows: outbox?.ids.length ?? 0,
      hours: outbox?.hours ?? 0,
      count: outbox ? (outbox.ids.length ? `${canvasesWord(heldCanvases)} · ${rowsWord(outbox.ids.length)}` : canvasesWord(heldCanvases)) : 'Nothing waiting',
      why: outbox ? 'Review each batch, then Apply: the app creates it in Slack' : 'A staged batch waits here for your Apply',
      state: outbox ? 'later' : 'done',
      step: outbox,
      secondary: [],
    },
    {
      id: 'tell',
      title: 'Send to Org62 via Slackbot',
      rows: confirm?.ids.length ?? 0,
      hours: confirm?.hours ?? 0,
      count: confirm ? `${rowsWord(confirm.ids.length)}${tellCanvases ? ` on ${canvasesWord(tellCanvases)}` : ''}` : 'Nothing waiting',
      why: confirm
        ? confirm.state === 'waiting'
          ? 'Prompt copied: Slackbot writes Org62, the Org62 check confirms it'
          : `Copy the prompt, open the batch in Slack and send it to Org62 via Slackbot${missing ? ` · ${missing} missing in Org62` : ''}`
        : 'Created batches wait here until Slackbot runs them',
      state: confirm ? (confirm.state === 'waiting' ? 'waiting' : 'later') : 'done',
      step: confirm,
      secondary: [],
    },
    {
      id: 'verified',
      title: 'Verified',
      rows: verified.length,
      hours: sumH(verified),
      count: verified.length ? rowsAndHours(verified.length, sumH(verified)) : 'None yet',
      why: `In Org62 this quarter (${input.week.quarter.label})`,
      state: 'done',
      step: null,
      secondary: [],
    },
  ];
  // one filled button: the first stage that waits on your click, in the old order (log → apply → tell). Log DCs now
  // (a canvas of only DCs) is a choice: the default only when nothing else waits; a stop with no button never is.
  const clickable = stages.filter((s) => s.state === 'later' && s.step);
  const current = clickable.find((s) => s.step!.id !== 'dcs') ?? clickable[0] ?? null;
  if (current) current.state = 'current';
  return { steps, stages, current, needs: needsYou(input.rows, { canvases: input.week.logCanvases, taskTypeRequired, recordTypeName: input.recordTypeName }), readyIds, internal: internalGroup(input.rows, input.week.logCanvases) };
}

// ── The quarter header ─────────────────────────────────────────────────────────────────────

export interface QuarterPart {
  id: 'needs' | 'ready' | 'apply' | 'tell';
  label: string;
  rows: number;
  hours: number;
}

export interface CanvasSpill {
  draftId: string;
  title: string;
  /** Applied (landed) or still waiting for Apply (will land). */
  applied: boolean;
  at: string;
  hours: number;
  /** Its hours in the current quarter. */
  hereH: number;
  /** Its hours in other quarters, newest first: "31.8 h landed in Q3 FY27". */
  elsewhere: Array<{ label: string; rows: number; hours: number }>;
}

export interface QuarterTruth {
  label: string;
  loggedH: number;
  targetH: number;
  /** Hours to the target (0 when met or without a target). */
  leftH: number;
  /** 0–100 of the target. */
  pct: number;
  /** Of the logged hours, those Org62 read-back verified (GET /time/log's quarter); null while unknown. */
  verifiedH: number | null;
  pace: QuarterPace | null;
  tone: 'danger' | 'warning' | 'none';
  /** Rows of this quarter that wait on a step of yours: needs you, ready to log, apply, tell Slackbot. */
  waiting: { rows: number; hours: number; parts: QuarterPart[] };
  /** Rows of this quarter on their way (prompt copied, or a canvas on its way to Slack): not on you. */
  onItsWay: { rows: number; hours: number };
  /** Canvases whose rows land (or will land) in another quarter. */
  spill: CanvasSpill[];
}

export function quarterTruth(input: PathInput, path: LogPath, verifiedH: number | null = null): QuarterTruth {
  const { quarter } = input.week;
  const b = quarterBounds(quarter.label);
  const inQ = (e: ActivityEntry | undefined): e is ActivityEntry => !!e && (!b || (e.date >= b.start && e.date <= b.end));
  const byId = new Map(input.rows.map((r) => [r.id, r] as const));
  const pick = (ids: readonly string[]) => ids.map((id) => byId.get(id)).filter(inQ);
  const tell = path.stages.find((s) => s.id === 'tell')!;
  const copied = tell.state === 'waiting';
  const lists: Array<[QuarterPart['id'], string, ActivityEntry[]]> = [
    // C1: the same rows as the header's "need you" (./lanes-derive.ts): fix rows and the not-found ones, never Internal
    ['needs', 'need you', pick([...fixRowsOf(path.needs), ...(path.needs.groups.find((g) => g.kind === 'org62')?.rows ?? [])].map((e) => e.id))],
    ['ready', 'ready to log', pick(path.readyIds)],
    ['apply', 'to apply', pick(path.stages.find((s) => s.id === 'apply')!.step?.ids ?? [])],
    ['tell', 'to send to Org62 via Slackbot', copied ? [] : pick(tell.step?.ids ?? [])],
  ];
  const seen = new Set<string>();
  const parts: QuarterPart[] = [];
  for (const [id, label, list] of lists) {
    const mine = list.filter((e) => !seen.has(e.id));
    for (const e of mine) seen.add(e.id);
    if (mine.length) parts.push({ id, label, rows: mine.length, hours: sumH(mine) });
  }
  const waitingRows = [...seen].map((id) => byId.get(id)!);
  const applying = new Set((input.week.logCanvases ?? []).filter((c) => c.state === 'applying').flatMap((c) => c.rowIds));
  const way = [...(copied ? pick(tell.step?.ids ?? []) : []), ...pick([...applying])].filter((e, i, xs) => !seen.has(e.id) && xs.findIndex((x) => x.id === e.id) === i);
  const spill: CanvasSpill[] = [];
  for (const c of input.week.logCanvases ?? []) {
    const elsewhere = (c.quarters ?? []).filter((q) => q.label !== quarter.label && q.hours > 0);
    if (!elsewhere.length) continue;
    spill.push({ draftId: c.draftId, title: c.title, applied: APPLIED.has(c.state), at: c.appliedAt ?? c.createdAt, hours: c.hours, hereH: r2((c.quarters ?? []).filter((q) => q.label === quarter.label).reduce((s, q) => s + q.hours, 0)), elsewhere });
  }
  return {
    label: quarter.label,
    loggedH: r2(quarter.loggedH),
    targetH: quarter.targetH,
    leftH: quarter.targetH > 0 ? Math.max(0, Math.round((quarter.targetH - quarter.loggedH) * 10) / 10) : 0,
    pct: quarter.targetH > 0 ? Math.min(100, (quarter.loggedH / quarter.targetH) * 100) : 0,
    verifiedH,
    pace: quarterPace(quarter, input.nowIso, input.tz),
    tone: q4Tone(quarter, input.nowIso),
    waiting: { rows: waitingRows.length, hours: sumH(waitingRows), parts },
    onItsWay: { rows: way.length, hours: sumH(way) },
    spill,
  };
}

/** "31.8 h landed in Q3 FY27" / "31.8 h will land in Q3 FY27" (one canvas, every other quarter it touches). */
export function spillLine(s: Pick<CanvasSpill, 'applied' | 'elsewhere'>): string {
  return s.elsewhere.map((q) => `${fmtH(q.hours)} ${s.applied ? 'landed' : 'will land'} in ${q.label}`).join(', ');
}

// ── Suggested (the selected week) ──────────────────────────────────────────────────────────

export interface WeekSuggested {
  /** This week's rows the app proposed that count as your hours (not excluded, not later this week). */
  rows: number;
  hours: number;
  /** Rows later this week (meetings that have not happened yet). */
  upcoming: number;
  /** Where those rows are now (internal: internal-only suggestions waiting for your Log, D-64). */
  parts: Array<{ id: 'needs' | 'ready' | 'internal' | 'way' | 'org62' | 'other'; label: string; rows: number; hours: number }>;
  /** Excluded or dismissed rows of the week (never logged; the Ledger says why). */
  excluded: number;
  cf: number;
  cr: number;
  unassigned: number;
  overlap: string | null;
}

export function weekSuggested(entries: readonly ActivityEntry[], path: Pick<LogPath, 'needs' | 'readyIds' | 'stages'> & Partial<Pick<LogPath, 'internal'>>, canvases?: readonly LogCanvas[]): WeekSuggested {
  const live = entries.filter((e) => e.status !== 'dismissed' && e.status !== 'upcoming');
  const needs = new Set(path.needs.ids);
  const ready = new Set(path.readyIds);
  const internal = new Set(path.internal?.ids ?? []);
  const applied = appliedRowIds(canvases as LogCanvas[] | undefined);
  const parts: WeekSuggested['parts'] = [];
  const buckets: Record<WeekSuggested['parts'][number]['id'], ActivityEntry[]> = { needs: [], ready: [], internal: [], way: [], org62: [], other: [] };
  for (const e of live) {
    if (needs.has(e.id)) buckets.needs.push(e);
    else if (ready.has(e.id)) buckets.ready.push(e);
    else if (internal.has(e.id)) buckets.internal.push(e);
    // D-65 (TL-45): the one count map; a row not in Org62 after all (deleted there, or its canvas ran without it) needs you
    else if (needsRelog(e)) buckets.needs.push(e);
    else if (countsAsLogged(e) || e.status === 'logged' || e.status === 'verified') buckets.org62.push(e);
    else if (e.canvasDraftId || applied.has(e.id) || e.status === 'synced_to_canvas') buckets.way.push(e);
    else buckets.other.push(e);
  }
  const LABEL = { needs: ['needs you', 'need you'], ready: ['ready to log', 'ready to log'], internal: ['internal, to log or dismiss', 'internal, to log or dismiss'], way: ['on its way', 'on their way'], org62: ['in Org62', 'in Org62'], other: ['not ended yet', 'not ended yet'] } as const;
  for (const id of ['needs', 'ready', 'internal', 'way', 'org62', 'other'] as const) {
    const n = buckets[id].length;
    if (n) parts.push({ id, label: LABEL[id][n === 1 ? 0 : 1], rows: n, hours: sumH(buckets[id]) });
  }
  const split = weekSplit([...entries]);
  return {
    rows: live.length,
    hours: sumH(live),
    upcoming: entries.filter((e) => e.status === 'upcoming').length,
    parts,
    excluded: entries.filter((e) => e.status === 'dismissed').length,
    cf: r2(split.cf),
    cr: r2(split.cr),
    unassigned: r2(split.unassigned),
    overlap: overlapCaption(live),
  };
}

/** Week of the row's local day (Monday, YYYY-MM-DD): where "Show in the week" goes. */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}
