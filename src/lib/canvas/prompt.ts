/**
 * "Copy Slackbot prompt" for ONE canvas: Time's Confirm step and Applied canvases, Outbox ▸ Sent, Time ▸ Forecast's
 * With Slackbot. Pure, shared by the UI and the server. The prompt names the canvas by its own title (and link), and a
 * logging canvas by the persona's Org62 Event record type (an SE's Solutions Event, an AE's Sales Event, D-55). No
 * secrets: a title, a link and counts. Nothing is sent from here; the user pastes it to Slackbot.
 */
import type { ActionDestination } from '@/contract';
import { canvasInputOf, ucRowCount } from './payload';
import { legacyShape } from './tables';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hoursLabel = (h: number) => `${Math.round(h * 100) / 100} h`;

/** "Sales Events" → "Sales Event": one Event of the record type. */
export const eventNoun = (recordTypeName: string): string => recordTypeName.trim().replace(/s$/, '') || 'Event';

/** Deal Contribution rows in a work order (creates and changes; either table layout, WO-1). */
export function dcRowCount(markdown: string): number {
  return legacyShape(markdown).split('\n').filter((l) => /^\|[^|]*\|Deal_Contribution__c\|/.test(l)).length;
}

export interface LogCanvasPromptInput {
  title: string;
  url?: string | null;
  rows: number;
  hours: number;
  dcs?: number;
  updates?: number;
  /** D-67: Use_Case__c rows (creates and Stage / Go-Live fixes). */
  useCases?: number;
  /** The persona's record type Name ("Solutions Event", "Sales Events"): loggingProfile().recordTypeName. */
  recordTypeName: string;
  /** The rows carry an SE task type (the persona's logging needs one). */
  taskType?: boolean;
}

/** A logging canvas (D-47): Events to create, Deal Contributions to add, Duration fixes. */
export function logCanvasPrompt(i: LogCanvasPromptInput): string {
  const dcs = i.dcs ?? 0;
  const updates = i.updates ?? 0;
  const noun = eventNoun(i.recordTypeName);
  const what = [
    i.rows ? `${plural(i.rows, 'activity row')} (${hoursLabel(i.hours)}) approved for Org62 that ${i.rows === 1 ? 'has' : 'have'} not been created yet` : null,
    dcs ? `${plural(dcs, 'Deal Contribution')} to add` : null,
    updates ? `${plural(updates, 'Duration fix', 'Duration fixes')}` : null,
    i.useCases ? `${plural(i.useCases, 'VDP use case')} (Use_Case__c) to create or update` : null,
  ].filter(Boolean);
  return [
    `Please execute the "${i.title}" canvas now${i.url ? ` (${i.url})` : ''}.`,
    `It lists ${what.length ? what.join(', ') : 'the work order'}.`,
    // WO-1: one table per object and verb, each with its own paragraph: Slackbot never picks a column for a type
    'It has one table per job (EVENTS TO CREATE, DEAL CONTRIBUTIONS TO CREATE, USE CASES TO CREATE, then the TO UPDATE tables): work through the tables from top to bottom and follow the paragraph under each heading.',
    ...(i.rows
      ? [`For each activity row: create the ${noun} (or update it if one already exists for that date and opp), keep the ${i.taskType === false ? '' : 'task type, '}opp (WhatId), CF/CR, start/end and description exactly as written, and do not add rows that are not on the canvas.`]
      : []),
    i.rows ? 'When you finish, reply with the created Event Ids so they can be read back and verified.' : 'When you finish, reply with counts: created / updated / skipped / failed.',
  ].join('\n');
}

export interface ForecastCanvasPromptInput {
  title: string;
  url?: string | null;
  notes: number;
  roles: number;
}

/** A Specialist Forecast canvas: notes and Deal Roles on SpecialistForecast__c. */
export function forecastCanvasPrompt(i: ForecastCanvasPromptInput): string {
  const what = [i.notes ? plural(i.notes, 'forecast note') : null, i.roles ? plural(i.roles, 'Deal Role') : null].filter(Boolean).join(' and ') || 'the records';
  return [
    `Please execute the "${i.title}" canvas now${i.url ? ` (${i.url})` : ''}.`,
    `It updates ${what} on my Specialist Forecasts (SpecialistForecast__c): only those fields, only those records.`,
    "When you finish, reply with counts: updated / skipped / failed. Command Center reads the records again and flags anything that didn't land.",
  ].join('\n');
}

/** The forecast field changes a canvas item carries (`input.forecast.updates`), counted; null: not a forecast canvas. */
function forecastCounts(dest: Pick<ActionDestination, 'input'>): { notes: number; roles: number } | null {
  const f = (dest.input as { forecast?: { kind?: unknown; updates?: unknown } }).forecast;
  if (!f || f.kind !== 'specialist_forecast' || !Array.isArray(f.updates)) return null;
  const ups = f.updates as Array<{ field?: unknown }>;
  const notes = ups.filter((u) => u.field === 'ForecastNotes__c').length;
  return { notes, roles: ups.length - notes };
}

/** The prompt for any canvas item (`slack_canvas.create`), from its destination: forecast or logging wording. */
export function canvasPromptFor(dest: ActionDestination, o: { url: string | null; recordTypeName: string; taskType?: boolean }): string {
  const title = dest.target.label;
  const fc = forecastCounts(dest);
  if (fc) return forecastCanvasPrompt({ title, url: o.url, ...fc });
  const i = canvasInputOf(dest);
  return logCanvasPrompt({ title, url: o.url, rows: i.eventIds.length, hours: i.hours, dcs: dcRowCount(i.markdown), updates: i.updates, useCases: ucRowCount(i.markdown), recordTypeName: o.recordTypeName, taskType: o.taskType });
}
