/**
 * The Review page's model (pure; tests/time/review.test.ts). "Review N to log" opens one page of checkboxes:
 *
 *   ready      a row with everything it needs (its opp or internal, its type, its hours): ticked when the app is sure
 *              enough of where it goes (at or over the settle line), else unticked so I look at it first.
 *   suggested  a row that only lacks its opp, with a suggestion at or over the settle line and no close second:
 *              ticked; "Log these" takes the suggestion first (one save, like Accept), then logs it.
 *   unsure     a row that only lacks its opp and the app can't settle it: unticked, with the likely opps inline;
 *              picking one sets it (a correction the app learns from) and ticks it.
 *
 * Nothing is sent from here: "Log these" stages ONE batch for my Apply (D-47) exactly as To log's button did, and in
 * dry run that Apply only shows the payload (*tenet: Nothing leaves without approval*). Pre-ticked is not logged:
 * only the button logs. Hours stay human hours: nothing here changes a row's hours.
 */
import type { ActivityEntry, ActivitySuggestion, DcSuggestion, EventUpdateRow, StageLogBatchRequest, StageLogBatchResult, UseCaseLanding } from '@/contract';
import { DEFAULT_WEIGHTS } from '@/engines/attribution/weights';
import type { ResolvedPersona } from '@/personas/types';
import { fmtH } from './derive';
import { acceptPatch, suggestionLabel } from './rows-derive';
import { plainWords } from './plain';
import { settled } from './compact-derive';

export type ReviewKind = 'ready' | 'suggested' | 'unsure';

export interface ReviewEntry {
  id: string;
  entry: ActivityEntry;
  kind: ReviewKind;
  /** How sure the app is of where it goes (0–1). */
  confidence: number;
  /** Ticked when the page opens. */
  preChecked: boolean;
  /** Where it goes, in words ("Initech · D360 Pilot", "Internal (no opportunity)"); null: not settled yet. */
  target: string | null;
  /** Why the app put it there, one plain sentence. */
  why: string;
  /** A DC the app suggests claiming on the same deal (new, not decided). */
  dc: DcSuggestion | null;
  /** The AE whose deal it is, when I cover them. */
  coveredAe: string | null;
}

/**
 * A DC to claim, a use case ready for Org62, or a change to an Event already there: ticked like a row, logged in the
 * same batch (D-47; C11: everything bound for Org62 is first class in lane 2).
 */
export interface ReviewExtra {
  /** `dc|<suggestion id>`, `uc|<key>` or `up|<write id>`: the tick's id. */
  id: string;
  kind: 'dc' | 'useCase' | 'update';
  /** The suggestion id (DC), the round-trip key (use case) or the write id (update), as the writes take it. */
  ref: string;
  title: string;
  why: string;
  /** Ticked once seen (default true). A DC with light evidence is not (DcSuggestions' rule: pre-ticked only). */
  preTicked?: boolean;
  /** Why it can't be ticked yet ("Split? agree it first"); null or absent: it can. */
  locked?: string | null;
  /** "from your time on Thu 19 Nov": the time row that brought a DC in (C11, time answers ripple to DCs). */
  note?: string | null;
  /** The DC suggestion itself (its row's Accept and Reject). */
  dc?: DcSuggestion;
}

/** Can this extra be ticked (a DC with a split question waits for Edit). */
export const canTickExtra = (x: Pick<ReviewExtra, 'locked'>): boolean => !x.locked;

/** "Thu 19 Nov" */
const shortDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');

/**
 * The time row a DC came from: the latest day I have time on its opp (any row with that opp set, not internal).
 * "from your time on Thu 19 Nov"; null when no time row names the opp.
 */
export function dcTimeNote(s: Pick<DcSuggestion, 'oppId'>, rows: readonly Pick<ActivityEntry, 'oppId' | 'internal' | 'date' | 'status'>[]): string | null {
  const days = rows.filter((e) => e.oppId === s.oppId && !e.internal && e.status !== 'dismissed').map((e) => e.date).sort();
  const last = days.at(-1);
  return last ? `from your time on ${shortDay(last)}` : null;
}

