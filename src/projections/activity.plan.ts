// planWeek: one week's desired entries and moves. Split from activity.ts (max-lines); activity.ts re-exports the public names.
import {
  type ActivityEntry as EngineEntry, type CalendarEvidence, type ClaudeEvidence, type DriveEvidence,
  type EmailSentEvidence, type Org62EventRow, type SlackBurstEvidence, type SlackMessageEvidence, addDays,
  CANCELLED_HELD_FLAG, CANCELLED_LOGGED_FLAG, CANCELLED_MARKER, coveredFlag, DUPLICATE_MARKER, duplicateFlag,
  isRoundTripFlag, localDay as localDayMs, localHm, MANUAL_LOG_NOTE, NOT_IN_ORG62_FLAG, overlapInfo,
  RESCHEDULED_MARKER, rescheduledFlag, sameRelatedTo, START_DIFFERS_MARKER, DECLINED_HELD_FLAG, DECLINED_LOGGED_FLAG,
  DECLINED_MARKER, dismissRuleFlag, dismissSourceOf, isRuleDismissal, seriesKeyOf, finalizeStatus, NOT_ON_TEAM_FLAG,
  NOT_ON_TEAM_MARKER, overlapModeOf, proposeActivity, roundQuarter, verifyReadback,
} from '@/engines/activity';
import type { SlackMessage } from './types';
import { id15, localDay } from './util';
import {
  MIN, type WeekEvent, kindOf, selfResponse, type WeekInput, type WeekPlan, sessionInWindow, type RekeyMove,
  type FixedEntry, type ReadbackMove, type CoverMove, type DesiredEntry, type WeekOrg62Event, type DeclinedMove,
  type FlagMove, type ReviveMove, type DesiredBlock,
} from './activity.model';
import {
  isMeetingKey, calKeyOf, adoptDiff, adoptOf, fromProposal, fromOrg62, isTwinEvent, blockLabeler, dropExcludedTwins,
} from './activity.moves';

