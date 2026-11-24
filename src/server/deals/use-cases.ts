/**
 * VDP use cases → Org62 Use_Case__c (D-67), the part both DataSources share: what the logging canvases hold, how the
 * rows ride on a batch, and the read model (`getUseCaseSync`). The rules are the engine's
 * (src/engines/activity/use-cases.ts); this module only feeds it the drafts and packs its rows onto canvases.
 *
 * - Holding works like the DC rows' (src/server/deals/dc-requests.ts dcHolds): a canvas item waiting for Apply holds
 *   the use-case rows it carries, a rejected or discarded one lets them go, a sent one handed them to Slackbot. The rows
 *   are read back from the canvas markdown itself (`CC-UC#<VDP use case id>` in Notes__c, a fix's Record Id + Field).
 * - Use cases ride on a batch that has rows, on its one canvas (src/server/time/batch-canvases.ts): never a canvas of
 *   their own, never on a DC-only one, and every pending one goes (2026-11-13: no per-batch count; Slack's 1 MiB is
 *   the only limit, and past it the whole work order splits into parts).
 */
import type { Draft, NeedDecision, UseCaseSyncPayload } from '@/contract';
import {
  ucCreateKey,
  ucExisting,
  ucNormalizeVdp,
  UC_LEAVE_RULE,
  UC_READD_RULE,
  type Org62UseCase,
  type UcOpp,
  type UcVdp,
  type UseCaseDecisions,
  ucUpdateKey,
  ucRowsIn,
  type UcCanvasCreate,
  type UseCaseHolds,
  type UseCasePlan,
} from '@/engines/activity/use-cases';
import { CANVAS_HOLDING, canvasInputOf } from '@/lib/canvas/payload';
import { hasObjectRows } from '@/lib/canvas/tables';
import { org62RecordUrl } from '@/projections/links';

/** Canvas items whose rows go back to waiting: never Applied, rejected or discarded. Anything else was sent. */
const RELEASED: ReadonlySet<string> = new Set(['drafting', 'rejected', 'discarded']);

/**
 * Which use-case rows the canvas items carry: held by a pending one, or handed off by a sent one, and when it was sent
 * (`sentAt`: the live Apply; the row's last update when unknown). A record Slackbot made after that is the app's.
 */
export function ucHolds(drafts: ReadonlyArray<Pick<Draft, 'id' | 'status' | 'destination' | 'updatedAt'> & { sentAt?: string | null }>): UseCaseHolds {
  const held = new Map<string, string>();
  const sent = new Map<string, { draftId: string; at: string }>();
  const sentCreates = new Map<string, UcCanvasCreate & { draftId: string; at: string }>();
  // oldest first, so a later canvas carrying the same row (offered again) wins
  for (const d of [...drafts].sort((a, b) => (a.sentAt ?? a.updatedAt).localeCompare(b.sentAt ?? b.updatedAt) || a.id.localeCompare(b.id))) {
    if (d.destination.kind !== 'action' || d.destination.action !== 'slack_canvas.create') continue;
    const md = canvasInputOf(d.destination).markdown;
    if (!hasObjectRows(md, 'Use_Case__c')) continue;
    const rows = ucRowsIn(md);
    if (CANVAS_HOLDING.has(d.status)) {
      for (const c of rows.creates) held.set(ucCreateKey(c.vdpUseCaseId), d.id);
      for (const u of rows.updates) held.set(ucUpdateKey(u.recordId, u.field), d.id);
      continue;
    }
    if (RELEASED.has(d.status)) continue;
    const at = d.sentAt ?? d.updatedAt;
    for (const c of rows.creates) {
      sent.set(ucCreateKey(c.vdpUseCaseId), { draftId: d.id, at });
      sentCreates.set(c.vdpUseCaseId, { ...c, draftId: d.id, at });
    }
    for (const u of rows.updates) sent.set(ucUpdateKey(u.recordId, u.field), { draftId: d.id, at });
  }
  return { held, sent, sentCreates };
}

/** The read model: every VDP use case and where it stands, with the Org62 link once there is a record. */
export function ucSyncView(plan: UseCasePlan, readAt: string | null): UseCaseSyncPayload {
  return {
    readAt,
    items: plan.items.map((x) => ({ ...x, question: x.question ?? null, org62Url: x.org62UseCaseId ? org62RecordUrl('Use_Case__c', x.org62UseCaseId) : null })),
    counts: plan.counts,
  };
}

/** The use-case decisions among the needs decisions (D-61): Leave it (`use_case`), Add it again (`use_case_readd`). */
export function ucDecisionsOf(ds: readonly NeedDecision[], now: Date = new Date()): UseCaseDecisions {
  const on = (d: NeedDecision) => d.kind === 'not_needed' || (d.kind === 'snooze' && !!d.until && Date.parse(d.until) > now.getTime());
  return {
    leave: new Set(ds.filter((d) => d.rule === UC_LEAVE_RULE && on(d)).map((d) => d.subjectId)),
    readd: new Set(ds.filter((d) => d.rule === UC_READD_RULE && on(d)).map((d) => d.subjectId)),
  };
}

