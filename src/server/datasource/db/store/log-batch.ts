/**
 * A logging batch: the approved (and, on request, complete proposed) Time rows that have happened, shaped into ONE
 * Slackbot work order (src/engines/activity/slackbot.ts; parts only past Slack's 1 MiB: src/server/time/batch-canvases.ts),
 * plus Duration__c backfills for Solutions
 * Events whose Time (Hrs) was never filled. Reads only; staging and delivery go through the Outbox.
 *
 * A row is eligible when it has ended, has a WhatId (an opportunity, or the account as the stand-in) and, when the
 * persona's logging needs one (the SE's Solutions Events), an SE task type. D-64: an internal row (internal-only work:
 * what_kind none, no opp or account, CF / CR off, an internal task type) has no WhatId by design and logs with Related
 * To empty, once you Log it (approved): a batch never approves a proposed internal row for you. Anything else is listed as skipped with the reason, so the user sees what still needs input. A row (or a
 * Duration fix) an earlier batch's canvas item still holds in the Outbox is left out and counted as `waiting`, so
 * staging twice never puts the same row on two canvases. A row a sent canvas already handed off (`synced_to_canvas_at`
 * set, or on any sent or verified canvas) is never taken again, whatever its status says.
 */
import { sql } from 'drizzle-orm';

import type { Db, DbOrTx } from '@/db/client';
import { heldNotOnTeam, NOT_ON_TEAM_SKIP } from '@/engines/activity/classify';
import { isInternalTaskType } from '@/engines/activity/internal';
import { LOG_AGAIN_FLAG } from '@/engines/activity/org62-check';
import { eventRow, quarterHours, type WorkOrderEvent, type WorkOrderUpdate } from '@/engines/activity/slackbot';
import { SE_LOGGING, type LoggingProfile } from '@/engines/activity/persona';
import { updateOverrideOf } from '@/lib/canvas/overrides';
import type { CanvasHolds } from '@/lib/canvas/payload';
import { eventUpdatesForBatch } from '@/lib/landings/updates';
import { batchCanvases, batchSpan } from '@/server/time/batch-canvases';

import { fiscalQuarterAt } from '../quarter';
import { pendingDcsFor } from './dc-requests';
import { loadLandingStore } from './landings';
import { loadRowOverrides, pendingUseCasesFor } from './use-cases';
import { candidateCanvasRows } from '../use-cases';

export interface LogBatchOptions {
  now: Date;
  timezone: string;
  /** YYYY-MM-DD bounds on the row's local date (inclusive); default: everything that has ended. */
  from?: string;
  to?: string;
  /** Also take proposed rows that are complete (task type + WhatId): they are approved as part of the batch. */
  approveComplete: boolean;
  recordTypeId: string;
  /** UTF-8 bytes per canvas (default Slack's limit with a margin, CANVAS_MAX_BYTES); tests split with a small one. */
  limitBytes?: number;
  /** What the pending canvas items already hold (canvasHolds over the Outbox drafts). */
  held: CanvasHolds;
  /**
   * D-55: the persona's logging (record type, task type required). Absent: the SE's (Solutions Events, task type
   * required), as before personas.
   */
  logging?: LoggingProfile;
  /** Log DCs now: only the pending DC requests, on a canvas of their own (no activity rows or Duration fixes). */
  dcOnly?: boolean;
  /** Time ▸ Log it: only these rows (each still has to be ready); with none of them ready, no canvas. */
  ids?: ReadonlySet<string>;
  /** D-70: only these use cases (round-trip keys) and Event updates (write ids); null / absent: all of that kind. */
  useCases?: ReadonlySet<string> | null;
  eventUpdates?: ReadonlySet<string> | null;
}

export interface LogBatchCanvas {
  part: number;
  parts: number;
  title: string;
  markdown: string;
  eventIds: string[];
  hours: number;
  updates: number;
  /** The Org62 Events whose Duration fix this canvas carries. */
  updateIds: string[];
}

export interface LogBatchSkip {
  id: string;
  date: string;
  description: string;
  why: string;
}

