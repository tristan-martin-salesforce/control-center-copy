/**
 * Stage A of the projections tick (run.ts), one change set: Org62 → my book (accounts, opps, my team rows, my DCs) and
 * my Org62 Events, missed opportunities; calendar items → events (+ attendees, cancellations); Claude sessions; Drive
 * files → assets; Gemini notes → meeting notes and the event's takeaways; work items → the account their title names.
 * Every write goes through the store (run.store.ts); the raw reads are `sql` over the change set's `tx`.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import type { WriteCtx } from '@/server/datasource/db/store/common';

import { assetsFromDrive, assetsFromEvents, driveEdit, mergeAssets, projectGeminiNote } from './assets';
import { calendarKey, isGone, projectCalendarEvent, resolveCalendarItems } from './calendar';
import { missedOpps } from './missed';
import { missedSlackEvidence } from './missed-slack';
import { oppsInBook, projectOrg62 } from './org62';
import { addDays, addMonths, emailDirectory, fiscalQuarterStart, missedEvidence, workItemsByFile, workItemsFromSource } from './run.helpers';
import { REMATCH_AHEAD_DAYS, REMATCH_BACK_DAYS, iso, loadMatcher, loadSources, mappingOf, type ProjectionCounts, type ProjectionResult, type State } from './run.model';
import type { ProjectionStore } from './run.store';
import { humanTurnsOf, projectClaudeSession, sessionDeepLink } from './sessions';
import type { DomainRules, Me, ProjectedEvent, SourceRow } from './types';
import { id15, isSfId, localDay, org62RecordUrl } from './util';
import { matchWorkItemAccounts } from './work-accounts';

export interface EntitiesInput {
  store: ProjectionStore;
  w: WriteCtx;
  tx: Tx;
  me: Me;
  rules: DomainRules;
  state: State | null;
  now: Date;
  /** The re-read start (watermark minus the slack), or null on a full pass. */
  since: Date | null;
  bySource: (s: string) => SourceRow[];
  addWeek: (at: string | null | undefined) => void;
  written: ProjectionCounts;
  /** What the pass saw, for the result and the log line. */
  out: { org62WithoutStart: number; bookSeen: ProjectionResult['book']; missedSeen: number };
}