const id15 = (s: string | null | undefined) => (s ?? '').slice(0, 15);
/** VDP drafts that carry a new use case: everything but the ones that went nowhere. */
const DEAD: ReadonlySet<string> = new Set(['drafting', 'rejected', 'discarded']);

export interface UcGuardContext {
  /** Every VDP the mirror has (live, past, gone from my list), with the account it links to. */
  vdps: readonly UcVdp[];
  records: readonly Org62UseCase[];
  opps: readonly UcOpp[];
  drafts: ReadonlyArray<Pick<Draft, 'id' | 'status' | 'destination'>>;
  /** VDPs of a company I am not on (VDP's get_company vdp_count), by app account id, when the mirror has it. */
  hiddenVdps?: (accountId: string) => number;
}

/**
 * D-67: before any new use case is staged or pushed (the VDP tree's "Add a use case", an Org62 → VDP item, the
 * Assistant), check BOTH systems and what is on its way: every VDP of the company (past ones too), the account's
 * Use_Case__c, staged or applied VDP creates and canvas rows. Returns why it would be a duplicate, or null. The VDP of
 * an item (`vdpSlug`) or the account a new VDP is for (`accountId`) scopes the company; `excludeRecord` is the record an
 * Org62 → VDP item comes from.
 */
export function ucDuplicateGuard(ctx: UcGuardContext): (title: string, scope: { vdpSlug?: string | null; accountId?: string | null; excludeRecord?: string | null }) => string | null {
  const all = ctx.vdps.map((v) => ucNormalizeVdp(v));
  return (title, scope) => {
    const self = scope.vdpSlug ? all.find((v) => v.snapshot.slug === scope.vdpSlug) : undefined;
    const accountId = scope.accountId ?? self?.accountId ?? null;
    const companyId = self?.snapshot.company.id ?? null;
    const vdps = all.filter((v) => v.snapshot.slug === scope.vdpSlug || (accountId && v.accountId === accountId) || (companyId && v.snapshot.company.id === companyId));
    const slugs = new Set(vdps.map((v) => v.snapshot.slug));
    const opps = ctx.opps.filter((o) => accountId && o.accountId === accountId);
    const opp15 = new Set([...opps.map((o) => id15(o.org62Id)), ...vdps.flatMap((v) => (v.snapshot.salesforceOpportunityIds ?? []).map(id15))]);
    const acc15 = new Set([...opps.map((o) => id15(o.accountOrg62Id)), ...vdps.map((v) => id15(v.snapshot.salesforceAccountId))].filter(Boolean));
    const records = ctx.records.filter((r) => (r.opportunityId && opp15.has(id15(r.opportunityId))) || (r.accountId && acc15.has(id15(r.accountId))));
    const pending: Array<{ title: string; where: string }> = [];
    for (const d of ctx.drafts) {
      if (d.destination.kind !== 'action' || DEAD.has(d.status)) continue;
      if (d.destination.action === 'vdp.create_use_case') {
        const i = d.destination.input as { vdpSlug?: string; field?: string; value?: unknown; changes?: Array<{ field: string; value: unknown }> };
        // an item's call lists its fields in `changes`; a one-field stage (the Assistant's) carries field / value
        const t = i.changes?.find((c) => c.field === 'title')?.value ?? (i.field === 'title' ? i.value : undefined);
        const mineScope = (i.vdpSlug && slugs.has(i.vdpSlug)) || (accountId && i.vdpSlug?.startsWith(`account:${accountId}`));
        if (typeof t === 'string' && mineScope) pending.push({ title: t, where: d.status === 'ready' ? 'staged for VDP, waiting for your Apply' : 'applied to VDP, waiting for the next read' });
      } else if (d.destination.action === 'slack_canvas.create') {
        const md = canvasInputOf(d.destination).markdown;
        if (!hasObjectRows(md, 'Use_Case__c')) continue;
        for (const c of ucRowsIn(md).creates) if (opp15.has(id15(c.opportunityId))) pending.push({ title: c.name, where: 'on a logging canvas for Org62' });
      }
    }
    const hit = ucExisting(title, { vdps: vdps.map((v) => v.snapshot), records, pending }, { org62UseCaseId: scope.excludeRecord ?? null });
    if (hit) return `Already a use case: ${hit.label}. Nothing was staged, so it is never in either system twice`;
    return null;
  };
}

/** Hidden VDPs (VDP's get_company vdp_count) a proposal can't see into: said, never refused on. */
export function ucHiddenNote(ctx: Pick<UcGuardContext, 'hiddenVdps'>, accountId: string | null): string | null {
  const n = accountId && ctx.hiddenVdps ? ctx.hiddenVdps(accountId) : 0;
  return n ? `${n} VDP${n === 1 ? '' : 's'} of this company you’re not on may have it already: check in VDP first` : null;
}