/**
 * The DCs to claim as lane 2 items: why in plain words, the time it came from, ticked only on strong evidence. R3-6:
 * the coverage reason says who and how ("covering for Elena Cruz (OOO) · 50%", "Morgan Hale's deal (AE you
 * cover)"), so the covered AE is named only when no coverage reason is there (never "AE you cover" for an OOO cover).
 */
export function dcExtras(dcs: readonly DcSuggestion[] = [], rows: readonly Pick<ActivityEntry, 'oppId' | 'internal' | 'date' | 'status'>[] = []): ReviewExtra[] {
  return dcs.map((s): ReviewExtra => {
    const split = s.splitPercent === null ? 'Split? agree it first' : `${s.splitPercent}% DC`;
    const covered = s.coveredAe && !s.reasons.some((r) => r.code === 'covered_ae') ? `Covering ${s.coveredAe}` : null;
    const why = plainWords([split, covered, ...s.reasons.filter((r) => r.code !== 'split_question').map((r) => r.text)].filter(Boolean).join(' · '));
    return { id: `dc|${s.id}`, kind: 'dc', ref: s.id, title: accountTitle(s), why, preTicked: s.preTicked && s.splitPercent !== null, locked: s.splitPercent === null ? 'Split? agree it first' : null, note: dcTimeNote(s, rows), dc: s };
  });
}

const accountTitle = (s: Pick<DcSuggestion, 'accountName' | 'oppName'>) => (s.accountName && !s.oppName.toLowerCase().startsWith(s.accountName.toLowerCase()) ? `${s.accountName} · ${s.oppName}` : s.oppName);

export function reviewExtras(useCases: readonly UseCaseLanding[] = [], updates: readonly EventUpdateRow[] = [], dcs: readonly DcSuggestion[] = [], rows: readonly Pick<ActivityEntry, 'oppId' | 'internal' | 'date' | 'status'>[] = []): ReviewExtra[] {
  return [
    ...dcExtras(dcs, rows),
    ...useCases.filter((x) => x.ready).map((x): ReviewExtra => ({ id: `uc|${x.key}`, kind: 'useCase', ref: x.key, title: x.title, why: plainWords([x.companyName, x.oppName, x.sends].filter(Boolean).join(' · ')) || 'Ready for Org62' })),
    ...updates.filter((u) => u.state !== 'dismissed').map((u): ReviewExtra => ({ id: `up|${u.writeId}`, kind: 'update', ref: u.writeId, title: u.label, why: plainWords([u.summary.replace(/^update · /, 'Change: '), u.reason].filter(Boolean).join(' · ')) })),
  ];
}

/**
 * The settle line: at or over it the app is sure enough to tick a row for me. Today every persona uses the
 * attribution weights' line (0.75); a persona field can override it once one exists (Config over code).
 */
export function settleLineFor(persona?: Pick<ResolvedPersona, 'id'> | null, override?: number | null): number {
  void persona;
  return typeof override === 'number' && override > 0 && override <= 1 ? override : DEFAULT_WEIGHTS.settle;
}

/** The engine's own confidence words, as a number, for a row it placed (Sure / Likely / Guess). */
const WORD: Record<ActivityEntry['confidence'], number> = { sure: 0.95, likely: 0.8, guess: 0.5 };

/** How sure the app is of where a ready row goes: my own pick or approval is certain; else the engine's word. */
export function readyConfidence(e: ActivityEntry): number {
  if (e.status === 'approved' || e.userLockedFields.includes('oppId') || e.fromOrg62) return 1;
  return WORD[e.confidence] ?? 0.5;
}

/** The top suggestion is settled (./compact-derive, a leaf: the compact row reads it without this module's imports). */
export { settled };

const targetOf = (e: Pick<ActivityEntry, 'internal' | 'oppName' | 'accountName' | 'oppId'>): string | null => (e.internal ? 'Internal (no opportunity)' : e.oppId ? suggestionLabel({ kind: 'opp', oppName: e.oppName, accountName: e.accountName }) : null);