/** Returns whether anything was written (the change set commits only then). */
export async function projectEntities(i: EntitiesInput): Promise<boolean> {
  const { store, w, tx, me, rules, state, now, since, bySource, addWeek, written, out } = i;
  const userId = me.userId;
  let wrote = false;
  let bookChanged = false;

  // Org62 → my book and my Events (a full recompute over every Org62 snapshot: the book is an aggregate)
  if (bySource('org62').length || !state) {
    const all = await loadSources(tx, userId, sql`si.source = 'org62'`);
    const book = projectOrg62(all, { me: me.org62UserId }); // DC-13: a DC another SE holds now is not mine
    out.org62WithoutStart = book.eventsWithoutStart;
    out.bookSeen = book.bookRead ? { ...book.bookRead, openTeamOpps: book.opps.filter((o) => o.inBook).length, left: book.opps.filter((o) => o.leftBookAt).length } : null;
    const inBook = oppsInBook(book);
    const hours = new Map<string, number>(); // org62 opp/account id (15) → my logged hours this quarter
    const qStart = fiscalQuarterStart(now, me.timezone);
    for (const e of book.events) {
      if (!e.whatOrg62Id || localDay(e.startsAt, me.timezone) < qStart) continue;
      const h = e.durationField ?? (Date.parse(e.endsAt) - Date.parse(e.startsAt)) / 3_600_000;
      hours.set(id15(e.whatOrg62Id), (hours.get(id15(e.whatOrg62Id)) ?? 0) + h);
    }
    const acctIds = new Map<string, string>();
    for (const a of book.accounts) {
      const opps = inBook.filter((x) => id15(x.org62AccountId) === id15(a.org62AccountId));
      // DEALS-1: the DC status is about my open opps (team, DC, or my hours), not every opp on the account.
      const open = opps.filter((x) => !x.isClosed && (x.onMyTeam || x.myDc || x.inBook || (x.sweep?.hours ?? 0) > 0 || (hours.get(id15(x.org62OpportunityId)) ?? 0) > 0));
      const dcOpen = open.filter((x) => x.myDc).length;
      const acctHours = opps.reduce((s, x) => s + (hours.get(id15(x.org62OpportunityId)) ?? 0), hours.get(id15(a.org62AccountId)) ?? 0);
      const r = await store.upsertAccountFromOrg62(
        w,
        {
          org62AccountId: a.org62AccountId,
          name: a.name,
          ext: { org62Url: org62RecordUrl('Account', a.org62AccountId), dcStatus: !open.length || !dcOpen ? 'none' : dcOpen === open.length ? 'assigned' : 'partial', hoursQtd: Math.round(acctHours * 100) / 100 },
        },
        store.uuidFor(`proj:account:${userId}:${a.org62AccountId}`),
      );
      acctIds.set(id15(a.org62AccountId), r.id);
      if (r.written) {
        written.accounts++;
        bookChanged = true;
      }
    }
    // Opps that left my book (the complete daily book read no longer lists them) are marked, never deleted;
    // one whose account is no longer in my book is only marked when it already has a row.
    const projectedIds = new Set(inBook.map((o) => id15(o.org62OpportunityId)));
    const leftOut = book.opps.filter((o) => (o.leftBookAt || o.notInBookAt) && !projectedIds.has(id15(o.org62OpportunityId)));
    const leftRows = leftOut.length
      ? new Set(
          (
            await tx.execute<{ org62: string }>(sql`
              select org62_opportunity_id as org62 from opportunities
               where owner_user_id = ${userId} and on_my_team and org62_opportunity_id in (${sql.join(leftOut.map((o) => sql`${o.org62OpportunityId}`), sql`, `)})`)
          ).rows.map((x) => id15(x.org62)),
        )
      : new Set<string>();
    const oppIds = new Map<string, string>(); // org62 opp id (15) → app opportunity id
    for (const op of [...inBook, ...leftOut.filter((o) => leftRows.has(id15(o.org62OpportunityId)))]) {
      const r = await store.upsertOpportunityFromOrg62(
        w,
        {
          org62OpportunityId: op.org62OpportunityId,
          accountId: op.org62AccountId ? (acctIds.get(id15(op.org62AccountId)) ?? null) : null,
          name: op.name,
          stage: op.stage,
          amount: op.amount,
          closeDate: op.closeDate,
          forecastCategory: op.forecastCategory,
          type: op.type,
          isClosed: op.isClosed,
          isWon: op.isWon,
          // holding a DC is not being on the team (myDc / ext.dcAssigned and deal_contributions say that)
          onMyTeam: !op.leftBookAt && op.onMyTeam,
          teamKnown: op.teamKnown,
          myTeamRole: op.myTeamRole,
          org62ModifiedAt: op.org62ModifiedAt,
          ext: { dcAssigned: op.myDc, nextStep: op.nextStep, nextStepRead: op.nextStepRead, org62Url: org62RecordUrl('Opportunity', op.org62OpportunityId), hoursQtd: Math.round((hours.get(id15(op.org62OpportunityId)) ?? 0) * 100) / 100 },
          leftBookAt: op.leftBookAt,
          notInBookAt: op.notInBookAt,
        },
        store.uuidFor(`proj:opportunity:${userId}:${op.org62OpportunityId}`),
      );
      oppIds.set(id15(op.org62OpportunityId), r.id);
      if (op.myTeamRole && me.org62UserId && op.onMyTeam && !op.leftBookAt && !op.notInBookAt) await store.upsertMyTeamMembership(w, r.id, me.org62UserId, op.myTeamRole);
      if (r.written) {
        written.opportunities++;
        bookChanged = true;
      }
    }
    // My DCs (split, role) into deal_contributions, and the DC requests they confirm (Deals ▸ DCs). A DC on an opp
    // this pass did not project (its account is outside the book read, or it was stored by another read) links to
    // the opp row the app already has for that Org62 id (15 characters), so `myDc` shows its split on that opp
    // instead of "assigned, split not read" (PROJECTIONS_VERSION 6 re-links the DCs already stored).
    const unlinked = [...new Set(book.dcs.map((d) => (d.org62OpportunityId ? id15(d.org62OpportunityId) : null)).filter((k): k is string => !!k && !oppIds.has(k)))];
    if (unlinked.length) {
      const rows = await tx.execute<{ id: string; org62: string }>(sql`
        select id, org62_opportunity_id as org62 from opportunities
         where owner_user_id = ${userId} and archived_at is null and left(org62_opportunity_id, 15) in (${sql.join(unlinked.map((k) => sql`${k}`), sql`, `)})
         order by created_at, id`);
      for (const r of rows.rows) if (!oppIds.has(id15(r.org62))) oppIds.set(id15(r.org62), r.id);
    }
    const dcRows = await store.syncMyDcs(
      w,
      book.dcs.map((d) => ({ org62DcId: d.org62DcId, opportunityId: d.org62OpportunityId ? (oppIds.get(id15(d.org62OpportunityId)) ?? null) : null, role: d.role, splitPercent: d.splitPercent, seenAt: d.seenAt, sourceItemId: d.sourceItemId })),
      me.org62UserId ?? null,
      { book }, // D-68: the complete read, the accounts that left the book or were merged
    );
    if (dcRows) {
      written.deal_contributions += dcRows;
      wrote = true;
    }
    wrote ||= bookChanged;
    const matcher0 = await loadMatcher(tx, userId, rules);
    // D-65 (TL-13): a snapshot the runner recorded (REC-2 `rec: auto`: every field, a blank one as null) says what
    // Org62 has now, also a Related To cleared there (the merge across snapshots would bring an older WhatId back)
    const snapById = new Map(all.map((s) => [s.id, s.meta] as const));
    for (const e of book.events) {
      const snap = snapById.get(e.sourceItemId);
      if (snap?.rec === 'auto' && 'WhatId' in snap && !isSfId(snap.WhatId)) {
        e.whatOrg62Id = null;
        e.whatName = null;
      }
    }
    for (const e of book.events) {
      const opp = matcher0.oppByOrg62(e.whatOrg62Id);
      const acct = opp?.accountId ?? matcher0.accountByOrg62(e.whatOrg62Id)?.id ?? null;
      const r = await store.upsertOrg62Event(w, { ...e, opportunityId: opp?.id ?? null, accountId: acct });
      if (r.written) {
        written.org62_events++;
        wrote = true;
        addWeek(e.startsAt);
      }
    }
    // Logged rows are kept for every quarter (past weeks and History show them; the pages total only this
    // quarter's). Weeks of Org62 Events with no logged row yet (an older pass skipped other quarters) get a pass.
    const unlogged = await tx.execute<{ s: Date | string }>(sql`
      select e.starts_at as s from org62_events e
       where e.owner_user_id = ${userId} and e.deleted_upstream_at is null
         and not exists (select 1 from activity_entries a where a.owner_user_id = e.owner_user_id and a.org62_event_row_id = e.id)`);
    for (const x of unlogged.rows) addWeek(iso(x.s));
    // Drift: a verified row whose opp no longer matches its Org62 Event gets a pass, so it follows Org62
    for (const s0 of await store.driftedLoggedRowStarts(tx, userId)) addWeek(s0);
    // D-65: a row on a live Org62 Event that an older rule hid as overlap gets a pass, so it shows (flagged) again
    for (const s0 of await store.hiddenOrg62RowStarts(tx, userId)) addWeek(s0);
    // HYG-1: a row still verified or logged on an Event deleted in Org62 gets a pass, so it says "Deleted in Org62"
    const gone = await tx.execute<{ s: Date | string }>(sql`
      select distinct a.starts_at as s from activity_entries a join org62_events e on e.id = a.org62_event_row_id
       where a.owner_user_id = ${userId} and e.deleted_upstream_at is not null and a.status in ('approved', 'synced_to_canvas', 'logged', 'verified')`);
    for (const x of gone.rows) addWeek(iso(x.s));

    // Missed opportunities (Deals ▸ Missed): the deals engine over the stored Org62 data. Read only: claiming
    // and dismissing stay the user's (drafts and dry runs, invariant 1).
    if (me.org62UserId) {
      const res = missedOpps({
        book,
        me: { org62UserId: me.org62UserId, name: me.name },
        evidence: { ...(await missedEvidence(tx, userId, now)), slack: await missedSlackEvidence(tx, userId, now) }, // DC-33
        today: localDay(now.toISOString(), me.timezone),
        quarter: { start: qStart, end: addDays(addMonths(qStart, 3), -1) },
      });
      const n = await store.writeMissedFindings(w, res, book);
      out.missedSeen = res.findings.length;
      if (n) {
        written.missed_findings += n;
        wrote = true;
      }
    }
  }

  const matcher = await loadMatcher(tx, userId, rules);
  const windowFrom = new Date(now.getTime() - REMATCH_BACK_DAYS * 86_400_000).toISOString();
  const windowTo = new Date(now.getTime() + REMATCH_AHEAD_DAYS * 86_400_000).toISOString();

  // Calendar → events (all of an event's items, so a cancellation marker and the event row are weighed together)
  const calKeys = new Set(bySource('calendar').map((si) => calendarKey(si)?.externalEventId).filter((x): x is string => !!x));
  const calItems = bookChanged || !state
    ? await loadSources(tx, userId, sql`si.source = 'calendar' and si.occurred_at between ${windowFrom}::timestamptz - interval '1 day' and ${windowTo}::timestamptz`)
    : calKeys.size
      ? await loadSources(tx, userId, sql`si.source = 'calendar' and (si.meta->>'eventId' in (${sql.join([...calKeys].map((k) => sql`${k}`), sql`, `)}) or si.external_id in (${sql.join([...calKeys].map((k) => sql`${k}`), sql`, `)}))`)
      : [];
  const projected: ProjectedEvent[] = [];
  const eventIds = new Map<string, string>(); // externalEventId → row id
  const personByEmail = await emailDirectory(tx, userId);
  for (const [, r] of resolveCalendarItems(calItems)) {
    const key = calendarKey((r.event ?? r.cancelled)!)!;
    const gone = isGone(r);
    if (gone && (!!r.event?.deletedUpstreamAt || !r.event)) {
      // deleted at the source, or a marker for an event we never saw: flag the row we have, if any
      if (await store.markCalendarEventGone(w, key.calendarId, key.externalEventId, r.event?.deletedUpstreamAt ? 'deleted' : 'cancelled')) {
        written.cancelled_events++;
        wrote = true;
      }
      addWeek(r.event?.occurredAt ?? (r.cancelled?.meta.start as string | undefined));
      continue;
    }
    const projectedEv = projectCalendarEvent(r.event!, me, rules);
    if (!projectedEv) continue;
    // cancelled upstream: the event stays, as cancelled (Today labels it; it never blocks time)
    const ev: ProjectedEvent = gone ? { ...projectedEv, status: 'cancelled' } : projectedEv;
    if (!gone) projected.push(ev);
    const match = matcher.resolve(ev.title, ev.externalDomains);
    const up = await store.upsertCalendarEventFromSource(
      w,
      {
        ...ev,
        ...mappingOf(match),
        attendees: ev.attendees.map((a) => ({ ...a, personId: personByEmail.get(a.email) ?? (a.isSelf ? me.personId : null), displayName: null })),
      },
      store.uuidFor(`proj:calendar_event:${userId}:${ev.calendarId}:${ev.externalEventId}`),
    );
    eventIds.set(ev.externalEventId, up.id);
    if (up.written) {
      if (gone) written.cancelled_events++;
      else written.calendar_events++;
      wrote = true;
      addWeek(ev.startsAt);
    }
  }

  // Claude sessions
  const sessItems = bookChanged || !state ? await loadSources(tx, userId, sql`si.source = 'claude'`) : bySource('claude');
  for (const si of sessItems) {
    const s = projectClaudeSession(si);
    if (!s) continue;
    const match = matcher.resolve([s.repo, s.cwd ? s.cwd.split('/').slice(-3).join(' ') : null, s.gitBranch, s.title].filter(Boolean).join(' '));
    const up = await store.upsertSessionFromSource(w, { ...s, ...mappingOf(match), deepLink: sessionDeepLink(s) }, store.uuidFor(`proj:claude_session:${userId}:${s.sessionExternalId}`));
    if (up.written) {
      written.claude_sessions++;
      wrote = true;
      addWeek(s.lastActivityAt);
      addWeek(s.startedAt);
    }
    // its prompts (engaged time, 2026-11-14): every week they fall in recomputes, also when only they changed
    for (const t of humanTurnsOf(si.meta)) addWeek(t.at);
  }

  // Drive files → assets (all revisions of every changed file, plus invite attachments)
  const driveChanged = bookChanged || !state ? await loadSources(tx, userId, sql`si.source = 'drive'`) : bySource('drive');
  const fileIds = [...new Set(driveChanged.map((si) => driveEdit(si)?.fileId).filter((x): x is string => !!x))];
  const driveAll = fileIds.length && state && !bookChanged ? await loadSources(tx, userId, sql`si.source = 'drive' and si.meta->>'fileId' in (${sql.join(fileIds.map((f) => sql`${f}`), sql`, `)})`) : driveChanged;
  for (const si of driveChanged) {
    const e = driveEdit(si);
    if (e?.byMe) addWeek(e.at);
  }
  const assetList = mergeAssets(assetsFromDrive(driveAll), assetsFromEvents(projected));
  const workByFile = await workItemsByFile(tx, userId, assetList.map((a) => a.externalId));
  for (const a of assetList) {
    const evRow = a.eventExternalId ? eventIds.get(a.eventExternalId) : undefined;
    const evMatch = evRow ? await store.eventMapping(tx, evRow) : null;
    const match = matcher.resolve(a.title) ?? (evMatch?.accountId ? { accountId: evMatch.accountId, oppId: evMatch.opportunityId, via: 'title' as const, confidence: 0.6 } : null);
    const up = await store.upsertDriveAsset(w, { ...a, ...mappingOf(match), workItemIds: workByFile.get(a.externalId) ?? [] }, store.uuidFor(`proj:asset:${userId}:drive:${a.externalId}`));
    if (up.written) {
      written.assets++;
      wrote = true;
    }
  }

  // Gemini notes → meeting notes + the event's takeaways
  const noteItems = state && !bookChanged ? bySource('gemini_notes') : await loadSources(tx, userId, sql`si.source = 'gemini_notes'`);
  for (const si of noteItems) {
    const n = projectGeminiNote(si);
    if (!n) continue;
    const eventId = n.eventExternalId ? (eventIds.get(n.eventExternalId) ?? (await store.eventRowId(tx, userId, n.eventExternalId))) : null;
    const up = await store.upsertMeetingNote(w, { ...n, calendarEventId: eventId });
    if (up.written) {
      written.meeting_notes++;
      wrote = true;
    }
    if (eventId) {
      const items = await workItemsFromSource(tx, si.id);
      if (await store.setEventTakeaways(w, eventId, { count: items.length, workItemIds: items, notesUrl: n.url })) wrote = true;
      addWeek(si.occurredAt);
    }
  }

  // Work items → the account their title names (ACC-1): new or changed items, and all of them when the book changed.
  const named = await matchWorkItemAccounts(tx, userId, matcher, { since: bookChanged || !state ? null : since });
  if (named) {
    written.work_item_accounts += named;
    wrote = true;
  }

  for (const si of bySource('slack')) addWeek(si.occurredAt);
  return wrote;
}
