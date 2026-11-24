/**
 * D-65 (TL-06, TL-24, TL-25): the logging canvas's Apply preflight. A `slack_canvas.create` item holds a work order
 * written when it was staged; by Apply, a row in it may be logged by hand already, declined or cancelled, dismissed,
 * edited, or no longer approved. Before anything leaves, every table row is checked against the app's state now, by
 * the check registered for its kind; the canvas is re-rendered without the rows that must not go (renumbered, its
 * counts and title fixed), and an item with nothing left is refused. Pure and generic: the DataSources supply the
 * state (`CanvasPreflightContext`), and another lane adds a row kind by registering its check (`registerCanvasRowCheck`:
 * Deal Contributions, Use_Case__c).
 *
 *   create rows   kind from the table: EVENTS TO CREATE → `event`, DEAL CONTRIBUTIONS TO CREATE → `dc`, USE CASES TO
 *                 CREATE → `use_case__c`
 *   update rows   kind `update:<Object>` from the table (`update:Event` is a Duration__c fix)
 *
 * WO-1 (2026-11-23): a work order has one table per object and verb (src/lib/canvas/tables.ts). A canvas staged before
 * that has the legacy `# ADD` / `# USE CASES` / `# UPDATE` tables, told apart by their headings, with the kind read from
 * the Object cell. Either way a row's `cells` are in the legacy layout (an Object cell second), so the checks, the
 * review and the read-back read one shape; `table` says which new table the line is in (undefined: a legacy table).
 *
 * A kind with no check is kept as it is.
 */
import { quarterHours, sfInstant } from '@/engines/activity/slackbot';
import { DECLINED_MARKER } from '@/engines/activity/internal';
import { CANCELLED_MARKER, ccKeyOf } from '@/engines/activity/org62-check';

import type { CanvasActionInput } from './payload';
import { cellsOfLine, isHeading, legacyCellsOf, lineInTable, tableHeading, tableOfHeading, tableOfKind, type TableId, type TableSpec } from './tables';

export interface CanvasRow {
  section: 'add' | 'use_cases' | 'update';
  /** `event`, `dc`, `use_case__c`, `update:Event`, … */
  kind: string;
  /** Its line in the markdown. */
  line: number;
  /** The table cells, `#` first, in the legacy layout (an Object cell second) whatever table the line is in. */
  cells: string[];
  /** The per-object table the line is in; undefined: a legacy table (`# ADD` / `# USE CASES` / `# UPDATE`). */
  table?: TableId;
  /** The line as it is in the markdown (another lane's own parser reads it). */
  text: string;
  /** ADD Event rows: the CC# key (the app's activity row id). USE CASES rows: the VDP use case id. UPDATE rows: the record id. */
  ref: string | null;
}

/** The app's activity row behind an Event row's CC# key, as it is now. */
export interface PreflightActivity {
  status: string;
  startsAt: string;
  endsAt: string;
  durationH: number;
  taskType: string | null;
  /** The WhatId a batch writes for it now ('' internal); undefined: not known here (not compared). */
  whatId?: string | null;
  flags: readonly string[];
}

/** The state the checks read. Another row kind's check reads its own fields (an open record). */
export interface CanvasPreflightContext {
  activity?: (id: string) => PreflightActivity | null;
  /** An Org62 Event the app mirrors (a Duration__c fix's target): null when the app has none. */
  org62Event?: (id: string) => { durationField: number | null; deleted: boolean } | null;
  /** Whether the persona's Events carry an SE task type (the type cell is compared). */
  taskTypeRequired?: boolean;
  /** TL-25: rows the user just edited: an edit unstages a held row (it goes on the next canvas). */
  unstage?: ReadonlySet<string>;
  [more: string]: unknown;
}

/** A check: why this row must not go (it is dropped), or null (it stays). */
export type CanvasRowCheck = (row: CanvasRow, ctx: CanvasPreflightContext) => string | null;

const CHECKS = new Map<string, CanvasRowCheck>();