/** Why it goes there, in one sentence a seller reads once. */
function whyOf(e: ActivityEntry, kind: ReviewKind, s: ActivitySuggestion | null): string {
  if (kind === 'unsure') return s ? `Not sure: maybe ${suggestionLabel(s)} (${s.reason}). Pick where it goes.` : 'The app could not tell which deal this was for. Pick where it goes.';
  if (kind === 'suggested' && s) return `The app suggests ${suggestionLabel(s)}: ${s.reason}.`;
  if (e.status === 'approved') return e.internal ? 'You approved it as internal work.' : 'You approved it.';
  if (e.userLockedFields.includes('oppId')) return 'You picked the opportunity.';
  return e.why ? `${e.why.charAt(0).toUpperCase()}${e.why.slice(1)}.`.replace(/\.\.$/, '.') : 'Complete: it has everything it needs.';
}

/** DC suggestions still waiting, by opp. */
function dcByOpp(dcs: readonly DcSuggestion[]): Map<string, DcSuggestion> {
  const m = new Map<string, DcSuggestion>();
  for (const d of dcs) if (d.state === 'new' && !m.has(d.oppId)) m.set(d.oppId, d);
  return m;
}

export interface ReviewInput {
  /** Rows ready to log (To log's ready rows). */
  ready: readonly ActivityEntry[];
  /** Rows that only lack their opportunity (Needs you's opportunity group). */
  needOpp?: readonly ActivityEntry[];
  dcs?: readonly DcSuggestion[];
  settle: number;
  taskTypeRequired?: boolean;
}

/** A row that only lacks its opp: `suggested` when taking its settled suggestion completes it, else `unsure`. */
export function needOppKind(e: ActivityEntry, settle: number, taskTypeRequired = true): Exclude<ReviewKind, 'ready'> {
  const s = e.suggestion;
  const patch = s ? acceptPatch(e, taskTypeRequired) : null;
  // the suggestion settles it only when taking it completes the row (it would be approved with the save)
  const completes = !!patch && 'status' in patch && patch.status === 'approved';
  return s && completes && settled(e, settle) ? 'suggested' : 'unsure';
}

/**
 * F5 (R2-6): the Review page is lane 2 at full width. Of lane 1's pick-an-opp rows it lists only the unsure ones with
 * likely opps, which a pick ("Log it here") sets and ticks in place; the rest (a settled suggestion to accept, or no
 * suggestion at all) stay lane 1's, as one link: "N more rows need an opp first ▸ Fix or approve".
 */
export function reviewPickRows(needOpp: readonly ActivityEntry[], settle: number, taskTypeRequired = true): { pick: ActivityEntry[]; more: number } {
  const pick = needOpp.filter((e) => (e.suggestion || e.suggestions?.length) && needOppKind(e, settle, taskTypeRequired) === 'unsure');
  return { pick, more: needOpp.length - pick.length };
}

/** "3 more rows need an opp first" (null: none). */
export const fixMoreLine = (n: number): string | null => (n > 0 ? `${n} more ${n === 1 ? 'row needs' : 'rows need'} an opp first` : null);

/** The page's rows, oldest first: ready rows, then the ones the app can settle with one save, then the unsure. */
export function reviewEntries(input: ReviewInput): ReviewEntry[] {
  const dc = dcByOpp(input.dcs ?? []);
  const ttr = input.taskTypeRequired ?? true;
  const out: ReviewEntry[] = [];
  const seen = new Set<string>();
  for (const e of input.ready) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const c = readyConfidence(e);
    const d = e.oppId ? (dc.get(e.oppId) ?? null) : null;
    out.push({ id: e.id, entry: e, kind: 'ready', confidence: c, preChecked: c >= input.settle, target: targetOf(e), why: whyOf(e, 'ready', null), dc: d, coveredAe: d?.coveredAe ?? null });
  }
  for (const e of input.needOpp ?? []) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const s = e.suggestion;
    const kind = needOppKind(e, input.settle, ttr);
    const oppId = s?.kind === 'opp' ? s.oppId : null;
    const d = oppId ? (dc.get(oppId) ?? null) : null;
    out.push({ id: e.id, entry: e, kind, confidence: s?.confidence ?? 0, preChecked: kind === 'suggested', target: kind === 'suggested' && s ? suggestionLabel(s) : null, why: whyOf(e, kind, s), dc: d, coveredAe: d?.coveredAe ?? null });
  }
  return out.sort((a, b) => a.entry.start.localeCompare(b.entry.start));
}

