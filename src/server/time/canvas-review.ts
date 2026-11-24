/**
 * The canvas review before Apply (2026-11-13 audit B2), the part both DataSources share. Pure.
 *
 * The rows come from the work order itself (src/lib/canvas/preflight.ts `canvasRowsOf`, the parser the Apply
 * preflight uses), so the review shows exactly what Slackbot will write. A review row is one thing to decide on: an
 * Event, a DC add, a DC change (its split row and, when the role changes too, its role row), a VDP use case, an
 * UPDATE row (a Duration fix, a use case's Stage / Go-Live fix), or a forecast row (read-only).
 *
 *   Remove   the row's lines leave the work order (renumbered, counts and title rebuilt): it goes back to waiting,
 *            since nothing holds it any more (an Event stays approved; a DC request or a use case waits again)
 *   Edit     the DataSource keeps the edit on the row's record, then the row's line(s) are written again from it
 *
 * Each is one undoable change on the item, with a new version: a confirm made before it no longer applies.
 */
import type { ActivityEntry, CanvasReview, CanvasReviewDc, CanvasReviewEvent, CanvasReviewUpdate, CanvasReviewUseCase, DcRequest, Draft } from '@/contract';
import { adminSurfaceOf } from '@/contract';
import { cell } from '@/engines/activity/slackbot';
import { UC_AGENT_TYPES, UC_ENTITLEMENTS, UC_PRODUCTS, UC_STAGES, ucNotesText, type UseCaseCreate } from '@/engines/activity/use-cases';
import { ucRowKey, updateRowKey } from '@/lib/canvas/overrides';
import { CANVAS_MAX_BYTES, canvasInputOf, maybeDelivered, utf8Bytes, type CanvasActionInput } from '@/lib/canvas/payload';
import { canvasRowsOf, lineForRow, rerenderCanvas, rowLine, type CanvasRow } from '@/lib/canvas/preflight';
import { AppError, invalid } from '@/server/errors';

import { isPendingLogCanvas } from './canvas-preflight';

const id15 = (s: string | null | undefined) => (s ?? '').slice(0, 15);
/** A canvas cell back to its text (a ` ⏎ ` was a line break). */
export const uncell = (s: string | null | undefined) => (s ?? '').replace(/ ⏎ /g, '\n').trim();

export type ReviewRowKind = 'event' | 'dc' | 'dcchange' | 'use_case' | 'update' | 'forecast';

/** One thing to decide on, and its line(s) in the work order. */
export interface ReviewRow {
  key: string;
  kind: ReviewRowKind;
  rows: CanvasRow[];
}

export const eventRowKey = (ref: string) => `event:${ref}`;
export const dcAddRowKey = (oppId: string, role: string) => `dc:${id15(oppId)}:${role.trim().toLowerCase()}`;
export const dcChangeRowKey = (recordId: string) => `dcchange:${id15(recordId)}`;

/** The review rows of a work order, in its order (a DC change's split and role rows are one). */
export function reviewRowsOf(markdown: string): ReviewRow[] {
  const out: ReviewRow[] = [];
  const changes = new Map<string, ReviewRow>();
  for (const r of canvasRowsOf(markdown)) {
    const c = r.cells;
    if (r.kind === 'event') out.push({ key: eventRowKey(r.ref ?? `n${c[0]}`), kind: 'event', rows: [r] });
    else if (r.kind === 'dc') out.push({ key: dcAddRowKey(c[7] ?? '', c[5] ?? ''), kind: 'dc', rows: [r] });
    else if (r.section === 'use_cases') out.push({ key: ucRowKey(r.ref ?? `n${c[0]}`), kind: 'use_case', rows: [r] });
    else if (r.kind === 'update:Deal_Contribution__c') {
      const key = dcChangeRowKey(c[2] ?? '');
      const had = changes.get(key);
      if (had) had.rows.push(r);
      else {
        const row: ReviewRow = { key, kind: 'dcchange', rows: [r] };
        changes.set(key, row);
        out.push(row);
      }
    } else if (r.kind === 'update:SpecialistForecast__c') out.push({ key: `forecast:${c[2] ?? c[0]}`, kind: 'forecast', rows: [r] });
    else if (r.section === 'update') out.push({ key: updateRowKey(c[1] ?? '', c[2] ?? '', c[3] ?? ''), kind: 'update', rows: [r] });
  }
  return out;
}

