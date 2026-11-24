/**
 * Use-case candidates on Postgres (src/engines/use-cases; holistic review 2026-11-20 lane 06 R6). The mock's twin is
 * src/server/datasource/mock/use-cases.ts.
 *
 *   sources     source_items of the last 21 days with a customer counterpart: Gemini notes (their meeting's opp as
 *               the explicit link), calendar events (title + description), Slack threads (a mapped or shared channel,
 *               or an author outside my domain), Gmail threads (an external participant, not bulk)
 *   existing    use_cases, org62_use_cases (by opp) and the VDP mirror's use cases, for dedupe
 *   extract     runUseCaseExtract (the `use_cases.extract` job): mentions → (the model for the unsure ones, injected by
 *               the job) → planCandidates → rows; then the landing sweep (staged ones the reads found)
 *   decide      Accept / Edit / Reject in ONE change set: the row, the VDP create_use_case Outbox item (Accept), and
 *               the learned rules + attribution_outcomes row a pick or a wrong-opp reject writes. Undo reverts all.
 *   canvas      pendingCandidateCreates: the Org62 rows the next logging canvas carries (log-batch's one call)
 * Writes go through change sets (the table is audited). Logs carry ids and counts, never text.
 */
import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { attributionSettingsOf, type AddUseCaseCandidateRequest, type AddUseCaseCandidateResult, type DecideUseCaseCandidateRequest, type DecideUseCaseCandidateResult, type RefreshUseCaseCandidatesResult, type UseCaseCandidatesPayload } from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import type { Db, DbOrTx, Tx } from '@/db/client';
import { enqueueJob } from '@/db/queue';
import { useCaseCandidates } from '@/db/schema';
import { localDay, weekStart } from '@/engines/activity/time';
import { planLearning } from '@/engines/attribution/rules';
import { totalsByOpp, type OppTotals } from '@/engines/attribution/engagement';
import { worldOfContract } from '@/engines/attribution/row';
import type { World } from '@/engines/attribution/types';
import type { UseCaseCreate, UseCaseHolds } from '@/engines/activity/use-cases';
import { oppIdsOf } from '@/lib/vdp/types';
import { DecideError, decideCandidate, landingOf, pendingCandidateCreates, stagePlanOf, withoutCandidateDuplicates, type CanvasOpp } from '@/engines/use-cases/stage';
import { attributeMention, findMatch, planCandidates, signalOf } from '@/engines/use-cases/plan';
import { candidatesPayload, candidateView } from '@/engines/use-cases/view';
import { mentionsOf } from '@/engines/use-cases/mentions';
import { productVocabulary } from '@/engines/use-cases/vocab';
import { dedupeKeyOf } from '@/engines/use-cases/similar';
import type { UcCandidateRow, UcExisting, UcMention, UcSource } from '@/engines/use-cases/types';
import { featureActive, personaOf } from '@/personas';
import { AppError, invalid, notFound } from '@/server/errors';

import { contextOf, loadEngagement, loadRowExtras, loadRules, recordOutcome, writeRuleChanges } from './attribution';
import { putKv } from './ext';
import { loadModel, type ReadModel } from './model';
import { everything } from './reads/scope';
import type { WriteCtx } from './store/common';
import { loadOrg62UseCases, loadUcOpps, loadUcVdps, loadUseCaseHolds } from './store/use-cases';

export const USE_CASES_EXTRACT_JOB = 'use_cases.extract';
export const USE_CASES_QUEUE = 'maintenance';
export const USE_CASES_ENGINE = 'use-cases@1';
/** kv: when the sources were last read for use cases (and what the pass found, counts only). */
export const USE_CASES_KV = 'cc.use_cases.extract';
export const LOOKBACK_DAYS = 21;

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const id15 = (s: string | null | undefined) => (s ?? '').slice(0, 15);
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type Row = typeof useCaseCandidates.$inferSelect;

