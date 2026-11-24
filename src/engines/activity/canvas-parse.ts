/**
 * Canvas edit parser: two-way sync between the app's rows and the canvases.
 *
 *  - Review canvas: ticks and `=>` marks (port of canvas.parse_marks / apply_marks).
 *  - App edit -> canvas diff: `diffEntries` + `markFor` produce the `=> …` text for changed rows.
 *  - Work-order canvas: `parseWorkOrder` reads the tables back into rows (WO-1's per-object tables via
 *    `legacyShape`, or a legacy canvas's ADD/UPDATE; also accepts
 *    Slack's normalized tables, which blank the "#" header cell and pad the separator), and
 *    `diffWorkOrder` reports what changed in the canvas since the render.
 *
 * Pure. Nothing is written anywhere.
 */
import { refOf } from './entry';
import { ccKeyOf } from './org62-check';
import { TAXONOMY, TYPES_LOWER, isNeither, roundQuarter } from './taxonomy';
import { HOUR, toIsoSec, toMs } from './time';
import type { ActivityEntry } from './types';
import { legacyShape } from '@/lib/canvas/tables';

// ------------------------------------------------------------------ review canvas marks

export interface ReviewMark {
  approve: boolean;
  skip: boolean;
  type: string | null;
  whatId: string | null;
  hours: number | null;
}