/** Register (or replace) the check of one row kind. */
export function registerCanvasRowCheck(kind: string, check: CanvasRowCheck): void {
  CHECKS.set(kind, check);
}
export const canvasRowCheckOf = (kind: string): CanvasRowCheck | undefined => CHECKS.get(kind);

const cellsOf = cellsOfLine;
const isSeparator = (cells: string[]) => cells.every((c) => /^:?-{3,}:?$/.test(c));

/** D-67: a USE CASES row's key (the VDP use case id) in its Notes cell. */
const UC_KEY_RE = /CC-UC#([A-Za-z0-9-]+)/;

/** A row from its legacy-layout cells: kind and key from the section and the Object cell. */
function rowOf(section: CanvasRow['section'], cells: string[], line: number, text: string, table?: TableId): CanvasRow {
  const object = cells[1] ?? '';
  const base = { section, line, text, cells, ...(table ? { table } : {}) };
  if (section === 'add') return { ...base, kind: object === 'Event' ? 'event' : object === 'Deal_Contribution__c' ? 'dc' : object.toLowerCase(), ref: object === 'Event' ? ccKeyOf(cells[9]) : null };
  if (section === 'use_cases') return { ...base, kind: object.toLowerCase(), ref: UC_KEY_RE.exec(cells[12] ?? '')?.[1] ?? null };
  return { ...base, kind: `update:${object}`, ref: cells[2] || null };
}