const rowOf = (r: Row): UcCandidateRow => ({
  id: r.id,
  source: r.source as UcCandidateRow['source'],
  sourceKey: r.sourceKey,
  title: r.title,
  problem: r.problem,
  products: r.products,
  outcome: r.outcome,
  track: (r.track as UcCandidateRow['track']) ?? null,
  stageHint: r.stageHint,
  status: r.status as UcCandidateRow['status'],
  rejectReason: (r.rejectReason as UcCandidateRow['rejectReason']) ?? null,
  accountId: r.accountId,
  oppId: r.opportunityId,
  confidence: num(r.confidence),
  why: r.why,
  needsPick: r.needsPick,
  alternates: r.alternates,
  basis: r.basis === 'ai' ? 'ai' : 'rules',
  dedupeKey: r.dedupeKey,
  problemKey: r.problemKey,
  evidence: r.evidence,
  signal: r.signal ?? null,
  matchedKind: (r.matchedKind as UcCandidateRow['matchedKind']) ?? null,
  useCaseId: r.useCaseId,
  org62UseCaseId: r.org62UseCaseId,
  vdpUseCaseId: r.vdpUseCaseId,
  vdpSlug: r.vdpSlug,
  vdpDraftId: r.vdpDraftId,
  createdAt: iso(r.createdAt)!,
  decidedAt: iso(r.decidedAt),
  updatedAt: iso(r.updatedAt)!,
});

const columnsOf = (c: UcCandidateRow) => ({
  source: c.source,
  sourceKey: c.sourceKey,
  accountId: c.accountId,
  opportunityId: c.oppId,
  confidence: String(Math.max(0, Math.min(1, c.confidence))),
  why: c.why,
  needsPick: c.needsPick,
  alternates: c.alternates,
  title: c.title,
  problem: c.problem,
  products: c.products,
  outcome: c.outcome,
  track: c.track,
  stageHint: c.stageHint,
  status: c.status,
  rejectReason: c.rejectReason,
  basis: c.basis,
  dedupeKey: c.dedupeKey,
  problemKey: c.problemKey,
  evidence: c.evidence,
  signal: c.signal,
  matchedKind: c.matchedKind,
  useCaseId: c.useCaseId,
  org62UseCaseId: c.org62UseCaseId,
  vdpUseCaseId: c.vdpUseCaseId,
  vdpSlug: c.vdpSlug,
  vdpDraftId: c.vdpDraftId,
  decidedAt: c.decidedAt ? new Date(c.decidedAt) : null,
  updatedAt: new Date(c.updatedAt),
});

export async function loadCandidates(db: DbOrTx, userId: string): Promise<UcCandidateRow[]> {
  const rows = await db.select().from(useCaseCandidates).where(eq(useCaseCandidates.ownerUserId, userId));
  return rows.map(rowOf);
}

/** Insert a new candidate (a dedupe-key twin that slipped in is left as it is). */
export async function insertCandidate(tx: Tx, userId: string, c: UcCandidateRow): Promise<void> {
  await tx
    .insert(useCaseCandidates)
    .values({ id: c.id, ownerUserId: userId, ...columnsOf(c), createdAt: new Date(c.createdAt) })
    .onConflictDoNothing();
}

export async function updateCandidate(tx: Tx, userId: string, c: UcCandidateRow): Promise<void> {
  await tx.update(useCaseCandidates).set(columnsOf(c)).where(and(eq(useCaseCandidates.id, c.id), eq(useCaseCandidates.ownerUserId, userId)));
}

// ---------------------------------------------------------------------------
// Sources and what exists
// ---------------------------------------------------------------------------

interface SiRow extends Record<string, unknown> {
  id: string;
  source: string;
  title: string | null;
  body: string | null;
  url: string | null;
  occurred_at: Date | string;
  meta: Record<string, unknown> | null;
  ev_opp: string | null;
  ev_account: string | null;
  ev_domains: string[] | null;
  rid: string | null;
}

const emailsOf = (xs: unknown): Array<{ email: string; isExternal?: boolean }> => (Array.isArray(xs) ? xs.filter((p): p is { email: string; isExternal?: boolean } => !!p && typeof (p as { email?: unknown }).email === 'string') : []);
const domainOf = (e: string) => e.split('@')[1]?.toLowerCase() ?? '';

