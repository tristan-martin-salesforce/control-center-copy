/** Closure invariants over random items × random signals (hand-rolled generators). */
import { describe, expect, it } from 'vitest';
import { applyDecision, undoDecision } from '@/engines/closure/apply';
import { applySignal, isLocked, isNotMine } from '@/engines/closure/machine';
import {
  DEFAULT_CLOSURE_SETTINGS,
  LIVE_STATUSES,
  WORK_ITEM_STATUSES,
  type ClosureItem,
  type ClosureSettings,
  type Signal,
  type WorkItemKind,
} from '@/engines/types';
import { int, pick, rng } from '../priority/fixtures';
import { citem, daysBefore, plus, SIGNALS } from './fixtures';

const KINDS: WorkItemKind[] = ['task', 'commitment', 'ask', 'training', 'follow_up', 'travel', 'deliverable'];
const RESOLUTIONS = [undefined, 'done_by_me', 'handed_off', 'done_by_other', 'not_needed', 'duplicate', 'declined', 'superseded'] as const;
const INVOLVEMENT = ['owner', 'owner', 'owner', 'contributor', 'watcher', 'not_involved'] as const;
const LOCKS = [[], [], [], ['status'], ['state'], ['involvement'], ['waitingReason'], ['status', 'involvement']];
const SIGNAL_LIST = Object.values(SIGNALS);

function genItem(r: () => number): ClosureItem {
  const status = pick(r, WORK_ITEM_STATUSES);
  const it = citem({
    id: `w${int(r, 1, 999)}`,
    version: int(r, 1, 20),
    kind: pick(r, KINDS),
    status,
    closureKind: pick(r, ['manual_only', 'reply_in_thread', 'email_sent', 'claude_session_completed', 'deliverable_judged'] as const),
    involvement: pick(r, INVOLVEMENT),
    userLockedFields: pick(r, LOCKS),
  });
  if (r() < 0.2) it.autoCloseAllowed = false;
  if (status === 'done') {
    it.doneAt = daysBefore(int(r, 0, 30));
    it.doneBy = 'user';
    const res = pick(r, RESOLUTIONS);
    if (res) it.resolution = res;
    if (res === 'duplicate' || res === 'superseded') it.resolutionDetail = { inferred: false, relatedItemId: 'w-surv' };
  }
  if (status === 'dismissed') it.dismissedAt = daysBefore(int(r, 0, 30));
  if (status === 'snoozed') {
    it.snoozedUntil = plus(int(r, -120, 240));
    it.snoozedFromStatus = pick(r, ['open', 'in_progress', 'waiting_on_others'] as const);
  }
  if (status === 'waiting_on_me') it.waitingReason = 'Session asked something';
  if (status === 'waiting_on_others') it.nudgeAt = plus(int(r, -60, 240));
  if (status === 'likely_done') it.likelyDoneFromStatus = pick(r, ['open', 'in_progress', 'waiting_on_others', 'waiting_on_me'] as const);
  if (status === 'merged') it.mergedIntoId = 'w-surv';
  return it;
}

function genSettings(r: () => number): ClosureSettings {
  return {
    reopenWindowDays: pick(r, [7, 14, 30]),
    autoCloseSure: r() < 0.8,
    snoozeWakeOnNewInfo: r() < 0.2,
    handoffInvolvement: pick(r, ['watcher', 'not_involved'] as const),
  };
}

describe('closure properties (5000 random item × signal pairs)', () => {
  it('holds every invariant', () => {
    let transitions = 0;
    for (let seed = 1; seed <= 5000; seed++) {
      const r = rng(seed);
      const item = genItem(r);
      const signal: Signal = pick(r, SIGNAL_LIST);
      const settings = r() < 0.5 ? DEFAULT_CLOSURE_SETTINGS : genSettings(r);
      const d = applySignal(item, signal, settings);
      const ctx = `seed ${seed}: ${item.status}/${signal.type}`;

      // Deterministic.
      expect(applySignal(item, signal, settings), ctx).toEqual(d);
      // Undoable: apply then undo restores the exact item.
      const { item: after } = applyDecision(item, d);
      expect(undoDecision(after, d), ctx).toEqual(item);
      // Locked fields are never written; a locked status never transitions.
      for (const c of d.fieldChanges) expect(isLocked(item, c.field), ctx).toBe(false);
      if (isLocked(item, 'status')) expect(d.transition, ctx).toBeNull();
      for (const p of d.proposals) expect(p.baseVersion, ctx).toBe(item.version);
      // Run state iff a session signal.
      expect(d.runState !== null, ctx).toBe(signal.type === 'session');

      if (d.transition) {
        transitions++;
        const t = d.transition;
        expect(t.from, ctx).toBe(item.status);
        expect(t.to, ctx).not.toBe(t.from);
        // Engines never move items into user-only states.
        expect(['suggested', 'snoozed', 'dismissed', 'merged'], ctx).not.toContain(t.to);
        // Backward moves out of done/dismissed only via a reopen decision.
        if (t.from === 'done' || t.from === 'dismissed') {
          expect(t.to, ctx).toBe('open');
          expect(d.reopenDecision?.outcome, ctx).toBe('reopened');
        }
        // DB guards: done ⇔ done_at + done_by, with completion evidence and a resolution.
        if (t.to === 'done') {
          expect(after.doneAt, ctx).toBeTruthy();
          expect(after.doneBy, ctx).toBe('engine');
          expect(t.evidenceId, ctx).toBeTruthy();
          expect(d.resolution, ctx).not.toBeNull();
          expect(t.autonomy, ctx).toBe('L4_auto');
        }
        if (t.to === 'waiting_on_me') expect(after.waitingReason, ctx).toBeTruthy();
        if (t.to === 'likely_done') expect(LIVE_STATUSES, ctx).toContain(after.likelyDoneFromStatus);
        // Snoozed and dismissed only come back by timer, direct ask, or the opt-in.
        if (t.from === 'snoozed') expect(signal.type === 'timer' || signal.type === 'loop_back' || settings.snoozeWakeOnNewInfo, ctx).toBe(true);
        if (t.from === 'dismissed') expect(signal.type, ctx).toBe('loop_back');
      }
      // Not mine: only a direct ask or the clock changes anything.
      if (isNotMine(item) && signal.type !== 'loop_back' && signal.type !== 'timer') {
        expect(['none'], ctx).toContain(d.kind);
        if (item.status !== 'merged') expect(d.recordAs, ctx).toBe('context');
      }
      // Siblings never modify the done item.
      if (d.kind === 'sibling') {
        expect(d.fieldChanges, ctx).toEqual([]);
        expect(d.sibling!.relation.toWorkItemId, ctx).toBe(item.id);
        expect(d.sibling!.initiativeId, ctx).toBe(item.initiativeId ?? null);
      }
    }
    expect(transitions).toBeGreaterThan(300);
  }, 60_000); // 5000 generated pairs; slow under a loaded full-suite run
});
