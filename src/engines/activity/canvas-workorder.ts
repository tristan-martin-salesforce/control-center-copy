/**
 * Slackbot work-order canvas renderer. Port of autoplan.render_slackbot / split_parts.
 * This lane only RENDERS markdown. It never writes the canvas (the Outbox owns that, per-target L4).
 */
import { CANVAS_MAX_BYTES } from '@/lib/canvas/payload';
import { upsertTable } from '@/lib/canvas/tables';

import { toOrg62Event } from './entry';
import { splitWorkOrder, updateRule, workOrderCallout } from './slackbot';
import { roundQuarter } from './taxonomy';
import { toMs } from './time';
import type { ActivityConfig, ActivityEntry, Org62EventRow } from './types';

export interface WorkOrderIdentity {
  ownerName: string;
}

export interface DcAddRow {
  oppId: string;
  oppName: string;
  split: number;
  comment: string;
  role?: string;
}

export interface UpdateRow {
  object: 'Deal_Contribution__c' | 'Event';
  recordId: string;
  /** Field API name, or `Delete`. */
  actionOrField: string;
  newValue: string;
  currentValue: string;
  why: string;
}

/** Python float repr for numbers in the canvas: 1 -> "1.0", 0.75 -> "0.75". */
export const fmtNum = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/** Table-cell hygiene used by the canvas: pipes become "/", newlines become " ⏎ ". */
export const cell = (s: unknown): string =>
  String(s ?? '')
    .replace(/\|/g, '/')
    .replace(/\n/g, ' ⏎ ')
    .trim();

/** Entries that belong in the ADD table: approved/synced create rows that already ended. */
export function addableEntries(entries: readonly ActivityEntry[], nowIso: string): ActivityEntry[] {
  const now = toMs(nowIso);
  return entries
    .filter((e) => e.operation === 'create' && (e.status === 'approved' || e.status === 'synced_to_canvas') && toMs(e.endsAt) <= now)
    .sort((a, b) => toMs(a.startsAt) - toMs(b.startsAt) || a.dedupeKey.localeCompare(b.dedupeKey));
}

/** Duration__c backfill rows for Solutions Events whose Time(Hrs) was never filled. */
export function durationBackfillUpdates(org62: readonly Org62EventRow[], fromDay: string): UpdateRow[] {
  return org62
    .filter((e) => e.recordTypeName === 'Solutions Event' && e.durationField === null && e.startsAt.slice(0, 10) >= fromDay)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((e) => ({
      object: 'Event' as const,
      recordId: e.org62EventId,
      actionOrField: 'Duration__c',
      newValue: fmtNum(roundQuarter((toMs(e.endsAt) - toMs(e.startsAt)) / 3_600_000)),
      currentValue: '(blank)',
      why: `Time(Hrs) never filled: End − Start of '${cell(e.subject).slice(0, 60)}'`,
    }));
}

/** Delete rows for legacy-record-type originals that have a REPLACES re-create. */
export function legacyDeleteUpdates(entries: readonly ActivityEntry[], org62: readonly Org62EventRow[]): UpdateRow[] {
  const present = new Set(org62.map((r) => r.org62EventId));
  return entries
    .filter((e) => e.origin === 'legacy_recreate' && e.targetOrg62EventId && present.has(e.targetOrg62EventId))
    .map((e) => ({
      object: 'Event' as const,
      recordId: e.targetOrg62EventId!,
      actionOrField: 'Delete',
      newValue: 'n/a',
      currentValue: 'Sales Engineer Events record type, no SE Task Type',
      why: `Replaced by the EVENTS TO CREATE row whose Description starts with REPLACES ${e.targetOrg62EventId}`,
    }));
}

export interface WorkOrderInput {
  entries: readonly ActivityEntry[];
  dcAdds?: readonly DcAddRow[];
  updates?: readonly UpdateRow[];
  nowIso: string;
  cfg: ActivityConfig;
  identity: WorkOrderIdentity;
}

export interface WorkOrderStats {
  adds: number;
  dcAdds: number;
  addHours: number;
  updates: number;
}