/** The sources of the last LOOKBACK_DAYS days that have a customer counterpart (the extractor drops the rest too). */
export async function loadUcSources(db: DbOrTx, userId: string, now: Date, myDomain: string | null): Promise<UcSource[]> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const r = await db.execute<SiRow>(sql`
    select si.id, si.source::text as source, si.title, si.body, si.url, si.occurred_at, si.meta,
           coalesce(e.opportunity_id, ne.opportunity_id)::text as ev_opp, coalesce(e.account_id, ne.account_id)::text as ev_account,
           coalesce(e.external_domains, ne.external_domains) as ev_domains, coalesce(e.recurring_event_id, ne.recurring_event_id) as rid
      from source_items si
      left join calendar_events e on e.source_item_id = si.id
      left join meeting_notes n on n.source_item_id = si.id
      left join calendar_events ne on ne.id = n.calendar_event_id
     where si.owner_user_id = ${userId} and si.deleted_upstream_at is null and si.occurred_at >= ${since}::timestamptz and si.occurred_at <= ${now.toISOString()}::timestamptz
       and si.source::text in ('gemini_notes', 'calendar', 'slack', 'gmail') and si.body is not null
     order by si.occurred_at`);
  const channelMaps = await db.execute<{ external_id: string; name: string | null; account_id: string | null; opportunity_id: string | null }>(sql`
    select c.external_id, c.name, m.account_id::text as account_id, m.opportunity_id::text as opportunity_id
      from channels c join channel_account_maps m on m.channel_id = c.id and m.user_verdict is distinct from 'rejected'
     where c.owner_user_id = ${userId}`);
  const mapped = new Map(channelMaps.rows.map((c) => [c.external_id, c] as const));
  const external = (emails: string[]) => emails.filter((e) => !!myDomain && domainOf(e) !== myDomain);
  const out: UcSource[] = [];
  const threads = new Map<string, { kind: 'slack_burst' | 'mail_thread'; rows: SiRow[] }>();
  for (const x of r.rows) {
    const meta = x.meta ?? {};
    const at = iso(x.occurred_at)!;
    if (x.source === 'gemini_notes' || x.source === 'calendar') {
      const people = emailsOf(meta.participants ?? meta.attendees);
      const ext = people.filter((p) => p.isExternal === true || (p.isExternal === undefined && external([p.email]).length)).map((p) => p.email.toLowerCase());
      const domains = [...new Set([...(x.ev_domains ?? []), ...ext.map(domainOf)])].filter(Boolean);
      out.push({ kind: x.source === 'calendar' ? 'meeting' : 'gemini_note', key: x.id, sourceItemIds: [x.id], title: (x.title ?? '').replace(/\s+-\s+Notes by Gemini$/i, '').slice(0, 200), text: x.body ?? '', at, url: x.url, externalEmails: ext, externalDomains: domains, seriesId: x.rid, explicit: x.ev_opp || x.ev_account ? { oppIds: x.ev_opp ? [x.ev_opp] : [], accountIds: x.ev_account ? [x.ev_account] : [], via: 'The meeting' } : null });
      continue;
    }
    if (meta.bulk === true) continue;
    const ref = typeof meta.threadRef === 'string' ? meta.threadRef : `${x.source}:${x.id}`;
    const t = threads.get(ref) ?? { kind: x.source === 'slack' ? ('slack_burst' as const) : ('mail_thread' as const), rows: [] };
    t.rows.push(x);
    threads.set(ref, t);
  }
  for (const [ref, t] of threads) {
    const first = t.rows[0]!;
    const meta = first.meta ?? {};
    const people = t.rows.flatMap((x) => [...emailsOf(x.meta?.participants), ...emailsOf(x.meta?.author ? [x.meta.author] : [])]);
    const ext = [...new Set(people.filter((p) => p.isExternal === true || (p.isExternal === undefined && external([p.email]).length)).map((p) => p.email.toLowerCase()))];
    const channelId = typeof meta.channelId === 'string' ? meta.channelId : null;
    const map = channelId ? mapped.get(channelId) : undefined;
    out.push({
      kind: t.kind,
      key: ref,
      sourceItemIds: t.rows.map((x) => x.id),
      title: (t.kind === 'slack_burst' ? `#${String(meta.channelName ?? 'slack')}` : String(meta.subject ?? first.title ?? 'Mail thread')).slice(0, 200),
      text: t.rows.map((x) => x.body ?? '').join('\n').slice(0, 8000),
      at: iso(t.rows.at(-1)!.occurred_at)!,
      url: t.rows.at(-1)!.url,
      externalEmails: ext,
      externalDomains: [...new Set(ext.map(domainOf))],
      customer: !!map,
      channel: channelId ? { id: channelId, name: typeof meta.channelName === 'string' ? meta.channelName : null } : null,
      explicit: map ? { oppIds: map.opportunity_id ? [map.opportunity_id] : [], accountIds: map.account_id ? [map.account_id] : [], via: 'The channel' } : null,
    });
  }
  return out;
}