export interface LogBatch {
  canvases: LogBatchCanvas[];
  events: number;
  hours: number;
  updates: number;
  /** Proposed rows the batch approves (approveComplete). */
  approveIds: string[];
  skipped: LogBatchSkip[];
  /** Rows already waiting in an Outbox canvas item (left out of this batch). */
  waiting: { rows: number; hours: number; draftIds: string[] };
  owner: { name: string; org62Id: string } | null;
  range: { from: string | null; to: string | null };
  /** D-67: VDP use-case rows on the canvases (creates + Stage / Go-Live fixes), and creates waiting for a batch with rows. */
  useCases: { rows: number; later: number };
  /** D-58: Deal Contribution rows on the canvases. */
  dcs: number;
  /** D-70: updates to Events already in Org62 on the canvases (approved, or proposed and complete). */
  eventUpdates: number;
}

type Row = {
  id: string;
  subject: string | null;
  description: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  duration_hours: string | number;
  status: string;
  origin: string;
  what_org62_id: string | null;
  flags: string[] | null;
  task_type: string | null;
  synced_to_canvas_at: Date | string | null;
  what_kind: string;
  opportunity_id: string | null;
  account_id: string | null;
  customer_facing: boolean;
  customer_related: boolean;
  what_name: string | null;
  /** D-66: the row's note (its ext side-car); null: none drafted (eventRow makes one from the fields). */
  log_note: string | null;
};

/** D-64: internal-only work, as the read model derives it (src/server/datasource/db/store/time.ts loadActivity). */
const internalRow = (r: Row) => r.what_kind === 'none' && !r.what_org62_id && !r.opportunity_id && !r.account_id && !r.customer_facing && !r.customer_related && isInternalTaskType(r.task_type);

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

export function localDate(at: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at instanceof Date ? at : new Date(at));
}

/** "CF forced: external attendee (a.example, b.example); …" → the domains. */
export function externalDomains(flags: readonly string[] | null | undefined): string[] {
  for (const f of flags ?? []) {
    const m = /external attendees? \(([^)]+)\)/i.exec(f);
    if (m) return m[1]!.split(/\s*,\s*/).filter(Boolean);
  }
  return [];
}

async function ownerOf(db: DbOrTx, userId: string): Promise<{ name: string; org62Id: string } | null> {
  const r = await db.execute<{ name: string | null; external_id: string | null }>(sql`
    select u.display_name as name, pi.external_id
      from users u left join person_identities pi on pi.person_id = u.person_id and pi.system = 'org62_user'
     where u.id = ${userId} limit 1`);
  const x = r.rows[0];
  return x?.external_id ? { name: x.name ?? 'me', org62Id: x.external_id } : null;
}

/** The activity rows a batch reads (with their task type and note), filtered by `where` on `a`. */
async function batchRows(db: DbOrTx, userId: string, where: ReturnType<typeof sql>): Promise<Row[]> {
  return (
    await db.execute<Row>(sql`
      select a.id, a.subject, a.description, a.starts_at, a.ends_at, a.duration_hours, a.status::text as status, a.origin::text as origin,
             a.what_org62_id, a.flags, t.name as task_type, a.synced_to_canvas_at,
             a.what_kind::text as what_kind, a.opportunity_id, a.account_id, a.customer_facing, a.customer_related, a.what_name,
             coalesce(a.log_note, x.value ->> 'logNote') as log_note
        from activity_entries a left join se_task_types t on t.id = a.se_task_type_id
        left join user_settings x on x.owner_user_id = a.owner_user_id and x.key = 'cc.ext/activity_entries/' || a.id::text
       where a.owner_user_id = ${userId} and ${where}
       order by a.starts_at, a.id`)
  ).rows;
}

/** One row's Event as a batch writes it, or why it can't go (it needs a task type, a WhatId). */
export function batchEventOf(r: Row, logging: LoggingProfile): { event: WorkOrderEvent } | { why: string } {
  const internal = internalRow(r);
  const missing = [logging.taskTypeRequired && !r.task_type ? 'an SE task type' : null, !r.what_org62_id && !internal ? 'a WhatId (opportunity or account)' : null].filter(Boolean);
  if (missing.length) return { why: `needs ${missing.join(' and ')}` };
  const label = (r.description ?? r.subject ?? '').slice(0, 120);
  return {
    event: eventRow({
      id: r.id,
      subject: r.subject ?? label,
      start: iso(r.starts_at),
      end: iso(r.ends_at),
      durationH: Number(r.duration_hours),
      taskType: logging.taskTypeRequired ? r.task_type! : '', // no SE task type on another persona's Events
      // internal: Related To empty (the work order's rule says so)
      whatOrg62Id: internal ? '' : r.what_org62_id!,
      origin: r.origin,
      // D-66: the row's note (yours, or the app's draft), then the CC# key; none yet: one from the row's fields
      note: r.log_note,
      customer: r.what_name ? r.what_name.split(' - ')[0]! : null,
      externalDomains: externalDomains(r.flags),
    }),
  };
}

