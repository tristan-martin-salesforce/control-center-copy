/**
 * Stage B of the projections tick (run.ts), one change set per affected week: the week's calendar events, sessions,
 * Drive edits, Slack and mail I sent and Org62 Events → planWeek (activity.ts) → time blocks, activity entries and the
 * onsite record. Reads are `sql` over the week's `tx`; the schema reads and every write go through the store.
 */
import { basename } from 'node:path';
import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { DEFAULT_EVIDENCE_CONFIG, type ActivityConfig } from '@/engines/activity';
import type { WriteCtx } from '@/server/datasource/db/store/common';
import type { ActivityProjection, ActivityRow } from '@/server/datasource/db/store/projections';

import { ENGINE_VERSION, planWeek, type FixedEntry, type WeekEmail, type WeekEvent, type WeekInput } from './activity';
import { driveEdit } from './assets';
import { claudeSessionLink, sourceItemUrl } from './links';
import { NOTE_LOCK, NOTE_REFRESH_STATUSES, addDays, emailDomains, meetingNoteFacts, toProjection, vdpUseCases, zoned } from './run.helpers';
import { DELETED_IN_ORG62_ISSUE, iso, loadMatcher, loadSources, ownedRow, uuidArr, type LoadWeekOptions, type LoadedWeek, type WeekCtx } from './run.model';
import type { ProjectionMe, ProjectionStore } from './run.store';
import { humanTurnsOf } from './sessions';
import { id15, localDay } from './util';

/**
 * The week pass's activity config: the user's timezone, workday and hours target, the persona's logging rules, and
 * Settings ▸ Time (onsite days, overlaps). `evidence` defaults to the engaged-time model's calibrated parameters.
 */
export async function weekConfig(store: ProjectionStore, userId: string, m: ProjectionMe, evidence: ActivityConfig['evidence'] = DEFAULT_EVIDENCE_CONFIG): Promise<ActivityConfig> {
  const { me, workday, quarterTargetH, logging } = m;
  return {
    timezone: me.timezone,
    ownerId: me.org62UserId ?? '',
    recordTypeId: '',
    lightningHost: 'https://org62.lightning.force.com',
    workday,
    hoursTarget: quarterTargetH,
    liveFrom: '1970-01-01',
    // D-55: the persona's record type and task-type rule (the SE's: Solutions Event, required). No hour caps (2026-11-14).
    recordTypeName: logging.recordTypeName,
    taskTypeRequired: logging.taskTypeRequired,
    // D-64: the persona's internal-only activity (the SE's)
    internalActivity: logging.internalActivity,
    evidence,
    quarters: [],
    ...(await store.loadTimeConfig(userId, logging.overlaps)),
  };
}