/** Use cases that exist: the app's (use_cases), Org62's (on my opps) and VDP's (the mirror), for dedupe. */
export async function loadExisting(db: DbOrTx, userId: string): Promise<{ existing: UcExisting[]; vdps: Awaited<ReturnType<typeof loadUcVdps>>['live']; org62: Awaited<ReturnType<typeof loadOrg62UseCases>> }> {
  const opps = await db.execute<{ id: string; org62: string | null; account_id: string | null }>(sql`select id::text, org62_opportunity_id as org62, account_id::text from opportunities where owner_user_id = ${userId}`);
  const byOrg62 = new Map(opps.rows.filter((o) => o.org62).map((o) => [id15(o.org62), o] as const));
  const ucs = await db.execute<{ id: string; title: string; account_id: string | null; opportunity_id: string | null; org62_use_case_id: string | null; vdp_use_case_id: string | null; vdp_slug: string | null }>(sql`
    select id::text, title, account_id::text, opportunity_id::text, org62_use_case_id, vdp_use_case_id, vdp_slug from use_cases where owner_user_id = ${userId} and title <> ''`);
  const existing: UcExisting[] = ucs.rows.map((u) => ({ kind: 'use_case', id: u.id, title: u.title, oppId: u.opportunity_id, accountId: u.account_id, org62UseCaseId: u.org62_use_case_id, vdpUseCaseId: u.vdp_use_case_id, vdpSlug: u.vdp_slug, useCaseId: u.id }));
  const org62 = await loadOrg62UseCases(db, userId);
  for (const rec of org62.records) {
    if (rec.goneAt || !rec.name) continue;
    const o = byOrg62.get(id15(rec.opportunityId));
    existing.push({ kind: 'org62', id: rec.id, title: rec.name, oppId: o?.id ?? null, accountId: o?.account_id ?? null, org62UseCaseId: rec.id });
  }
  const vdps = (await loadUcVdps(db, userId)).live;
  for (const v of vdps) {
    const opp = oppIdsOf(v.snapshot).map((x) => byOrg62.get(id15(x))).find(Boolean);
    for (const u of v.snapshot.useCases) if (u.title?.trim()) existing.push({ kind: 'vdp', id: u.id, title: u.title.trim(), oppId: opp?.id ?? null, accountId: v.accountId ?? opp?.account_id ?? null, vdpUseCaseId: u.id, vdpSlug: v.snapshot.slug });
  }
  return { existing, vdps, org62 };
}

/** The VDP a candidate goes under: one listing its opp, else its account's only live one. */
export function vdpSlugFor(row: Pick<UcCandidateRow, 'oppId' | 'accountId' | 'vdpSlug'>, vdps: Awaited<ReturnType<typeof loadUcVdps>>['live'], org62OppOf: (id: string) => string | null): string | null {
  if (row.vdpSlug) return row.vdpSlug;
  const live = vdps.filter((v) => !v.snapshot.archivedAt && !v.snapshot.isSeed);
  const o62 = row.oppId ? org62OppOf(row.oppId) : null;
  const onOpp = o62 ? live.find((v) => oppIdsOf(v.snapshot).some((x) => id15(x) === id15(o62))) : undefined;
  if (onOpp) return onOpp.snapshot.slug;
  const onAccount = row.accountId ? live.filter((v) => v.accountId === row.accountId) : [];
  return onAccount.length === 1 ? onAccount[0]!.snapshot.slug : null;
}

/** The attribution engine's World for this user now (the same read the Time rows' suggestion uses). */
export async function worldFor(db: Db, m: ReadModel, now: Date): Promise<{ world: World; totals4w: Map<string, OppTotals>; today: string }> {
  const today = localDay(now.getTime(), m.settings().profile.timezone || 'UTC');
  const extras = await loadRowExtras(db, m.ctx.userId, m.settings(), m.ctx.kv, today);
  const world = worldOfContract(contextOf(m, now, extras));
  const totals4w = totalsByOpp(await loadEngagement(db, m.ctx.userId, weekStart(new Date(Date.parse(`${today}T12:00:00Z`) - 27 * 86_400_000).toISOString().slice(0, 10))), '0000-00-00');
  return { world, totals4w, today };
}

const enabledFor = (m: ReadModel) => featureActive(personaOf(m.settings()), 'vdp');

// ---------------------------------------------------------------------------
// The extraction pass (the use_cases.extract job)
// ---------------------------------------------------------------------------

