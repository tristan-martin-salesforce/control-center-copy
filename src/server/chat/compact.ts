/**
 * Compact, model-facing views of contract payloads (BE-CHAT). No bodies, no tokens, every string through the
 * credential redactor. Views shape a payload; they don't drop rows (reads page instead: src/server/chat/read.ts).
 * The context pack alone is a snapshot (top rows and counts), with every list one read away.
 */
import type { ActionDestination, CalendarEvent, CalendarPayload, Draft, HealthPayload, OutboxPayload, Settings, TodayPayload, WorkItem, WorkItemDetail } from '@/contract';
import { adminDraftHref } from '@/contract';
import { actionKindLabel } from '@/lib/actions';
import { redactPayload, redactText } from '@/llm/redact';
import { appliedAtOf } from '@/server/datasource/log-canvases';
import type { ChatItemHit } from '@/llm/chat/types';

const clip = (s: string | null | undefined, n: number): string => {
  const t = redactText((s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function itemHit(w: WorkItem): ChatItemHit {
  return {
    id: w.id,
    title: clip(w.title, 140),
    kind: w.isBackground && w.kind === 'commitment' ? 'promise' : w.kind,
    state: w.state,
    rank: w.rank,
    due: w.due,
    startBy: w.startBy,
    snoozedUntil: w.snoozedUntil,
    account: w.refs?.account?.label ?? null,
    why: clip(w.why, 160),
    topReasons: [...(w.rankReasons ?? [])].sort((a, b) => b.contribution - a.contribution).slice(0, 3).map((r) => clip(r.label, 60)),
    locked: [...(w.userLockedFields ?? [])],
    // A4: a patchItem's ifVersion (Apply fills it in when a staged change leaves it out)
    version: w.version,
  };
}

function eventRow(e: CalendarEvent) {
  return { id: e.id, title: clip(e.title, 100), start: e.start, end: e.end, attendance: e.attendance, customerFacing: e.isCustomerFacing, prep: e.prep ? { ready: e.prep.ready, workItemId: e.prep.workItemId } : null };
}

export function compactCalendar(c: CalendarPayload) {
  return { from: c.from, to: c.to, events: c.events.map(eventRow) };
}

/** What an applied action's status means, for the model ("was the canvas created?"). */
const APPLIED_STATE: Partial<Record<Draft['status'], string>> = {
  sending: 'applying: on its way, not confirmed yet',
  sent: 'created / applied',
  staged: 'created / applied',
  verified: 'created / applied and read back (verified)',
  verify_failed: 'created / applied, but the read-back did not confirm it',
};

/** The latest dry run of an item still waiting (Apply with dry run on created nothing). */
const lastDryRunAt = (d: Draft) => [...d.attempts].reverse().find((a) => a.dryRun)?.at ?? null;

export function compactOutbox(o: OutboxPayload) {
  const sent = o.groups.find((g) => g.group === 'sent')?.items ?? [];
  return {
    dryRun: o.dryRun,
    counts: o.counts,
    groups: o.groups.map((g) => ({
      group: g.group,
      items: g.items.map((i) => ({
        draftId: i.draft.id,
        status: i.draft.status,
        to: i.draft.destination.kind === 'slack' ? i.draft.destination.channelName : i.draft.destination.kind === 'action' ? i.draft.destination.target.label : i.draft.destination.to.map((t) => t.email).join(', '),
        workItem: i.workItem?.title ? clip(i.workItem.title, 80) : null,
        preview: clip(i.previewText, 120),
        ...(i.draft.resultUrl ? { url: i.draft.resultUrl } : {}),
      })),
    })),
    /**
     * Applied admin items and feedback posts, newest first (logging and forecast canvases, VDP changes): what was
     * created, its status and the link to it. A canvas listed here exists in Slack (unless status is sending).
     */
    applied: [...sent, ...(o.admin.applied ?? [])]
      .filter((i) => i.draft.destination.kind === 'action')
      .sort((a, b) => b.draft.updatedAt.localeCompare(a.draft.updatedAt))
      .map((i) => {
        const dest = i.draft.destination as ActionDestination;
        return {
          draftId: i.draft.id,
          kind: actionKindLabel(dest),
          title: clip(dest.target.label, 100),
          status: i.draft.status,
          meaning: APPLIED_STATE[i.draft.status] ?? i.draft.status,
          appliedAt: appliedAtOf(i.draft) ?? i.draft.updatedAt,
          url: i.draft.resultUrl,
          verification: i.draft.verification ? clip(i.draft.verification.detail, 120) : null,
        };
      }),
    /** Admin items still waiting for the user's Apply on Time (or a retry). Nothing was created for these. */
    waitingOnTime: o.admin.items.map((i) => {
      const dest = i.draft.destination as ActionDestination;
      return { draftId: i.draft.id, kind: actionKindLabel(dest), title: clip(dest.target.label, 100), status: i.draft.status, lastDryRunAt: lastDryRunAt(i.draft), href: adminDraftHref(i.draft) };
    }),
  };
}

export function compactHealth(h: HealthPayload) {
  return {
    worst: h.summary.worst,
    connectors: h.connectors.map((c) => ({
      id: c.id,
      label: c.label,
      state: c.state,
      cursor: c.cursor.label,
      lastSuccessAt: c.lastSuccessAt,
      lastError: c.lastError ? { class: c.lastError.class, message: clip(c.lastError.message, 120) } : null,
      impact: c.impact ? clip(c.impact, 140) : null,
      reauth: c.reauth ? c.reauth.label : null,
    })),
    spend: { todayUsd: h.spend.today.usd, softBudgetUsd: h.spend.today.softBudgetUsd, hardCapUsd: h.spend.today.hardCapUsd, state: h.spend.state },
    worker: h.worker,
    dryRun: h.dryRun,
  };
}

export function compactDetail(d: WorkItemDetail) {
  return {
    item: { ...itemHit(d.item), purpose: d.item.purpose, notes: d.item.notes, effort: d.item.effort, version: d.item.version, resolution: d.item.resolution, sources: d.item.sources.map((s) => ({ kind: s.kind, label: clip(s.label, 80), url: s.url ?? null })) },
    nba: d.nba ? { verb: d.nba.verb, title: clip(d.nba.title, 140), why: clip(d.nba.why, 160), status: d.nba.status } : null,
    draft: d.draft ? { id: d.draft.id, status: d.draft.status, preview: clip(d.draft.plainText, 160) } : null,
    initiative: d.initiative ? { id: d.initiative.id, title: clip(d.initiative.title, 100), purpose: clip(d.initiative.purpose, 160) } : null,
    siblings: d.siblings.map((s) => ({ id: s.id, title: clip(s.title, 80), state: s.state })),
    pendingProposals: d.proposals.filter((p) => p.status === 'pending').map((p) => ({ id: p.id, reason: clip(p.reason, 120) })),
    assets: d.assets.map((a) => ({ id: a.id, title: clip(a.title, 80), url: a.url ?? null })),
    account: d.account ? d.account.name : null,
    opp: d.opp ? { name: d.opp.name, stage: d.opp.stage } : null,
    meeting: d.meeting ? eventRow(d.meeting) : null,
    evidenceCount: d.evidenceCount,
  };
}

/** The per-turn context pack: today, ranked items, calendar, outbox, health and the policy, in that order. */
export function buildContextPack(o: { now: Date; timezone: string; today: TodayPayload; settings: Settings; outbox: OutboxPayload; health: HealthPayload }) {
  const { today, settings } = o;
  const pol = settings.policy;
  const pack = {
    now: o.now.toISOString(),
    timezone: o.timezone,
    me: { name: settings.profile.name, role: settings.profile.role, workingHours: settings.profile.workingHours, manager: settings.profile.managerName },
    today: {
      rankedAt: today.nowStack.rankedAt,
      rerankReady: today.nowStack.rerankReady,
      top3: today.nowStack.cards.map((c) => ({ ...itemHit(c.item), effortYouMin: c.item.effort.youMin, nba: c.nba ? { verb: c.nba.verb, title: clip(c.nba.title, 120) } : null })),
      moreToday: today.moreToday.items.slice(0, 7).map(itemHit),
      moreTodayCount: today.moreToday.count,
      triageCount: today.triageCount,
      // a per-turn prompt budget, never a hidden cut: each list carries its whole count and the read tools have the rest
      promises: today.shelves.promises.slice(0, 4).map((s) => ({ id: s.item.id, title: clip(s.item.title, 100), hint: clip(s.hint, 80) })),
      promisesCount: today.shelves.promises.length,
      fitIns: today.shelves.fitIns.slice(0, 4).map((s) => ({ id: s.item.id, title: clip(s.item.title, 100), hint: clip(s.hint, 80) })),
      fitInsCount: today.shelves.fitIns.length,
      navCounts: today.navCounts,
    },
    calendar: today.spine.events.slice(0, 14).map(eventRow),
    calendarCount: today.spine.events.length,
    outbox: (() => {
      const c = compactOutbox(o.outbox);
      // the newest applied canvases / VDP changes / feedback posts with their link, and what still waits on Time
      return { dryRun: c.dryRun, counts: c.counts, applied: c.applied.slice(0, 5), appliedCount: c.applied.length, waitingOnTime: c.waitingOnTime.length };
    })(),
    health: {
      worst: o.health.summary.worst,
      broken: o.health.connectors.filter((c) => c.state !== 'ok').map((c) => ({ id: c.id, label: c.label, state: c.state, impact: c.impact ? clip(c.impact, 120) : null, reauth: c.reauth?.label ?? null })),
      spend: { todayUsd: o.health.spend.today.usd, state: o.health.spend.state },
      workerAlive: o.health.worker.alive,
    },
    policy: { version: pol.version, name: pol.name, weights: pol.weights, rules: pol.rules.map((r) => ({ id: r.id, text: clip(r.text, 100), enabled: r.enabled, boost: r.boost })) },
  };
  return redactPayload(pack, { maxDepth: 8, maxString: 600 }).value as Record<string, unknown>;
}

/** Above this a tool result is too big for one call (the Agent SDK's ~25k-token tool-output limit). */
export const TOOL_JSON_MAX = 64_000;

/**
 * JSON for a tool result, credential-redacted, always valid JSON: no array, depth or string cut (reads page instead; a
 * long string in a read names its `field`, ASSIST-5), and a
 * result over `max` comes back as a stub that says so and how to narrow it, never cut mid-JSON (A1, 2026-11-13).
 */
export function toolJson(v: unknown, max = TOOL_JSON_MAX): string {
  const s = JSON.stringify(redactPayload(v, { maxDepth: 24, maxString: max, maxArray: Number.POSITIVE_INFINITY }).value);
  if (s.length <= max) return s;
  // the result's own top-level facts (staged, proposalId, status, counts) survive; the rest is a valid stub
  const facts = v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(redactPayload(v, { maxDepth: 1, maxString: 300 }).value as Record<string, unknown>).filter(([, x]) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) : {};
  return JSON.stringify({ ...facts, tooLarge: true, chars: s.length, note: 'This result is larger than one tool call can carry. Read it in pages (offset, limit, list) or narrow it (an id, a range).', start: s.slice(0, Math.floor(max / 2)) });
}

export { clip };
