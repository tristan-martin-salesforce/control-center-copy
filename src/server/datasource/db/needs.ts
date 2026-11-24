/**
 * GET /needs and POST /needs/:id/decide on both DataSources (01 R1, D-86). A thin composition over the existing
 * DataSource methods, so the mock and the db build the same queue from the same reads, and a decision is the page's
 * own call:
 *
 *   listNeeds   the reads (triage, outbox, activity, DC suggestions, health, VDP, guide, open items, queue snoozes),
 *               each allowed to fail on its own → src/engines/needs composeNeeds (pure) → the payload
 *   decideNeed  list again, find the row, plan its verb (src/engines/needs/decide.ts), run that route's DataSource
 *               method with its parsed input; the envelope carries that method's auditId (Undo)
 *
 * No database or network access of its own (the mock imports this file). Nothing here sends: every dispatchable
 * route is a local, audited change (NeedDispatchRoute). A read or a provider that fails costs its rows only and logs
 * one `BUG.NEEDS_PROVIDER` line (ids and codes, never content: *tenet: Local data, privacy-safe logs*).
 */
import { PersonaFeature, routes, type DecideNeedRowResult, type NeedDispatchRoute, type NeedKind, type NeedsPayload, type RouteInput, type RouteOutput } from '@/contract';
import { loggingProfile } from '@/engines/activity/persona';
import { utcOffsetMs } from '@/engines/activity/time';
import { composeNeeds } from '@/engines/needs/compose';
import { planNeedDecision } from '@/engines/needs/decide';
import type { NeedsContext } from '@/engines/needs/types';
import { logger } from '@/lib/log';
import { featureActive, personaOf } from '@/personas';
import { AppError } from '@/server/errors';
import { logCanvasesOf } from '../log-canvases';
import type { DataSource } from '../types';

const log = logger('needs');

/** How far back live activity rows are read: the quarter so far and the weeks before it (14 weeks). */
const ACTIVITY_DAYS = 98;

/** The kinds each read feeds (a failed read marks them partial). */
const READ_KINDS = {
  triage: ['triage_guess', 'mapping_question', 'resolution_confirm'],
  outbox: ['outbox_draft', 'time_ready_to_log'],
  activity: ['time_ready_to_log'],
  dc: ['dc_suggestion'],
  health: ['spend_ask', 'setup_step'],
  vdp: ['vdp_change'],
  guide: ['setup_step'],
  items: ['reopen_review'],
  useCases: ['use_case_candidate'],
  decisions: [],
} as const satisfies Record<string, readonly NeedKind[]>;

type ReadKey = keyof typeof READ_KINDS;

const errName = (e: unknown) => (e instanceof AppError ? e.code : e instanceof Error ? e.name : 'error');

const dayOf = (ms: number, offsetMs: number) => new Date(ms + offsetMs).toISOString().slice(0, 10);