/** Why this item can't be changed here (null: it can). */
export function reviewLockedWhy(d: Pick<Draft, 'destination' | 'status' | 'attempts'>): string | null {
  if (d.destination.kind !== 'action' || d.destination.action !== 'slack_canvas.create') return 'Not a canvas';
  if (adminSurfaceOf(d) === 'forecast') return 'A forecast canvas: change its notes on Forecast, then stage it again';
  if (maybeDelivered(d)) return 'The last Apply got no answer, so the canvas may exist already: check Slack first';
  if (!isPendingLogCanvas(d)) return `It is ${d.status.replace(/_/g, ' ')}: it can no longer change here`;
  return null;
}

/** Refuses unless the item can be changed and is still the version you saw. */
export function assertReviewable(d: Draft, ifVersion: number): void {
  const why = reviewLockedWhy(d);
  if (why) throw new AppError('conflict', `Can't change this canvas: ${why}`, { current: d });
  if (d.version !== ifVersion) throw new AppError('conflict', 'The canvas changed since you opened it: its rows are shown again as they are now', { current: d, reason: 'version' });
}

/** A DC canvas row's request: one this item holds first, then any (the canvas names the opp, the role or the DC). */
function requestOf(row: ReviewRow, d: Pick<Draft, 'id'>, requests: readonly DcRequest[]): DcRequest | null {
  const c = row.rows[0]!.cells;
  const here = (r: DcRequest) => r.canvasDraftId === d.id;
  const match =
    row.kind === 'dc'
      ? (r: DcRequest) => r.kind !== 'change' && (r.role || '').trim().toLowerCase() === (c[5] ?? '').toLowerCase() && (id15(r.org62OpportunityId) === id15(c[7]) || r.oppName === c[2])
      : (r: DcRequest) => r.kind === 'change' && id15(r.dc?.org62DcId) === id15(c[2]);
  return requests.find((r) => here(r) && match(r)) ?? requests.find(match) ?? null;
}

export interface ReviewContext {
  entry: (id: string) => ActivityEntry | undefined;
  dcRequests: readonly DcRequest[];
  /** The opp's name for an Org62 opportunity id (15 or 18), when the app has it. */
  oppName?: (org62Id: string) => string | null;
  now: Date;
}

/** A USE CASES row back to the create it was written from (the fields Slackbot sets). */
export function ucCreateOfRow(r: CanvasRow): UseCaseCreate & { source: string } {
  const c = r.cells;
  const notes = uncell(c[12]);
  return {
    vdpUseCaseId: r.ref ?? '',
    vdpSlug: '',
    vdpUrl: null,
    companyName: '',
    displayOrder: 0,
    name: c[2] ?? '',
    opportunityId: c[3] ?? '',
    accountId: c[4] ?? '',
    oppName: '',
    oppCloseDate: null,
    product: c[5] ?? '',
    agentTypes: (c[6] ?? '').split(';').map((x) => x.trim()).filter(Boolean),
    entitlement: c[7] ?? '',
    stage: c[8] ?? '',
    goLive: c[9] ?? '',
    businessProblem: uncell(c[10]),
    kpis: uncell(c[11]),
    notes,
    again: false,
    source: notes.slice(ucNotesText(notes).length).trim(),
  };
}

