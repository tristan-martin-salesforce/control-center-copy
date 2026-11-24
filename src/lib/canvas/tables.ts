/**
 * The work order's tables (D-47, amended 2026-11-23, WO-1): one table per object and verb, each under its own `## `
 * heading, present only when it has rows, in this order (Slackbot works them top to bottom). Each has only the columns
 * its object needs, so Slackbot never decides which column belongs to which type: there is no Object column.
 *
 *   ## EVENTS TO CREATE                9  #, Subject, StartDateTime, EndDateTime, SE_Task_Type__c, Duration__c, WhatId, Meeting_Type__c, Description (ends with the CC# key)
 *   ## DEAL CONTRIBUTIONS TO CREATE    6  #, Opportunity, Opportunity__c, Opportunity_Role__c, Split_Percentage__c, Comments__c
 *   ## USE CASES TO CREATE            12  #, Use_Case_Name__c … Notes__c (ends with the CC-UC# key)
 *   ## EVENTS TO UPDATE                6  #, Record Id, Field, New value, Current value, Why
 *   ## DEAL CONTRIBUTIONS TO UPDATE    6  (the same)
 *   ## USE CASES TO UPDATE             6  (the same)
 *   ## SPECIALIST FORECASTS TO UPDATE  4  #, Record Id, ForecastNotes__c, Deal_Role__c
 *
 * The readers (preflight, review, read-back, the DC and use-case holds) see every row in ONE cell layout: the legacy one
 * (`# ADD` / `# USE CASES` / `# UPDATE`, an Object cell second), so a canvas staged before this change still reviews,
 * preflights and reads back. `toLegacy` maps a column of the new table to its legacy cell. Pure, no imports.
 */

export type TableId = 'events_create' | 'dcs_create' | 'ucs_create' | 'events_update' | 'dcs_update' | 'ucs_update' | 'forecasts_update';

export interface TableSpec {
  id: TableId;
  /** The heading's words (`## EVENTS TO CREATE (…)`). */
  title: string;
  section: 'add' | 'use_cases' | 'update';
  object: string;
  /** The header row's column names, `#` first. */
  columns: readonly string[];
  /** For each column, its index in the legacy cell layout (the Object cell is legacy index 1). */
  toLegacy: readonly number[];
  /** Cells in the legacy layout. */
  legacyWidth: number;
}

const UPDATE_COLS = ['#', 'Record Id', 'Field', 'New value', 'Current value', 'Why'] as const;
const UPDATE_MAP = [0, 2, 3, 4, 5, 6] as const;

export const TABLES: readonly TableSpec[] = [
  { id: 'events_create', title: 'EVENTS TO CREATE', section: 'add', object: 'Event', columns: ['#', 'Subject', 'StartDateTime (UTC)', 'EndDateTime (UTC)', 'SE_Task_Type__c', 'Duration__c', 'WhatId', 'Meeting_Type__c', 'Description'], toLegacy: [0, 2, 3, 4, 5, 6, 7, 8, 9], legacyWidth: 10 },
  { id: 'dcs_create', title: 'DEAL CONTRIBUTIONS TO CREATE', section: 'add', object: 'Deal_Contribution__c', columns: ['#', 'Opportunity', 'Opportunity__c', 'Opportunity_Role__c', 'Split_Percentage__c', 'Comments__c'], toLegacy: [0, 2, 7, 5, 6, 9], legacyWidth: 10 },
  {
    id: 'ucs_create',
    title: 'USE CASES TO CREATE',
    section: 'use_cases',
    object: 'Use_Case__c',
    columns: ['#', 'Use_Case_Name__c', 'Opportunity__c', 'Account__c', 'Product__c', 'Use_Case_Agent_Type__c', 'Entitlement_Leveraged__c', 'Stage__c', 'Go_Live_Date__c', 'Business_Problem_Solved__c', 'Business_Problem_KPIs__c', 'Notes__c'],
    toLegacy: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    legacyWidth: 13,
  },
  { id: 'events_update', title: 'EVENTS TO UPDATE', section: 'update', object: 'Event', columns: UPDATE_COLS, toLegacy: UPDATE_MAP, legacyWidth: 7 },
  { id: 'dcs_update', title: 'DEAL CONTRIBUTIONS TO UPDATE', section: 'update', object: 'Deal_Contribution__c', columns: UPDATE_COLS, toLegacy: UPDATE_MAP, legacyWidth: 7 },
  { id: 'ucs_update', title: 'USE CASES TO UPDATE', section: 'update', object: 'Use_Case__c', columns: UPDATE_COLS, toLegacy: UPDATE_MAP, legacyWidth: 7 },
  { id: 'forecasts_update', title: 'SPECIALIST FORECASTS TO UPDATE', section: 'update', object: 'SpecialistForecast__c', columns: ['#', 'Record Id', 'ForecastNotes__c', 'Deal_Role__c'], toLegacy: [0, 2, 3, 4], legacyWidth: 5 },
];