export interface ExtractDeps {
  /** The model pass over the unsure mentions (the job's: governor hold, booked, cassette-able); absent: they are dropped. */
  confirm?: (unsure: ReadonlyMap<string, readonly UcMention[]>, products: readonly string[]) => Promise<{ confirmed: Map<string, UcMention[]>; calls: number; costUsd: number; deferred?: string | null }>;
}

export async function runUseCaseExtract(db: Db, userId: string, now: Date, deps: ExtractDeps = {}): Promise<Record<string, unknown>> {
  const m = await loadModel(db, userId, now, { scope: everything('use-case job'), ops: false });
  if (!enabledFor(m)) return { skipped: 'feature_off' };
  const myDomain = m.settings().profile.email?.split('@')[1]?.toLowerCase() ?? (await db.execute<{ email: string | null }>(sql`select email from users where id = ${userId}`)).rows[0]?.email?.split('@')[1]?.toLowerCase() ?? null;
  const sources = await loadUcSources(db, userId, now, myDomain);
  const products = attributionSettingsOf(m.settings().time).dcProducts;
  const { sure, unsure } = mentionsOf(sources, { vocab: productVocabulary(products) });
  let model: Awaited<ReturnType<NonNullable<ExtractDeps['confirm']>>> | null = null;
  if (unsure.size && deps.confirm) model = await deps.confirm(unsure, products);
  const mentions = new Map(sure);
  const ai = new Set<UcMention>();
  for (const [k, ms] of model?.confirmed ?? []) {
    for (const x of ms) ai.add(x);
    mentions.set(k, [...(mentions.get(k) ?? []), ...ms]);
  }
  const { world, totals4w } = await worldFor(db, m, now);
  const { existing, vdps, org62 } = await loadExisting(db, userId);
  const candidates = await loadCandidates(db, userId);
  const plan = planCandidates({ sources, mentions, world, totals4w, existing, candidates, now: now.toISOString(), newId: () => randomUUID(), basis: (x) => (ai.has(x) ? 'ai' : 'rules') });
  // the landing sweep: staged candidates the reads found in Org62 or VDP
  const holds = await loadUseCaseHolds(db, userId);
  const opps = new Map((await loadUcOpps(db, userId)).map((o) => [o.id, o] as const));
  const landed: UcCandidateRow[] = [];
  for (const c of candidates) {
    const l = landingOf(c, c.oppId ? (opps.get(c.oppId)?.org62Id ?? null) : null, { org62: org62.records.filter((r) => !r.goneAt), vdp: vdps.flatMap((v) => v.snapshot.useCases.map((u) => ({ id: u.id, title: u.title, vdpSlug: v.snapshot.slug }))), sentCreate: (k) => holds.sentCreates.get(k) });
    if (l) landed.push({ ...c, ...l, updatedAt: now.toISOString() });
  }
  const counts = { sources: sources.length, ...plan.counts, unsure: [...unsure.values()].reduce((s, x) => s + x.length, 0), calls: model?.calls ?? 0, costUsd: model?.costUsd ?? 0, landed: landed.length };
  await withChangeSet({ db, userId, actor: actors.engine(USE_CASES_ENGINE), reason: `Use cases to add: ${plan.counts.created} new, ${plan.counts.attached} with more evidence, ${landed.length} landed`, undoable: false }, async (tx) => {
    for (const c of plan.creates) await insertCandidate(tx, userId, c);
    for (const u of plan.updates) await updateCandidate(tx, userId, u.after);
    for (const c of landed) await updateCandidate(tx, userId, c);
    const prev = (await tx.execute<{ value: unknown }>(sql`select value from user_settings where owner_user_id = ${userId} and key = ${USE_CASES_KV}`)).rows[0]?.value;
    await putKv(tx, userId, USE_CASES_KV, { at: now.toISOString(), counts }, prev);
  });
  return { ...counts, ...(model?.deferred ? { deferred: model.deferred } : {}) };
}

// ---------------------------------------------------------------------------
// The logging canvas (log-batch.ts) and the canvas question's marker
// ---------------------------------------------------------------------------