export const initialChecked = (rows: readonly ReviewEntry[]): Set<string> => new Set(rows.filter((r) => r.preChecked).map((r) => r.id));

/** A row can be ticked once the app knows where it goes (an unsure row needs my pick first). */
export const canCheck = (r: ReviewEntry): boolean => r.kind !== 'unsure';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sumH = (rows: readonly ReviewEntry[]) => Math.round(rows.reduce((s, r) => s + r.entry.durationH, 0) * 100) / 100;

/** The one button: "Log these 12 · 14.5 h", or disabled with why. Extras (use cases, Event changes) count as rows. */
export function logButton(rows: readonly ReviewEntry[], checked: ReadonlySet<string>, extras: readonly ReviewExtra[] = []): { label: string; disabled: boolean; why: string | null; count: number; hours: number } {
  const take = rows.filter((r) => checked.has(r.id) && canCheck(r));
  const more = extras.filter((x) => checked.has(x.id) && canTickExtra(x)).length;
  if (!rows.length && !extras.length) return { label: 'Log these', disabled: true, why: 'Nothing is ready to log right now.', count: 0, hours: 0 };
  if (!take.length && !more) return { label: 'Log these', disabled: true, why: 'Tick at least one row to log. Nothing is logged until you do.', count: 0, hours: 0 };
  const h = sumH(take);
  const n = take.length + more;
  return { label: `Log ${n === 1 ? 'this one' : `these ${n}`}${take.length ? ` · ${fmtH(h)}` : ''}`, disabled: false, why: null, count: n, hours: h };
}

/** What each row was when the page opened: its opp, internal flag and version. */
export type ReviewSnapshot = Map<string, { oppId: string | null; internal: boolean; version: number; status: ActivityEntry['status'] }>;

export function snapshotOf(rows: readonly ReviewEntry[]): ReviewSnapshot {
  return new Map(rows.map((r) => [r.id, { oppId: r.entry.oppId, internal: r.entry.internal, version: r.entry.version, status: r.entry.status }]));
}

export interface ReviewChange {
  id: string;
  description: string;
  /** In words: "now goes to Globex · Renewal", "was logged elsewhere", "is gone". */
  what: string;
}

const LOGGED: ReadonlySet<string> = new Set(['synced_to_canvas', 'logged', 'verified', 'dismissed']);

/**
 * Before "Log these" stages anything: the ticked rows as they are now against the page as it opened. A row whose opp
 * changed elsewhere, that left (dismissed, logged, on another batch) or is gone is NOT logged silently: the page says
 * so and waits for a second press (*tenet: Suggest, then learn*: never override what changed under you).
 */
export function recheck(snapshot: ReviewSnapshot, fresh: readonly ActivityEntry[], ids: readonly string[], mine: ReadonlySet<string> = new Set()): ReviewChange[] {
  const byId = new Map(fresh.map((e) => [e.id, e] as const));
  const out: ReviewChange[] = [];
  for (const id of ids) {
    const was = snapshot.get(id);
    if (!was) continue;
    const now = byId.get(id);
    if (!now) {
      out.push({ id, description: 'A row', what: 'is gone: it was removed since you opened this page' });
      continue;
    }
    const name = now.description || 'A row';
    if (LOGGED.has(now.status) && !LOGGED.has(was.status)) out.push({ id, description: name, what: now.status === 'dismissed' ? 'was dismissed since you opened this page' : 'went to Org62 another way since you opened this page' });
    else if (!mine.has(id) && (now.oppId !== was.oppId || now.internal !== was.internal)) out.push({ id, description: name, what: now.internal ? 'is now internal work' : now.oppId ? `now goes to ${targetOf(now)}` : 'lost its opportunity' });
    else if (now.canvasDraftId) out.push({ id, description: name, what: 'is already in a batch waiting for your Apply' });
  }
  return out;
}