/** The canvas review's Edit: one row's Event as a batch would write it now (inside the edit's transaction). */
export async function batchEventFor(db: DbOrTx, userId: string, id: string, logging: LoggingProfile = SE_LOGGING): Promise<{ event: WorkOrderEvent } | { why: string }> {
  const [r] = await batchRows(db, userId, sql`a.id = ${id}::uuid`);
  return r ? batchEventOf(r, logging) : { why: 'it is no longer in Activity' };
}

export async function buildLogBatch(db: Db, userId: string, o: LogBatchOptions): Promise<LogBatch> {
  const logging = o.logging ?? SE_LOGGING;
  const owner = await ownerOf(db, userId);
  const rows = await batchRows(db, userId, sql`a.status in ('approved', 'proposed') and a.ends_at <= ${o.now.toISOString()}::timestamptz`);
  const events: WorkOrderEvent[] = [];
  const approveIds: string[] = [];
  const skipped: LogBatchSkip[] = [];
  const waiting = { rows: 0, hours: 0, draftIds: new Set<string>() };
  for (const r of o.dcOnly ? [] : rows) {
    if (o.ids && !o.ids.has(r.id)) continue;
    const date = localDate(r.starts_at, o.timezone);
    if ((o.from && date < o.from) || (o.to && date > o.to)) continue;
    // already handed off: a sent canvas has it (its status may still read approved), so it is never logged twice
    // D-65: unless you put it back with Log again (not in Org62 after all, TL-14 / TL-20)
    if ((r.synced_to_canvas_at || o.held.sent?.has(r.id)) && !(r.flags ?? []).includes(LOG_AGAIN_FLAG)) continue;
    const holder = o.held.rows.get(r.id);
    if (holder) {
      waiting.rows += 1;
      waiting.hours += Number(r.duration_hours);
      waiting.draftIds.add(holder);
      continue;
    }
    const label = (r.description ?? r.subject ?? '').slice(0, 120);
    if (r.status === 'proposed' && !o.approveComplete) continue;
    const internal = internalRow(r);
    // D-64: an internal row waits for your own Log (Time ▸ Log it ▸ Internal); a batch never approves it
    if (r.status === 'proposed' && internal) continue;
    // a proposed row on an opp I'm not on waits for the user's own Approve: a batch (or chat staging) never approves it
    if (r.status === 'proposed' && heldNotOnTeam(r.flags)) {
      skipped.push({ id: r.id, date, description: label, why: NOT_ON_TEAM_SKIP });
      continue;
    }
    const ev = batchEventOf(r, logging);
    if ('why' in ev) {
      skipped.push({ id: r.id, date, description: label, why: ev.why });
      continue;
    }
    if (r.status === 'proposed') approveIds.push(r.id);
    events.push(ev.event);
  }
  // Events of my record type (an SE's Solutions Events) this quarter whose Time (Hrs) was never filled: one UPDATE row each.
  const q = fiscalQuarterAt(o.now, o.timezone);
  const backfill = (
    await db.execute<{ org62_event_id: string; subject: string | null; starts_at: Date | string; ends_at: Date | string }>(sql`
      select org62_event_id, subject, starts_at, ends_at from org62_events
       where owner_user_id = ${userId} and record_type_name = ${logging.recordTypeName} and duration_field is null and deleted_upstream_at is null
         and starts_at >= ${`${q.start}T00:00:00Z`}::timestamptz and ends_at <= ${o.now.toISOString()}::timestamptz
       order by starts_at`)
  ).rows;
  // the canvas review: a Duration you set on an earlier canvas's row stays yours
  const overrides = await loadRowOverrides(db, userId);
  // the rows you picked (Log it) carry the Duration fixes along; picked rows none of which are ready make no canvas
  const updates: WorkOrderUpdate[] = backfill.filter((e) => !o.dcOnly && !(o.ids && !events.length) && !o.held.updates.has(e.org62_event_id)).map((e) => ({
    recordId: e.org62_event_id,
    field: 'Duration__c',
    newValue: updateOverrideOf(overrides, 'Event', e.org62_event_id, 'Duration__c') ?? String(quarterHours((Date.parse(iso(e.ends_at)) - Date.parse(iso(e.starts_at))) / 3_600_000)),
    currentValue: '(blank)',
    why: `Time (Hrs) never filled: End − Start of '${(e.subject ?? '').slice(0, 60)}'`,
  }));
  // D-70: approved Event updates (the re-derive's, approved by you; proposed ones too when complete rows are approved
  // with the batch) ride in the UPDATE table, "update · Duration 2 h → 3 h"
  const eventUpdates = o.dcOnly ? [] : eventUpdatesForBatch(await loadLandingStore(db, userId), { approveComplete: o.approveComplete, only: o.eventUpdates ?? (o.ids || o.useCases ? new Set<string>() : null) });
  updates.push(...eventUpdates.filter((u) => !o.held.updates.has(u.recordId)).map(({ writeId: _w, ...u }) => u));
  const span = batchSpan(events.map((e) => localDate(e.startUtc, o.timezone)));
  const base = {
    ownerName: owner?.name ?? 'me',
    ownerOrg62Id: owner?.org62Id ?? '',
    recordTypeId: o.recordTypeId,
    generatedAt: o.now.toISOString(),
    sourceLabel: `Command Center · ${span ?? 'Duration fixes'}`,
    ...(o.logging ? { logging: { recordTypeName: logging.recordTypeName, taskTypeRequired: logging.taskTypeRequired } } : {}),
  };
  // 2026-11-13 (B1): ONE canvas per batch: Events, Duration fixes, DCs (D-58) and VDP use cases (D-67) in one work
  // order; parts only past Slack's own limit (src/server/time/batch-canvases.ts)
  // D-70: a use case is a row like any other (it logs on its own); the ticked ones only, when you ticked some
  const uc0 = !o.dcOnly ? await pendingUseCasesFor(db, userId) : { creates: [], updates: [] };
  // use cases to add: accepted candidates' Org62 rows ride too (db/use-cases.ts; the plan's twins of them are left out)
  const ucAll = !o.dcOnly ? { creates: await candidateCanvasRows(db, userId, uc0.creates), updates: uc0.updates } : uc0;
  // a selection is exact: rows picked and no use cases named takes none of them
  const ucOnly = o.useCases ?? (o.ids || o.eventUpdates ? new Set<string>() : null);
  const uc = ucOnly ? { creates: ucAll.creates.filter((c) => ucOnly.has(`uc:${c.vdpUseCaseId}`)), updates: ucAll.updates.filter((u) => ucOnly.has(`uc:${u.vdpUseCaseId}`)) } : ucAll;
  const hasRows = events.length > 0 || updates.length > 0 || uc.creates.length > 0 || uc.updates.length > 0;
  const dcs = hasRows || o.dcOnly ? await pendingDcsFor(db, userId) : [];
  const b = batchCanvases(base, { events, updates, dcs, ucCreates: uc.creates, ucUpdates: uc.updates }, { span: span ?? (updates.length ? 'Duration fixes' : null), ...(o.dcOnly ? { dcOnly: true } : {}), ...(o.limitBytes ? { limit: o.limitBytes } : {}) });
  return {
    canvases: b.canvases,
    events: events.length,
    hours: events.reduce((s, e) => s + e.durationH, 0),
    updates: updates.length,
    approveIds,
    skipped,
    waiting: { rows: waiting.rows, hours: Math.round(waiting.hours * 100) / 100, draftIds: [...waiting.draftIds] },
    owner,
    range: { from: o.from ?? null, to: o.to ?? null },
    useCases: b.useCases,
    dcs: b.dcs,
    eventUpdates: b.canvases.length ? eventUpdates.length : 0,
  };
}
