/**
 * The projections tick (worker hook `projections`, every minute): source items changed since the stored watermark
 * → domain rows, through the idempotent upserts in store/projections.ts.
 *
 *  - Watermark: `user_settings` key `cc.projections` holds the newest `changed_at` processed. Each tick re-reads
 *    from 10 min before it (a scanner transaction that started earlier but committed later is still seen); the
 *    upserts make the overlap free. No watermark (first run, or a new projection version) = everything: so a
 *    worker that was down catches up by itself, and nothing depends on scan internals.
 *  - Stage A, one change set: Org62 → my book (accounts, opps, my team rows) and my Org62 Events; calendar items →
 *    events (+ attendees, cancellations); Claude sessions; Drive files → assets; Gemini notes → meeting notes and
 *    the event's takeaways. When the book changes, recent events / sessions / assets are re-matched.
 *  - Stage B, one change set per affected week: time blocks and activity entries (activity.ts).
 *  - A pass that changes nothing commits nothing (no empty change sets, no audit rows).
 * Logs carry counts and codes only, never titles or bodies (tenet: Local data, privacy-safe logs).
 *
 * The projection layer is pure: every schema read, change set and DataSource write goes through `ProjectionStore`
 * (run.store.ts), which the caller passes in (`projectionStore(db)`, src/server/datasource/db/store/projections.run.ts).
 * Parts: run.entities.ts (Stage A), run.week.ts (Stage B), run.model.ts / run.helpers.ts (types, loaders, helpers).
 */
import { sql } from 'drizzle-orm';

import { COUNTED_STATUSES, DEFAULT_EVIDENCE_CONFIG, diffRows, durationUpdateCandidates, rowsAfter, type EngagedParams, type RederiveRow } from '@/engines/activity';

import { weekOf } from './activity';
import type { Matcher } from './matching';
import { projectEntities, type EntitiesInput } from './run.entities';
import { addDays } from './run.helpers';
import {
  CHANGED_AT, PROJECTIONS_VERSION, SLACK_MS, SOURCES, WEEK_REFRESH_MS, domainRules, errCode, lastWorkItemPass, loadMatcher,
  loadSources, ownedRow, r2, zero, type LoadWeekOptions, type LoadedWeek, type ProjectionOptions, type ProjectionResult,
  type RederiveDay, type RederiveReport,
} from './run.model';
import type { ProjectionStore } from './run.store';
import { loadWeek, projectWeek, weekConfig } from './run.week';
import type { DomainRules } from './types';
import { domainOf, isSfId, localDay, maxIso } from './util';
import { matchWorkItemAccounts } from './work-accounts';

export { PROJECTIONS_VERSION, STATE_KEY, DELETED_IN_ORG62_ISSUE } from './run.model';
export type {
  ProjectionCounts, ProjectionResult, ProjectionOptions, LoadWeekOptions, LoadedWeek, RederiveDay, RederiveReport,
} from './run.model';
export type { ProjectionStore, ProjectionMe } from './run.store';
export { emailDomains, meetingNoteExtKey, fiscalQuarterStart } from './run.helpers';

