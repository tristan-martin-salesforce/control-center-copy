/**
 * Triage, read side (R7 step 3): every suggestion, the likely-done items, missed opps and mapping questions, and what
 * closed for you, in focus order. One body for both DataSources (docs/reviews/2026-11-20-holistic/19-read-twins.md);
 * what only a store knows (the undo id of each close) comes in as `closed.undoOf`.
 */
import type { TriageItem, TriagePayload, WorkItem, WorkItemRecord } from '@/contract';
import { closedForYouSince, closedWhy, type ClosedEvidence } from '@/engines/home/closed';
import { looksDoneEvidence } from '@/engines/home/looks-done';
import { isStillNeeded, stillNeededWhy } from '@/engines/still-needed';
import { featureActive, personaOf } from '@/personas';

import type { ReadSource } from './source';
import { hydrateItem } from './work';

/** Triage's groups in focus order (LD-1: likely-done work first, one click each; SETTLE-1: what closed for you, last). */
export const TRIAGE_ORDER = ['looks_done', 'asks_promises', 'meeting_takeaways', 'missed_opps', 'mappings', 'still_needed', 'closed_for_you'] as const;
export const TRIAGE_LABELS = { looks_done: 'Looks done', asks_promises: 'Asks & promises', meeting_takeaways: 'Meeting takeaways', missed_opps: 'Missed opps', mappings: 'Mappings', still_needed: 'Still needed?', closed_for_you: 'Closed for you' };

/** SETTLE-1: the groups that hold guesses to confirm (`TriagePayload.count`, the nav badge); Closed for you is a record. */
export const triageCount = (items: ReadonlyArray<Pick<TriageItem, 'group'>>) => items.filter((i) => i.group !== 'closed_for_you').length;

/** SETTLE-1: what the Closed for you group needs: the window's start, and item id → the undo audit id of its close. */
export interface ClosedInputs {
  sinceMs: number;
  undoOf: (itemId: string) => string | null;
}

/**
 * SETTLE-1: an engine close as a Triage row, newest first (`createdAt` = when it closed). Its why is the plain reason
 * and how long after the ask; Undo is the close's audit id (null: Reopen instead).
 */
export function closedTriageItem(w: WorkItemRecord, workItem: WorkItem, evidence: ReadonlyArray<ClosedEvidence>, undoAuditId: string | null): TriageItem {
  return { id: w.id, group: 'closed_for_you', kind: 'work_item', title: w.title, why: closedWhy(w, evidence), confidence: w.confidence, sources: w.sources, createdAt: w.doneAt ?? w.updatedAt, workItem, missedOpp: null, mapping: null, undoAuditId };
}

/** A suggestion's Triage group and why (DEEP-1: an old ask waits as "Still needed?", its why says how old). */
export function suggestionGroup(w: Pick<WorkItemRecord, 'kind' | 'state' | 'closedReason' | 'why'>): { group: 'still_needed' | 'meeting_takeaways' | 'asks_promises'; why: string } {
  if (isStillNeeded(w)) return { group: 'still_needed', why: stillNeededWhy(w.closedReason!) };
  return { group: w.kind === 'follow_up' ? 'meeting_takeaways' : 'asks_promises', why: w.why };
}

/** LD-1: a likely-done item as a Triage row: Confirm or Not done, with the evidence line as its why. */
export function looksDoneTriageItem(w: WorkItemRecord, workItem: WorkItem): TriageItem {
  return { id: w.id, group: 'looks_done', kind: 'work_item', title: w.title, why: looksDoneEvidence(workItem), confidence: w.confidence, sources: w.sources, createdAt: w.updatedAt, workItem, missedOpp: null, mapping: null };
}

/** GET /triage, and the lookup the triage writes act on (called without `closed`, the Closed for you group is empty). */
export function triageView(src: ReadSource, closed?: ClosedInputs): TriagePayload {
  const items: TriageItem[] = [];
  // DEEP-1: every suggestion, from the model (no row limit: the Still needed? group can be long)
  for (const w of src.all('workItems')) {
    if (w.state === 'likely_done') {
      items.push(looksDoneTriageItem(w, hydrateItem(src, w)));
      continue;
    }
    if (w.state !== 'suggested') continue;
    const sg = suggestionGroup(w);
    items.push({ id: w.id, group: sg.group, kind: 'work_item', title: w.title, why: sg.why, confidence: w.confidence, sources: w.sources, createdAt: w.createdAt, workItem: hydrateItem(src, w), missedOpp: null, mapping: null });
  }
  // D-55: missed opps (deal contributions) only while the persona has them active
  for (const mo of featureActive(personaOf(src.settings()), 'missedOpps') ? src.all('missedOpps') : []) {
    if (mo.status !== 'new') continue;
    // Provenance on everything: the Org62 source links the opp's record when the app has it
    const oppUrl = mo.oppId ? src.get('opps', mo.oppId)?.org62Url : null;
    items.push({
      id: mo.id,
      group: 'missed_opps',
      kind: 'missed_opp',
      title: `${mo.verdict === 'claim' ? 'Claim' : 'Check'}: ${mo.oppName}`,
      why: mo.evidence[0] ?? 'Possible missed opportunity',
      confidence: mo.verdict === 'claim' ? 'likely' : 'guess',
      sources: [{ kind: 'org62', label: `Org62 · ${mo.accountName}`, ...(oppUrl ? { url: oppUrl } : {}) }],
      createdAt: mo.foundAt,
      workItem: null,
      missedOpp: mo,
      mapping: null,
    });
  }
  for (const q of src.all('mappings')) {
    if (q.status !== 'open') continue;
    items.push({ id: q.id, group: 'mappings', kind: 'mapping', title: q.question, why: `About ${q.subject.label}`, confidence: 'guess', sources: [q.source], createdAt: q.createdAt, workItem: null, missedOpp: null, mapping: q });
  }
  // SETTLE-1: what closed for you in the window (a record, never counted)
  if (closed) {
    const evidence = src.all('evidence');
    for (const w of closedForYouSince(src.all('workItems'), closed.sinceMs)) items.push(closedTriageItem(w, hydrateItem(src, w), evidence, closed.undoOf(w.id)));
  }
  return {
    groups: TRIAGE_ORDER.map((g) => ({ group: g, label: TRIAGE_LABELS[g], items: items.filter((i) => i.group === g).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })),
    count: triageCount(items),
  };
}
