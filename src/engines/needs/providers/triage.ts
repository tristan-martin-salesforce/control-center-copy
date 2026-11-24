/**
 * Triage's rows (GET /triage), one per guess, with the verbs Triage's own rows run (app/triage/_triage/TriageRows.tsx,
 * src/components/lists/useTriageActions.ts):
 *
 *   triage_guess        asks & promises, meeting takeaways: Accept a · Not mine n · Later s; a missed opp: Claim a
 *   mapping_question    "Is this ACME or Globex?": Answer (one choice) · Not relevant n
 *   resolution_confirm  Looks done: Confirm done a · Not done n; Still needed?: Keep a · Close n
 *
 * Closed for you rows are a record, never a need (they are not counted, as on Triage).
 */
import type { NeedRow, NeedVerb, TriageItem } from '@/contract';
import { callVerb, isSnoozed, needRow, refOf, sinceOf, sourceOf, verb } from '../row';
import type { NeedProvider, NeedsContext } from '../types';
import { groupKeyOf, KIND_URGENCY, workItemUrgency } from '../urgency';

type Kind = 'triage_guess' | 'mapping_question' | 'resolution_confirm';

const GUESS = new Set<TriageItem['group']>(['asks_promises', 'meeting_takeaways', 'missed_opps']);

function kindOf(it: TriageItem): Kind | null {
  if (it.group === 'closed_for_you') return null;
  if (it.group === 'mappings' || it.kind === 'mapping') return 'mapping_question';
  if (it.group === 'looks_done' || it.group === 'still_needed') return 'resolution_confirm';
  return GUESS.has(it.group) ? 'triage_guess' : null;
}

const openVerb = (): NeedVerb => verb({ id: 'open', label: 'Open in Triage', href: '/triage' });

function verbsOf(it: TriageItem, kind: Kind): NeedVerb[] {
  const p = { id: it.id };
  const w = it.workItem;
  if (kind === 'mapping_question') {
    const m = it.mapping;
    return [
      ...(m?.choices.length
        ? [callVerb({ id: 'answer', label: 'Answer', kbd: 'a', primary: true, route: 'acceptTriage', params: p, body: { choiceId: m.choices[0]!.id }, choices: m.choices.map((c) => ({ id: c.id, label: c.label })), undoable: true })]
        : []),
      callVerb({ id: 'dismiss', label: 'Not relevant', kbd: 'n', route: 'dismissTriage', params: p, body: { reason: 'not_relevant' }, undoable: true }),
      openVerb(),
    ];
  }
  if (kind === 'resolution_confirm' && w) {
    if (it.group === 'still_needed')
      return [
        callVerb({ id: 'keep', label: 'Keep', kbd: 'a', primary: true, route: 'acceptTriage', params: p, body: {}, undoable: true }),
        callVerb({ id: 'close', label: 'Close', kbd: 'n', route: 'itemAction', params: { id: w.id, verb: 'resolve' }, body: { ifVersion: w.version, resolution: 'not_needed' }, undoable: true }),
        openVerb(),
      ];
    return [
      callVerb({ id: 'confirm', label: 'Confirm done', kbd: 'a', primary: true, route: 'itemAction', params: { id: w.id, verb: 'confirm-done' }, body: { ifVersion: w.version }, undoable: true }),
      callVerb({ id: 'not_done', label: 'Not done', kbd: 'n', route: 'itemAction', params: { id: w.id, verb: 'not-done' }, body: { ifVersion: w.version }, undoable: true }),
      openVerb(),
    ];
  }
  if (it.kind === 'missed_opp') {
    const m = it.missedOpp;
    return [
      // one Claim verb: a DC request on the next logging canvas (nothing goes to Org62 until its Apply)
      callVerb({ id: 'claim', label: m?.verdict === 'check' ? 'Check, then claim' : 'Claim', kbd: 'a', primary: true, route: 'acceptTriage', params: p, body: {}, undoable: true, feature: 'missedOpps' }),
      callVerb({ id: 'dismiss', label: 'Not my account', kbd: 'n', route: 'dismissTriage', params: p, body: { reason: 'not_my_account' }, undoable: true }),
      openVerb(),
    ];
  }
  return [
    callVerb({ id: 'accept', label: 'Accept', kbd: 'a', primary: true, route: 'acceptTriage', params: p, body: {}, undoable: true }),
    callVerb({ id: 'dismiss', label: 'Not mine', kbd: 'n', route: 'dismissTriage', params: p, body: { reason: 'not_mine' }, undoable: true }),
    callVerb({ id: 'snooze', label: 'Later', kbd: 's', route: 'dismissTriage', params: p, body: { reason: 'later' }, undoable: true }),
    openVerb(),
  ];
}

function rowOf(it: TriageItem, kind: Kind, ctx: NeedsContext): NeedRow | null {
  const verbs = verbsOf(it, kind);
  if (!verbs.some((v) => v.primary)) return null;
  const w = it.workItem;
  // a dated guess takes priority@2's urgency; an undated one the kind's (a guess to confirm is not "no need-by" work)
  const urgency = w && kind === 'triage_guess' && (w.due || w.startBy) ? workItemUrgency(w, ctx) : KIND_URGENCY[kind];
  const m = it.missedOpp;
  return needRow({
    kind,
    sourceId: it.id,
    title: it.title,
    why: it.why,
    who: w?.counterparty ? { id: w.counterparty.id, label: w.counterparty.name, href: null } : null,
    account: refOf(w?.refs.account) ?? (m ? { id: null, label: m.accountName, href: null } : null),
    opp: refOf(w?.refs.opp) ?? (m ? { id: m.oppId, label: m.oppName, href: null } : null),
    verbs,
    groupKey: groupKeyOf(kind, urgency, w?.due, ctx),
    urgency,
    since: sinceOf([it.createdAt, w?.createdAt], ctx.nowMs),
    source: sourceOf(it.sources.length ? it.sources : w?.sources),
    estimateMin: w ? w.effort.youMin : null,
    confidence: it.confidence,
    subject: w ? `item:${w.id}` : m?.oppId ? `opp:${m.oppId}` : null,
  });
}

function triageRows(kind: Kind) {
  return (ctx: NeedsContext): NeedRow[] => {
    const out: NeedRow[] = [];
    for (const g of ctx.triage?.groups ?? [])
      for (const it of g.items) {
        if (kindOf(it) !== kind || isSnoozed(ctx, kind, it.id)) continue;
        const r = rowOf(it, kind, ctx);
        if (r) out.push(r);
      }
    return out;
  };
}

export const triageGuessProvider: NeedProvider = { kind: 'triage_guess', run: triageRows('triage_guess') };
export const mappingQuestionProvider: NeedProvider = { kind: 'mapping_question', run: triageRows('mapping_question') };
export const resolutionConfirmProvider: NeedProvider = { kind: 'resolution_confirm', run: triageRows('resolution_confirm') };