/** The Org62 rows accepted candidates put on the next logging canvas, and the plan's creates without their twins. */
export async function candidateCanvasRows(db: DbOrTx, userId: string, planCreates: readonly UseCaseCreate[], holds?: UseCaseHolds): Promise<UseCaseCreate[]> {
  const rows = await loadCandidates(db, userId);
  if (!rows.length) return [...planCreates];
  const opps = new Map((await loadUcOpps(db as Db, userId)).map((o) => [o.id, o] as const));
  const h = holds ?? (await loadUseCaseHolds(db, userId));
  const oppOf = (id: string): CanvasOpp | null => {
    const o = opps.get(id);
    return o && o.isOpen && o.accountOrg62Id ? { org62Id: o.org62Id, name: o.name, accountOrg62Id: o.accountOrg62Id, closeDate: o.closeDate } : null;
  };
  return [...withoutCandidateDuplicates(planCreates, rows, (id) => opps.get(id)?.org62Id ?? null), ...pendingCandidateCreates(rows, h, oppOf)];
}

/** Accepted candidates as the canvas question's `suggested` marker reads them (src/lib/canvas/prefill.ts markSuggested). */
export async function suggestedCandidates(db: DbOrTx, userId: string): Promise<Array<{ id: string; title: string; accountId: string | null; oppOrg62Id: string | null; from: string | null }>> {
  const rows = (await loadCandidates(db, userId)).filter((r) => r.matchedKind === null && r.status !== 'rejected' && r.status !== 'suggested' && r.status !== 'edited');
  if (!rows.length) return [];
  const opps = new Map((await loadUcOpps(db as Db, userId)).map((o) => [o.id, o.org62Id] as const));
  return rows.map((r) => ({ id: r.id, title: r.title, accountId: r.accountId, oppOrg62Id: r.oppId ? (opps.get(r.oppId) ?? null) : null, from: r.evidence[0]?.label ?? null }));
}

// ---------------------------------------------------------------------------
// The DataSource side
// ---------------------------------------------------------------------------

export interface DbUseCasesHost {
  db: Db;
  now(): Date;
  userId(): Promise<string>;
  model(): Promise<ReadModel>;
  mutate<T>(meta: { action: string; summary: string; entity: { type: string; id: string } }, fn: (w: WriteCtx, model: ReadModel) => Promise<T>): Promise<{ result: T; auditId: string; undoable: boolean }>;
  /** Draft the VDP create_use_case Outbox item in this change set (the D-49 adapter's path: vdpActionFor, its duplicate check). */
  draftVdpIn(w: WriteCtx, model: ReadModel, req: { vdpSlug: string; title: string; track: 'd360' | 'agentforce' }): Promise<{ id: string }>;
  publish(tables: string[], ids: string[], reason: string): void;
}

export class DbUseCases {
  constructor(private readonly host: DbUseCasesHost) {}

  private async viewContext(m: ReadModel) {
    const db = this.host.db;
    const userId = m.ctx.userId;
    const opps = new Map((await loadUcOpps(db, userId)).map((o) => [o.id, o] as const));
    const vdps = (await loadUcVdps(db, userId)).live;
    const holds = await loadUseCaseHolds(db, userId);
    const org62OppOf = (id: string) => opps.get(id)?.org62Id ?? null;
    return {
      opps,
      vdps,
      holds,
      ctx: {
        accountName: (id: string) => m.get('accounts', id)?.name ?? null,
        oppName: (id: string) => m.get('opps', id)?.name ?? null,
        org62OppId: org62OppOf,
        vdpFor: (r: UcCandidateRow) => vdpSlugFor(r, vdps, org62OppOf),
        holds,
        vdpDraftStatus: (id: string) => m.get('drafts', id)?.status ?? null,
      },
    };
  }

  async list(): Promise<UseCaseCandidatesPayload> {
    const m = await this.host.model();
    const enabled = enabledFor(m);
    const rows = enabled ? await loadCandidates(this.host.db, m.ctx.userId) : [];
    const v = await this.viewContext(m);
    const ran = m.ctx.kv.get(USE_CASES_KV) as { at?: string } | undefined;
    return candidatesPayload(rows, v.ctx, { enabled, now: this.host.now().toISOString(), generatedAt: ran?.at ?? null });
  }

