/**
 * 2026-11-13 audit C4: the last logging step never looks stuck. Slackbot writes Org62 when you tell it to, and the Org62
 * scans read Events and DCs hourly (6-hourly off hours): on 2026-11-13 Slackbot created the Events at 17:37, the last
 * scan ran 17:19, and the step read "waiting" all evening. So, per canvas:
 *
 *   copied   you copied its Slackbot prompt: the app re-checks Org62 for it about 5, 15, 30 and 60 min later
 *   applied  you Applied the canvas (the outbox hook): the same re-checks, but it does not mark Slackbot as told, so
 *            the canvas does not read "checking" until you copy the prompt (W0-10)
 *   now      "Slackbot's done: check now": one check at once
 *
 * A check queues the Org62 `events` and `dcs` scans (and the use-case read-back when use cases are on the canvas)
 * through the existing scan / job paths (deduped per minute slot, read only). Per-canvas memory (when you told
 * Slackbot, which checks are queued) lives in the kv `cc.time.canvas_checks` (db) or the mock's own map.
 * `canvasProgressOf` turns a canvas, its DC requests, its use cases and the last Org62 reads into its own line.
 * Pure; both DataSources use it.
 */
import type { CanvasProgress, CanvasProgressPart, DcRequest, UseCaseSyncItem } from '@/contract';

export const CANVAS_CHECKS_KV = 'cc.time.canvas_checks';
/** Minutes after the copy at which the app re-checks Org62 (then the normal scan cadence). */
export const RECHECK_AFTER_MIN = [5, 15, 30, 60] as const;
/** A canvas's memory is dropped this long after its last check. */
const KEEP_MS = 7 * 86_400_000;

export interface CanvasCheck {
  /** When you last copied its Slackbot prompt. */
  toldAt: string | null;
  /** When you last asked "check now". */
  askedAt: string | null;
  /** Every check queued for it (ISO), oldest first. */
  at: string[];
}
export type CanvasChecks = Record<string, CanvasCheck>;

const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** The stored map, tolerant of anything older or malformed. */
export function canvasChecksOf(v: unknown): CanvasChecks {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: CanvasChecks = {};
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<CanvasCheck>;
    out[id] = { toldAt: isIso(r.toldAt) ? r.toldAt : null, askedAt: isIso(r.askedAt) ? r.askedAt : null, at: Array.isArray(r.at) ? r.at.filter(isIso).sort() : [] };
  }
  return out;
}

/** The minute a check runs in: checks of one minute share one queued read (dedupe across canvases). */
export const slotOf = (iso: string) => new Date(Math.floor(Date.parse(iso) / 60_000) * 60_000).toISOString();

export interface RecheckPlan {
  next: CanvasChecks;
  /** The new checks to queue (ISO, one slot each). */
  slots: string[];
}

/** What a copy, an Apply or a "check now" adds to the map: the checks to queue, and the map without entries past KEEP_MS. */
export type RecheckReason = 'copied' | 'applied' | 'now';

export function planRecheck(prev: CanvasChecks, draftId: string, reason: RecheckReason, now: Date): RecheckPlan {
  const nowIso = now.toISOString();
  const cur = prev[draftId] ?? { toldAt: null, askedAt: null, at: [] };
  const slots = reason !== 'now' ? RECHECK_AFTER_MIN.map((m) => slotOf(new Date(now.getTime() + m * 60_000).toISOString())) : [slotOf(nowIso)];
  const entry: CanvasCheck = {
    toldAt: reason === 'copied' ? nowIso : cur.toldAt,
    askedAt: reason === 'now' ? nowIso : cur.askedAt,
    at: [...new Set([...cur.at, ...slots])].sort(),
  };
  const next: CanvasChecks = {};
  for (const [id, c] of Object.entries({ ...prev, [draftId]: entry })) {
    const last = Math.max(...[c.toldAt, c.askedAt, ...c.at].filter(isIso).map((x) => Date.parse(x)), 0);
    if (now.getTime() - last <= KEEP_MS) next[id] = c;
  }
  return { next, slots };
}

/** The window a queued check reads: from before the canvas was applied (or an hour back) up to when it runs. */
export function recheckWindow(runAt: string, appliedAt: string | null): { from: string; to: string } {
  const t = Date.parse(runAt);
  const applied = appliedAt ? Date.parse(appliedAt) : Number.NaN;
  const from = Math.max(t - 24 * 3_600_000, Math.min(Number.isFinite(applied) ? applied - 15 * 60_000 : t, t - 3_600_000));
  return { from: new Date(from).toISOString(), to: new Date(t).toISOString() };
}

