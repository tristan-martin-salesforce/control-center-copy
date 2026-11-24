/**
 * Home as the briefing (phase 3: 01 R2/R3, 07 R6, 07 §4.2): the pieces around Do now that answer "what do I do now"
 * without a second list. Pure, like build.ts; build.ts calls each with what it already knows.
 *
 *   respondOf     drafts the app wrote (ready, failed, being written) and replies it can draft, as chips; a chip only
 *                 opens the Outbox row or the item (*Nothing leaves without approval*: no send from Home)
 *   buildsOf      agent runs in flight (queued, running, waiting on you), one row each with an ETA
 *   adminOf       admin as one quiet row: priority@2's batch math when it is the shown ranking, else the persona's
 *                 admin rules listing the items (*Config over code*: the classes are the persona's)
 *   moveItOf      overbooked → the first makeRoom row as a sentence and one "Move it" (the existing snooze verb)
 *   closedNowOf   closed for you in the last few hours (a card that leaves this way stays with its tag and Undo)
 *   watchingOf    what the app is watching (the empty-day line)
 */
import type { AgentRun, Connector, Draft, HomeAdmin, HomeBuild, HomeClosedNow, HomeDayRef, HomeMoveIt, HomeRespond, HomeRespondChip, HomeRow, MakeRoom, PriorityEngineSetting, WorkItem } from '@/contract';
import { isAdminDraft } from '@/contract';
import { adminBatchOf, adminClassOf, type AdminMember } from '@/engines/priority/v2/admin';
import { DEFAULT_PRIORITY_CONFIG, type AdminClassId, type PriorityConfig } from '@/engines/priority/v2/config';
import { closedBadge, closedForYouSince, closedWhy } from './closed';
import { clip, firstName, plural } from './text';
import { dur, HOUR_MS, MIN_MS, offsetMin, toMs, whenLabel } from './time';

/** Chips shown in the Respond strip (the rest are one click away: Review N, the Outbox). */
export const RESPOND_CHIPS = 5;
/** A close this recent is "just now": the card that leaves stays in place with its tag. */
export const CLOSED_NOW_MS = 4 * HOUR_MS;

const DRAFT_LIVE = new Set(['ready', 'failed', 'verify_failed']);

/** Who a draft goes to, in a word ("Dana", "#team-updates"). */
export function draftWho(d: Draft): string {
  const dest = d.destination;
  if (dest.kind === 'email') return firstName(dest.to[0]?.name ?? dest.to[0]?.email.split('@')[0] ?? 'Email');
  if (dest.kind === 'action') return dest.target.label;
  const name = dest.channelName;
  return name.startsWith('#') ? name : firstName(name.replace(/^Group DM\s*·\s*/i, '').split(',')[0] ?? name);
}

