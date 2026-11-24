// Projection run helpers with no db writes: row mapping, meeting-note facts, missed-opp evidence, dates. Split from run.ts (max-lines); run.ts re-exports the public names.
import { sql } from 'drizzle-orm';

import type { SourceRef } from '@/contract';
import type { Tx } from '@/db/client';
import type { ActivityProjection } from '@/server/datasource/db/store/projections';
import type { DesiredEntry } from './activity';
import { Matcher } from './matching';
import type { MissedEvidence } from './missed';
import { id15, localDay } from './util';
import { oppIdsOf, type VdpSnapshot } from '@/lib/vdp/types';
import type { UseCaseOption } from '@/engines/activity/note';
import { iso } from './run.model';

/** The recipients' email domains of a message I sent (to, cc), lower-cased; never the addresses. */
export function emailDomains(meta: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.toLowerCase().matchAll(/@([a-z0-9.-]+\.[a-z]{2,})/g)) out.add(m[1]!);
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(add);
  };
  add(meta.to);
  add(meta.cc);
  return [...out].sort();
}
export function toProjection(e: DesiredEntry, m: Matcher): ActivityProjection {
  const opp = e.whatOrg62Id?.startsWith('006') ? m.oppByOrg62(e.whatOrg62Id) : null;
  const acct = opp?.accountId ? (m.accounts.get(opp.accountId) ?? null) : e.whatOrg62Id?.startsWith('001') ? m.accountByOrg62(e.whatOrg62Id) : null;
  return {
    dedupeKey: e.dedupeKey,
    origin: e.origin,
    subject: e.subject,
    description: e.description,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    durationHours: e.durationHours,
    seTaskType: e.seTaskType,
    meetingType: e.meetingType,
    customerFacing: e.customerFacing,
    customerRelated: e.customerRelated,
    whatKind: e.whatKind,
    whatOrg62Id: e.whatOrg62Id,
    whatName: e.whatName ?? opp?.name ?? acct?.name ?? null,
    opportunityId: opp?.id ?? null,
    accountId: acct?.id ?? null,
    // the loader takes the account from the opp; the ext name is for account-level WhatIds and unknown opps
    accountName: opp ? null : (acct?.name ?? null),
    confidence: e.confidence,
    reason: e.reason,
    flags: e.flags,
    status: e.status,
    excludedReason: e.excludedReason,
    org62EventRowId: e.org62EventRowId,
    sources: e.sources as SourceRef[],
    remote: e.remote,
    logNote: e.logNote,
    logNoteBasis: e.logNoteBasis,
  };
}
/** D-66: the lock a note you edited carries (src/server/datasource/db/store/time.ts LOCK_COL.logNote). */
export const NOTE_LOCK = 'log_note';
/** Rows that wait to be logged: their note is still the app's to redraft (until you edit it). */
export const NOTE_REFRESH_STATUSES = new Set(['upcoming', 'needs_input', 'proposed', 'approved']);
/** The key of a meeting note's side-car, where `activity.notes` keeps the cheap model's note (`logSummary`). */
export const meetingNoteExtKey = (meetingNoteId: string) => `cc.ext/meeting_notes/${meetingNoteId}`;
/**
 * D-66: per calendar event row, its notes' facts for the row's note: the cheap model's note (`activity.notes` keeps it
 * on the meeting note's side-car) and the next step (the first to-do the scanner took from the notes; never the
 * notes' text itself).
 */
export async function meetingNoteFacts(tx: Tx, userId: string, eventIds: string[]): Promise<Map<string, { summary: string | null; nextStep: string | null }>> {
  const out = new Map<string, { summary: string | null; nextStep: string | null }>();
  if (!eventIds.length) return out;
  const r = await tx.execute<{ event_id: string; summary: string | null; next_step: string | null }>(sql`
    select n.calendar_event_id as event_id, x.value -> 'logSummary' ->> 'note' as summary,
           (select w.title from work_item_evidence we join work_items w on w.id = we.work_item_id
             where we.source_item_id = n.source_item_id and we.role = 'origin' and w.status not in ('dismissed', 'merged')
             order by we.created_at, w.id limit 1) as next_step
      from meeting_notes n
      left join user_settings x on x.owner_user_id = n.owner_user_id and x.key = 'cc.ext/meeting_notes/' || n.id::text
     where n.owner_user_id = ${userId} and n.calendar_event_id in (${sql.join(eventIds.map((id) => sql`${id}::uuid`), sql`, `)})
     order by n.arrived_at desc`);
  for (const row of r.rows) {
    const cur = out.get(row.event_id);
    // the newest notes win; an older notes doc still fills what the newer one lacks
    out.set(row.event_id, { summary: cur?.summary ?? row.summary, nextStep: cur?.nextStep ?? row.next_step });
  }
  return out;
}
/** D-66: every opp's VDP use cases (the mirror's live VDPs), by 15-char Org62 opp id. */
export async function vdpUseCases(tx: Tx, userId: string): Promise<Map<string, UseCaseOption[]>> {
  const out = new Map<string, UseCaseOption[]>();
  const r = await tx.execute<{ detail: VdpSnapshot | null }>(sql`select detail from vdp_records where owner_user_id = ${userId} and gone_at is null and not archived and detail is not null`);
  for (const { detail } of r.rows) {
    if (!detail) continue;
    const ucs = (detail.useCases ?? []).map((u) => ({ title: u.title, priority: u.priority }));
    if (!ucs.length) continue;
    for (const opp of oppIdsOf(detail)) out.set(id15(opp), [...(out.get(id15(opp)) ?? []), ...ucs]);
  }
  return out;
}
// ---------------------------------------------------------------------------
// Missed opportunities: evidence in, findings out
// ---------------------------------------------------------------------------