const ITEM_RE = /^\s*[-*]\s*\[(?<mark>[ xX])\]\s*#(?<ref>[A-Za-z0-9_]+)\b(?<rest>.*)$/;
const WHAT_RE = /^00[16][A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;
const HOURS_RE = /^\d+(\.\d+)?\s*h(rs?)?$/;
const SKIP_WORDS = new Set(['skip', 'no', 'drop', 'not mine']);

export function parseMarks(text: string): Map<string, ReviewMark> {
  const marks = new Map<string, ReviewMark>();
  for (const line of text.split(/\r?\n/)) {
    const m = ITEM_RE.exec(line);
    if (!m?.groups) continue;
    const rest = m.groups.rest ?? '';
    const d: ReviewMark = { approve: m.groups.mark!.toLowerCase() === 'x', skip: false, type: null, whatId: null, hours: null };
    const idx = rest.indexOf('=>');
    if (idx >= 0) {
      for (const raw of rest.slice(idx + 2).split(/[,;]/)) {
        const tok = raw.trim().replace(/^[`*_ ]+|[`*_ ]+$/g, '');
        if (!tok) continue;
        const low = tok.toLowerCase();
        if (SKIP_WORDS.has(low)) d.skip = true;
        else if (WHAT_RE.test(tok)) d.whatId = tok;
        else if (HOURS_RE.test(low)) d.hours = roundQuarter(parseFloat(low));
        else if (TYPES_LOWER.has(low)) d.type = TYPES_LOWER.get(low)!;
      }
    }
    marks.set(m.groups.ref!, d);
  }
  return marks;
}

export interface MarkChange {
  ref: string;
  dedupeKey: string;
  action: 'approved' | 'dismissed' | 'edited';
  fields: Partial<Pick<ActivityEntry, 'seTaskType' | 'whatOrg62Id' | 'durationHours'>>;
}

const OPEN_FOR_MARKS = new Set(['proposed', 'needs_input', 'upcoming', 'excluded', 'approved']);

/**
 * Apply ticks/edits. Only open rows change; synced/logged rows ignore stale ticks.
 * An empty box never un-approves: in hands-off mode everything is pre-approved (`=> skip` drops a row).
 */
export function applyMarks(entries: readonly ActivityEntry[], marks: ReadonlyMap<string, ReviewMark>, nowIso: string): { entries: ActivityEntry[]; changes: MarkChange[] } {
  const changes: MarkChange[] = [];
  const out = entries.map((e) => {
    const mk = marks.get(refOf(e));
    if (!mk || !OPEN_FOR_MARKS.has(e.status)) return e;
    const ref = refOf(e);
    if (mk.skip) {
      changes.push({ ref, dedupeKey: e.dedupeKey, action: 'dismissed', fields: {} });
      return { ...e, status: 'dismissed' as const };
    }
    let n = { ...e, userLockedFields: [...e.userLockedFields] };
    const fields: MarkChange['fields'] = {};
    if (mk.type) {
      n.seTaskType = mk.type;
      fields.seTaskType = mk.type;
      n.userLockedFields.push('seTaskType');
    }
    if (mk.whatId) {
      n = { ...n, whatOrg62Id: mk.whatId, whatKind: mk.whatId.startsWith('006') ? 'opportunity' : 'account' };
      fields.whatOrg62Id = mk.whatId;
      n.userLockedFields.push('whatOrg62Id');
    }
    if (mk.hours) {
      n.durationHours = mk.hours;
      n.endsAt = toIsoSec(toMs(n.startsAt) + mk.hours * HOUR);
      fields.durationHours = mk.hours;
      n.userLockedFields.push('durationHours');
    }
    if (Object.keys(fields).length) changes.push({ ref, dedupeKey: e.dedupeKey, action: 'edited', fields });
    if (mk.approve && n.status !== 'approved') {
      const type = n.seTaskType ?? '';
      const okWhat = !!n.whatOrg62Id || type === 'Travel';
      if (okWhat && !(TAXONOMY[type] && isNeither(type))) {
        n = { ...n, status: 'approved', approvedAt: nowIso, approvalMethod: 'click' };
        changes.push({ ref, dedupeKey: e.dedupeKey, action: 'approved', fields: {} });
      }
    }
    return n;
  });
  return { entries: out, changes };
}

// ------------------------------------------------------------------ app edit -> canvas diff

export interface EntryChange {
  dedupeKey: string;
  ref: string;
  before: Partial<ActivityEntry>;
  after: Partial<ActivityEntry>;
  /** The `=> …` text that expresses this edit on the review canvas ('' when nothing to express). */
  mark: string;
}

export interface CanvasDiff {
  added: ActivityEntry[];
  removed: ActivityEntry[];
  changed: EntryChange[];
}

/** `=> skip`, or a comma-joined combination of type, hours and Related To. */
export function markFor(before: ActivityEntry, after: ActivityEntry): string {
  if (after.status === 'dismissed' && before.status !== 'dismissed') return '=> skip';
  const toks: string[] = [];
  if (after.seTaskType && after.seTaskType !== before.seTaskType) toks.push(after.seTaskType);
  if (after.durationHours !== before.durationHours) toks.push(`${after.durationHours}h`);
  if (after.whatOrg62Id && after.whatOrg62Id !== before.whatOrg62Id) toks.push(after.whatOrg62Id);
  return toks.length ? `=> ${toks.join(', ')}` : '';
}

/** What changed in the app since `prev` (the rows as last rendered to the canvas). */
export function diffEntries(prev: readonly ActivityEntry[], next: readonly ActivityEntry[]): CanvasDiff {
  const pm = new Map(prev.map((e) => [e.dedupeKey, e]));
  const nm = new Map(next.map((e) => [e.dedupeKey, e]));
  const changed: EntryChange[] = [];
  for (const [k, a] of nm) {
    const b = pm.get(k);
    if (!b) continue;
    const mark = markFor(b, a);
    const keys = ['subject', 'startsAt', 'endsAt', 'durationHours', 'seTaskType', 'meetingType', 'whatOrg62Id', 'status'] as const;
    const before: Partial<ActivityEntry> = {};
    const after: Partial<ActivityEntry> = {};
    for (const f of keys)
      if (b[f] !== a[f]) {
        (before as Record<string, unknown>)[f] = b[f];
        (after as Record<string, unknown>)[f] = a[f];
      }
    if (Object.keys(after).length) changed.push({ dedupeKey: k, ref: refOf(a), before, after, mark });
  }
  return {
    added: next.filter((e) => !pm.has(e.dedupeKey)),
    removed: prev.filter((e) => !nm.has(e.dedupeKey)),
    changed: changed.sort((x, y) => x.dedupeKey.localeCompare(y.dedupeKey)),
  };
}

/** Append (or replace) the `=>` mark on a rendered review line. */
export function withMark(line: string, mark: string): string {
  if (!mark) return line;
  const base = line.includes('=>') ? line.slice(0, line.indexOf('=>')).trimEnd() : line;
  return `${base} ${mark}`;
}

// ------------------------------------------------------------------ work-order canvas back to rows

export interface ParsedEventRow {
  kind: 'event';
  n: number;
  subject: string;
  startsAt: string;
  endsAt: string;
  seTaskType: string;
  durationHours: number;
  whatId: string;
  meetingType: string;
  description: string;
  /** `CC#<ref>` from the Description, if present. */
  ref: string | null;
  /** Legacy event id when the Description starts with `REPLACES <id>`. */
  replacesId: string | null;
}
export interface ParsedDcRow {
  kind: 'dc';
  n: number;
  oppName: string;
  role: string;
  split: number;
  oppId: string;
  /** "⏎" restored to newlines. */
  comment: string;
}
export interface ParsedUpdateRow {
  n: number;
  object: string;
  recordId: string;
  actionOrField: string;
  newValue: string;
  currentValue: string;
  why: string;
}
export interface ParsedWorkOrder {
  adds: (ParsedEventRow | ParsedDcRow)[];
  updates: ParsedUpdateRow[];
}

function tableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const inner = t.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}
const isSeparator = (cells: string[]) => cells.every((c) => /^:?-{3,}:?$/.test(c));