/** "1 row changed since you opened this page: Acme sync now goes to Globex · Renewal. Check it, then press Log again." */
export function changeNotice(changes: readonly ReviewChange[]): string | null {
  if (!changes.length) return null;
  const list = changes.slice(0, 3).map((c) => `${c.description} ${c.what}`).join('; ');
  const more = changes.length > 3 ? `; and ${changes.length - 3} more` : '';
  return `${plural(changes.length, 'row')} changed since you opened this page: ${list}${more}. ${changes.length === 1 ? 'It is' : 'They are'} unticked; check, then press Log again.`;
}

/** The one stage request: exactly the ticked rows (each still has to be ready on the server; the rest wait). */
export function stageRequest(rows: readonly ReviewEntry[], checked: ReadonlySet<string>, extras: readonly ReviewExtra[] = []): StageLogBatchRequest {
  const ids = rows.filter((r) => checked.has(r.id) && canCheck(r)).map((r) => r.id);
  const useCases = extras.filter((x) => x.kind === 'useCase' && checked.has(x.id)).map((x) => x.ref);
  const updates = extras.filter((x) => x.kind === 'update' && checked.has(x.id)).map((x) => x.ref);
  // DCs claimed just before (dcsToClaim) ride this batch; with nothing else ticked the batch is the DC requests alone
  const dcOnly = !ids.length && !useCases.length && !updates.length && dcsToClaim(extras, checked).length > 0;
  // the server's rule: with none of the three lists, EVERY ready thing goes; the button is off for an empty pick, and
  // an explicit empty list says "none of these" for the kinds not ticked
  return { ...(ids.length ? { ids } : {}), useCases, updates, ...(dcOnly ? { dcOnly: true } : {}) };
}

/** The DC suggestions "Log" claims first (each a DC request that rides the batch it stages): ticked and tickable. */
export const dcsToClaim = (extras: readonly ReviewExtra[], checked: ReadonlySet<string>): string[] => extras.filter((x) => x.kind === 'dc' && checked.has(x.id) && canTickExtra(x)).map((x) => x.ref);

/** The result screen: what was staged, and that nothing was sent. */
export function resultLines(r: StageLogBatchResult, dryRun: boolean): { title: string; body: string[] } {
  if (!r.draftIds.length) {
    if (r.waiting.rows) return { title: 'Already waiting for your Apply', body: [`${plural(r.waiting.rows, 'row')} ${r.waiting.rows === 1 ? 'is' : 'are'} in a batch you have not applied yet.`, 'Nothing was sent.'] };
    return { title: 'Nothing was staged', body: [r.skipped.length ? `${plural(r.skipped.length, 'row')} still ${r.skipped.length === 1 ? 'needs' : 'need'} something first: ${r.skipped.slice(0, 2).map((s) => `${s.description} (${s.why})`).join('; ')}.` : 'None of the ticked rows was ready.', 'Nothing was sent.'] };
  }
  const n = r.canvases.length;
  return {
    title: `Staged ${n === 1 ? 'one batch' : `${n} batches`}: ${plural(r.events, 'row')} · ${fmtH(r.hours)}`,
    body: [
      ...(r.approved ? [`${plural(r.approved, 'suggested row')} approved with it.`] : []),
      ...(r.skipped.length ? [`${plural(r.skipped.length, 'row')} left out: ${r.skipped.slice(0, 2).map((s) => s.description).join(', ')}.`] : []),
      dryRun ? 'Nothing was sent. Dry run is on: Apply only shows what would go to Org62.' : 'Nothing was sent. It waits for your Apply; then Send to Org62 via Slackbot, and the app checks Org62.',
    ],
  };
}

/** The keys: space ticks, j/k move, Enter opens the row, `a` logs. Null: not a review key. */
export function reviewKey(key: string): 'toggle' | 'next' | 'prev' | 'open' | 'log' | null {
  if (key === ' ') return 'toggle';
  if (key === 'j' || key === 'ArrowDown') return 'next';
  if (key === 'k' || key === 'ArrowUp') return 'prev';
  if (key === 'Enter') return 'open';
  if (key === 'a') return 'log';
  return null;
}
