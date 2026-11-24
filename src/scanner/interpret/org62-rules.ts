/**
 * Org62 rows interpreted by rules (scan-org62 §5 in code). Almost every Org62 decision is a join, so only one kind of
 * row reaches the classifier: an opportunity whose next step names my role's work (it may be an ask of me).
 *
 *   Event                  completion (`sure`) of a "log activity / hours" item on the same opp or subject
 *   Deal_Contribution__c   completion (`sure`) of a "DC" item on the same opp; a DC of mine on a closed-lost or "Dead…"
 *                          opp is stranded: propose "Move stranded DC from <opp>" (`likely`) unless an item exists
 *   Opportunity closed lost   contradiction `opp_closed_lost: <name>` on items of that opp (s ≥ 0.5)
 *   Opportunity closed won    context `closed_won: DC deadline applies` on my DC items (when DCs are on)
 *   newly on the team         "Get up to speed on <opp>" (`guess`) when Settings ▸ Scanning has it on (the gate drops it otherwise)
 *   next step names my work   → the classifier
 * Pure: the caller resolves candidates and writes the actions through the cc handlers.
 */
import type { ResolvedPersona } from '../../personas/types';
import type { ScanningPrefs, TimeWindow } from '../types';
import type { Action } from './apply';
import type { InterpretItem } from './types';

type P = { IsClosed?: unknown; IsWon?: unknown; TeamMemberSystemModstamp?: unknown; WhatName?: unknown; Opportunity__c?: unknown };
const yes = (v: unknown) => v === true || v === 'true';
const no = (v: unknown) => v === false || v === 'false';

/** What the persona's own work is called in a next step (scan-org62 §5: for an SE, SE, demo, POC …). */
export function roleWords(persona: ResolvedPersona | undefined): RegExp {
  return persona?.id === 'ae' ? /\b(AE|specialist|pricing|quote|proposal|business case|ROI)\b/i : /\b(SE|solutions? engineer|demo|POC|proof of concept|workshop|sizing|architecture|technical)\b/i;
}

const DATE_HINT = /\b(\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|next week|eow|eod|by \w+)\b/i;
const nextStepOf = (excerpt: string | undefined) => /(?:^|;\s*)next=([^;]*)/.exec(excerpt ?? '')?.[1]?.trim() ?? '';

export interface Org62Plan {
  actions: Action[];
  /** Rows the classifier must read. */
  units: InterpretItem[];
  /** Rows settled here (no call). */
  decided: string[];
}

export function planOrg62(rows: InterpretItem[], o: { window: TimeWindow; persona?: ResolvedPersona; prefs: ScanningPrefs; dcsOn: boolean }): Org62Plan {
  const plan: Org62Plan = { actions: [], units: [], decided: [] };
  const role = roleWords(o.persona);
  const link = (x: InterpretItem, workItemId: string, role_: 'completion' | 'contradiction' | 'context', confidence: 'sure' | 'likely', reason: string) =>
    plan.actions.push({ tool: 'cc_link_evidence', args: { workItemId, sourceItemId: x.sourceItemId, role: role_, confidence, reason: reason.slice(0, 400) } });
  for (const x of rows) {
    const it = x.item;
    const sobject = it.externalId.split(':')[0];
    const p = (it.payload ?? {}) as P;
    const title = it.title ?? '';
    if (sobject === 'Event') {
      const c = x.candidates.find((c) => /\blog\b/i.test(c.title) && c.state !== 'done');
      if (c) {
        link(x, c.workItemId, 'completion', 'sure', `org62 event logged: ${title}`);
      }
    } else if (sobject === 'Deal_Contribution__c') {
      const opp = String(p.Opportunity__c ?? '');
      const dcItem = x.candidates.find((c) => /\b(dc|deal contribution)s?\b/i.test(c.title) && !/stranded/i.test(c.title) && c.state !== 'done');
      const stranded = (yes(p.IsClosed) && no(p.IsWon)) || /^dc on dead/i.test(title);
      if (stranded) {
        if (!x.candidates.some((c) => /stranded|move .*\bdc\b/i.test(c.title))) {
          plan.actions.push({ tool: 'cc_propose_item', args: { kind: 'follow_up', title: `Move stranded DC from ${title.replace(/^DC on /, '')}`.slice(0, 160), purpose: 'My Deal Contribution is on a closed-lost or dead opportunity', ...(opp ? { oppId: opp } : {}), evidence: [{ sourceItemId: x.sourceItemId, role: 'origin', reason: 'stranded DC: the opportunity is closed lost or dead' }], confidence: 'likely' } });
        }
      } else if (dcItem) {
        link(x, dcItem.workItemId, 'completion', 'sure', `org62 DC recorded: ${title}`);
      }
    } else if (sobject === 'Opportunity') {
      const closed = yes(p.IsClosed);
      if (closed && no(p.IsWon)) {
        for (const c of x.candidates.filter((c) => c.score >= 0.5 && c.state !== 'done')) link(x, c.workItemId, 'contradiction', 'likely', `opp_closed_lost: ${title}`);
      } else if (closed && yes(p.IsWon)) {
        if (o.dcsOn) for (const c of x.candidates.filter((c) => c.score >= 0.5 && /\b(dc|deal contribution)s?\b/i.test(c.title))) link(x, c.workItemId, 'context', 'likely', 'closed_won: DC deadline applies');
      } else {
        const stamp = typeof p.TeamMemberSystemModstamp === 'string' ? Date.parse(p.TeamMemberSystemModstamp) : NaN;
        const newlyOnTeam = Number.isFinite(stamp) && stamp >= Date.parse(o.window.from) && stamp < Date.parse(o.window.to);
        if (newlyOnTeam && o.prefs.oppTeamCatchUps && !x.candidates.length) {
          plan.actions.push({ tool: 'cc_propose_item', args: { kind: 'follow_up', title: `Get up to speed on ${title}`.slice(0, 160), purpose: 'I was added to the opportunity team', ...(it.oppHints?.[0] ? { oppId: it.oppHints[0] } : {}), evidence: [{ sourceItemId: x.sourceItemId, role: 'origin', reason: 'newly on the opportunity team' }], confidence: 'guess' } });
        }
        const next = nextStepOf(it.excerpt);
        if (next && role.test(next) && DATE_HINT.test(next)) {
          plan.units.push(x);
          continue;
        }
      }
    }
    // settled by a rule: acted on above, or nothing in it for me
    plan.decided.push(x.sourceItemId);
  }
  return plan;
}