/** The legacy section a legacy heading opens (a canvas staged before WO-1), or null. */
function legacySectionOf(ln: string): CanvasRow['section'] | null {
  if (/^#\s+ADD\b/.test(ln)) return 'add';
  if (/^#\s+USE CASES\b/.test(ln)) return 'use_cases';
  if (/^#\s+UPDATE\b/.test(ln)) return 'update';
  return null;
}

/** Every data row of the work order's tables (headers and separators left out), per-object tables or legacy. */
export function canvasRowsOf(markdown: string): CanvasRow[] {
  const out: CanvasRow[] = [];
  let section: CanvasRow['section'] | null = null;
  let spec: TableSpec | null = null;
  markdown.split('\n').forEach((ln, i) => {
    if (isHeading(ln)) {
      spec = tableOfHeading(ln);
      section = spec ? spec.section : legacySectionOf(ln);
    }
    if (!section) return;
    const cells = cellsOf(ln);
    if (!cells || isSeparator(cells) || !/^\d+$/.test(cells[0] ?? '')) return; // the header row's `#` is not a number
    const s = spec as TableSpec | null;
    out.push(s ? rowOf(section, legacyCellsOf(s, cells), i, ln, s.id) : rowOf(section, cells, i, ln));
  });
  return out;
}

/** A row's line written again from legacy-layout cells, in the table it is in (a legacy row stays legacy). */
export function rowLine(r: Pick<CanvasRow, 'table' | 'kind'>, legacyCells: readonly string[]): string {
  const spec = r.table ? tableOfKind(r.kind) : null;
  return spec ? lineInTable(spec, legacyCells) : `|${legacyCells.join('|')}|`;
}

/**
 * A line the writers made (they write the per-object tables) for the table the row is in: unchanged on a new-layout
 * canvas, back to the legacy layout (Object cell second) when the row sits in a legacy table.
 */
export function lineForRow(r: Pick<CanvasRow, 'table' | 'kind'>, line: string): string {
  if (r.table) return line;
  const spec = tableOfKind(r.kind);
  const cells = cellsOf(line);
  return spec && cells && cells[1] !== spec.object ? `|${legacyCellsOf(spec, cells).join('|')}|` : line;
}

export interface CanvasDrop {
  kind: string;
  ref: string | null;
  /** The row's subject / record, for the notice. */
  label: string;
  reason: string;
}

export interface CanvasPreflight {
  /** Something must not go: `input` is the canvas without it. */
  changed: boolean;
  /** Nothing is left to send: Apply is refused. */
  empty: boolean;
  dropped: CanvasDrop[];
  /** The canvas as it may go now (the same object when nothing changed). */
  input: CanvasActionInput;
}

/** One sentence for the notice and the refusal: "2 rows left out: 'X' (logged in Org62 already); …". */
export function preflightSummary(p: Pick<CanvasPreflight, 'dropped'>): string {
  const n = p.dropped.length;
  const list = p.dropped
    .slice(0, 4)
    .map((d) => `'${d.label.slice(0, 60)}' (${d.reason})`)
    .join('; ');
  return `${n} ${n === 1 ? 'row' : 'rows'} left out: ${list}${n > 4 ? `; and ${n - 4} more` : ''}`;
}

/** Check every row; re-render without the dropped ones. */
export function preflightCanvas(input: CanvasActionInput, ctx: CanvasPreflightContext): CanvasPreflight {
  const rows = canvasRowsOf(input.markdown);
  const dropped: CanvasDrop[] = [];
  const drop = new Set<number>();
  for (const r of rows) {
    const reason = CHECKS.get(r.kind)?.(r, ctx) ?? null;
    if (!reason) continue;
    drop.add(r.line);
    dropped.push({ kind: r.kind, ref: r.ref, label: r.section === 'update' ? `${r.cells[3] ?? ''} on ${r.cells[2] ?? ''}` : r.cells[2] || r.kind, reason });
  }
  if (!drop.size) return { changed: false, empty: false, dropped, input };
  const left = rows.filter((r) => !drop.has(r.line));
  return { changed: true, empty: left.length === 0, dropped, input: rerenderCanvas(input, rows, drop) };
}

const words = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;

/**
 * A logging canvas's title with its counts as the rows now stand ("Activity log · Nov 3 · 12 rows · 3 DCs · 20 use
 * cases (part 1 of 2)"): each count replaced, a DC or use-case count that fell to zero dropped. Other titles (a
 * forecast canvas's) only get their row count fixed.
 */
export function retitleCanvas(title: string, c: { rows: number; dcs: number; useCases: number }): string {
  const part = / \(part \d+ of \d+\)$/.exec(title)?.[0] ?? '';
  const head = part ? title.slice(0, -part.length) : title;
  const bits = head.split(' · ');
  const out: string[] = [];
  for (const b of bits) {
    if (/^\d+ rows?$/.test(b)) out.push(words(c.rows, 'row'));
    else if (/^\d+ DCs?$/.test(b)) {
      if (c.dcs) out.push(words(c.dcs, 'DC'));
    } else if (/^\d+ use cases?$/.test(b)) {
      if (c.useCases) out.push(words(c.useCases, 'use case'));
    } else out.push(b);
  }
  if (c.dcs && !out.some((b) => /^\d+ DCs?$/.test(b))) out.push(words(c.dcs, 'DC'));
  if (c.useCases && !out.some((b) => /^\d+ use cases?$/.test(b))) out.push(words(c.useCases, 'use case'));
  return `${out.join(' · ')}${part}`;
}

/**
 * The canvas without the dropped lines (an empty `drop` renumbers and recounts as it is, after a row was replaced):
 * each table renumbered, its header's counts rebuilt the way the work order writes them (rows, hours, deal
 * contributions, DC changes, use-case fixes), and the title, Event ids, hours and Duration fixes fixed.
 */
export function rerenderCanvas(input: CanvasActionInput, rows: CanvasRow[], drop: ReadonlySet<number>): CanvasActionInput {
  const lines = input.markdown.split('\n');
  const kept = rows.filter((r) => !drop.has(r.line));
  const keptEvents = kept.filter((r) => r.kind === 'event');
  const hours = Math.round(keptEvents.reduce((s, r) => s + (Number(r.cells[6]) || 0), 0) * 100) / 100;
  const dcAdds = kept.filter((r) => r.kind === 'dc').length;
  const keptUpdates = kept.filter((r) => r.section === 'update');
  const dcChanges = new Set(keptUpdates.filter((r) => r.kind === 'update:Deal_Contribution__c').map((r) => (r.cells[2] ?? '').slice(0, 15))).size;
  const keptUcFixes = keptUpdates.filter((r) => r.kind === 'update:Use_Case__c').length;
  const keptUcRows = kept.filter((r) => r.section === 'use_cases').length;
  const out: string[] = [];
  let n = 0;
  // WO-1: a per-object table is recounted from its own kept rows, and leaves the canvas when none are left
  let skipping = false;
  lines.forEach((ln, i) => {
    if (drop.has(i)) return;
    const spec = tableOfHeading(ln);
    if (spec) {
      const mine = kept.filter((r) => r.table === spec.id).map((r) => r.cells);
      skipping = mine.length === 0;
      n = 0;
      if (!skipping) out.push(tableHeading(spec, mine));
      return;
    }
    if (isHeading(ln)) skipping = false;
    if (skipping) return;
    if (/^#\s+ADD\b/.test(ln) && /h of activities/.test(ln)) {
      n = 0;
      out.push(`# ADD (${keptEvents.length + dcAdds} rows · ${hours.toFixed(2)} h of activities${dcAdds ? ` · ${words(dcAdds, 'deal contribution')}` : ''})`);
      return;
    }
    if (/^#\s+UPDATE\b/.test(ln)) {
      n = 0;
      // another work order's UPDATE table (a forecast canvas): only its row count
      if (/forecast note/.test(ln)) out.push(ln.replace(/^(#\s+UPDATE\s+)\(\d+ rows?/, `$1(${keptUpdates.length} rows`));
      else out.push(`# UPDATE (${keptUpdates.length} rows${dcChanges ? ` · ${words(dcChanges, 'DC change')}` : ''}${keptUcFixes ? ` · ${words(keptUcFixes, 'use-case fix')}` : ''})`);
      return;
    }
    if (/^#\s+(ADD|USE CASES)\b/.test(ln)) {
      n = 0;
      out.push(ln.replace(/^(#\s+USE CASES\s+)\(\d+ rows?\)/, `$1(${words(keptUcRows, 'row')})`));
      return;
    }
    const r = rows.find((x) => x.line === i);
    if (r) {
      n += 1;
      out.push(ln.replace(/^(\s*\|)\d+\|/, `$1${n}|`));
      return;
    }
    out.push(ln);
  });
  const refs = new Set(keptEvents.map((r) => r.ref).filter((x): x is string => !!x));
  const ups = new Set(keptUpdates.map((r) => r.ref).filter((x): x is string => !!x));
  const eventIds = input.eventIds.filter((id) => refs.has(id));
  return {
    ...input,
    markdown: out.join('\n'),
    eventIds,
    hours,
    updates: keptUpdates.filter((r) => r.kind === 'update:Event').length,
    updateIds: (input.updateIds ?? []).filter((id) => ups.has(id)),
    title: retitleCanvas(input.title, { rows: eventIds.length, dcs: dcAdds + dcChanges, useCases: keptUcRows + keptUcFixes }),
  };
}

// ---------------------------------------------------------------------------
// The checks this lane owns: activity Events and Duration__c fixes
// ---------------------------------------------------------------------------

const NOT_APPROVED: Record<string, string> = {
  logged: 'in Org62 already',
  verified: 'in Org62 already',
  verify_failed: 'in Org62 already',
  synced_to_canvas: 'on an applied canvas already',
  dismissed: 'dismissed',
  excluded: 'an Org62 Event covers it already',
  proposed: 'no longer approved',
  needs_input: 'no longer approved',
  upcoming: 'no longer approved',
};

/** TL-06 / TL-24 / TL-25: an Event row goes only while its row is approved, unchanged, and its meeting still on. */
export const eventRowCheck: CanvasRowCheck = (r, ctx) => {
  if (!r.ref || !ctx.activity) return null;
  const a = ctx.activity(r.ref);
  if (!a) return 'removed from Time';
  if (ctx.unstage?.has(r.ref)) return 'edited after staging; it goes on the next canvas';
  if (a.status !== 'approved') return NOT_APPROVED[a.status] ?? 'no longer approved';
  if (a.flags.some((f) => f.startsWith(DECLINED_MARKER))) return 'you declined the meeting';
  if (a.flags.some((f) => f.startsWith(CANCELLED_MARKER))) return 'the meeting was cancelled';
  // the row as a batch would write it now (eventRow's rule: exact Start/End, the end moves only when the hours do)
  const start = sfInstant(a.startsAt);
  const h = quarterHours(a.durationH);
  const span = (Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 3_600_000;
  const end = Math.abs(span - a.durationH) > 0.25 ? sfInstant(new Date(Date.parse(a.startsAt) + Math.round(h * 60) * 60_000).toISOString()) : sfInstant(a.endsAt);
  const changed = r.cells[3] !== start || r.cells[4] !== end || Number(r.cells[6]) !== h || (ctx.taskTypeRequired !== false && (r.cells[5] ?? '') !== (a.taskType ?? '').replace(/\|/g, '/')) || (a.whatId !== undefined && (r.cells[7] ?? '') !== (a.whatId ?? ''));
  return changed ? 'changed after staging; it goes on the next canvas' : null;
};

/**
 * A Duration__c row goes only while the Event is still there and Org62 does not have it yet:
 *  - a backfill (Current value "(blank)": Time (Hrs) never filled) only while Org62's is still blank;
 *  - D-70: an update ("update · Duration 0.25 h → 3 h", Current value a number) only while Org62's is not the new
 *    value already. 2026-11-16: the backfill rule alone dropped every update (Org62's Duration is filled: that is what
 *    an update changes), ~20 s after each canvas was staged; the update came back to Log it and never reached Org62.
 */
export const eventUpdateCheck: CanvasRowCheck = (r, ctx) => {
  if (!r.ref || !ctx.org62Event || (r.cells[3] ?? '') !== 'Duration__c') return null;
  const e = ctx.org62Event(r.ref);
  if (!e) return null;
  if (e.deleted) return 'deleted in Org62';
  const current = (r.cells[5] ?? '').trim();
  if (current === '' || current === '(blank)') return e.durationField !== null ? 'Duration__c is filled in Org62 already' : null;
  const next = Number(r.cells[4]);
  return e.durationField !== null && Number.isFinite(next) && Math.abs(e.durationField - next) < 0.001 ? 'Org62 has this Duration already' : null;
};

registerCanvasRowCheck('event', eventRowCheck);
registerCanvasRowCheck('update:Event', eventUpdateCheck);

// ---------------------------------------------------------------------------
// D-67 rows: VDP use cases → Use_Case__c (created, and Stage / Go-Live fixes)
// ---------------------------------------------------------------------------

/** A use case as the use-case plan sees it now (src/engines/activity/use-cases.ts planUseCases). */
export interface PreflightUseCase {
  state: string;
  /** Stage / Go-Live changes still on their way to Org62. */
  fields: readonly string[];
}

/** A Use_Case__c create goes only while the use case still waits for one: not created in Org62 since, nor withdrawn. */
export const useCaseRowCheck: CanvasRowCheck = (r, ctx) => {
  const of = ctx.useCase as ((vdpUseCaseId: string) => PreflightUseCase | null) | undefined;
  if (!r.ref || !of) return null;
  const u = of(r.ref);
  if (!u || u.state === 'gone' || u.state === 'left' || u.state === 'skipped') return 'withdrawn from VDP';
  if (u.state === 'in_org62' || u.state === 'update' || u.state === 'duplicate' || u.state === 'drift' || u.state === 'others') return 'created in Org62 already';
  if (u.state === 'handed_off') return 'on an applied canvas already';
  return null;
};

/** A Stage / Go-Live fix goes only while Org62 still lacks it. */
export const useCaseUpdateCheck: CanvasRowCheck = (r, ctx) => {
  const of = ctx.useCaseRecord as ((recordId: string) => PreflightUseCase | null) | undefined;
  if (!r.ref || !of) return null;
  const u = of(r.ref);
  if (!u || u.state === 'gone' || u.state === 'left') return 'withdrawn';
  return u.fields.includes(r.cells[3] ?? '') ? null : 'Org62 has it already';
};

registerCanvasRowCheck('use_case__c', useCaseRowCheck);
registerCanvasRowCheck('update:Use_Case__c', useCaseUpdateCheck);
