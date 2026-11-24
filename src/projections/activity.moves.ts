// planWeek's helpers: adopting the read-back, proposals and Org62 rows into entries, evidence sources, block labels. Split from activity.ts (max-lines); activity.ts re-exports the public names.
import {
  type ActivityEntry as EngineEntry, type OnsiteDay, type Org62EventRow, type SlackBurstEvidence,
  type TimeBlock as EngineBlock, accountByKey, legacyFlag, localDay as localDayMs, normSubject, RELATED_TO_EMPTY_FLAG,
  sameRelatedTo, isInternalTaskType, pickUseCase, templateNote, type NoteFacts, roundQuarter,
} from '@/engines/activity';
import { driveFileLink, org62RecordUrl } from './links';
import type { SlackMessage } from './types';
import { id15 } from './util';
import {
  type FixedEntry, type WeekOrg62Event, MIN, type ReadbackMove, type DesiredEntry, type WeekEvent, type WeekInput,
  cfcr, confOf,
} from './activity.model';

/** A calendar meeting's row (the engine's `cal|` key; travel shares the prefix and is not one). */
export const isMeetingKey = (dedupeKey: string, seTaskType: string | null): boolean => dedupeKey.startsWith('cal|') && seTaskType !== 'Travel';
/** `cal|<calendar>|<event id>|<start>` (a meeting's key; travel pieces carry a suffix and are not one). */
export function calKeyOf(key: string): { calendarId: string; eventId: string; startsAt: string } | null {
  const m = /^cal\|([^|]+)\|([^|]+)\|([^|@#]+)$/.exec(key);
  return m ? { calendarId: m[1]!, eventId: m[2]!, startsAt: m[3]! } : null;
}
const blankOf = (v: string | null | undefined): string => (v ?? '').trim();
/** What an Org62 Event says differently from the user's row (D-65: only a real difference is adopted, TL-11). */
export function adoptDiff(f: FixedEntry, r: WeekOrg62Event, o: { typed: boolean; keepTimes: boolean }): string[] {
  const d: string[] = [];
  if (id15(f.whatOrg62Id) !== id15(r.whatOrg62Id)) d.push(`WhatId ${f.whatOrg62Id ?? '(none)'} → ${r.whatOrg62Id ?? '(none)'}`);
  if (o.typed && blankOf(f.seTaskType) !== blankOf(r.seTaskTypeName)) d.push(`SE_Task_Type__c ${blankOf(f.seTaskType) || '(blank)'} → ${blankOf(r.seTaskTypeName) || '(blank)'}`);
  const h = r.durationField === null ? null : roundQuarter(r.durationField);
  if (h !== null && h > 0 && Math.abs(h - f.durationHours) > 1e-6) d.push(`Duration__c ${f.durationHours} → ${h}`);
  if (!o.keepTimes && Math.abs(Date.parse(r.startsAt) - Date.parse(f.startsAt)) > MIN) d.push(`start ${f.startsAt.slice(11, 16)} → ${r.startsAt.slice(11, 16)} UTC`);
  if (!o.keepTimes && Math.abs(Date.parse(r.endsAt) - Date.parse(f.endsAt)) > MIN) d.push(`end ${f.endsAt.slice(11, 16)} → ${r.endsAt.slice(11, 16)} UTC`);
  if (normSubject(r.subject) && normSubject(r.subject) !== normSubject(f.subject)) d.push('Subject');
  return d;
}
/** Org62's values for the user's row (the fields that differ; opp, type and meeting type always). */
export function adoptOf(f: FixedEntry, r: WeekOrg62Event, note: string, keepTimes: boolean): NonNullable<ReadbackMove['adopt']> {
  const h = r.durationField === null ? null : roundQuarter(r.durationField);
  return {
    whatOrg62Id: r.whatOrg62Id,
    seTaskType: r.seTaskTypeName ?? null,
    meetingType: r.meetingTypeName ?? null,
    note,
    ...(h !== null && h > 0 && Math.abs(h - f.durationHours) > 1e-6 ? { durationHours: h } : {}),
    ...(!keepTimes && Math.abs(Date.parse(r.startsAt) - Date.parse(f.startsAt)) > MIN ? { startsAt: r.startsAt } : {}),
    ...(!keepTimes && Math.abs(Date.parse(r.endsAt) - Date.parse(f.endsAt)) > MIN ? { endsAt: r.endsAt } : {}),
    ...(r.subject && normSubject(r.subject) !== normSubject(f.subject) ? { subject: r.subject } : {}),
  };
}
/**
 * TL-04 / TL-21: two Org62 Events of one slot: the same CC# key (a canvas run twice, a Slackbot duplicate), or
 * overlapping on the same start (±5 min) or by half, with the same Related To or the same subject.
 */
export function isTwinEvent(a: Org62EventRow, b: Org62EventRow, tz: string, accountOf?: (id: string) => string | null): boolean {
  if (a.ccKey && b.ccKey) return a.ccKey === b.ccKey;
  const as = Date.parse(a.startsAt);
  const ae = Date.parse(a.endsAt);
  const bs = Date.parse(b.startsAt);
  const be = Date.parse(b.endsAt);
  const ov = Math.min(ae, be) - Math.max(as, bs);
  if (ov <= 0) return false;
  const shorter = Math.max(MIN, Math.min(ae - as, be - bs));
  const slot = Math.abs(as - bs) <= 5 * MIN || (ov / shorter >= 0.5 && localDayMs(as, tz) === localDayMs(bs, tz));
  return slot && (sameRelatedTo(a.whatOrg62Id, b.whatOrg62Id, accountOf) || (!!normSubject(a.subject) && normSubject(a.subject) === normSubject(b.subject)));
}
/** A meeting the engine excluded (e.g. Admin) that the user logged in Org62 anyway is that Org62 row: drop the twin. */
export function dropExcludedTwins(entries: DesiredEntry[]): DesiredEntry[] {
  const logged = entries.filter((e) => e.status === 'logged');
  return entries.filter((e) => {
    if (e.status !== 'excluded' || e.origin !== 'calendar') return true;
    const s = Date.parse(e.startsAt);
    return !logged.some((l) => Math.abs(Date.parse(l.startsAt) - s) <= 5 * MIN && Date.parse(l.startsAt) < Date.parse(e.endsAt));
  });
}
export function fromProposal(e: EngineEntry, evById: Map<string, WeekEvent>, input: WeekInput): DesiredEntry {
  const ev = e.origin === 'calendar' ? evById.get(e.evidenceIds[0] ?? '') : undefined;
  const t = cfcr(e.seTaskType);
  const status: DesiredEntry['status'] = e.status === 'upcoming' || e.status === 'needs_input' || e.status === 'proposed' || e.status === 'excluded' ? e.status : 'proposed';
  const sources: DesiredEntry['sources'] = [];
  if (ev) sources.push({ kind: 'calendar', label: 'Google Calendar', externalId: ev.externalEventId, ...(ev.url ? { url: ev.url } : {}), at: ev.startsAt });
  const kindLabels: string[] = [];
  if (e.origin === 'evidence') {
    // an email I sent has no source kind of its own here (its row shows it in the evidence line): not counted as Slack
    const emailIds = new Set((input.emails ?? []).map((m) => m.id));
    const kinds = new Set(e.evidenceIds.filter((id) => !emailIds.has(id)).map((id) => (input.sessions.some((s) => s.rowId === id) ? 'claude' : input.drive.some((d) => d.fileId === id) ? 'drive' : 'slack')));
    for (const k of [...kinds].sort()) kindLabels.push(k === 'claude' ? 'Claude sessions' : k === 'drive' ? 'Drive edits' : 'Slack');
    // Each piece of evidence links to its original: a session, a file, a Slack burst's first message (provenance).
    sources.push(...evidenceSources(e.evidenceIds, input));
  }
  // The engine names an unmapped bucket by its doc count; a bucket of Slack bursts alone would read "0 unmapped doc(s)".
  const subject = e.subject.replace(/^0 unmapped doc\(s\)(?=:)/, `Unmapped ${(kindLabels.length ? kindLabels : sources.map((s) => s.label)).join(' + ') || 'work'}`);
  return {
    dedupeKey: e.dedupeKey,
    origin: e.origin === 'calendar' ? 'calendar' : 'evidence',
    subject,
    description: e.evidence ? `${subject} · ${e.evidence}` : subject,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    durationHours: e.durationHours,
    seTaskType: e.seTaskType,
    // D-64: internal-only work is neither customer-facing nor customer-related, whatever its type counts as (Travel)
    meetingType: e.internal ? null : t.meetingType,
    customerFacing: e.internal ? false : e.customerFacing,
    customerRelated: e.internal ? false : e.customerRelated || t.cr,
    whatKind: e.whatKind === 'opportunity' || e.whatKind === 'account' ? e.whatKind : 'none',
    whatOrg62Id: e.whatOrg62Id,
    whatName: e.whatName,
    confidence: confOf(e.confidence),
    reason: e.reason,
    flags: [...e.flags],
    status,
    excludedReason: status === 'excluded' ? (e.excludedReason ?? 'neither_type') : null,
    org62EventRowId: null,
    sources,
    remote: e.remote ?? true,
    ...(e.internal ? { internal: true } : {}),
    ...noteOf(e, ev, input),
  };
}
/** The row's evidence as note facts (D-66): titles, channels, attendee domains and names; never message text. */
export function noteFactsOf(e: EngineEntry, ev: WeekEvent | undefined, input: WeekInput): NoteFacts {
  const internal = !!e.internal;
  const customer = internal ? null : e.whatName ? e.whatName.split(' - ')[0]!.trim() || null : null;
  const kind: NoteFacts['kind'] = e.origin === 'evidence' || e.origin === 'build_estimate' ? 'work' : e.dedupeKey.startsWith('onsite|') ? 'onsite' : e.seTaskType === 'Travel' ? 'travel' : 'meeting';
  const ids = new Set(e.evidenceIds);
  const sessions = kind === 'work' ? input.sessions.filter((x) => ids.has(x.rowId)).map((x) => x.title) : [];
  const docs = kind === 'work' ? input.drive.filter((d) => ids.has(d.fileId)).map((d) => d.title) : [];
  const channels = kind === 'work' ? [...new Set(input.slack.filter((m) => ids.has(`${m.channelId}|${m.at}`)).map((m) => m.channelName).filter((c): c is string => !!c))] : [];
  const repo = /\|repo:([^#]+)/.exec(e.dedupeKey)?.[1];
  // a meeting's own notes only (an onsite frame's first signal may be a meeting: its notes are not the day's)
  const notes = kind === 'meeting' && ev && input.meetingNotes ? input.meetingNotes(ev.rowId) : null;
  const uses = e.whatOrg62Id && !internal && input.useCases ? input.useCases(e.whatOrg62Id) : [];
  const useCase = uses.length ? pickUseCase(uses, [e.subject, ...sessions, ...docs].join(' ')) : null;
  return {
    kind,
    subject: kind === 'meeting' || kind === 'travel' ? (ev?.title ?? e.subject) : e.subject,
    taskType: e.seTaskType,
    internal,
    customer,
    externalDomains: ev?.attendeeDomains ?? [],
    useCase,
    nextStep: notes?.nextStep ?? null,
    sessions,
    docs,
    channels,
    repos: repo ? [repo] : [],
    city: kind === 'onsite' ? (/\(([^)]+)\)\s*$/.exec(e.subject)?.[1] ?? null) : null,
  };
}
/** D-66: the cheap model's note over the meeting notes when there is one, else the template. */
function noteOf(e: EngineEntry, ev: WeekEvent | undefined, input: WeekInput): Pick<DesiredEntry, 'logNote' | 'logNoteBasis'> {
  const facts = noteFactsOf(e, ev, input);
  const summary = facts.kind === 'meeting' && e.dedupeKey.startsWith('cal|') && ev && input.meetingNotes ? input.meetingNotes(ev.rowId)?.summary : null;
  if (summary) return { logNote: summary, logNoteBasis: 'summary' };
  return { logNote: templateNote(facts), logNoteBasis: 'template' };
}
export function fromOrg62(r: WeekOrg62Event, replacedAll: EngineEntry[] | undefined, evById: Map<string, WeekEvent>, input: WeekInput): DesiredEntry {
  const replaced = replacedAll?.[0];
  const hours = roundQuarter(r.durationField ?? (Date.parse(r.endsAt) - Date.parse(r.startsAt)) / 3_600_000);
  const t = cfcr(r.seTaskTypeName);
  const ev = replaced?.origin === 'calendar' ? evById.get(replaced.evidenceIds[0] ?? '') : undefined;
  const flags: string[] = [];
  if (r.durationField === null) flags.push('Duration__c is blank in Org62; backfill it');
  // D-55: the persona's record type (an SE's Solutions Event, an AE's Sales Events); a task type only where it is needed
  const rt = input.cfg.recordTypeName ?? 'Solutions Event';
  // TL-41: a legacy record type closes the proposal it matches but is not counted until re-created (the count map)
  if (r.recordTypeName !== rt) flags.push(legacyFlag(r.recordTypeName, rt));
  if (!r.seTaskTypeName && input.cfg.taskTypeRequired !== false) flags.push('SE_Task_Type__c is blank in Org62');
  const what = r.whatOrg62Id;
  // D-64: an Event logged with Related To empty and an internal type is internal-only work (CF / CR off)
  const internal = !what && isInternalTaskType(r.seTaskTypeName);
  // TL-08: a customer task type logged with Related To empty: say so (it counts, but against no opportunity)
  if (!what && !internal && r.seTaskTypeName && r.recordTypeName === rt) flags.push(RELATED_TO_EMPTY_FLAG);
  const eventUrl = org62RecordUrl('Event', r.org62EventId);
  const sources: DesiredEntry['sources'] = [{ kind: 'org62', label: `Org62 · ${rt}`, externalId: r.org62EventId, ...(eventUrl ? { url: eventUrl } : {}), at: r.startsAt }];
  if (ev) sources.push({ kind: 'calendar', label: 'Google Calendar', externalId: ev.externalEventId, ...(ev.url ? { url: ev.url } : {}), at: ev.startsAt });
  const end = hours > 0 ? new Date(Date.parse(r.startsAt) + hours * 3_600_000).toISOString() : r.endsAt;
  return {
    dedupeKey: `org62|${r.org62EventId}`,
    origin: 'manual',
    subject: r.subject ?? '(no subject)',
    description: r.subject ?? '(no subject)',
    startsAt: r.startsAt,
    endsAt: end,
    durationHours: hours,
    seTaskType: r.seTaskTypeName,
    meetingType: internal ? null : t.meetingType,
    customerFacing: internal ? false : t.cf,
    customerRelated: internal ? false : t.cr,
    whatKind: what?.startsWith('006') ? 'opportunity' : what?.startsWith('001') ? 'account' : 'none',
    whatOrg62Id: what,
    whatName: r.whatName ?? (what ? (input.names(what)?.name ?? null) : null),
    confidence: 'sure',
    reason: replacedAll?.length ? `already in Org62 (matched ${replacedAll.map((x) => `'${x.subject}'`).join(', ')})` : 'logged in Org62',
    flags,
    status: 'logged',
    excludedReason: null,
    org62EventRowId: r.rowId,
    sources,
    remote: replaced?.remote ?? true,
    ...(internal ? { internal: true } : {}),
    // Org62's own Description is not read: the app has no note for it
    logNote: null,
    logNoteBasis: null,
  };
}
/** At most this many linked sources per evidence row (the rest is in the description's counts). */
const MAX_EVIDENCE_SOURCES = 8;
/**
 * An evidence entry's sources, one per piece of evidence, each with its link: a Claude session (continue link), a
 * Drive file (editor link), a Slack burst (its first message's permalink).
 */
function evidenceSources(ids: string[], input: WeekInput): DesiredEntry['sources'] {
  const out: DesiredEntry['sources'] = [];
  const sessions = new Map(input.sessions.map((x) => [x.rowId, x]));
  const files = new Map(input.drive.map((d) => [d.fileId, d]));
  let bursts: Map<string, SlackMessage> | undefined;
  for (const id of ids) {
    if (out.length >= MAX_EVIDENCE_SOURCES) break;
    const sess = sessions.get(id);
    if (sess) {
      out.push({ kind: 'claude', label: `Claude · ${sess.title}`, externalId: sess.rowId, ...(sess.url ? { url: sess.url } : {}), ...(sess.lastActivityAt ? { at: sess.lastActivityAt } : {}) });
      continue;
    }
    const file = files.get(id);
    if (file) {
      out.push({ kind: 'drive', label: `Drive · ${file.title}`, externalId: file.fileId, url: file.url ?? driveFileLink(file.fileId), at: file.at });
      continue;
    }
    // A Slack burst id is `<channelId>|<first message at>` (slackBursts).
    bursts ??= new Map(input.slack.map((m) => [`${m.channelId}|${m.at}`, m]));
    const first = bursts.get(id);
    if (first) out.push({ kind: 'slack', label: first.channelName ? `Slack · #${first.channelName}` : 'Slack', externalId: first.externalId ?? id, ...(first.url ? { url: first.url } : {}), at: first.at });
  }
  return out;
}
export function blockLabeler(input: WeekInput, evById: Map<string, WeekEvent>, slack: SlackBurstEvidence[], onsite: OnsiteDay[]) {
  const sessions = new Map(input.sessions.map((s) => [s.rowId, s]));
  const files = new Map(input.drive.map((d) => [d.fileId, d.title]));
  const bursts = new Map(slack.map((b) => [b.id, b]));
  const days = new Map(onsite.map((d) => [d.day, d]));
  return (b: EngineBlock): string => {
    const ids = b.evidenceIds;
    if (b.source === 'onsite') {
      const d = days.get(b.localDay);
      const who = d?.whatName ?? accountByKey(input.mappings, b.accountKey)?.whatName ?? null;
      return `Onsite${who ? ` · ${who.split(' - ')[0]}` : ''}${d?.city ? ` (${d.city})` : ''}`;
    }
    if (b.source === 'travel') return `Travel · ${evById.get(ids[0] ?? '')?.title ?? 'flight'}`;
    if (b.source === 'calendar') return evById.get(ids[0] ?? '')?.title ?? 'Meeting';
    if (b.source === 'claude_hands_on' || b.source === 'claude_background') {
      const titles = ids.map((i) => sessions.get(i)?.title).filter((t): t is string => !!t);
      const head = b.repoKey ? `${b.repoKey}` : 'Claude';
      return titles.length === 1 ? `${head} · ${titles[0]}` : `${head} · ${titles.length} sessions`;
    }
    if (b.source === 'doc_edit') {
      const t = ids.map((i) => files.get(i) ?? i);
      return t.length === 1 ? `Edited ${t[0]}` : `Edited ${t.length} files`;
    }
    if (b.source === 'slack_burst') {
      const x = bursts.get(ids[0] ?? '');
      const n = ids.length > 1 || !x?.messageCount ? ids.length : x.messageCount;
      return n ? `${n} Slack message${n === 1 ? '' : 's'}` : 'Slack';
    }
    if (b.source === 'estimate') return `${ids.length} email${ids.length === 1 ? '' : 's'} sent`;
    return b.source;
  };
}