async function workItemAccountsPass(store: ProjectionStore, userId: string, rules: DomainRules, since: Date | null): Promise<number> {
  const start = (await store.db.execute<{ t: string }>(sql`select now() as t`)).rows[0]!.t;
  const c = await store.db.execute<{ n: number }>(sql`
    select count(*)::int as n from work_items
     where owner_user_id = ${userId} and account_id is null and merged_into_id is null
       and not ('account_id' = any(coalesce(user_locked_fields, '{}')))
       ${since ? sql`and updated_at > ${since.toISOString()}::timestamptz` : sql``}`);
  let n = 0;
  if (c.rows[0]!.n) {
    n =
      (await store.changeSet(userId, 'Projections: work item accounts', async (tx) => {
        const k = await matchWorkItemAccounts(tx, userId, await loadMatcher(tx, userId, rules), { since });
        return { result: k, wrote: k > 0 };
      })) ?? 0;
  }
  lastWorkItemPass.set(userId, new Date(start));
  return n;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export async function runProjections(o: ProjectionOptions): Promise<ProjectionResult> {
  const { store, userId } = o;
  const now = o.now ?? new Date();
  const log = o.log ?? (() => {});
  const written = zero();
  const errors: string[] = [];
  const state = o.full ? null : await store.readState(userId);
  const m = await store.loadMe(userId);
  const { me, packSlug, packRaw } = m;
  const rules = domainRules(me, packSlug, packRaw);
  const extractorId = await store.ensureExtractor();

  const since = state?.watermark ? new Date(Date.parse(state.watermark) - SLACK_MS) : null;
  const changed = await loadSources(
    store.db,
    userId,
    sql`si.source in (${sql.join(SOURCES.map((s) => sql`${s}`), sql`, `)}) and (si.source <> 'slack' or si.from_me)${since ? sql` and ${CHANGED_AT} > ${since.toISOString()}::timestamptz` : sql``}`,
  );
  const refreshDue = !state?.weekRefreshedAt || now.getTime() - Date.parse(state.weekRefreshedAt) >= WEEK_REFRESH_MS;
  const newMark = maxIso(state?.watermark, ...changed.map((c) => c.changedAt));
  const markMoved = !!newMark && (!state?.watermark || Date.parse(newMark) - Date.parse(state.watermark) >= SLACK_MS);
  // items inside the re-read slack were already projected: nothing new unless something changed after the mark
  const fresh = state?.watermark ? changed.filter((c) => c.changedAt > state.watermark!) : changed;
  // ACC-1: new or changed work items get the account their title names, also on a pass with no new source items (a
  // quick capture, an edit). Its own watermark (this process, database clock): a restart sweeps the unmatched once.
  try {
    written.work_item_accounts += await workItemAccountsPass(store, userId, rules, o.full ? null : (lastWorkItemPass.get(userId) ?? null));
  } catch (e) {
    errors.push(`work_item_accounts:${errCode(e)}`);
  }
  if (!fresh.length && !refreshDue && !state?.pendingWeeks?.length) return { skipped: true, changedItems: 0, weeks: [], written, org62EventsWithoutStart: 0, errors };

  const bySource = (s: string) => changed.filter((c) => c.source === s);
  const weeks = new Set<string>();
  const addWeek = (at: string | null | undefined) => {
    if (at && !Number.isNaN(Date.parse(at))) weeks.add(weekOf(at, me.timezone).start);
  };
  const out: EntitiesInput['out'] = { org62WithoutStart: 0, bookSeen: null, missedSeen: 0 };
  let entitiesFailed = false;
  const failedWeeks: string[] = [];

  // ---------------- Stage A: entities
  try {
    await store.changeSet(userId, 'Projections: calendar, deals, sessions, assets', async (tx, cs) => {
      const w = await store.writeCtx(tx, cs, me, now, extractorId);
      const wrote = await projectEntities({ store, w, tx, me, rules, state, now, since, bySource, addWeek, written, out });
      return { result: null, wrote };
    });
  } catch (e) {
    entitiesFailed = true;
    errors.push(`entities:${errCode(e)}`);
    log('projections: entities stage failed', { code: errCode(e) });
    if (process.env.CC_PROJECTIONS_DEBUG === '1') console.error(e);
  }

  // ---------------- Stage B: the Time page, per affected week
  if (refreshDue) addWeek(now.toISOString());
  for (const p of state?.pendingWeeks ?? []) weeks.add(p);
  if (!state) {
    for (let i = 1; i <= 5; i++) addWeek(new Date(now.getTime() - i * 7 * 86_400_000).toISOString());
    addWeek(new Date(now.getTime() + 7 * 86_400_000).toISOString());
  }
  // Onsite corrections (day chips, Mark trip, an Undo of either): the weeks they touch recompute until their stored
  // onsite record carries the corrections' hash.
  for (const ws of await store.onsiteWeeksDue(userId)) weeks.add(ws);
  const weekList = [...weeks].sort();
  const vocab = await store.loadVocab(store.db, userId);
  const cfg = await weekConfig(store, userId, m);
  for (const ws of weekList) {
    try {
      const n = await store.changeSet(userId, `Projections: time, week of ${ws}`, async (tx, cs) => {
        const w = await store.writeCtx(tx, cs, me, now, extractorId);
        const r = await projectWeek(store, w, tx, ws, { me, rules, cfg, vocab });
        return { result: r, wrote: r.entries + r.blocks > 0 };
      });
      if (n) {
        written.activity_entries += n.entries;
        written.time_blocks += n.blocks;
      }
    } catch (e) {
      failedWeeks.push(ws);
      errors.push(`week:${ws}:${errCode(e)}`);
      log('projections: week failed', { week: ws, code: errCode(e) });
      if (process.env.CC_PROJECTIONS_DEBUG === '1') console.error(e);
    }
  }

  // ---------------- state: the mark moves only past what Stage A projected; failed weeks are retried next tick
  const pendingChanged = (state?.pendingWeeks ?? []).join() !== failedWeeks.join();
  if (!entitiesFailed && (fresh.length || markMoved || refreshDue || !state || pendingChanged)) {
    await store.writeState(userId, {
      version: PROJECTIONS_VERSION,
      watermark: newMark ?? state?.watermark ?? null,
      weekRefreshedAt: refreshDue ? now.toISOString() : (state?.weekRefreshedAt ?? null),
      ...(failedWeeks.length ? { pendingWeeks: failedWeeks } : {}),
    });
  }

  const total = Object.values(written).reduce((s, n) => s + n, 0);
  if (total || errors.length) {
    // counts only (tenet: Local data, privacy-safe logs)
    const bs = out.bookSeen;
    const b = bs ? { book_rows: bs.seen, book_expected: bs.expected, book_authoritative: bs.authoritative, book_left: bs.left } : {};
    log('projections', { changed: fresh.length, weeks: weekList.length, ...written, ...b, missed: out.missedSeen, errors: errors.length });
  }
  return { skipped: false, changedItems: fresh.length, weeks: weekList, written, org62EventsWithoutStart: out.org62WithoutStart, book: out.bookSeen, missedFindings: out.missedSeen, errors };
}

/**
 * Recompute the Time weeks of these local days now (an onsite correction from the day chip): the same Stage B pass
 * the tick runs, so the page shows the new rows without waiting for the worker.
 */
export async function recomputeWeeks(o: { store: ProjectionStore; userId: string; days: string[]; now?: Date } & LoadWeekOptions): Promise<{ weeks: string[]; errors: string[] }> {
  const { store, userId } = o;
  const now = o.now ?? new Date();
  const m = await store.loadMe(userId);
  const { me, packSlug, packRaw } = m;
  const rules = domainRules(me, packSlug, packRaw);
  const extractorId = await store.ensureExtractor();
  const vocab = await store.loadVocab(store.db, userId);
  const cfg = await weekConfig(store, userId, m);
  const weeks = [...new Set(o.days.map((d) => weekOf(`${d}T12:00:00Z`, 'UTC').start))].sort();
  const errors: string[] = [];
  for (const ws of weeks) {
    try {
      await store.changeSet(userId, `Projections: time, week of ${ws}`, async (tx, cs) => {
        const w = await store.writeCtx(tx, cs, me, now, extractorId);
        const r = await projectWeek(store, w, tx, ws, { me, rules, cfg, vocab }, o.turnsOf ? { turnsOf: o.turnsOf } : {});
        return { result: r, wrote: r.entries + r.blocks > 0 };
      });
    } catch (e) {
      errors.push(`week:${ws}:${errCode(e)}`);
    }
  }
  return { weeks, errors };
}

/**
 * Re-derive [from, to] (local days), read-only: every week loaded and planned exactly as the week pass does it, inside
 * one READ ONLY transaction, then compared with what Time holds (rederive.ts). Writes nothing; `--apply` is
 * `recomputeWeeks` over the same days (the worker's own pass: it touches only the rows the projections own).
 */
export async function rederiveWeeks(o: { store: ProjectionStore; userId: string; from: string; to: string; now?: Date; engaged?: Partial<EngagedParams> } & LoadWeekOptions): Promise<RederiveReport> {
  const { store, userId } = o;
  const now = o.now ?? new Date();
  const m = await store.loadMe(userId);
  const { me, packSlug, packRaw } = m;
  const rules = domainRules(me, packSlug, packRaw);
  const tz = me.timezone;
  const dayOf = (isoAt: string) => localDay(isoAt, tz);
  const report: RederiveReport = { from: o.from, to: o.to, days: [], totals: { before: 0, after: 0, afterModel: 0 }, added: [], changed: [], removed: [], candidates: [], held: [], errors: [] };
  const weeks: string[] = [];
  for (let d = o.from; d <= o.to && weeks.length < 60; d = addDays(d, 7)) weeks.push(weekOf(`${d}T12:00:00Z`, 'UTC').start);
  const lastWeek = weekOf(`${o.to}T12:00:00Z`, 'UTC').start;
  if (!weeks.includes(lastWeek)) weeks.push(lastWeek);
  const inRange = (isoAt: string) => dayOf(isoAt) >= o.from && dayOf(isoAt) <= o.to;
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  const model = new Map<string, number>();
  const split = new Map<string, RederiveDay['split']>();
  const add = (m: Map<string, number>, day: string, h: number) => m.set(day, (m.get(day) ?? 0) + h);
  await store.readOnly(me, now, async (tx, w) => {
    const vocab = await store.loadVocab(tx, userId);
    // the engaged-time model's calibrated defaults, or the parameters a calibration run tries (`--engaged`)
    const cfg = await weekConfig(store, userId, m, o.engaged ? { ...DEFAULT_EVIDENCE_CONFIG, engaged: o.engaged } : DEFAULT_EVIDENCE_CONFIG);
    for (const ws of weeks) {
      let L: LoadedWeek;
      try {
        L = await loadWeek(store, w, tx, ws, { me, rules, cfg, vocab }, o.turnsOf ? { turnsOf: o.turnsOf } : {});
      } catch (e) {
        report.errors.push(`week:${ws}:${errCode(e)}`);
        continue;
      }
      const vocabName = (id: string | null) => (id ? (vocab.taskTypeById.get(id) ?? null) : null);
      const existing: (RederiveRow & { owned: boolean })[] = L.mine
        .filter((r) => r.operation === 'create')
        .map((r) => ({ id: r.id, dedupeKey: r.dedupeKey, startsAt: r.startsAt.toISOString(), durationHours: Number(r.durationHours), status: r.status, seTaskType: vocabName(r.seTaskTypeId), whatOrg62Id: r.whatOrg62Id, subject: r.subject, owned: ownedRow(r) }));
      const want: RederiveRow[] = L.want.map((a) => ({ dedupeKey: a.dedupeKey, startsAt: a.startsAt, durationHours: a.durationHours, status: a.status, seTaskType: a.seTaskType, whatOrg62Id: a.whatOrg62Id, subject: a.subject }));
      const owned = (r: RederiveRow) => (r as RederiveRow & { owned?: boolean }).owned === true;
      const diff = diffRows(existing, want, owned);
      report.added.push(...diff.added.filter((r) => inRange(r.startsAt)).map((r) => ({ ...r, week: ws })));
      report.changed.push(...diff.changed.filter((c) => inRange(c.to.startsAt)).map((c) => ({ ...c, week: ws })));
      report.removed.push(...diff.removed.filter((r) => inRange(r.startsAt)).map((r) => ({ ...r, week: ws })));
      for (const r of existing) if (inRange(r.startsAt) && COUNTED_STATUSES.has(r.status)) add(before, dayOf(r.startsAt), r.durationHours);
      const afterRows = rowsAfter(existing, want, owned).filter((r) => inRange(r.startsAt) && COUNTED_STATUSES.has(r.status));
      for (const r of afterRows) {
        const day = dayOf(r.startsAt);
        add(after, day, r.durationHours);
        add(model, day, r.durationHours);
        const sp = split.get(day) ?? { meetings: 0, solo: 0, travel: 0, onsite: 0, org62: 0, internal: 0 };
        split.set(day, sp);
        const k = r.dedupeKey;
        if (k.startsWith('org62|')) sp.org62 += r.durationHours;
        else if (k.startsWith('onsite|')) sp.onsite += r.durationHours;
        else if (k.startsWith('wb|')) sp.solo += r.durationHours;
        else if (r.seTaskType === 'Travel') sp.travel += r.durationHours;
        else sp.meetings += r.durationHours;
        const wantRow = L.want.find((x) => x.dedupeKey === k);
        if (wantRow && !wantRow.whatOrg62Id && !wantRow.customerRelated && !wantRow.customerFacing) sp.internal += r.durationHours;
      }
      const fixed = L.input.fixed.map((f) => ({ rowId: f.rowId, dedupeKey: f.dedupeKey, status: f.status, durationHours: f.durationHours, org62EventId: f.org62EventRowId ? (L.org62Ids.get(f.org62EventRowId) ?? null) : null, lockedFields: f.lockedFields ?? [] }));
      const { candidates, held } = durationUpdateCandidates(fixed, L.plan.shadowed);
      const startOf = new Map(L.input.fixed.map((f) => [f.rowId, f.startsAt]));
      for (const c of [...candidates, ...held]) {
        const s0 = startOf.get(c.activityEntryId);
        if (!s0 || !inRange(s0)) continue;
        add(model, dayOf(s0), c.to - c.from);
        const sp = split.get(dayOf(s0));
        if (sp) sp.solo += c.to - c.from;
      }
      report.candidates.push(...candidates.filter((c) => inRange(startOf.get(c.activityEntryId) ?? '')));
      report.held.push(...held.filter((c) => inRange(startOf.get(c.activityEntryId) ?? '')));
    }
  });
  for (let d = o.from; d <= o.to; d = addDays(d, 1)) {
    const sp = split.get(d) ?? { meetings: 0, solo: 0, travel: 0, onsite: 0, org62: 0, internal: 0 };
    const day: RederiveDay = { day: d, before: r2(before.get(d) ?? 0), after: r2(after.get(d) ?? 0), afterModel: r2(model.get(d) ?? 0), split: { meetings: r2(sp.meetings), solo: r2(sp.solo), travel: r2(sp.travel), onsite: r2(sp.onsite), org62: r2(sp.org62), internal: r2(sp.internal) } };
    report.days.push(day);
    report.totals.before += day.before;
    report.totals.after += day.after;
    report.totals.afterModel += day.afterModel;
  }
  report.totals = { before: r2(report.totals.before), after: r2(report.totals.after), afterModel: r2(report.totals.afterModel) };
  return report;
}

export { isSfId };

/**
 * The projections' account matcher (names, aliases, short names, learned meeting domains) for other deterministic
 * passes: the VDP asset matcher (src/server/datasource/db/store/vdp-assets.ts) resolves new files and links with it.
 */
export async function accountMatcher(store: ProjectionStore, userId: string): Promise<{ matcher: Matcher; rules: DomainRules; myDomain: string | null }> {
  const { me, packSlug, packRaw } = await store.loadMe(userId);
  const rules = domainRules(me, packSlug, packRaw);
  return { matcher: await loadMatcher(store.db, userId, rules), rules, myDomain: domainOf(me.email) };
}