  /** A correction's learning in the decision's change set: the rules (mapping_rules) and the outcome row. */
  private async learn(w: WriteCtx, world: World, row: UcCandidateRow, l: NonNullable<ReturnType<typeof decideCandidate>['learning']>, outcomeOnly = false): Promise<string[]> {
    const ruleIds = !outcomeOnly && row.signal ? await writeRuleChanges(w, planLearning({ signal: row.signal, chosen: l.chosen, outcome: l.outcome, shown: l.shown, world }, await loadRules(w.tx, w.userId, { all: true }), w.now.toISOString(), () => randomUUID())) : [];
    await recordOutcome(w.tx, w.userId, { subjectKind: 'use_case_candidate', subjectId: row.id, outcome: l.outcome, basis: row.basis === 'ai' ? 'ai' : 'engine', topReason: row.why[0]?.code ?? null, shownConfidence: row.confidence, shownTarget: row.oppId, chosenTarget: l.chosen.oppId, ruleIds });
    return ruleIds;
  }

  async decide(id: string, body: DecideUseCaseCandidateRequest): Promise<{ entity: DecideUseCaseCandidateResult; auditId: string | null }> {
    const r = await this.host.mutate({ action: `use_case.candidate.${body.decision}`, summary: `Use case to add: ${body.decision}`, entity: { type: 'use_case_candidates', id } }, async (w, model) => {
      if (!enabledFor(model)) throw invalid('Use cases are off for this persona');
      const cur = (await loadCandidates(w.tx, w.userId)).find((x) => x.id === id);
      if (!cur) throw notFound('Use case candidate', id);
      const opps = model.all('opps').map((o) => ({ id: o.id, accountId: o.accountId || null, isOpen: o.isOpen }));
      let d: ReturnType<typeof decideCandidate>;
      try {
        d = decideCandidate(cur, body, opps, w.now.toISOString());
      } catch (e) {
        if (e instanceof DecideError) throw invalid(e.message);
        throw e;
      }
      let next = d.next;
      let vdpDraftId: string | null = null;
      let org62Staged = false;
      const { world } = await worldFor(w.tx as unknown as Db, model, w.now);
      if (d.stage) {
        const v = await this.viewContext(model);
        const o = next.oppId ? v.opps.get(next.oppId) : undefined;
        const slug = vdpSlugFor(next, v.vdps, (x) => v.opps.get(x)?.org62Id ?? null);
        // since it was suggested, did Org62 or VDP get it? (D-67: never a use case either system already has)
        const { existing } = await loadExisting(w.tx, w.userId);
        const twin = findMatch(world, { oppId: next.oppId, accountId: next.accountId, title: next.title, dedupeKey: next.dedupeKey }, existing, []);
        let plan;
        try {
          plan = stagePlanOf(next, { org62OppId: o?.org62Id ?? null, oppOpen: o?.isOpen ?? false, vdpSlug: slug, inOrg62: twin?.kind === 'org62', inVdp: twin?.kind === 'vdp' });
        } catch (e) {
          if (e instanceof DecideError) throw invalid(e.message);
          throw e;
        }
        if (plan.vdp) vdpDraftId = (await this.host.draftVdpIn(w, model, plan.vdp)).id;
        org62Staged = plan.org62;
        next = { ...next, status: plan.status, vdpSlug: plan.vdp?.vdpSlug ?? next.vdpSlug, vdpDraftId };
      }
      await updateCandidate(w.tx, w.userId, next);
      if (d.learning) await this.learn(w, world, cur, d.learning);
      else await recordOutcome(w.tx, w.userId, { subjectKind: 'use_case_candidate', subjectId: cur.id, outcome: body.decision === 'reject' ? 'reject' : body.decision === 'edit' ? 'edit' : 'accept', basis: cur.basis === 'ai' ? 'ai' : 'engine', topReason: cur.why[0]?.code ?? null, shownConfidence: cur.confidence, shownTarget: cur.oppId, chosenTarget: next.oppId });
      const v2 = await this.viewContext(model);
      return { candidate: candidateView(next, v2.ctx), vdpDraftId, org62Staged };
    });
    this.host.publish(['use_case_candidates', ...(r.result.vdpDraftId ? ['drafts'] : []), ...(r.result.org62Staged ? ['use_cases'] : [])], [id], `use_case.candidate.${body.decision}`);
    return { entity: r.result, auditId: r.undoable ? r.auditId : null };
  }

