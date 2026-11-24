/**
 * Small builders the providers share: a row with the contract's defaults, a verb, the Later verb (the existing
 * Snooze decision, `rule: needs:<kind>`), refs and source links.
 */
import type { EntityRef, NeedKind, NeedRef, NeedRow, NeedVerb, PersonaFeature, SourceRef } from '@/contract';
import { needRule, type NeedsContext } from './types';
import { nextWorkingMorning } from './urgency';

export type RowInput = Omit<NeedRow, 'id' | 'who' | 'account' | 'opp' | 'source' | 'estimateMin' | 'confidence' | 'subject' | 'also'> &
  Partial<Pick<NeedRow, 'who' | 'account' | 'opp' | 'source' | 'estimateMin' | 'confidence' | 'subject' | 'also'>> & { sourceId: string };

export function needRow(r: RowInput): NeedRow {
  const { sourceId, ...rest } = r;
  return {
    who: null,
    account: null,
    opp: null,
    source: null,
    estimateMin: null,
    confidence: null,
    subject: null,
    also: [],
    ...rest,
    id: `${r.kind}:${sourceId}`,
    urgency: Math.round(Math.max(0, Math.min(1, r.urgency)) * 1000) / 1000,
  };
}

export type VerbInput = Pick<NeedVerb, 'id' | 'label'> & Partial<Omit<NeedVerb, 'id' | 'label'>>;

export function verb(v: VerbInput): NeedVerb {
  return { kbd: null, primary: false, call: null, href: null, undoable: false, feature: null, ...v };
}

/** A route call verb (the payload the page already sends). */
export function callVerb(v: VerbInput & { route: NonNullable<NeedVerb['call']>['route']; params?: Record<string, string>; body?: Record<string, unknown> }): NeedVerb {
  const { route, params = {}, body = {}, ...rest } = v;
  return verb({ ...rest, call: { route, params, body } });
}

/** Later: the existing Snooze decision on this row until the next working morning (Undo on the toast). */
export function laterVerb(kind: NeedKind, sourceId: string, label: string, ctx: Pick<NeedsContext, 'nowMs' | 'utcOffsetMinutes'>, feature: PersonaFeature | null = null): NeedVerb {
  return callVerb({
    id: 'snooze',
    label: 'Later',
    kbd: 's',
    route: 'decideNeed',
    body: { rule: needRule(kind), subjectIds: [sourceId], kind: 'snooze', until: nextWorkingMorning(ctx), label: label.slice(0, 200) },
    undoable: true,
    feature,
  });
}

/** Whether a Later on this row is still running (it comes back by itself at `until`). */
export function isSnoozed(ctx: Pick<NeedsContext, 'decisions' | 'nowMs'>, kind: NeedKind, sourceId: string): boolean {
  const rule = needRule(kind);
  return (ctx.decisions ?? []).some((d) => d.rule === rule && d.subjectId === sourceId && (d.kind === 'not_needed' || (d.until !== null && Date.parse(d.until) > ctx.nowMs)));
}

export function refOf(e: EntityRef | null | undefined): NeedRef | null {
  return e ? { id: e.id, label: e.label, href: e.href ?? null } : null;
}

/** The first source with a link: the row's "Open in Slack" (`o`). */
export function sourceOf(sources: readonly SourceRef[] | null | undefined): NeedRow['source'] {
  const s = (sources ?? []).find((x) => !!x.url);
  return s?.url ? { label: s.label, url: s.url } : null;
}

/** The earliest valid instant, else the fallback. */
export function sinceOf(candidates: ReadonlyArray<string | null | undefined>, fallbackMs: number): string {
  let best: number | null = null;
  for (const c of candidates) {
    const t = c ? Date.parse(c) : NaN;
    if (Number.isFinite(t) && (best === null || t < best)) best = t;
  }
  return new Date(best ?? fallbackMs).toISOString();
}