export function parseWorkOrder(md: string): ParsedWorkOrder {
  const out: ParsedWorkOrder = { adds: [], updates: [] };
  let section: 'add' | 'update' | null = null;
  let seenHeader = false;
  for (const line of legacyShape(md.replace(/\r\n?/g, '\n')).split('\n')) {
    if (/^#\s+ADD\b/.test(line)) {
      section = 'add';
      seenHeader = false;
      continue;
    }
    if (/^#\s+UPDATE\b/.test(line)) {
      section = 'update';
      seenHeader = false;
      continue;
    }
    // any other table (D-67: USE CASES) is not Events: its rows are never read as ADD rows
    if (/^#\s+\S/.test(line)) {
      section = null;
      continue;
    }
    if (!section) continue;
    const cells = tableCells(line);
    if (!cells) continue;
    if (isSeparator(cells)) continue;
    if (!seenHeader) {
      seenHeader = true; // header row (`#`, or Slack's blank first cell)
      continue;
    }
    if (section === 'add') {
      if (cells.length < 10) continue;
      const [n, obj, subj, s, e, type, dur, what, mt, desc] = cells as [string, string, string, string, string, string, string, string, string, string];
      if (obj === 'Deal_Contribution__c') {
        out.adds.push({ kind: 'dc', n: Number(n), oppName: subj, role: type, split: Number(dur), oppId: what, comment: desc.replace(/ ⏎ /g, '\n') });
      } else {
        out.adds.push({
          kind: 'event',
          n: Number(n),
          subject: subj,
          startsAt: s,
          endsAt: e,
          seTaskType: type,
          durationHours: Number(dur),
          whatId: what,
          meetingType: mt,
          description: desc,
          ref: ccKeyOf(desc),
          replacesId: /^REPLACES\s+(\S+)/.exec(desc)?.[1] ?? null,
        });
      }
    } else {
      if (cells.length < 7) continue;
      const [n, object, recordId, actionOrField, newValue, currentValue, why] = cells as [string, string, string, string, string, string, string];
      out.updates.push({ n: Number(n), object, recordId, actionOrField, newValue, currentValue, why });
    }
  }
  return out;
}

export interface WorkOrderRowChange {
  ref: string;
  fields: Record<string, { before: unknown; after: unknown }>;
}
export interface WorkOrderDiff {
  changed: WorkOrderRowChange[];
  /** Rows the user deleted from the canvas. */
  removedRefs: string[];
  /** Rows the user added by hand (no matching ref). */
  addedRows: (ParsedEventRow | ParsedDcRow)[];
}

/** Compare the canvas as rendered with the canvas as read back after the user edited it. */
export function diffWorkOrder(rendered: ParsedWorkOrder, edited: ParsedWorkOrder): WorkOrderDiff {
  const key = (r: ParsedEventRow | ParsedDcRow) => (r.kind === 'event' ? r.ref : `dc:${r.oppId}`);
  const before = new Map<string, ParsedEventRow | ParsedDcRow>();
  for (const r of rendered.adds) {
    const k = key(r);
    if (k) before.set(k, r);
  }
  const seen = new Set<string>();
  const changed: WorkOrderRowChange[] = [];
  const addedRows: (ParsedEventRow | ParsedDcRow)[] = [];
  for (const r of edited.adds) {
    const k = key(r);
    const b = k ? before.get(k) : undefined;
    if (!k || !b) {
      addedRows.push(r);
      continue;
    }
    seen.add(k);
    const fields: WorkOrderRowChange['fields'] = {};
    for (const f of Object.keys(r) as (keyof typeof r)[]) {
      if (f === 'n') continue;
      if (r[f] !== (b as unknown as Record<string, unknown>)[f]) fields[f] = { before: (b as unknown as Record<string, unknown>)[f], after: r[f] };
    }
    if (Object.keys(fields).length) changed.push({ ref: k, fields });
  }
  const removedRefs = [...before.keys()].filter((k) => !seen.has(k)).sort();
  return { changed, removedRefs, addedRows };
}

/** Parsed Event rows back to partial entries (status synced_to_canvas), for two-way sync. */
export function parsedEventToEntry(r: ParsedEventRow): Pick<ActivityEntry, 'subject' | 'startsAt' | 'endsAt' | 'durationHours' | 'seTaskType' | 'whatOrg62Id' | 'meetingType' | 'status'> {
  return {
    subject: r.subject,
    startsAt: toIsoSec(toMs(r.startsAt)),
    endsAt: toIsoSec(toMs(r.endsAt)),
    durationHours: r.durationHours,
    seTaskType: r.seTaskType,
    whatOrg62Id: r.whatId || null,
    meetingType: r.meetingType,
    status: 'synced_to_canvas',
  };
}