  async add(body: AddUseCaseCandidateRequest): Promise<{ entity: AddUseCaseCandidateResult; auditId: string | null }> {
    const r = await this.host.mutate({ action: 'use_case.candidate.add', summary: `Use case to add: ${body.title}`.slice(0, 200), entity: { type: 'use_case_candidates', id: 'manual' } }, async (w, model) => {
      if (!enabledFor(model)) throw invalid('Use cases are off for this persona');
      const opp = body.oppId ? model.get('opps', body.oppId) : undefined;
      if (body.oppId && !opp) throw notFound('Opportunity', body.oppId);
      const accountId = opp?.accountId || body.accountId || null;
      if (!opp && !accountId) throw invalid('Say which opportunity or account it is on');
      const now = w.now.toISOString();
      const src: UcSource = { kind: 'manual', key: `manual:${randomUUID()}`, sourceItemIds: [], title: 'Added by you', text: body.problem ?? body.title, at: now, url: null, externalEmails: [], externalDomains: [], explicit: { oppIds: opp ? [opp.id] : [], accountIds: accountId ? [accountId] : [], via: 'You' } };
      const m: UcMention = { sourceKey: src.key, statement: (body.problem ?? body.title).slice(0, 300), title: body.title.trim(), problem: body.problem ?? '', products: body.products ?? [], track: body.track ?? null, outcome: body.outcome ?? '', stageHint: null, cue: 'manual', certainty: 'sure' };
      const { world, totals4w } = await worldFor(w.tx as unknown as Db, model, w.now);
      const at = opp ? { oppId: opp.id, accountId, confidence: 1, why: [{ code: 'explicit' as const, weight: 1, text: 'You picked this opportunity' }], needsPick: false, alternates: [] } : attributeMention(signalOf(src, m), world, totals4w);
      const key = dedupeKeyOf({ oppId: at.needsPick ? null : at.oppId, accountId: at.accountId ?? accountId, product: m.products[0] ?? null, title: m.title });
      // the fuzzy pool: rows of mine whose title is near (pg_trgm, the title index), plus the same dedupe key
      const near = (await w.tx.execute<{ id: string }>(sql`select id::text from use_case_candidates where owner_user_id = ${w.userId} and (dedupe_key = ${key} or similarity(lower(title), lower(${m.title})) >= 0.3)`)).rows.map((x) => x.id);
      const pool = (await loadCandidates(w.tx, w.userId)).filter((x) => near.includes(x.id));
      const { existing } = await loadExisting(w.tx, w.userId);
      const plan = planCandidates({ sources: [src], mentions: new Map([[src.key, [m]]]), world, totals4w, existing, candidates: pool, now, newId: () => randomUUID() });
      const created = plan.creates[0];
      // you named the opp: that is the answer (never the engine's guess over yours)
      if (opp && created && created.status === 'suggested') Object.assign(created, { oppId: opp.id, accountId, confidence: 1, why: at.why, needsPick: false, alternates: [], dedupeKey: key });
      for (const c of plan.creates) await insertCandidate(w.tx, w.userId, c);
      for (const u of plan.updates) await updateCandidate(w.tx, w.userId, u.after);
      const row = created ?? plan.updates[0]?.after ?? pool.find((x) => x.dedupeKey === key);
      if (!row) throw new AppError('conflict', 'That use case is one the app already has');
      const v = await this.viewContext(model);
      const matched = created && created.status === 'suggested' ? null : created ? created.matchedKind : 'candidate';
      return { candidate: candidateView(row, v.ctx), matched };
    });
    this.host.publish(['use_case_candidates'], [r.result.candidate.id], 'use_case.candidate.add');
    return { entity: r.result, auditId: r.undoable ? r.auditId : null };
  }

  async refresh(): Promise<RefreshUseCaseCandidatesResult> {
    const userId = await this.host.userId();
    const queued = await withChangeSet({ db: this.host.db, userId, actor: actors.user('use_cases.refresh'), reason: 'Read the sources for use cases', undoable: false }, async (tx) =>
      enqueueJob(tx, { ownerUserId: userId, kind: USE_CASES_EXTRACT_JOB, queue: USE_CASES_QUEUE, payload: { trigger: 'refresh' }, dedupeKey: `${USE_CASES_EXTRACT_JOB}:${userId}:refresh`, maxAttempts: 2, timeoutSeconds: 900 }),
    );
    const n = (await loadCandidates(this.host.db, userId)).filter((x) => x.matchedKind === null && (x.status === 'suggested' || x.status === 'edited')).length;
    this.host.publish(['jobs'], [String(queued.result.id)], 'use_cases.refresh');
    return { queued: true, candidates: n, note: 'The worker reads your notes, meetings, Slack and mail for use cases in a moment' };
  }
}