/** Load and plan one week exactly as the week pass does (rederive reads it without writing). */
export async function loadWeek(store: ProjectionStore, w: WriteCtx, tx: Tx, weekStart: string, c: WeekCtx, opts: LoadWeekOptions = {}): Promise<LoadedWeek> {
  const tz = c.me.timezone;
  const from = new Date(zoned(weekStart, tz));
  const to = new Date(from.getTime() + 7 * 86_400_000 + 2 * 3_600_000); // DST-safe: next Monday 00:00 local, recomputed below
  const nextMon = new Date(zoned(addDays(weekStart, 7), tz));
  const end = nextMon.getTime() < to.getTime() ? nextMon : to;
  const inWin = (iso: string | null | undefined) => !!iso && Date.parse(iso) >= from.getTime() && Date.parse(iso) < end.getTime();
  const userId = c.me.userId;

  const matcher = await loadMatcher(tx, userId, c.rules);
  // the attribution engine's learned rules and the confirmed channel map (src/engines/attribution, db/attribution.ts)
  const learned = await store.loadLearnedMappings(tx, userId);
  const eventsIn = async (lo: Date, hi: Date, notIn?: { lo: Date; hi: Date }): Promise<WeekEvent[]> => {
    const r = await tx.execute<{
      id: string; calendar_id: string; external_event_id: string; title: string | null; starts_at: Date; ends_at: Date; is_all_day: boolean; event_type: string; status: string;
      my_response: string; i_am_organizer: boolean; attendance: string; external_domains: string[] | null; recurring_event_id: string | null; html_link: string | null;
      account_id: string | null; opp_org62: string | null; has_notes: boolean; local_day: string; location: string | null;
    }>(sql`
      select e.id, e.calendar_id, e.external_event_id, e.title, e.starts_at, e.ends_at, e.is_all_day, e.event_type, e.status, e.my_response, e.i_am_organizer,
             e.attendance, e.external_domains, e.recurring_event_id, e.html_link, e.account_id, o.org62_opportunity_id as opp_org62, e.local_day::text as local_day,
             -- the column (0009); rows not re-projected since still carry it in ext
             coalesce(e.location, x.value->>'location') as location,
             exists (select 1 from meeting_notes n where n.calendar_event_id = e.id) as has_notes
        from calendar_events e
        left join opportunities o on o.id = e.opportunity_id
        left join user_settings x on x.owner_user_id = e.owner_user_id and x.key = 'cc.ext/calendar_events/' || e.id::text
       where e.owner_user_id = ${userId} and e.deleted_upstream_at is null
         and e.starts_at >= ${lo.toISOString()}::timestamptz and e.starts_at < ${hi.toISOString()}::timestamptz
         ${notIn ? sql`and not (e.starts_at >= ${notIn.lo.toISOString()}::timestamptz and e.starts_at < ${notIn.hi.toISOString()}::timestamptz)` : sql``}`);
    return r.rows.map((r) => {
      const endIso = iso(r.ends_at);
      return {
        rowId: r.id,
        calendarId: r.calendar_id,
        externalEventId: r.external_event_id,
        title: r.title ?? '',
        startsAt: iso(r.starts_at),
        endsAt: endIso,
        isAllDay: r.is_all_day,
        eventType: r.event_type,
        cancelled: r.status === 'cancelled',
        myResponse: r.my_response,
        iAmOrganizer: r.i_am_organizer,
        attendance: r.attendance,
        attendeeDomains: r.external_domains ?? [],
        recurring: !!r.recurring_event_id,
        seriesId: r.recurring_event_id,
        hasNotes: r.has_notes,
        url: r.html_link,
        accountId: r.account_id,
        oppOrg62Id: r.opp_org62,
        location: r.location,
        // all-day: dates; rows stored before 0009 sit at UTC midnight, newer ones at local midnight
        allDayFrom: r.is_all_day ? r.local_day : null,
        allDayTo: r.is_all_day ? (endIso.endsWith('T00:00:00.000Z') ? endIso.slice(0, 10) : localDay(endIso, tz)) : null,
      };
    });
  };
  const events = await eventsIn(from, end);
  // a week each side: hotel stays, flights and onsite markers decide the trips this week's days belong to
  const context = await eventsIn(new Date(from.getTime() - 8 * 86_400_000), new Date(end.getTime() + 8 * 86_400_000), { lo: from, hi: end });
  const overrides = store.readOnsiteOverrides(w.kv);

  const sessRows = await store.weekSessions(tx, userId, from, end);
  const lastPrompt = new Map<string, string | null>();
  const turnsBySource = new Map<string, { at: string; runEndsAt: string }[]>();
  const sourceIds = sessRows.map((s) => s.sourceItemId).filter((x): x is string => !!x);
  if (sourceIds.length) {
    const lp = await tx.execute<{ id: string; at: string | null; turns: unknown }>(sql`select id, meta->>'lastHumanPromptAt' as at, meta->'humanTurns' as turns from source_items where id in (${sql.join(sourceIds.map((x) => sql`${x}::uuid`), sql`, `)})`);
    for (const r of lp.rows) {
      lastPrompt.set(r.id, r.at);
      const t = humanTurnsOf({ humanTurns: r.turns });
      if (t.length) turnsBySource.set(r.id, t);
    }
  }
  const repos: Record<string, string> = {};
  const sessions = sessRows
    .filter((s) => !!s.lastActivityAt)
    .map((s) => {
      const repoKey = s.cwd ? basename(s.cwd) || 'claude' : 'claude';
      if (s.accountId && !repos[repoKey]) repos[repoKey] = s.accountId;
      return {
        rowId: s.id,
        title: s.title ?? 'Claude session',
        url: s.sessionExternalId ? claudeSessionLink(s.sessionExternalId, s.desktopSessionId) : null,
        repoKey,
        startedAt: s.startedAt ? s.startedAt.toISOString() : null,
        lastActivityAt: s.lastActivityAt!.toISOString(),
        lastHumanPromptAt: s.sourceItemId ? (lastPrompt.get(s.sourceItemId) ?? null) : null,
        accountId: s.accountId,
        turns: (s.sourceItemId ? turnsBySource.get(s.sourceItemId) : undefined) ?? (s.sessionExternalId ? (opts.turnsOf?.(s.sessionExternalId) ?? null) : null),
      };
    });

  const winSql = sql`si.occurred_at >= ${from.toISOString()}::timestamptz and si.occurred_at < ${end.toISOString()}::timestamptz`;
  const driveRows = await loadSources(tx, userId, sql`si.source = 'drive' and ${winSql}`);
  const driveUrlOf = new Map(driveRows.map((si) => [si.id, sourceItemUrl(si)]));
  const drive = driveRows
    .map(driveEdit)
    .filter((d): d is NonNullable<typeof d> => !!d && d.byMe && inWin(d.at))
    .map((d) => ({ fileId: d.fileId, title: d.title, at: d.at, url: driveUrlOf.get(d.sourceItemId) ?? null }));
  const slack = (await loadSources(tx, userId, sql`si.source = 'slack' and si.from_me and ${winSql}`)).map((si) => ({
    id: si.id,
    channelId: si.externalId.split(':')[0] ?? 'slack',
    at: si.occurredAt,
    url: sourceItemUrl(si),
    externalId: si.externalId,
    channelName: typeof si.meta.channelName === 'string' ? si.meta.channelName : null,
  }));
  // the emails I sent: recipients' domains only (never addresses)
  const emails: WeekEmail[] = (await loadSources(tx, userId, sql`si.source = 'gmail' and si.from_me and ${winSql}`)).map((si) => ({
    id: si.id,
    subject: si.title,
    domains: emailDomains(si.meta),
    at: si.occurredAt,
  }));

  const existingWin = await store.loadActivityWindow(w, new Date(from.getTime() - 86_400_000), new Date(end.getTime() + 86_400_000));
  // D-65 (TL-32): my rows of this week's meetings that sit at another time (rescheduled across a week boundary): they
  // follow their meeting, and its new time opens no proposal
  const winIds = new Set(existingWin.map((r) => r.id));
  const idents = [...new Set(events.map((e) => `cal|${e.calendarId}|${e.externalEventId}|`))];
  const sameMeeting = idents.length
    ? (await store.sameMeetingRows(tx, userId, idents)).filter((r) => !winIds.has(r.id) && !ownedRow(r))
    : [];
  const existing = [...existingWin, ...sameMeeting];

  // D-65 (TL-12, TL-23): the week's Org62 Events, the ones my rows are tied to wherever they moved, and the CC# key each
  // carries (read from its newest snapshot: the scans read Description for it, never store its text)
  const linkedIds = [...new Set(existing.filter((r) => !ownedRow(r) && r.org62EventRowId).map((r) => r.org62EventRowId!))];
  const o62 = await tx.execute<{ id: string; org62_event_id: string; record_type_name: string; subject: string | null; starts_at: Date; ends_at: Date; duration_field: number | string | null; se_task_type_name: string | null; meeting_type_name: string | null; what_org62_id: string | null; logged_at: Date | string | null; cc_key: string | null }>(sql`
    select e.id, e.org62_event_id, e.record_type_name, e.subject, e.starts_at, e.ends_at, e.duration_field, e.se_task_type_name, e.meeting_type_name, e.what_org62_id,
           coalesce(e.org62_created_at, e.org62_modified_at) as logged_at, si.meta->>'ccKey' as cc_key
      from org62_events e left join source_items si on si.id = e.source_item_id
     where e.owner_user_id = ${userId} and e.deleted_upstream_at is null
       and ((e.starts_at >= ${from.toISOString()}::timestamptz and e.starts_at < ${end.toISOString()}::timestamptz)
            ${linkedIds.length ? sql`or e.id = any(${uuidArr(linkedIds)})` : sql``})`);
  const org62 = o62.rows.map((r) => ({
    rowId: r.id,
    org62EventId: r.org62_event_id,
    recordTypeName: r.record_type_name,
    subject: r.subject,
    startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at),
    durationField: r.duration_field === null ? null : Number(r.duration_field),
    seTaskTypeName: r.se_task_type_name,
    meetingTypeName: r.meeting_type_name,
    whatOrg62Id: r.what_org62_id,
    ownerId: c.me.org62UserId,
    whatName: null as string | null,
    ccKey: r.cc_key && /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(r.cc_key) ? r.cc_key : null,
  }));

  // fixed = the user's rows, and the neighbouring weeks' rows (their own pass owns them; ours must not overlap them)
  const fixed: FixedEntry[] = existing
    .filter((r) => !ownedRow(r) || !inWin(r.startsAt.toISOString()))
    .map((r) => ({
      rowId: r.id,
      dedupeKey: r.dedupeKey,
      subject: r.subject,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      durationHours: Number(r.durationHours),
      seTaskType: r.seTaskTypeId ? (c.vocab.taskTypeById.get(r.seTaskTypeId) ?? null) : null,
      whatOrg62Id: r.whatOrg62Id,
      meetingType: null,
      status: r.status,
      excludedReason: r.excludedReason,
      operation: r.operation,
      targetOrg62EventId: r.targetOrg62EventId,
      flags: r.flags ?? [],
      org62EventRowId: r.org62EventRowId,
      lockedFields: r.userLockedFields ?? [],
    }));
  // D-65 (TL-12): an Event of this week that a row outside this pass is tied to is that row's (never a second row here)
  const fixedIds = new Set(fixed.map((f) => f.rowId));
  const winEventRows = o62.rows.map((r) => r.id);
  const tiedElsewhere = winEventRows.length
    ? (
        await tx.execute<{ id: string; ev: string; dedupe_key: string; status: string; locks: string[] | null }>(sql`
          select a.id, e.org62_event_id as ev, a.dedupe_key, a.status::text as status, a.user_locked_fields as locks
            from activity_entries a join org62_events e on e.id = a.org62_event_row_id
           where a.owner_user_id = ${userId} and a.org62_event_row_id = any(${uuidArr(winEventRows)})
             and a.status in ('approved', 'synced_to_canvas', 'logged', 'verified', 'verify_failed')`)
      ).rows.filter((x) => !fixedIds.has(x.id) && !ownedRow({ dedupeKey: x.dedupe_key, status: x.status, userLockedFields: x.locks } as ActivityRow))
    : [];
  const linkedElsewhere = new Set(tiedElsewhere.map((x) => x.ev));
  const blocksExisting = await store.loadBlockWindow(w, from, end);
  const fixedBlocks = blocksExisting.filter((b) => b.engineVersion !== ENGINE_VERSION && b.countsAsHumanHours).map((b) => ({ startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString() }));

  const names = (id: string) => {
    const o = matcher.oppByOrg62(id);
    // mine: on the team or my DC (a meeting the resolver put on someone else's opp waits for the user's Approve)
    if (o) return { name: o.name, mine: o.onMyTeam || o.myDc };
    const a = matcher.accountByOrg62(id);
    return a ? { name: a.name } : null;
  };
  const held = await store.heldActivityRows(tx, userId);
  const notesByEvent = await meetingNoteFacts(tx, userId, events.filter((e) => e.hasNotes).map((e) => e.rowId));
  const useCases = await vdpUseCases(tx, userId);
  // every quarter's Org62 Events are logged rows (past weeks and History show them; the pages total this quarter's)
  const input: WeekInput = {
    now: w.now.toISOString(),
    from: from.toISOString(),
    to: end.toISOString(),
    cfg: c.cfg,
    mappings: { ...matcher.mappings({ internalDomains: c.rules.internal, partnerDomains: c.rules.partner, ignoreDomains: c.rules.ignore }, { repos, channels: learned.channels }), learned: learned.learned },
    events,
    sessions,
    drive,
    slack,
    emails,
    org62,
    fixed,
    fixedBlocks,
    names,
    context,
    onsiteOverrides: overrides,
    // D-64: "Dismiss all from …" rules, and the rows a canvas item not applied yet holds
    dismissRules: store.readTimeDismissRules(w.kv),
    held,
    // D-66: the rows' notes: the meetings' notes (the cheap model's note, the next step) and the opps' VDP use cases
    meetingNotes: (id) => notesByEvent.get(id) ?? null,
    useCases: (opp) => useCases.get(id15(opp)) ?? [],
    // D-65: the slot rule's "same account" (an opp → its account), and the Events rows of other passes are tied to
    accountOf: (id) => {
      const o = matcher.oppByOrg62(id);
      return o?.accountId ? (matcher.accounts.get(o.accountId)?.org62AccountId ?? null) : null;
    },
    linkedElsewhere,
  };
  const plan = planWeek(input);

  // planWeek returns this week's rows only; neighbours belong to their own pass
  const mine = existing.filter((r) => inWin(r.startsAt.toISOString()));
  // a logged row reached Org62 when its Event was created there (History places it on that day)
  const loggedAt = new Map(o62.rows.map((r) => [r.id, r.logged_at ? iso(r.logged_at) : null]));
  const want: ActivityProjection[] = plan.entries.map((e) => ({ ...toProjection(e, matcher), ...(e.status === 'logged' && e.org62EventRowId && loggedAt.get(e.org62EventRowId) ? { loggedAt: loggedAt.get(e.org62EventRowId)! } : {}) }));
  // an Org62 edit adopted on a verified row (activity.ts ReadbackMove.adopt): its WhatId as the app's opp / account
  const moves = plan.moves.map((mv) => {
    if (!mv.adopt) return mv;
    const what = mv.adopt.whatOrg62Id;
    const opp = what?.startsWith('006') ? matcher.oppByOrg62(what) : null;
    // TL-13: Related To cleared in Org62: no opp, no account (what_kind none, applyActivityWindow)
    const acct = opp?.accountId ? (matcher.accounts.get(opp.accountId) ?? null) : what?.startsWith('001') ? matcher.accountByOrg62(what) : null;
    return { ...mv, adopt: { ...mv.adopt, opportunityId: opp?.id ?? null, accountId: acct?.id ?? null, whatName: opp?.name ?? acct?.name ?? null } };
  });
  // HYG-1: an Event deleted in Org62 (the org62.readback job marks it): the app row it logged or verified says so,
  // `verify_failed` "Deleted in Org62", never silently "verified". Projection-owned mirror rows simply drop out
  // with the Event (it is no longer in `org62` above).
  const gone = await tx.execute<{ id: string; row: string }>(sql`
    select a.id, a.org62_event_row_id as row
      from activity_entries a join org62_events e on e.id = a.org62_event_row_id
     where a.owner_user_id = ${userId} and e.deleted_upstream_at is not null
       and a.status in ('approved', 'synced_to_canvas', 'logged', 'verified', 'verify_failed')
       and a.starts_at >= ${from.toISOString()}::timestamptz and a.starts_at < ${end.toISOString()}::timestamptz`);
  for (const g of gone.rows) {
    const r = mine.find((x) => x.id === g.id);
    if (!r || ownedRow(r) || moves.some((mv) => mv.rowId === g.id)) continue;
    moves.push({ rowId: g.id, status: 'verify_failed', org62EventRowId: g.row, issues: [DELETED_IN_ORG62_ISSUE] });
  }
  return { weekStart, from, end, input, plan, want, moves, mine, sameMeeting, held, blocksExisting, overrides, matcher, org62Ids: new Map(o62.rows.map((r) => [r.id, r.org62_event_id])) };
}