export const tableSpec = (id: TableId): TableSpec => TABLES.find((t) => t.id === id)!;

/** The table a heading line opens (`## EVENTS TO CREATE (3 rows …)`), or null (a legacy heading, or not a table). */
export function tableOfHeading(line: string): TableSpec | null {
  // R3-11: a hand edit in Slack (`## Events To Create`, `##EVENTS TO CREATE`, doubled spaces) is still the table
  const m = /^#{1,3}\s*([A-Za-z][A-Za-z ]*?[A-Za-z])\s*(?:\(|$)/.exec(line);
  if (!m) return null;
  const title = m[1]!.toUpperCase().replace(/\s+/g, ' ');
  return TABLES.find((t) => t.title === title) ?? null;
}

/** The legacy section a legacy heading opens (`# ADD`, `# USE CASES`, `# UPDATE`: a canvas staged before WO-1), or null. */
export function legacySectionOf(line: string): TableSpec['section'] | null {
  if (/^#\s+ADD\b/.test(line)) return 'add';
  if (/^#\s+USE CASES\b/.test(line)) return 'use_cases';
  if (/^#\s+UPDATE\b/.test(line)) return 'update';
  return null;
}

/** The table a canvas row of this kind (`event`, `dc`, `use_case__c`, `update:Event`, …) belongs in. */
export function tableOfKind(kind: string): TableSpec | null {
  if (kind === 'event') return tableSpec('events_create');
  if (kind === 'dc') return tableSpec('dcs_create');
  if (kind === 'use_case__c') return tableSpec('ucs_create');
  const obj = kind.startsWith('update:') ? kind.slice(7) : null;
  return obj ? (TABLES.find((t) => t.section === 'update' && t.object === obj) ?? null) : null;
}

/** A row's cells in its table → the legacy layout (Object filled in). */
export function legacyCellsOf(spec: TableSpec, cells: readonly string[]): string[] {
  const out = Array.from({ length: spec.legacyWidth }, () => '');
  out[1] = spec.object;
  spec.toLegacy.forEach((li, j) => (out[li] = cells[j] ?? ''));
  return out;
}

/** Legacy-layout cells → a line of this table. */
export function lineInTable(spec: TableSpec, legacy: readonly string[]): string {
  return `|${spec.toLegacy.map((li) => legacy[li] ?? '').join('|')}|`;
}

export const tableHeaderLines = (spec: TableSpec): string[] => [`|${spec.columns.join('|')}|`, `|${spec.columns.map(() => '---').join('|')}|`];

const words = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;

/** A table's heading with its counts (rows in the legacy cell layout). */
export function tableHeading(spec: TableSpec, rows: ReadonlyArray<readonly string[]>): string {
  const n = words(rows.length, 'row');
  let extra = '';
  if (spec.id === 'events_create') extra = ` · ${(Math.round(rows.reduce((s, c) => s + (Number(c[6]) || 0), 0) * 100) / 100).toFixed(2)} h of activities`;
  else if (spec.id === 'dcs_update') extra = ` · ${words(new Set(rows.map((c) => (c[2] ?? '').slice(0, 15))).size, 'DC change')}`;
  else if (spec.id === 'ucs_update') extra = ` · ${words(rows.length, 'use-case fix')}`;
  else if (spec.id === 'forecasts_update') {
    const notes = rows.filter((c) => c[3] && c[3] !== '—').length;
    const roles = rows.filter((c) => c[4] && c[4] !== '—').length;
    extra = ` · ${words(notes, 'forecast note')} · ${words(roles, 'deal role')}`;
  }
  return `## ${spec.title} (${n}${extra})`;
}

/** Is this line a heading (a new table's, a legacy table's, or any other)? */
export const isHeading = (line: string) => /^#{1,3}\s/.test(line) || !!tableOfHeading(line);

/** A table line's cells (`|a|b|` → ['a', 'b']), or null. */
export function cellsOfLine(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const isDataRow = (c: string[] | null): c is string[] => !!c && /^\d+$/.test(c[0] ?? '');

/**
 * A whole table block: heading, its one-paragraph instruction for Slackbot, header and rows (numbered from 1; rows in
 * the legacy layout), and a blank line.
 */
export function tableBlock(spec: TableSpec, rule: string, legacyRows: ReadonlyArray<readonly string[]>): string[] {
  return [tableHeading(spec, legacyRows), '', rule, '', ...tableHeaderLines(spec), ...legacyRows.map((c, i) => lineInTable(spec, [String(i + 1), ...c.slice(1)])), ''];
}

/**
 * The markdown with rows added to one table (numbered on, its heading recounted), or the table inserted in its place in
 * the fixed order when the canvas has none yet. `rule` is the table's paragraph (used only when the table is new).
 */
export function upsertTable(markdown: string, id: TableId, rule: string, legacyRows: ReadonlyArray<readonly string[]>): string {
  if (!legacyRows.length) return markdown;
  const spec = tableSpec(id);
  const lines = markdown.split('\n');
  const at = lines.findIndex((l) => tableOfHeading(l)?.id === id);
  if (at >= 0) {
    let end = at + 1;
    while (end < lines.length && !isHeading(lines[end]!)) end++;
    let last = end - 1;
    while (last > at && !lines[last]!.startsWith('|')) last--;
    const existing: string[][] = [];
    for (let i = at + 1; i <= last; i++) {
      const c = cellsOfLine(lines[i]!);
      if (isDataRow(c)) existing.push(legacyCellsOf(spec, c));
    }
    const added = legacyRows.map((c, k) => lineInTable(spec, [String(existing.length + k + 1), ...c.slice(1)]));
    const out = [...lines.slice(0, last + 1), ...added, ...lines.slice(last + 1)];
    out[at] = tableHeading(spec, [...existing, ...legacyRows]);
    return out.join('\n');
  }
  const order = TABLES.indexOf(spec);
  const later = lines.findIndex((l) => {
    const t = tableOfHeading(l);
    return !!t && TABLES.indexOf(t) > order;
  });
  const block = tableBlock(spec, rule, legacyRows);
  if (later >= 0) return [...lines.slice(0, later), ...block, ...lines.slice(later)].join('\n');
  const body = [...lines];
  while (body.length && body.at(-1) === '') body.pop();
  return [...body, '', ...block.slice(0, -1)].join('\n');
}

/** Whether a work order has rows on this object (a per-object table of it, or a legacy row with its Object cell). */
export function hasObjectRows(markdown: string, object: string): boolean {
  if (markdown.includes(`|${object}|`)) return true;
  return markdown.split('\n').some((l) => tableOfHeading(l)?.object === object);
}

/** Whether the markdown is in the per-table layout (any new heading). A legacy canvas has `# ADD` / `# UPDATE`. */
export const isTableLayout = (markdown: string): boolean => markdown.split('\n').some((l) => !!tableOfHeading(l));

/**
 * The work order in the legacy table shape (`# ADD` with Object cells, `# USE CASES`, `# UPDATE`), for the readers that
 * only pull data out of it (the DC and use-case holds, the read-back's parser). A legacy canvas comes back as it is.
 * Line numbers do not survive: the preflight and the review read `canvasRowsOf` instead.
 */
export function legacyShape(markdown: string): string {
  if (!isTableLayout(markdown)) return markdown;
  const groups: Record<'add' | 'use_cases' | 'update', string[]> = { add: [], use_cases: [], update: [] };
  const rest: string[] = [];
  let spec: TableSpec | null = null;
  // R3-10: a mixed canvas (a legacy `# ADD` table and a per-object one, when a writer upserts a table into a canvas
  // staged before WO-1): the legacy section's rows are already in the legacy layout and join their group
  let legacy: TableSpec['section'] | null = null;
  let inOther = false;
  for (const ln of markdown.split('\n')) {
    if (isHeading(ln)) {
      spec = tableOfHeading(ln);
      legacy = spec ? null : legacySectionOf(ln);
      inOther = !spec && !legacy;
      if (inOther) rest.push(ln);
      continue;
    }
    const c = cellsOfLine(ln);
    if (legacy) {
      if (isDataRow(c)) groups[legacy].push(`|${c.join('|')}|`);
      else if (!c) rest.push(ln);
      continue;
    }
    if (!spec) {
      if (!inOther || !ln.startsWith('|')) rest.push(ln);
      continue;
    }
    if (isDataRow(c)) groups[spec.section].push(`|${legacyCellsOf(spec, c).join('|')}|`);
  }
  const head = (s: string, w: number) => [`${s} (legacy shape)`, '', `|#|Object|${Array.from({ length: w - 2 }, (_, i) => `c${i + 2}`).join('|')}|`, `|${Array.from({ length: w }, () => '---').join('|')}|`];
  return [...rest, '', ...head('# ADD', 10), ...groups.add, '', ...head('# USE CASES', 13), ...groups.use_cases, '', ...head('# UPDATE', 7), ...groups.update].join('\n');
}