/** My evidence of the last 180 days, reduced to titles (never bodies): meetings, files, Claude sessions. */
export async function missedEvidence(tx: Tx, userId: string, now: Date): Promise<MissedEvidence> {
  const since = new Date(now.getTime() - 180 * 86_400_000).toISOString();
  const cal = await tx.execute<{ id: string; title: string | null; s: Date | string; my_response: string; org: boolean; attendance: string; recurring: string | null; ext: boolean; opp: string | null; acct: string | null }>(sql`
    select e.id, e.title, e.starts_at as s, e.my_response, e.i_am_organizer as org, e.attendance, e.recurring_event_id as recurring, e.has_external_attendees as ext,
           o.org62_opportunity_id as opp, a.org62_account_id as acct
      from calendar_events e
      left join opportunities o on o.id = e.opportunity_id
      left join accounts a on a.id = coalesce(e.account_id, o.account_id)
     where e.owner_user_id = ${userId} and e.deleted_upstream_at is null and e.status <> 'cancelled'
       and e.starts_at >= ${since}::timestamptz and e.starts_at < ${now.toISOString()}::timestamptz`);
  const drive = await tx.execute<{ id: string; title: string | null; at: Date | string | null; owned: boolean; acct: string | null }>(sql`
    select s.id, s.title, s.last_modified_at as at, (s.i_own or s.last_modified_by_me_at is not null) as owned, a.org62_account_id as acct
      from assets s left join accounts a on a.id = s.account_id
     where s.owner_user_id = ${userId} and coalesce(s.last_modified_at, ${now.toISOString()}::timestamptz) >= ${since}::timestamptz`);
  const sess = await tx.execute<{ id: string; title: string | null; at: Date | string; acct: string | null }>(sql`
    select s.id, s.title, s.last_activity_at as at, a.org62_account_id as acct
      from claude_sessions s left join accounts a on a.id = s.account_id
     where s.owner_user_id = ${userId} and s.last_activity_at >= ${since}::timestamptz`);
  return {
    calendar: cal.rows.map((r) => ({
      id: r.id,
      title: r.title ?? '',
      at: iso(r.s),
      oppOrg62Id: r.opp,
      accountOrg62Id: r.acct,
      owned: (r.my_response === 'accepted' || r.org) && r.attendance !== 'missed',
      recurring: !!r.recurring,
      internalOnly: !r.ext,
    })),
    drive: drive.rows.map((r) => ({ id: r.id, title: r.title ?? '', at: r.at ? iso(r.at) : null, owned: r.owned, accountOrg62Id: r.acct })),
    // a session's span is not hands-on time: it only ever makes a "some" signal (hours 0)
    sessions: sess.rows.map((r) => ({ id: r.id, title: r.title ?? '', at: iso(r.at), accountOrg62Id: r.acct, hours: 0 })),
  };
}
export const money = (v: number) => Math.round(v * 100) / 100;
// ---------------------------------------------------------------------------
// Small lookups
// ---------------------------------------------------------------------------

export async function emailDirectory(tx: Tx, userId: string): Promise<Map<string, string>> {
  const r = await tx.execute<{ email: string; person_id: string }>(sql`
    select lower(external_id) as email, person_id from person_identities where owner_user_id = ${userId} and system = 'email'
    union
    select lower(primary_email), id from people where owner_user_id = ${userId} and primary_email is not null`);
  return new Map(r.rows.map((x) => [x.email, x.person_id]));
}
/** Work items the scanner linked to a source item (any evidence role), newest first. */
export async function workItemsFromSource(tx: Tx, sourceItemId: string): Promise<string[]> {
  const r = await tx.execute<{ id: string }>(sql`
    select e.work_item_id as id from work_item_evidence e join work_items w on w.id = e.work_item_id
     where e.source_item_id = ${sourceItemId} group by e.work_item_id order by max(e.created_at) desc limit 20`);
  return r.rows.map((x) => x.id);
}
/** Work items whose evidence references a Drive file (source_item_refs), per file id. */
export async function workItemsByFile(tx: Tx, userId: string, fileIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!fileIds.length) return out;
  const r = await tx.execute<{ file: string; id: string }>(sql`
    select distinct r.value as file, e.work_item_id as id
      from source_item_refs r
      join source_items si on si.id = r.source_item_id and si.owner_user_id = ${userId}
      join work_item_evidence e on e.source_item_id = r.source_item_id
     where r.kind = 'drive_file' and r.value in (${sql.join(fileIds.map((f) => sql`${f}`), sql`, `)})
     order by 1, 2`);
  for (const x of r.rows) out.set(x.file, [...(out.get(x.file) ?? []), x.id]);
  return out;
}
// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + n * 86_400_000).toISOString().slice(0, 10);
}
/** `2026-11-01` + 3 months → `2027-02-01` (first-of-month days only, as the fiscal quarters use). */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10);
}
/** Epoch ms of local midnight of `day` in `tz`. */
export function zoned(day: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const off = (ms: number) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000;
  };
  let ms = guess - off(guess);
  ms = guess - off(ms);
  return ms;
}
/** First day (local) of the Salesforce fiscal quarter containing `now` (FY starts 1 Feb: Feb, May, Aug, Nov). */
export function fiscalQuarterStart(now: Date, tz: string): string {
  const day = localDay(now.toISOString(), tz);
  const [y, m] = day.split('-').map(Number) as [number, number];
  const qStartMonth = [2, 5, 8, 11].filter((q) => q <= m).pop() ?? 11;
  const year = m < 2 ? y - 1 : y;
  return `${year}-${String(qStartMonth).padStart(2, '0')}-01`;
}