/** The note in an Event's Description: its text without the CC# key that goes last. */
const noteOf = (desc: string) => uncell(desc.replace(/\s*·?\s*CC#[A-Za-z0-9_-]+\s*$/, ''));

/** Fields an UPDATE row's new value can be edited for here (the rest are another record's own: read-only). */
export const EDITABLE_UPDATE: ReadonlySet<string> = new Set(['Event:Duration__c', 'Use_Case__c:Stage__c', 'Use_Case__c:Go_Live_Date__c']);

export function canvasReviewOf(d: Draft, ctx: ReviewContext): CanvasReview {
  if (d.destination.kind !== 'action' || d.destination.action !== 'slack_canvas.create') throw invalid('Only a canvas item has a review');
  const input = canvasInputOf(d.destination);
  const rows = reviewRowsOf(input.markdown);
  const why = reviewLockedWhy(d);
  const events: CanvasReviewEvent[] = [];
  const dcs: CanvasReviewDc[] = [];
  const useCases: CanvasReviewUseCase[] = [];
  const updates: CanvasReviewUpdate[] = [];
  const forecast: CanvasReview['forecast'] = [];
  for (const row of rows) {
    const r = row.rows[0]!;
    const c = r.cells;
    const n = Number(c[0]) || 0;
    if (row.kind === 'event') {
      const e = r.ref ? (ctx.entry(r.ref) ?? null) : null;
      events.push({ key: row.key, n, entryId: e?.id ?? r.ref, subject: uncell(c[2]), startUtc: c[3] ?? '', endUtc: c[4] ?? '', taskType: c[5] ?? '', hours: Number(c[6]) || 0, whatId: c[7] ?? '', oppName: e?.oppName ?? (c[7] ? (ctx.oppName?.(c[7]) ?? null) : null), accountName: e?.accountName ?? null, meetingType: c[8] ?? '', note: noteOf(c[9] ?? ''), entry: e });
    } else if (row.kind === 'dc') {
      const q = requestOf(row, d, ctx.dcRequests);
      dcs.push({ key: row.key, n, kind: 'add', requestId: q?.id ?? null, oppName: uncell(c[2]), recordId: c[7] ?? '', role: c[5] ?? '', split: Number(c[6]) || 0, fromSplit: null, comment: uncell(c[9]) });
    } else if (row.kind === 'dcchange') {
      const q = requestOf(row, d, ctx.dcRequests);
      const split = row.rows.find((x) => x.cells[3] === 'Split_Percentage__c');
      const role = row.rows.find((x) => x.cells[3] === 'Opportunity_Role__c');
      dcs.push({ key: row.key, n, kind: 'change', requestId: q?.id ?? null, oppName: q?.oppName ?? uncell(c[6]), recordId: c[2] ?? '', role: role?.cells[4] ?? q?.role ?? '', split: Number(split?.cells[4]) || q?.splitPercent || 0, fromSplit: Number(split?.cells[5]) || null, comment: q?.comment ?? '' });
    } else if (row.kind === 'use_case') {
      const u = ucCreateOfRow(r);
      useCases.push({ key: row.key, n, vdpUseCaseId: u.vdpUseCaseId, name: u.name, opportunityId: u.opportunityId, oppName: ctx.oppName?.(u.opportunityId) ?? null, accountId: u.accountId, product: u.product, agentTypes: u.agentTypes, entitlement: u.entitlement, stage: u.stage, goLive: u.goLive, businessProblem: u.businessProblem, kpis: u.kpis, notes: ucNotesText(u.notes), source: u.source });
    } else if (row.kind === 'forecast') {
      forecast.push({ key: row.key, n, recordId: c[2] ?? '', notes: c[3] === '—' ? '' : uncell(c[3]), dealRole: c[4] === '—' ? '' : (c[4] ?? '') });
    } else {
      updates.push({ key: row.key, n, object: c[1] ?? '', recordId: c[2] ?? '', field: c[3] ?? '', newValue: uncell(c[4]), currentValue: uncell(c[5]), why: uncell(c[6]), editable: !why && EDITABLE_UPDATE.has(`${c[1]}:${c[3]}`) });
    }
  }
  const fixes = updates.filter((u) => u.object === 'Use_Case__c').length;
  return {
    draftId: d.id,
    version: d.version,
    title: d.destination.target.label,
    editable: !why,
    readOnlyWhy: why,
    bytes: utf8Bytes(input.markdown),
    maxBytes: CANVAS_MAX_BYTES,
    counts: { events: events.length, hours: Math.round(events.reduce((s, e) => s + e.hours, 0) * 100) / 100, dcs: dcs.length, useCases: useCases.length + fixes, updates: updates.length, forecast: forecast.length },
    events,
    dcs,
    useCases,
    updates,
    forecast,
    options: { ucStages: [...UC_STAGES], ucProducts: [...UC_PRODUCTS], ucEntitlements: [...UC_ENTITLEMENTS], ucAgentTypes: [...UC_AGENT_TYPES.d360, ...UC_AGENT_TYPES.agentforce] },
    generatedAt: ctx.now.toISOString(),
  };
}

/** The review row with this key, or a 404-style refusal that says the canvas moved on. */
export function reviewRowOf(input: Pick<CanvasActionInput, 'markdown'>, key: string): ReviewRow {
  const row = reviewRowsOf(input.markdown).find((r) => r.key === key);
  if (!row) throw new AppError('conflict', 'That row is no longer on this canvas: its rows are shown again as they are now', { reason: 'row_gone' });
  return row;
}

/** The canvas without these rows (they go back to waiting). Never empties it: Reject the canvas instead. */
export function withoutRows(input: CanvasActionInput, keys: readonly string[]): { input: CanvasActionInput; removed: ReviewRow[] } {
  const rows = reviewRowsOf(input.markdown);
  const want = new Set(keys);
  const removed = rows.filter((r) => want.has(r.key));
  if (removed.length !== want.size) throw new AppError('conflict', 'A row you picked is no longer on this canvas: its rows are shown again as they are now', { reason: 'row_gone' });
  if (removed.length === rows.length) throw invalid('That is every row on the canvas: Reject the canvas instead (its rows go back to waiting)');
  const drop = new Set(removed.flatMap((r) => r.rows.map((x) => x.line)));
  return { input: rerenderCanvas(input, canvasRowsOf(input.markdown), drop), removed };
}

/** The canvas with one row's line(s) written again (`lines`: the new ones, numbered anything; renumbered here). */
export function withRowReplaced(input: CanvasActionInput, key: string, lines: readonly string[]): CanvasActionInput {
  const row = reviewRowOf(input, key);
  const at = row.rows.map((r) => r.line);
  const md = input.markdown.split('\n');
  const out: string[] = [];
  md.forEach((ln, i) => {
    if (i === at[0]) out.push(...lines.map((l) => lineForRow(row.rows[0]!, l)));
    else if (!at.includes(i)) out.push(ln);
  });
  const next = { ...input, markdown: out.join('\n') };
  return rerenderCanvas(next, canvasRowsOf(next.markdown), new Set());
}

/** An UPDATE row with a new value (its other cells as they are). */
export function updateLineWith(r: CanvasRow, newValue: string): string {
  const c = [...r.cells];
  c[4] = cell(newValue);
  return rowLine(r, c);
}

/** The new value an editable UPDATE row takes, checked against what the field holds in Org62. */
export function checkedUpdateValue(r: CanvasRow, raw: string, stages: readonly string[] = UC_STAGES): string {
  const k = `${r.cells[1]}:${r.cells[3]}`;
  const v = raw.trim();
  if (!EDITABLE_UPDATE.has(k)) throw invalid(`${r.cells[3]} on ${r.cells[1]} can't be edited here: remove the row instead`);
  if (k === 'Event:Duration__c') {
    const h = Number(v);
    if (!Number.isFinite(h) || h <= 0 || h > 24 || Math.round(h * 4) !== h * 4) throw invalid('Duration__c is hours in 0.25 steps, more than 0 and at most 24');
    return String(h);
  }
  if (k === 'Use_Case__c:Stage__c' && !stages.includes(v)) throw invalid(`Stage__c is one of Org62's stages: ${stages.join(', ')}`);
  if (k === 'Use_Case__c:Go_Live_Date__c' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw invalid('Go_Live_Date__c is a date: YYYY-MM-DD');
  return v;
}

/** The use-case fields an edit sets, checked against Org62's picklists (only the ones it names). */
export function checkedUseCaseFields(f: Partial<Record<'name' | 'product' | 'entitlement' | 'stage' | 'goLive' | 'businessProblem' | 'kpis' | 'notes', string>> & { agentTypes?: string[] }): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const pick = (k: string, v: string | undefined, allowed: readonly string[], blankOk = false) => {
    if (v === undefined) return;
    const t = v.trim();
    if (!(blankOk && t === '') && !allowed.includes(t)) throw invalid(`${k} is one of Org62's values: ${allowed.join(', ')}`);
    out[k] = t;
  };
  if (f.name !== undefined) out.name = f.name.trim();
  pick('product', f.product, UC_PRODUCTS);
  pick('entitlement', f.entitlement, UC_ENTITLEMENTS);
  pick('stage', f.stage, UC_STAGES, true);
  if (f.goLive !== undefined) out.goLive = f.goLive.trim();
  if (f.agentTypes) {
    const all = [...UC_AGENT_TYPES.d360, ...UC_AGENT_TYPES.agentforce];
    const bad = f.agentTypes.filter((t) => !all.includes(t));
    if (bad.length) throw invalid(`Use_Case_Agent_Type__c takes Org62's values only (not: ${bad.join(', ')})`);
    out.agentTypes = [...f.agentTypes];
  }
  for (const k of ['businessProblem', 'kpis', 'notes'] as const) if (f[k] !== undefined) out[k] = f[k]!;
  return out;
}
