/**
 * The Needs-you queue on the client, pure (tested in tests/needs/model.test.ts): words per kind and group, which
 * kinds a page shows, a row's primary verb and its review verbs, the panel entity a row opens, and the optimistic
 * patch that takes a decided row out of the cached queue at once.
 */
import type { NeedGroupKey, NeedKind, NeedRow, NeedsPayload, NeedVerb } from '@/contract';
import type { PanelEntity } from '@/components/shell/panel';

/** The row's badge: what it is, in one word or two. */
export const KIND_LABEL: Readonly<Record<NeedKind, string>> = {
  triage_guess: 'To confirm',
  outbox_draft: 'Draft',
  time_ready_to_log: 'Time',
  vdp_change: 'VDP',
  dc_suggestion: 'DC',
  mapping_question: 'Question',
  spend_ask: 'Spend',
  resolution_confirm: 'Looks done',
  setup_step: 'Setup',
  use_case_candidate: 'Use case',
  reopen_review: 'Reopened',
};

export const GROUP_LABEL: Readonly<Record<NeedGroupKey, string>> = { today: 'Today', this_week: 'This week', deal: 'Deals', admin: 'Admin' };
export const GROUP_ORDER: readonly NeedGroupKey[] = ['today', 'this_week', 'deal', 'admin'];

/** What Activity's needs area shows: its own slice of the one queue. */
export const ACTIVITY_KINDS: readonly NeedKind[] = ['time_ready_to_log', 'dc_suggestion', 'vdp_change', 'use_case_candidate'];

/** Kinds the AI guessed (the ✦ AI chip). */
const AI_KINDS: ReadonlySet<NeedKind> = new Set(['triage_guess', 'dc_suggestion', 'resolution_confirm', 'mapping_question', 'use_case_candidate']);
export const isAiKind = (k: NeedKind): boolean => AI_KINDS.has(k);

export function primaryOf(r: Pick<NeedRow, 'verbs'>): NeedVerb | null {
  return r.verbs.find((v) => v.primary) ?? r.verbs[0] ?? null;
}

/** The verbs drain mode maps to `a` / `s` / `x` (each must be a call: drain never navigates away). */
export function reviewVerbs(r: Pick<NeedRow, 'verbs'>): { approve: NeedVerb | null; snooze: NeedVerb | null; dismiss: NeedVerb | null } {
  const p = primaryOf(r);
  const call = (v: NeedVerb | null | undefined) => (v?.call ? v : null);
  const dismiss = r.verbs.find((v) => v.call && ['dismiss', 'reject', 'not_done', 'close', 'stop'].includes(v.id)) ?? null;
  return { approve: call(p && p.id !== 'answer' ? p : null), snooze: call(r.verbs.find((v) => v.id === 'snooze')), dismiss };
}

/** Rows drain mode can walk: their primary verb is decided here (not Review in the Outbox, not a choice to pick). */
export function reviewableNeeds(rows: readonly NeedRow[]): NeedRow[] {
  return rows.filter((r) => !!reviewVerbs(r).approve);
}

/** What Enter opens in the Details panel; null: the row's page (its open verb). */
export function panelEntityOf(r: Pick<NeedRow, 'id' | 'kind' | 'subject' | 'title'>): PanelEntity | null {
  const sid = r.id.slice(r.id.indexOf(':') + 1);
  if (r.subject?.startsWith('item:')) return { kind: 'work_item', id: r.subject.slice(5), label: r.title };
  if (r.kind === 'outbox_draft') return { kind: 'draft', id: sid, label: r.title };
  if (r.kind === 'vdp_change') return { kind: 'vdp', id: sid.replace(/^vdp:/, '').replace(/^new:/, ''), label: r.title };
  return null;
}

/** Where the row's page is (its first navigation verb). */
export function hrefOf(r: Pick<NeedRow, 'verbs'>): string | null {
  return r.verbs.find((v) => v.href)?.href ?? null;
}

/** The cached queue without a row (optimistic: a decided row leaves at once; Undo or a refetch brings it back). */
export function withoutNeed(q: NeedsPayload, id: string): NeedsPayload {
  const gone = q.rows.find((r) => r.id === id);
  if (!gone) return q;
  return { ...q, rows: q.rows.filter((r) => r.id !== id), total: Math.max(0, q.total - 1), byKind: { ...q.byKind, [gone.kind]: Math.max(0, (q.byKind[gone.kind] ?? 0) - 1) } };
}

export function rowsOfKinds(rows: readonly NeedRow[] | undefined, kinds: readonly NeedKind[] | null): NeedRow[] | undefined {
  if (!rows) return undefined;
  if (!kinds) return [...rows];
  const want = new Set(kinds);
  return rows.filter((r) => want.has(r.kind) || r.also.some((k) => want.has(k)));
}

/** "~5 min" / "~1 h 30" (an estimate). */
export function estimateText(min: number | null): string | null {
  if (min === null || min <= 0) return null;
  if (min < 60) return `~${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `~${h} h${m ? ` ${m}` : ''}`;
}