/** My Slack messages, one own action each (engaged.ts). The id is the one a burst of one message has. */
export function slackActions(msgs: readonly SlackMessage[]): SlackMessageEvidence[] {
  return msgs.map((m) => ({ id: `${m.channelId}|${m.at}`, channelId: m.channelId, channelName: m.channelName ?? null, at: m.at }));
}
/** My Slack messages → bursts: one per channel run with ≤ 10 min between messages (block labels; legacy evidence). */
export function slackBursts(msgs: SlackMessage[]): SlackBurstEvidence[] {
  const by = new Map<string, SlackMessage[]>();
  for (const m of msgs) by.set(m.channelId, [...(by.get(m.channelId) ?? []), m]);
  const out: SlackBurstEvidence[] = [];
  for (const [channelId, list] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = list.sort((a, b) => a.at.localeCompare(b.at));
    let run: SlackMessage[] = [];
    const flush = () => {
      if (!run.length) return;
      const s = Date.parse(run[0]!.at) - 2 * MIN;
      const e = Date.parse(run[run.length - 1]!.at) + 3 * MIN;
      out.push({ id: `${channelId}|${run[0]!.at}`, channelId, startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), messageCount: run.length });
      run = [];
    };
    for (const m of sorted) {
      const prev = run[run.length - 1];
      if (prev && Date.parse(m.at) - Date.parse(prev.at) > 10 * MIN) flush();
      run.push(m);
    }
    flush();
  }
  return out;
}
export function toEvidence(e: WeekEvent): CalendarEvidence {
  return {
    id: `${e.calendarId}|${e.externalEventId}`,
    summary: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    allDay: e.isAllDay,
    kind: kindOf(e),
    selfResponse: selfResponse(e),
    organizerSelf: e.iAmOrganizer,
    recurring: e.recurring,
    attendeeDomains: e.attendeeDomains,
    attended: e.attendance === 'missed' ? false : undefined,
    hasGeminiNotes: e.hasNotes,
    deleted: e.cancelled,
    location: e.location ?? null,
    ...(e.isAllDay && e.allDayFrom ? { allDayFrom: e.allDayFrom, ...(e.allDayTo ? { allDayTo: e.allDayTo } : {}) } : {}),
    accountKey: e.accountId,
    oppWhatId: e.oppOrg62Id,
    ...(e.seriesId ? { seriesId: e.seriesId } : {}),
  };
}
/** The local days of a window [from, to) in `tz`. */
function daysIn(from: string, to: string, tz: string): string[] {
  const out: string[] = [];
  const last = localDay(new Date(Date.parse(to) - 1).toISOString(), tz);
  for (let d = localDay(from, tz); d <= last && out.length < 40; d = addDays(d, 1)) out.push(d);
  return out;
}
export function planWeek(input: WeekInput): WeekPlan {
  const { cfg } = input;
  const evById = new Map<string, WeekEvent>();
  const calendar: CalendarEvidence[] = input.events.map((e) => {
    const ev = toEvidence(e);
    evById.set(ev.id, e);
    return ev;
  });
  const context = (input.context ?? []).map(toEvidence);
  for (const e of input.context ?? []) if (!evById.has(`${e.calendarId}|${e.externalEventId}`)) evById.set(`${e.calendarId}|${e.externalEventId}`, e);
  const drive: DriveEvidence[] = input.drive.map((d) => ({ fileId: d.fileId, title: d.title, editedAt: d.at }));
  const slack = slackBursts(input.slack);
  const slackMessages = slackActions(input.slack);
  const emails: EmailSentEvidence[] = (input.emails ?? []).map((e) => ({ id: e.id, subject: e.subject, domains: e.domains, at: e.at }));
  const from = Date.parse(input.from);
  const to = Date.parse(input.to);
  const claude = input.sessions.map((s) => sessionInWindow(s, from, to)).filter((x): x is ClaudeEvidence => !!x);
  const org62: Org62EventRow[] = input.org62.map(({ rowId: _r, whatName: _w, ...r }) => r);

  // The user's rows are reserved: travel fills only time nobody owns, and so do onsite frames, except around the user's
  // meeting rows when every accepted meeting logs (D-18 amended). Rows the user dismissed never win an overlap.
  const DEAD = ['excluded', 'dismissed', 'dropped'];
  const reserved = input.fixed
    .filter((f) => f.operation === 'create' && !DEAD.includes(f.status))
    .map((f) => ({ startsAt: f.startsAt, endsAt: f.endsAt, meeting: isMeetingKey(f.dedupeKey, f.seTaskType) }));
  // a row the engine excluded only for an overlap is no dismissal, even once the user edited it: it may log again
  const revivable = new Map(input.fixed.filter((f) => f.status === 'excluded' && f.excludedReason === 'overlap').map((f) => [f.dedupeKey, f]));
  const notLogging = input.fixed.filter((f) => DEAD.includes(f.status) && !revivable.has(f.dedupeKey)).map((f) => f.dedupeKey);
  // D-64: the meetings of a series the user dismissed all of never log, so they never take time from one that does
  const rules = new Map((input.dismissRules ?? []).map((r) => [r.key, r.label] as const));
  for (const e of input.events) {
    const series = seriesKeyOf(e.calendarId, e.externalEventId);
    if (series && rules.has(series)) notLogging.push(`cal|${e.calendarId}|${e.externalEventId}|${e.startsAt}`);
  }
  // Solo work never counts again what the user's rows and Org62 already hold, except the user's own solo-work rows (and
  // their Events): the new estimate of the same work replaces those (the re-derive's update candidates, rederive.ts).
  const soloRow = (k: string) => k.startsWith('wb|');
  const soloEventRows = new Set(input.fixed.filter((f) => soloRow(f.dedupeKey) && f.org62EventRowId).map((f) => f.org62EventRowId!));
  const yieldTo = [
    ...input.fixed.filter((f) => f.operation === 'create' && !DEAD.includes(f.status) && !soloRow(f.dedupeKey)).map((f) => ({ startsAt: f.startsAt, endsAt: f.endsAt })),
    ...input.org62.filter((r) => !soloEventRows.has(r.rowId) && !(r.ccKey && input.fixed.some((f) => soloRow(f.dedupeKey) && f.rowId === r.ccKey))).map((r) => ({ startsAt: r.startsAt, endsAt: r.endsAt })),
  ];
  const plan = proposeActivity({
    now: input.now,
    cfg,
    mappings: input.mappings,
    evidence: { calendar, claude, drive, slack: [], slackMessages, emails, git: [] },
    org62Events: org62,
    handsOff: false,
    calendarContext: context,
    onsiteDays: daysIn(input.from, input.to, cfg.timezone),
    onsiteOverrides: input.onsiteOverrides,
    reserved,
    notLogging,
    yieldTo,
  });

  // Per-meeting opp: the resolver's (or the user's mapping) wins over the engine's account-level default, except on a
  // trip, where every row logs to the trip's one account and opp (onsite lane, root cause 6).
  // An opp I'm not on the team of (no DC either) holds the row for the user (needs_input: "Check and approve"); one
  // that is mine clears the engine's not-on-team flag. The status is settled again from the new flags.
  const proposals = plan.entries.map((e) => {
    if (e.origin !== 'calendar' || e.tripKey) return e;
    const ev = evById.get(e.evidenceIds[0] ?? '');
    if (!ev?.oppOrg62Id || e.whatKind === 'none' || id15(e.whatOrg62Id) === id15(ev.oppOrg62Id)) return e;
    const n = input.names(ev.oppOrg62Id);
    const flags = e.flags.filter((f) => !/WhatId = account fallback|NEEDS WhatId/.test(f) && !(n?.mine === true && f.includes(NOT_ON_TEAM_MARKER)));
    if (n?.mine === false && !flags.some((f) => f.includes(NOT_ON_TEAM_MARKER))) flags.push(NOT_ON_TEAM_FLAG);
    return finalizeStatus({ ...e, whatKind: 'opportunity' as const, whatOrg62Id: ev.oppOrg62Id, whatName: n?.name ?? e.whatName, flags }, Date.parse(input.now));
  });

  // ---- D-65 (TL-32): a meeting rescheduled after I approved (or dismissed) its row: the row moves with it, re-keyed by
  // the event id (the dedupe key carries the start), so no stale row stays and no new proposal opens. A row handed off
  // already stays where Org62 has it, flagged; its new time opens no proposal either.
  const tz = cfg.timezone;
  const fixedKeys = new Set(input.fixed.map((f) => f.dedupeKey));
  // a solo-work row the user owns stands for that day's bucket: the engine's proposal of it and its continuations
  // (`#2` …) are never written; the re-derive compares their hours with the row's (update candidates)
  const baseOf = (k: string) => k.replace(/#\d+$/, '');
  const shadowed: WeekPlan['shadowed'] = proposals
    // solo work, and travel (its buffers changed 2026-11-14)
    .filter((p) => (p.origin === 'evidence' || p.seTaskType === 'Travel') && fixedKeys.has(baseOf(p.dedupeKey)) && input.fixed.some((f) => f.dedupeKey === baseOf(p.dedupeKey) && !DEAD.includes(f.status)))
    .map((p) => ({ dedupeKey: p.dedupeKey, baseKey: baseOf(p.dedupeKey), durationHours: p.durationHours, reason: p.reason, evidence: p.evidence }));
  const shadowedKeys = new Set(shadowed.map((x) => x.dedupeKey));
  const byIdentity = new Map<string, WeekEvent>();
  for (const e of [...(input.context ?? []), ...input.events]) byIdentity.set(`${e.calendarId}|${e.externalEventId}`, e);
  const suppressed = new Set<string>();
  const rekeys: RekeyMove[] = [];
  const rescheduled = new Map<string, string[]>();
  for (const f of input.fixed) {
    const k = calKeyOf(f.dedupeKey);
    if (!k || !isMeetingKey(f.dedupeKey, f.seTaskType)) continue;
    const ev = byIdentity.get(`${k.calendarId}|${k.eventId}`);
    if (!ev || ev.cancelled || ev.isAllDay || Date.parse(ev.startsAt) === Date.parse(k.startsAt)) continue;
    const key = `cal|${k.calendarId}|${k.eventId}|${ev.startsAt}`;
    if (fixedKeys.has(key)) continue; // the user has a row at the new time already
    suppressed.add(key);
    if (['synced_to_canvas', 'logged', 'verified', 'verify_failed'].includes(f.status)) {
      rescheduled.set(f.rowId, [rescheduledFlag(localDayMs(Date.parse(ev.startsAt), tz), localHm(Date.parse(ev.startsAt), tz))]);
      continue;
    }
    // the row follows its meeting: its new start and end; a row whose start, end or hours you edited keeps its own
    // length and shifts by as much as the meeting did
    const span = Date.parse(f.endsAt) - Date.parse(f.startsAt);
    const edited = (f.lockedFields ?? []).some((c) => c === 'starts_at' || c === 'ends_at' || c === 'duration_hours');
    const follow = !edited && Date.parse(f.startsAt) === Date.parse(k.startsAt);
    const startsAt = follow ? ev.startsAt : new Date(Date.parse(f.startsAt) + Date.parse(ev.startsAt) - Date.parse(k.startsAt)).toISOString();
    rekeys.push({
      rowId: f.rowId,
      dedupeKey: key,
      startsAt,
      endsAt: follow ? ev.endsAt : new Date(Date.parse(startsAt) + span).toISOString(),
      durationHours: follow ? roundQuarter((Date.parse(ev.endsAt) - Date.parse(ev.startsAt)) / 3_600_000) : f.durationHours,
    });
  }

  // ---- read-back: fixed rows and proposals compete for each Org62 Event (D-65: the link first, then the CC# key,
  // Subject + Start, fuzzy, the slot, a tz shift). A proposal of a meeting the user owns a row of is that row: it never
  // takes the Event from it (TL-05). An Event an app row of another pass is tied to is that row's (TL-12).
  const asEngine = (f: FixedEntry): EngineEntry => ({
    dedupeKey: `fixed:${f.rowId}`,
    origin: 'manual',
    operation: f.operation,
    targetOrg62EventId: f.targetOrg62EventId,
    subject: f.subject,
    startsAt: f.startsAt,
    endsAt: f.endsAt,
    durationHours: f.durationHours,
    seTaskType: f.seTaskType,
    meetingType: f.meetingType ?? '',
    whatKind: 'none',
    whatOrg62Id: f.whatOrg62Id,
    whatName: null,
    customerFacing: false,
    customerRelated: false,
    description: '',
    confidence: 'High',
    reason: '',
    flags: [],
    evidenceIds: [],
    evidence: '',
    status: (f.status as EngineEntry['status']) ?? 'approved',
    excludedReason: null,
    userLockedFields: [],
  });
  const elsewhere = input.linkedElsewhere ?? new Set<string>();
  const org62Here = org62.filter((r) => !elsewhere.has(r.org62EventId));
  const org62ByRowId = new Map(input.org62.map((r) => [r.rowId, r]));
  const links = new Map<string, string>();
  const ccKeys = new Map<string, string>();
  for (const f of input.fixed) {
    const linked = f.org62EventRowId ? org62ByRowId.get(f.org62EventRowId) : undefined;
    if (linked) links.set(`fixed:${f.rowId}`, linked.org62EventId);
    ccKeys.set(`fixed:${f.rowId}`, f.rowId);
  }
  const accountOf = input.accountOf;
  const rb = verifyReadback([...input.fixed.map(asEngine), ...proposals.filter((p) => !fixedKeys.has(p.dedupeKey) && !suppressed.has(p.dedupeKey))], org62Here, {
    now: input.now,
    ownerId: cfg.ownerId || undefined,
    ...(cfg.recordTypeName ? { recordTypeName: cfg.recordTypeName } : {}),
    ...(cfg.taskTypeRequired === false ? { taskTypeRequired: false } : {}),
    links,
    ccKeys,
    ...(accountOf ? { accountOf } : {}),
    timezone: tz,
  });
  const itemOf = new Map(rb.items.map((i) => [i.dedupeKey, i]));
  const matchOf = new Map(rb.items.filter((i) => i.org62EventId).map((i) => [i.dedupeKey, i]));
  const org62ById = new Map(input.org62.map((r) => [r.org62EventId, r]));
  const claimed = new Map<string, string>(); // org62 event id → dedupeKey of the row that represents it
  const typed = cfg.taskTypeRequired !== false;
  const rt = cfg.recordTypeName ?? 'Solutions Event';

  const moves: ReadbackMove[] = [];
  const covers: CoverMove[] = [];
  const roundTrip = new Map<string, string[]>(); // fixed row id → the round-trip flags it should carry now
  for (const f of input.fixed) {
    const item = itemOf.get(`fixed:${f.rowId}`);
    const want: string[] = [];
    roundTrip.set(f.rowId, want);
    if (!item) continue;
    if (!item.org62EventId) {
      // TL-20: on a canvas that ran (Org62 shows later Events of mine), and still no Event: "Not in Org62"
      if (f.status === 'synced_to_canvas' && item.status === 'missing') want.push(NOT_IN_ORG62_FLAG);
      continue;
    }
    const r = org62ById.get(item.org62EventId)!;
    claimed.set(item.org62EventId, f.dedupeKey);
    const verifiedOnce = f.status === 'verified' && f.operation === 'create';
    // TL-22: the start Slackbot moved is flagged at the first verification, and stays flagged while it differs; a
    // verified row whose start moves later was edited in Org62 (TL-12: adopted below, never flagged)
    const shifted = (f.flags ?? []).some((x) => x.startsWith(START_DIFFERS_MARKER));
    if (!verifiedOnce || shifted) want.push(...item.notes);
    const found = item.status === 'verified' || item.status === 'verify_failed' || item.status === 'logged';
    if (!found) continue; // a legacy record type: it closes nothing for the user's row (re-create to count, TL-41)
    if (verifiedOnce) {
      // TL-10 / TL-11 / TL-12 / TL-13: verified once, different now: edited in Org62. Org62 wins, and only a real
      // difference writes (never a rewrite on every pass). A start Slackbot moved stays flagged, never adopted (TL-22).
      const keepTimes = shifted;
      const diff = adoptDiff(f, r, { typed, keepTimes });
      if (diff.length) moves.push({ rowId: f.rowId, status: 'verified', org62EventRowId: r.rowId, issues: [], adopt: adoptOf(f, r, `Updated from Org62 (edited there): ${diff.join('; ')}`.slice(0, 300), keepTimes) });
      continue;
    }
    if (f.status === 'approved' && item.matchedBy !== 'link' && item.matchedBy !== 'cc_key') {
      // TL-05: an approved row the user then logged by hand (another subject or start): Org62 is the record. The row
      // takes its values and is verified, so it never goes on a canvas (nor does the canvas item holding it, TL-06).
      const diff = item.status === 'logged' ? [] : adoptDiff(f, r, { typed, keepTimes: false });
      moves.push({ rowId: f.rowId, status: item.status === 'logged' ? 'logged' : 'verified', org62EventRowId: r.rowId, issues: item.status === 'logged' ? item.issues : [], ...(diff.length ? { adopt: adoptOf(f, r, `${MANUAL_LOG_NOTE}: ${diff.join('; ')}`.slice(0, 300), false) } : {}) });
      continue;
    }
    if (['approved', 'synced_to_canvas', 'logged', 'verify_failed'].includes(f.status)) {
      // TL-15: verify_failed moves on too (fixed in Org62 → verified); an unchanged verify_failed rewrites only its issue
      if (f.status !== item.status || f.status === 'verify_failed') moves.push({ rowId: f.rowId, status: item.status as ReadbackMove['status'], org62EventRowId: r.rowId, issues: item.issues });
    }
  }

  const entries: DesiredEntry[] = [];
  const replacedBy = new Map<string, EngineEntry[]>(); // org62 event id → the proposals it closes
  const open: EngineEntry[] = [];
  for (const e of proposals) {
    if (suppressed.has(e.dedupeKey)) continue; // TL-32: a rescheduled meeting's new time: the user's row is it
    if (shadowedKeys.has(e.dedupeKey) && !fixedKeys.has(e.dedupeKey)) continue; // a continuation of a solo-work row the user owns
    const m = matchOf.get(e.dedupeKey);
    if (m?.org62EventId && !claimed.has(m.org62EventId)) {
      replacedBy.set(m.org62EventId, [...(replacedBy.get(m.org62EventId) ?? []), e]);
      continue;
    }
    open.push(e);
  }
  // TL-03: one Event that covers two meetings closes every one it fully covers (the same Related To; never a meeting
  // double-booked over the one it was matched to: those both log, D-18)
  const representedBy = (id: string): { startsAt: string; endsAt: string }[] => [
    ...(replacedBy.get(id) ?? []),
    ...input.fixed.filter((f) => claimed.get(id) === f.dedupeKey),
  ];
  const coverOf = (x: { startsAt: string; endsAt: string; whatOrg62Id: string | null; accountKey?: string | null }): WeekOrg62Event | null => {
    const s = Date.parse(x.startsAt);
    const en = Date.parse(x.endsAt);
    for (const r of input.org62) {
      // an Event a canvas made (its CC# key) is that one row's: it never stands in for another meeting
      if (elsewhere.has(r.org62EventId) || r.recordTypeName !== rt || r.ccKey) continue;
      const rs = Date.parse(r.startsAt);
      const re = Date.parse(r.endsAt);
      if (!(rs <= s + MIN && en <= re + MIN && re - rs >= en - s + 15 * MIN)) continue;
      if (!sameRelatedTo(x.whatOrg62Id, r.whatOrg62Id, accountOf)) continue;
      if (representedBy(r.org62EventId).some((o) => Date.parse(o.startsAt) < en && s < Date.parse(o.endsAt))) continue;
      return r;
    }
    return null;
  };
  for (const e of open) {
    // a proposal of a meeting the user owns a row of is that row (its cover, if any, is the row's: below)
    const r = e.status === 'excluded' || fixedKeys.has(e.dedupeKey) ? null : coverOf(e);
    if (r && (claimed.has(r.org62EventId) || replacedBy.has(r.org62EventId))) {
      replacedBy.set(r.org62EventId, [...(replacedBy.get(r.org62EventId) ?? []), e]);
      continue;
    }
    entries.push(fromProposal(e, evById, input));
  }
  for (const f of input.fixed) {
    if (f.status !== 'approved' || f.operation !== 'create' || moves.some((mv) => mv.rowId === f.rowId) || itemOf.get(`fixed:${f.rowId}`)?.org62EventId) continue;
    if (Date.parse(f.startsAt) < from || Date.parse(f.startsAt) >= to) continue;
    const r = coverOf(f);
    if (r && (claimed.has(r.org62EventId) || replacedBy.has(r.org62EventId))) covers.push({ rowId: f.rowId, org62EventRowId: r.rowId, flag: coveredFlag(r.subject ?? '(no subject)') });
  }

  const mirrors: DesiredEntry[] = [];
  for (const r of input.org62) {
    if (claimed.has(r.org62EventId) || elsewhere.has(r.org62EventId)) continue;
    // Logged rows are this quarter's (the pages total every logged row as the quarter's hours); older Org62
    // Events still match proposals (those stay "already in Org62") and count toward the caps.
    if (input.loggedFrom && Date.parse(r.startsAt) < Date.parse(input.loggedFrom)) continue;
    const m = fromOrg62(r, replacedBy.get(r.org62EventId), evById, input);
    mirrors.push(m);
    entries.push(m);
  }
  // TL-04 / TL-21: a second Event in a slot another Event already logs stays logged (never hidden) and is flagged
  // "possible duplicate in Org62". The Events the user's rows are tied to come first, then by start.
  const canon = [
    ...input.org62.filter((r) => claimed.has(r.org62EventId) && !elsewhere.has(r.org62EventId)),
    ...mirrors.map((m) => org62ByRowId.get(m.org62EventRowId!)!).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.org62EventId.localeCompare(b.org62EventId)),
  ];
  for (const m of mirrors) {
    const r = org62ByRowId.get(m.org62EventRowId!)!;
    const i = canon.indexOf(r);
    const twin = canon.slice(0, i).find((o) => o.recordTypeName === r.recordTypeName && isTwinEvent(o, r, tz, accountOf));
    if (twin) m.flags.push(duplicateFlag(twin.subject ?? '(no subject)', Date.parse(twin.startsAt), Date.parse(twin.endsAt), tz));
  }

  // ---- D-64: rows whose source a "Dismiss all from …" rule covers are written dismissed, with the rule's flag
  for (const e of entries) {
    if (e.status === 'excluded' || e.status === 'logged') continue;
    const src = dismissSourceOf(e.dedupeKey, e.subject);
    const label = src ? rules.get(src.key) : undefined;
    if (label === undefined) continue;
    e.status = 'dismissed';
    e.excludedReason = null;
    e.flags.push(dismissRuleFlag(label));
  }

  // ---- overlaps between rows: user-owned, then Org62, then meetings, then evidence guesses (D-18 amended: by mode).
  // D-65: a real Org62 record is never hidden: an Org62 row logs in either mode, and one that overlaps another row
  // only says so (TL-07); estimates and meetings still yield to it as before.
  const logAll = overlapModeOf(cfg) === 'log_all_accepted';
  const rank = (e: DesiredEntry) => (e.status === 'logged' ? 0 : e.origin === 'calendar' ? 1 : 2);
  const taken: { s: number; e: number; label: string; key: string; org62: boolean }[] = input.fixed
    .filter((f) => f.operation === 'create' && !DEAD.includes(f.status))
    .map((f) => ({ s: Date.parse(f.startsAt), e: Date.parse(f.endsAt), label: f.subject, key: f.dedupeKey, org62: false }));
  const dead = new Set(notLogging);
  for (const e of [...entries].sort((a, b) => rank(a) - rank(b) || a.startsAt.localeCompare(b.startsAt) || a.dedupeKey.localeCompare(b.dedupeKey))) {
    // excluded, dismissed by a rule, or the proposal behind a row the user dismissed (theirs stands; never written)
    if (e.status === 'excluded' || e.status === 'dismissed' || dead.has(e.dedupeKey)) continue;
    const s = Date.parse(e.startsAt);
    const en = Date.parse(e.endsAt);
    const over = (t: (typeof taken)[number]) => t.s < en && s < t.e;
    if (e.status === 'logged' && e.dedupeKey.startsWith('org62|')) {
      const hit = e.flags.some((f) => f.startsWith(DUPLICATE_MARKER)) ? undefined : taken.find(over);
      if (hit) e.flags.push(overlapInfo(hit.label, Math.max(s, hit.s), Math.min(en, hit.e), tz));
      taken.push({ s, e: en, label: e.subject, key: e.dedupeKey, org62: true });
      continue;
    }
    // an accepted meeting (or an onsite frame) logs over other rows; only its twin stands in for it: the user's row of
    // the same key, or (a meeting) an Org62 Event of the same slot that the read-back could not match by subject
    const meeting = isMeetingKey(e.dedupeKey, e.seTaskType) && e.status !== 'logged';
    const frame = e.dedupeKey.startsWith('onsite|');
    const hit =
      logAll && (meeting || frame)
        ? taken.find((t) => t.key === e.dedupeKey || (meeting && t.org62 && over(t) && Math.abs(t.s - s) <= 5 * MIN))
        : taken.find(over);
    if (hit) {
      e.status = 'excluded';
      e.excludedReason = 'overlap';
      e.flags.push(`overlaps '${hit.label}': hours are human hours, counted once`);
      continue;
    }
    taken.push({ s, e: en, label: e.subject, key: e.dedupeKey, org62: false });
  }

  // ---- D-64: a meeting I declined has no row. The projection's own rows simply drop (no proposal); mine go too, unless
  // handed off or waiting in a canvas item: flagged, never deleted from Org62. D-65 (TL-31): a meeting cancelled before it
  // happened (the calendar's `cancelled`) the same way.
  const declinedKeys = input.events
    .filter((e) => e.myResponse === 'declined' && !e.isAllDay && !e.cancelled)
    .map((e) => `cal|${e.calendarId}|${e.externalEventId}|${e.startsAt}`);
  const isDeclined = (k: string) => declinedKeys.some((d) => k === d || k.startsWith(`${d}@`) || k.startsWith(`${d}#`));
  const cancelledIds = new Set([...input.events.filter((e) => e.cancelled && !e.isAllDay).map((e) => `cal|${e.calendarId}|${e.externalEventId}|`)]);
  const isCancelled = (k: string) => {
    const c = calKeyOf(k);
    return !!c && cancelledIds.has(`cal|${c.calendarId}|${c.eventId}|`);
  };
  const HANDED = ['synced_to_canvas', 'logged', 'verified', 'verify_failed'];
  // an Org62 Event of a meeting I declined (logged before I declined) stays logged, and says so
  // (the same subject, starting within 5 min: never a guess on another meeting of the slot)
  const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');
  const declinedAt = input.events.filter((e) => e.myResponse === 'declined' && !e.isAllDay && !e.cancelled).map((e) => ({ t: Date.parse(e.startsAt), title: norm(e.title) }));
  for (const e of entries)
    if (e.status === 'logged' && e.dedupeKey.startsWith('org62|') && declinedAt.some((d) => Math.abs(d.t - Date.parse(e.startsAt)) <= 5 * MIN && d.title === norm(e.subject)) && !e.flags.includes(DECLINED_LOGGED_FLAG)) e.flags.push(DECLINED_LOGGED_FLAG);
  const declined: DeclinedMove[] = [];
  for (const f of input.fixed) {
    const dec = isDeclined(f.dedupeKey);
    const can = !dec && isCancelled(f.dedupeKey);
    if ((!dec && !can) || Date.parse(f.startsAt) < from || Date.parse(f.startsAt) >= to) continue;
    // handed off already, or the read-back just found it in Org62
    const handed = HANDED.includes(f.status) || moves.some((mv) => mv.rowId === f.rowId);
    const held = !handed && !!input.held?.has(f.rowId);
    const marker = dec ? DECLINED_MARKER : CANCELLED_MARKER;
    if (!handed && !held) declined.push({ rowId: f.rowId, action: 'remove' });
    else if (!(f.flags ?? []).some((x) => x.startsWith(marker))) declined.push({ rowId: f.rowId, action: 'flag', flag: dec ? (handed ? DECLINED_LOGGED_FLAG : DECLINED_HELD_FLAG) : handed ? CANCELLED_LOGGED_FLAG : CANCELLED_HELD_FLAG });
  }

  // round-trip flags (Not in Org62, the start Slackbot moved, a reschedule after hand-off) on the user's rows: only a
  // change writes
  const flagMoves: FlagMove[] = [];
  for (const f of input.fixed) {
    const want = [...(roundTrip.get(f.rowId) ?? []), ...(rescheduled.get(f.rowId) ?? [])];
    const cur = (f.flags ?? []).filter((x) => isRoundTripFlag(x) || x.startsWith(RESCHEDULED_MARKER));
    const keepResched = cur.filter((x) => x.startsWith(RESCHEDULED_MARKER) && !rescheduled.has(f.rowId));
    const next = [...want, ...keepResched];
    if (next.length === cur.length && next.every((x) => cur.includes(x))) continue;
    flagMoves.push({ rowId: f.rowId, remove: cur.filter((x) => !next.includes(x)), add: next.filter((x) => !cur.includes(x)) });
  }

  // a row a rule had set aside whose rule is gone (Undo, Remove) logs again as the engine now proposes it
  const ruleGone = new Map(
    input.fixed
      .filter((f) => f.status === 'dismissed' && isRuleDismissal(f.flags) && !rules.has(dismissSourceOf(f.dedupeKey, f.subject)?.key ?? ''))
      .map((f) => [f.dedupeKey, f] as const),
  );
  const revives: ReviveMove[] = entries.flatMap((e): ReviveMove[] => {
    if (e.status !== 'upcoming' && e.status !== 'needs_input' && e.status !== 'proposed') return [];
    const f = revivable.get(e.dedupeKey);
    if (f) return [{ rowId: f.rowId, status: e.status, flags: [...e.flags] }];
    const g = ruleGone.get(e.dedupeKey);
    return g ? [{ rowId: g.rowId, status: e.status, flags: [...e.flags], kind: 'rule' }] : [];
  });

  // ---- blocks: labels from their evidence; never double-count a block the projections do not own
  const label = blockLabeler(input, evById, slack, plan.onsite);
  const fixedIv = input.fixedBlocks.map((b) => ({ s: Date.parse(b.startsAt), e: Date.parse(b.endsAt) }));
  const blocks: DesiredBlock[] = plan.blocks.map((b) => {
    const clash = b.countsAsHumanHours && fixedIv.some((f) => f.s < Date.parse(b.endsAt) && Date.parse(b.startsAt) < f.e);
    const ev = b.source === 'calendar' || b.source === 'travel' ? evById.get(b.evidenceIds[0] ?? '') : undefined;
    return {
      dedupeKey: b.dedupeKey,
      source: b.source,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      localDay: b.localDay,
      attention: b.attention,
      countsAsHumanHours: b.countsAsHumanHours && !clash,
      precedence: b.precedence,
      isOverlay: b.isOverlay || clash,
      accountId: b.accountKey,
      calendarEventId: ev?.rowId ?? null,
      label: label(b),
    };
  });

  const inWin = (iso: string) => Date.parse(iso) >= from && Date.parse(iso) < to;
  return {
    entries: dropExcludedTwins(entries)
      .filter((e) => inWin(e.startsAt))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.dedupeKey.localeCompare(b.dedupeKey)),
    shadowed: shadowed.filter((x) => inWin(input.fixed.find((f) => f.dedupeKey === x.baseKey)?.startsAt ?? '')),
    moves,
    revives,
    blocks: blocks.filter((b) => inWin(b.startsAt)),
    humanHours: plan.humanHours,
    leverageHours: plan.leverageHours,
    onsite: plan.onsite,
    trips: plan.trips,
    declined,
    rekeys,
    covers,
    flagMoves,
  };
}