/** The latest successful Org62 read of each kind (Events scan, DCs scan, the use-case read-back), ISO or null. */
export interface Org62Reads {
  events: string | null;
  dcs: string | null;
  useCases: string | null;
}

const part = (total: number, inOrg62: number, missing: number): CanvasProgressPart => ({ total, inOrg62: Math.min(total, inOrg62), missing: Math.min(total, missing) });

export interface CanvasProgressInput {
  draftId: string;
  appliedAt: string | null;
  /** The canvas's own counts (from its work order). */
  rows: number;
  dcs: number;
  useCases: number;
  /** Its rows as the Org62 check reads them (LogCanvas.org62). */
  org62: { logged: number; waiting: number; missing: number } | null;
}

/**
 * One created canvas's progress. Events: its rows' Org62 check. DCs: its DC requests (confirmed or settled by Org62
 * itself = in Org62; not created = missing); the work order's count when no request is linked to it. Use cases: the
 * ones still handed off on it wait; the rest of its count is in Org62. `checkedAt`: the oldest of the reads its parts
 * need, each only when it ran after the canvas was applied.
 */
export function canvasProgressOf(c: CanvasProgressInput, o: { dcRequests?: readonly Pick<DcRequest, 'canvasDraftId' | 'stage' | 'outcome'>[]; useCases?: readonly Pick<UseCaseSyncItem, 'canvasDraftId' | 'state'>[]; check?: CanvasCheck; reads?: Org62Reads; now: Date }): CanvasProgress {
  const events = part(c.rows, c.org62?.logged ?? 0, c.org62?.missing ?? 0);
  const mine = (o.dcRequests ?? []).filter((r) => r.canvasDraftId === c.draftId && r.stage !== 'in_canvas');
  const dcTotal = mine.length || c.dcs;
  const dcIn = mine.filter((r) => r.stage === 'confirmed' || (r.stage === 'dismissed' && !!r.outcome)).length;
  const dcs = part(dcTotal, dcIn, mine.filter((r) => r.stage === 'not_created').length);
  const ucWaiting = (o.useCases ?? []).filter((u) => u.canvasDraftId === c.draftId && (u.state === 'handed_off' || u.state === 'in_canvas')).length;
  const useCases = part(c.useCases, Math.max(0, c.useCases - ucWaiting), 0);
  const applied = c.appliedAt ? Date.parse(c.appliedAt) : 0;
  const since = (iso: string | null | undefined) => (iso && Date.parse(iso) >= applied ? iso : null);
  const needed = [events.total ? since(o.reads?.events) : undefined, dcs.total ? since(o.reads?.dcs) : undefined, useCases.total ? since(o.reads?.useCases) : undefined].filter((x) => x !== undefined);
  const checkedAt = needed.length && needed.every((x) => !!x) ? (needed as string[]).sort()[0]! : null;
  const nowMs = o.now.getTime();
  const nextCheckAt = (o.check?.at ?? []).find((x) => Date.parse(x) > nowMs - 60_000) ?? null;
  const total = events.total + dcs.total + useCases.total;
  const inOrg62 = events.inOrg62 + dcs.inOrg62 + useCases.inOrg62;
  const missing = events.missing + dcs.missing + useCases.missing;
  const state: CanvasProgress['state'] = total > 0 && inOrg62 >= total ? 'in_org62' : missing > 0 ? 'missing' : o.check?.toldAt || nextCheckAt ? 'checking' : 'waiting';
  return { events, dcs, useCases, state, toldAt: o.check?.toldAt ?? null, checkedAt, nextCheckAt };
}

/** "4 of 4 Events · 55 of 55 DCs · 3 of 3 use cases in Org62" (parts it has only); null when it carries nothing. */
export function progressLine(p: Pick<CanvasProgress, 'events' | 'dcs' | 'useCases'>, eventWord = 'Events'): string | null {
  const parts = [
    p.events.total ? `${p.events.inOrg62} of ${p.events.total} ${p.events.total === 1 ? eventWord.replace(/s$/, '') : eventWord}` : null,
    p.dcs.total ? `${p.dcs.inOrg62} of ${p.dcs.total} ${p.dcs.total === 1 ? 'DC' : 'DCs'}` : null,
    p.useCases.total ? `${p.useCases.inOrg62} of ${p.useCases.total} use ${p.useCases.total === 1 ? 'case' : 'cases'}` : null,
  ].filter(Boolean);
  return parts.length ? `${parts.join(' · ')} in Org62` : null;
}