export function renderWorkOrder(input: WorkOrderInput): { markdown: string; stats: WorkOrderStats } {
  const { cfg, nowIso } = input;
  const adds = addableEntries(input.entries, nowIso);
  const dcAdds = input.dcAdds ?? [];
  const updates = input.updates ?? [];
  const rows = adds.map((e) => ({ e, r: toOrg62Event(e, cfg) }));
  const addH = rows.reduce((s, x) => s + x.r.Duration__c, 0);
  const owner = cfg.ownerId;
  // WO-1: one table per object and verb (src/lib/canvas/tables.ts), each with its own paragraph under its heading
  const out: string[] = [...workOrderCallout(input.identity.ownerName, owner, 'created / updated / deleted / skipped as duplicate / failed (with the error for each failure)')];
  out.push('');
  out.push(`_Generated ${nowIso.slice(0, 16).replace('T', ' ')} UTC by ${input.identity.ownerName}'s activity autopilot from calendar, Org62, Claude Code, git, Drive and Slack. Rows disappear from this canvas once the read-back finds them in Org62._`);
  const eventRule = `**EVENTS TO CREATE:** create one Event per row with RecordTypeId \`${cfg.recordTypeId}\` (Solutions Event) and OwnerId \`${owner}\`. Each column is the Event field of the same name: Subject, StartDateTime and EndDateTime (UTC, exactly as given), SE_Task_Type__c, Duration__c, WhatId, Meeting_Type__c (only when given) and Description. Do not set DurationInMinutes or Remote__c. Skip a row ONLY if the owner already has an Event with RecordTypeId \`${cfg.recordTypeId}\` (Solutions Event) and the same Subject and StartDateTime. "Sales Events" records (Type = AE meeting, IsChild = true) are copies of AE calendar invites, not SE time, so they are NOT duplicates: create the row anyway. **Exception:** rows whose Description starts with \`REPLACES\` must be created even though an old Event with the same Subject/Start exists (it has the wrong, locked record type).`;
  const dcRule = `**DEAL CONTRIBUTIONS TO CREATE:** create one Deal Contribution (record type Unlocked) per row with SE_Name__c \`${owner}\`. Opportunity is the opportunity's name, for you to read; Opportunity__c is its Id; set Opportunity_Role__c and Split_Percentage__c as given, and Comments__c exactly as given, with every ⏎ replaced by a line break. If the owner already has a DC on that opportunity, update its Comments__c and Split_Percentage__c instead of creating a second one.`;
  const evUpdRule = updateRule('EVENTS TO UPDATE', 'Event', ' When Field is Delete, delete that Event **only after** the replacement row named in the Why column exists in Org62.');
  const dcUpdRule = updateRule('DEAL CONTRIBUTIONS TO UPDATE', 'Deal Contribution');
  const evRows = rows.map(({ e, r }, k) => {
    let desc = r.Description;
    if (e.origin === 'legacy_recreate' && e.targetOrg62EventId) desc = `REPLACES ${e.targetOrg62EventId} (legacy record type) | ${desc}`;
    return [String(k + 1), 'Event', cell(r.Subject), r.StartDateTime, r.EndDateTime, r.SE_Task_Type__c, fmtNum(r.Duration__c), r.WhatId, r.Meeting_Type__c, cell(desc)];
  });
  const dcRows = dcAdds.map((d, k) => [String(k + 1), 'Deal_Contribution__c', cell(d.oppName), '', '', d.role ?? 'AI + Data Architect', String(d.split), d.oppId, '', cell(d.comment)]);
  const upd = (o: UpdateRow['object']) => updates.filter((u) => u.object === o).map((u, k) => [String(k + 1), u.object, u.recordId, cell(u.actionOrField), cell(u.newValue), cell(u.currentValue), cell(u.why)]);
  let md = out.join('\n');
  md = upsertTable(md, 'events_create', eventRule, evRows);
  md = upsertTable(md, 'dcs_create', dcRule, dcRows);
  md = upsertTable(md, 'events_update', evUpdRule, upd('Event'));
  md = upsertTable(md, 'dcs_update', dcUpdRule, upd('Deal_Contribution__c'));
  return { markdown: md, stats: { adds: rows.length, dcAdds: dcAdds.length, addHours: Math.round(addH * 100) / 100, updates: updates.length } };
}

/** Split into canvas-sized parts (UTF-8 bytes) at row boundaries; each table part repeats its header (port of split_parts). */
export function splitWorkOrderParts(md: string, limit = CANVAS_MAX_BYTES): string[] {
  return splitWorkOrder(md, limit);
}