/** One week's pass: plan it and apply the plan (rows, blocks, the onsite record). */
export async function projectWeek(store: ProjectionStore, w: WriteCtx, tx: Tx, weekStart: string, c: WeekCtx, opts: LoadWeekOptions = {}): Promise<{ entries: number; blocks: number }> {
  // one pass per week at a time (the worker's tick, a Settings ▸ Time save's recompute, a Remove's): a second waits here
  // and then reads what the first wrote, instead of inserting the same rows again (unique_violation on the dedupe key)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cc.projections.week|${c.me.userId}|${weekStart}`}))`);
  const { from, end, plan, want, moves, mine, sameMeeting, held, blocksExisting, overrides, matcher } = await loadWeek(store, w, tx, weekStart, c, opts);
  const inWin = (iso: string | null | undefined) => !!iso && Date.parse(iso) >= from.getTime() && Date.parse(iso) < end.getTime();
  // D-66: a row you own still takes the app's newer note until you edit the note, while it waits to be logged
  const noteRefresh = (r: ActivityRow) => NOTE_REFRESH_STATUSES.has(r.status) && !r.syncedToCanvasAt && !held.has(r.id) && !(r.userLockedFields ?? []).includes(NOTE_LOCK);
  // the rows a move may touch: this week's, and my rows of this week's meetings elsewhere (a reschedule, TL-32)
  const a = await store.applyActivityWindow(w, c.vocab, [...mine, ...sameMeeting], want, moves, ownedRow, plan.revives, plan.declined, noteRefresh, { rekeys: plan.rekeys, covers: plan.covers, flags: plan.flagMoves });
  const b = await store.applyBlockWindow(w, blocksExisting.filter((x) => inWin(x.startsAt.toISOString())), plan.blocks, ENGINE_VERSION);
  // the week's onsite days, for the day chips (Time, History) and the read side's attendance (onsite lane)
  const days = plan.onsite.map((d) => ({ ...d, accountName: d.accountKey ? (matcher.accounts.get(d.accountKey)?.name ?? null) : null }));
  const onsiteWrote = await store.writeOnsiteWeek(w, weekStart, overrides, days);
  return { entries: a.inserted + a.updated + a.deleted + a.moved + onsiteWrote, blocks: b.inserted + b.updated + b.deleted };
}