/** The context the providers read, from the DataSource's own reads. */
export async function gatherNeeds(ds: DataSource, now: Date): Promise<{ ctx: NeedsContext; failed: Set<NeedKind> }> {
  const settings = await ds.getSettings({} as RouteInput<'getSettings'>);
  const persona = personaOf(settings);
  const features = new Set(PersonaFeature.options.filter((f) => featureActive(persona, f)));
  const timeZone = settings.profile.timezone || 'UTC';
  const nowMs = now.getTime();
  let offset = 0;
  try {
    offset = utcOffsetMs(nowMs, timeZone);
  } catch {
    offset = 0;
  }
  const failed = new Set<NeedKind>();
  const read = async <T>(key: ReadKey, on: boolean, run: () => Promise<T>): Promise<T | undefined> => {
    if (!on) return undefined;
    try {
      return await run();
    } catch (e) {
      for (const k of READ_KINDS[key]) failed.add(k);
      log.warn({ code: 'BUG.NEEDS_PROVIDER', read: key, err: errName(e) }, 'needs: a read failed; its rows are left out');
      return undefined;
    }
  };
  const [triage, outbox, activity, dc, health, vdp, guide, items, decisions, useCases] = await Promise.all([
    read('triage', true, () => ds.getTriage({} as RouteInput<'getTriage'>)),
    read('outbox', true, () => ds.getOutbox({} as RouteInput<'getOutbox'>)),
    read('activity', features.has('activityLogging'), () => ds.getActivityLog({ query: { from: dayOf(nowMs - ACTIVITY_DAYS * 86_400_000, offset) } } as RouteInput<'getActivityLog'>)),
    read('dc', features.has('dealContributions'), () => ds.getDcSuggestions({} as RouteInput<'getDcSuggestions'>)),
    read('health', true, () => ds.getHealth({} as RouteInput<'getHealth'>)),
    read('vdp', features.has('vdp'), () => ds.getVdpCoverage({} as RouteInput<'getVdpCoverage'>)),
    read('guide', true, () => ds.getGuide({} as RouteInput<'getGuide'>)),
    read('items', true, () => ds.listItems({ query: { tab: 'all_open' } } as RouteInput<'listItems'>)),
    read('decisions', true, () => ds.listNeedDecisions({} as RouteInput<'listNeedDecisions'>)),
    read('useCases', features.has('vdp'), () => ds.getUseCaseCandidates({} as RouteInput<'getUseCaseCandidates'>)),
  ]);
  const ctx: NeedsContext = {
    nowMs,
    timeZone,
    utcOffsetMinutes: Math.round(offset / 60_000),
    features,
    taskTypeRequired: loggingProfile(persona).taskTypeRequired,
    triage,
    outbox,
    activity,
    dc,
    health,
    vdp,
    guide,
    items,
    useCases,
    decisions: decisions?.decisions,
    // C6: lane 3's batches for the queue's time row (no read of its own: the Outbox's items and the activity rows).
    // R3-8: the applied items too, so a finished batch still in Sending counts as the lane counts it.
    canvases: outbox && activity ? logCanvasesOf([...outbox.admin.items, ...outbox.admin.applied].map((i) => i.draft), activity.entries, now) : undefined,
    approveComplete: settings.time.logging.approveComplete,
  };
  return { ctx, failed };
}

/** GET /needs. */
export async function listNeedsVia(ds: DataSource, now: Date): Promise<NeedsPayload> {
  const { ctx, failed } = await gatherNeeds(ds, now);
  const out = composeNeeds(ctx, undefined, {
    onError: (kind, e) => log.warn({ code: 'BUG.NEEDS_PROVIDER', kind, err: errName(e) }, 'needs: a provider threw; its rows are left out'),
  });
  const partial = [...new Set([...out.partial, ...failed])];
  return { ...out, partial };
}

type Dispatch = (input: unknown) => Promise<{ auditId?: string | null }>;

/** POST /needs/:id/decide: the row's verb through the existing route it names. */
export async function decideNeedRowVia(ds: DataSource, now: Date, input: RouteInput<'decideNeedRow'>): Promise<RouteOutput<'decideNeedRow'>> {
  const q = await listNeedsVia(ds, now);
  const row = q.rows.find((r) => r.id === input.params.id);
  if (!row) throw new AppError('not_found', `Nothing waits on you as ${input.params.id} (it was decided, or it left the queue)`, { id: input.params.id });
  const p = planNeedDecision(row, input.body);
  if (!p.ok) throw new AppError(p.code, p.message);
  const { route, verb, input: raw } = p.plan;
  const def = routes[route] as { params?: { parse: (v: unknown) => unknown }; body?: { parse: (v: unknown) => unknown } };
  const parsed: Record<string, unknown> = {};
  if (def.params) parsed.params = def.params.parse(raw.params);
  if (def.body) parsed.body = def.body.parse(raw.body);
  const fn = (ds[route as NeedDispatchRoute] as unknown as Dispatch).bind(ds);
  const res = await fn(parsed);
  const auditId = res?.auditId ?? null;
  const entity: DecideNeedRowResult = { row, verb: verb.id, route, undoable: verb.undoable && !!auditId };
  return { entity, auditId };
}