function draftText(d: Draft): string {
  const dest = d.destination;
  if (dest.kind === 'email') return dest.subject;
  if (dest.kind === 'action') return dest.target.label;
  return (d.plainText.split('\n').find((l) => l.trim()) ?? '').replace(/^@[\w .'-]+?:\s*/, '');
}

/** A reply row's verb in one word on its chip. */
const REPLY_VERB: Partial<Record<HomeRow['verb']['action'], string>> = { draft: 'Draft', send: 'Send', review: 'Review', nudge: 'Nudge', open: 'Open', open_in_claude: 'Open in Claude', plan: 'Plan', confirm: 'Confirm' };

const DRAFT_ORDER: Record<string, number> = { failed: 0, verify_failed: 0, ready: 1, drafting: 2 };

/**
 * The Respond strip: message drafts (admin payloads stay in Activity), failed first (Retry), then the ready ones most
 * recently updated first, then those still being written; then replies the app can draft (Reply & approve rows whose
 * verb is Draft reply). A draft already on a Do-now card is not a chip again.
 */
export function respondOf(drafts: readonly Draft[], replyRows: readonly HomeRow[], onCards: ReadonlySet<string>): HomeRespond {
  const live = drafts
    .filter((d) => DRAFT_LIVE.has(d.status) && !isAdminDraft(d))
    .sort((a, b) => (DRAFT_ORDER[a.status] ?? 3) - (DRAFT_ORDER[b.status] ?? 3) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const ready = live.filter((d) => d.status === 'ready').length;
  const failed = live.filter((d) => d.status === 'failed' || d.status === 'verify_failed').length;
  const draftChips: HomeRespondChip[] = live
    .filter((d) => !onCards.has(d.id))
    .map((d) => {
      const isFailed = d.status === 'failed' || d.status === 'verify_failed';
      return {
        id: d.id,
        kind: 'draft',
        who: draftWho(d),
        text: clip(draftText(d), 90),
        state: isFailed ? 'failed' : d.status === 'ready' ? 'ready' : 'drafting',
        verb: isFailed ? 'Retry' : d.status === 'ready' ? 'Send' : 'Drafting',
        href: `/outbox?draft=${encodeURIComponent(d.id)}`,
        entity: { kind: 'draft', id: d.id, label: `Draft to ${draftWho(d)}` },
      };
    });
  const drafted = new Set(live.map((d) => d.workItemId).filter((x): x is string => !!x));
  // every other reply waiting on you (the column this strip replaces): its own verb word, Blocked when it waits on
  // someone; a row that is a draft itself is already a chip above
  const replyChips: HomeRespondChip[] = replyRows
    .filter((r) => r.entity.kind !== 'draft' && !(r.item && (drafted.has(r.item.id) || onCards.has(r.item.id))) && !onCards.has(r.entity.id))
    .map((r) => ({
      id: r.item?.id ?? r.entity.id,
      kind: 'reply',
      who: clip(r.title, 48),
      text: r.why,
      state: 'can_draft',
      verb: r.state === 'blocked' ? 'Blocked' : (REPLY_VERB[r.verb.action] ?? r.verb.label),
      href: r.href,
      entity: r.entity,
    }));
  const chips = [...draftChips, ...replyChips];
  return {
    count: chips.length,
    ready,
    failed,
    chips: chips.slice(0, RESPOND_CHIPS),
    review: ready + failed ? { label: `Review ${ready + failed}`, href: '/outbox' } : null,
  };
}

const IN_FLIGHT = new Set(['queued', 'running', 'waiting_on_you']);

/** Agent runs in flight, one row each: waiting on you first, then running (earliest ETA first), then queued. */
export function buildsOf(runs: readonly AgentRun[], items: ReadonlyMap<string, WorkItem>, nowMs: number, tz: string): HomeBuild[] {
  const rank = { waiting_on_you: 0, running: 1, queued: 2 } as const;
  return runs
    .filter((r) => IN_FLIGHT.has(r.state) && !r.scheduled)
    .map((r): HomeBuild => {
      const state = r.state as HomeBuild['state'];
      const w = r.workItemId ? items.get(r.workItemId) : undefined;
      const agentMin = w?.effort.agentMin ?? 0;
      const started = r.startedAt ? toMs(r.startedAt) : null;
      let eta: number | null = null;
      if (state === 'running' && started !== null) {
        const p = r.progress;
        // progress first (elapsed ÷ share done), else the item's agent estimate from the start
        if (p && p.total > 0 && p.done > 0 && p.done < p.total) eta = started + ((nowMs - started) * p.total) / p.done;
        else if (agentMin > 0) eta = started + agentMin * MIN_MS;
        if (eta !== null && eta < nowMs) eta = null;
      }
      const etaLabel =
        state === 'waiting_on_you'
          ? 'Needs your answer'
          : state === 'queued'
            ? `Queued${agentMin ? ` · about ${dur(agentMin)}` : ''}`
            : eta !== null
              ? `ETA ${whenLabel(eta, nowMs, tz)}`
              : 'Running';
      const p = r.progress;
      return {
        id: r.id,
        title: r.title,
        state,
        etaLabel,
        eta: eta === null ? null : new Date(eta).toISOString(),
        progressLabel: p && p.total > 0 ? `${p.done} of ${p.total}${p.label ? ` · ${p.label}` : ''}` : null,
        workItemId: r.workItemId,
        deepLink: r.deepLink,
      };
    })
    .sort((a, b) => rank[a.state] - rank[b.state] || (a.eta ?? '9').localeCompare(b.eta ?? '9') || a.id.localeCompare(b.id));
}

const CLASS_WORD: Record<AdminClassId, string> = { logging: 'log time', dc: 'deal contributions', vdp: 'VDP', use_case: 'use cases', expense: 'expenses', training: 'trainings', forecast: 'forecast', sweep: 'sweeps' };

export interface AdminCandidate {
  item: WorkItem;
  youMin: number;
}

/**
 * Admin as one quiet row. `engine` is the shown ranking: `v2` draws priority@2's batch (count, minutes, next due,
 * promoted when due within the persona's window, late, or must start today); `v1` and `shadow` (priority@1.1 shown)
 * list the admin items by the persona's rules, without the batch math. Null when nothing is admin.
 */
export function adminOf(
  candidates: readonly AdminCandidate[],
  o: { engine: PriorityEngineSetting; config: Pick<PriorityConfig, 'admin'> | undefined; nowMs: number; todayEndMs: number; tz: string; todayFree: ReadonlyArray<{ s: number; e: number }>; href: string },
): HomeAdmin | null {
  const cfg = o.config ?? DEFAULT_PRIORITY_CONFIG;
  const members = candidates
    .map((c) => ({ c, cls: adminClassOf(c.item, cfg) }))
    .filter((x): x is { c: AdminCandidate; cls: AdminClassId } => x.cls !== null)
    .sort((a, b) => (a.c.item.due ?? '9').localeCompare(b.c.item.due ?? '9') || a.c.item.id.localeCompare(b.c.item.id));
  if (!members.length) return null;
  const rows = members.map(({ c, cls }) => ({
    id: c.item.id,
    title: c.item.title,
    kind: CLASS_WORD[cls],
    dueLabel: c.item.due ? `due ${whenLabel(toMs(c.item.due), o.nowMs, o.tz)}` : null,
    href: `/work/${c.item.id}`,
    item: { id: c.item.id, version: c.item.version },
  }));
  if (o.engine === 'v2') {
    const am: AdminMember[] = members.map(({ c, cls }) => {
      const dueMs = c.item.due ? toMs(c.item.due) : null;
      return { id: c.item.id, title: c.item.title, cls, youMin: c.youMin, dueMs, startByMs: c.item.startBy ? toMs(c.item.startBy) : null, late: dueMs !== null && dueMs < o.nowMs };
    });
    const b = adminBatchOf(am, {
      nowMs: o.nowMs,
      todayEndMs: o.todayEndMs,
      utcOffsetMinutes: offsetMin(o.nowMs, o.tz),
      promoteWithinH: cfg.admin.promoteWithinH,
      todayFree: o.todayFree.map((i) => ({ startMs: i.s, endMs: i.e })),
      committed: [],
    });
    if (b) {
      const order = new Map(b.itemIds.map((id, i) => [id, i]));
      return { mode: 'batch', label: b.label, count: b.count, promoted: b.promoted, rows: [...rows].sort((x, y) => (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0)), href: o.href };
    }
  }
  const kinds = [...new Set(members.map((m) => CLASS_WORD[m.cls]))];
  return { mode: 'rule', label: `Admin: ${plural(members.length, 'item')} · ${kinds.slice(0, 3).join(', ')}${kinds.length > 3 ? ' and more' : ''}`, count: members.length, promoted: false, rows, href: o.href };
}

/** "tomorrow" / "Monday" inside a sentence. */
const dayWord = (to: HomeDayRef) => (to.label === 'Tomorrow' ? 'tomorrow' : to.label);

/**
 * Overbooked → what to move: the first makeRoom row (lowest value, latest deadline first) moved to the next working
 * day, in one sentence; "Move it" runs the existing snooze to `to.startsAt` (audited, Undo). Nothing movable (all of
 * it pinned or due today): the sentence says what to do instead, and there is no button.
 */
export function moveItOf(room: MakeRoom | null, items: ReadonlyMap<string, WorkItem>, to: HomeDayRef | null): HomeMoveIt | null {
  if (!room) return null;
  const first = room.rows.find((r) => items.has(r.itemId));
  const w = first ? items.get(first.itemId)! : null;
  if (!first || !w || !to) {
    return { label: room.label, sentence: 'Nothing here can move: what is left is pinned or due today. Open one to re-date it, or ask for more time.', item: null, title: null, to: null, freesMin: 0, covers: false };
  }
  const covers = first.youMin >= room.overByMin;
  const title = clip(w.title, 60);
  const sentence = `Move “${title}” to ${dayWord(to)} to fit${covers ? '' : ` (frees about ${dur(first.youMin)} of ${dur(room.overByMin)})`}.`;
  return { label: room.label, sentence, item: { id: w.id, version: w.version }, title: w.title, to, freesMin: first.youMin, covers };
}

/** Closed for you in the last few hours, newest first (the in-place tag on a card that just left). */
export function closedNowOf(items: readonly WorkItem[], nowMs: number): HomeClosedNow[] {
  return closedForYouSince(items, nowMs - CLOSED_NOW_MS)
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''))
    .slice(0, 10)
    .map((w) => ({ id: w.id, title: w.title, badge: closedBadge(w).label, why: closedWhy(w, []), version: w.version }));
}

/** The sources the app reads right now, by name (the empty-day line: "Watching Slack, Gmail and Calendar"). */
export function watchingOf(connectors: readonly Connector[]): string[] {
  return connectors.filter((c) => c.state === 'ok' || c.state === 'catching_up').map((c) => c.label);
}
