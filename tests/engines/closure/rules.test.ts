/** Each closure rule, with the reasons, resolutions, labels and undo it promises. */
import { describe, expect, it } from 'vitest';
import { applyDecision, undoDecision } from '@/engines/closure/apply';
import { applySignal, normalizeSignal } from '@/engines/closure/machine';
import { DEFAULT_CLOSURE_SETTINGS, type Signal } from '@/engines/types';
import { citem, DANA, daysBefore, ME, plus, ROWS, SAM, SIGNALS, T0 } from './fixtures';

const S = SIGNALS as Record<keyof typeof SIGNALS, Signal>;

describe('Sure vs Likely completion', () => {
  it('Sure auto-closes as done (L4 internal) with an inferred resolution and its evidence', () => {
    const d = applySignal(citem({ status: 'in_progress' }), S.done_sure!);
    expect(d.kind).toBe('transition');
    expect(d.transition).toMatchObject({ from: 'in_progress', to: 'done', evidenceId: 'ev-done', autonomy: 'L4_auto', actor: 'engine' });
    expect(d.resolution).toEqual({
      resolution: 'done_by_me',
      detail: { inferred: true, evidenceIds: ['ev-done'], note: 'you posted "done, see deck" in #acme-ext' },
    });
    expect(d.labels[0]).toEqual({ kind: 'auto_closed', text: 'Closed for you · Done by you: you posted "done, see deck" in #acme-ext' });
    const after = applyDecision(citem({ status: 'in_progress' }), d).item;
    expect(after).toMatchObject({ status: 'done', doneAt: T0, doneBy: 'engine', resolution: 'done_by_me' });
    // R-UI-15: the deck stays linked as the item's deliverable.
    expect(after.deliverableRefs).toEqual(['file-deck']);
  });

  it('Likely goes to likely_done and asks to confirm, remembering where it came from', () => {
    const d = applySignal(citem({ status: 'in_progress' }), S.done_likely!);
    expect(d.transition).toMatchObject({ from: 'in_progress', to: 'likely_done' });
    expect(d.resolution).toBeNull();
    expect(d.labels[0]!.text).toBe('Likely done · Confirm: you shared a deck link');
    const after = applyDecision(citem({ status: 'in_progress' }), d).item;
    expect(after.likelyDoneFromStatus).toBe('in_progress');
    expect(after.likelyDone).toEqual({ reason: 'you shared a deck link', evidenceId: 'ev-done-l', proposedResolution: 'done_by_me' });
  });

  it('Sure on a likely-done item closes it ("confidence reaches the threshold")', () => {
    expect(applySignal(ROWS.likely_done!, S.done_sure!).transition).toMatchObject({ from: 'likely_done', to: 'done' });
  });

  it('falls back to Likely when auto-close is off for the user or the item', () => {
    expect(applySignal(citem(), S.done_sure!, { ...DEFAULT_CLOSURE_SETTINGS, autoCloseSure: false }).transition!.to).toBe('likely_done');
    expect(applySignal(citem({ autoCloseAllowed: false }), S.done_sure!).transition!.to).toBe('likely_done');
  });

  it('a Guess only attaches evidence', () => {
    const d = applySignal(citem(), S.done_guess!);
    expect(d.kind).toBe('none');
    expect(d.labels[0]!.kind).toBe('guess');
  });

  it('infers done_by_other and handed_off from who did it', () => {
    const byOmar: Signal = { ...S.done_sure!, actor: { id: 'p-omar', name: 'Omar' }, reason: 'Omar posted the deck in #acme' } as Signal;
    const d = applySignal(citem(), byOmar);
    expect(d.resolution).toMatchObject({ resolution: 'done_by_other', detail: { personName: 'Omar', personId: 'p-omar' } });
    expect(d.labels[0]!.text).toBe('Closed for you · Done by Omar: Omar posted the deck in #acme');

    const handoff: Signal = { type: 'evidence', role: 'completion', confidence: 'sure', resolution: 'handed_off', resolutionPerson: { id: 'p-kim', name: 'Kim' }, evidenceId: 'ev-h', at: T0, source: 'slack', actor: ME, reason: 'you: "Kim will take this one"' };
    const h = applySignal(citem(), handoff);
    expect(h.resolution).toMatchObject({ resolution: 'handed_off', detail: { personName: 'Kim' } });
    expect(h.fieldChanges).toContainEqual({ field: 'involvement', before: 'owner', after: 'watcher' });
    expect(h.labels[0]!.text).toContain('Handed off → Kim');
    expect(applySignal(citem(), handoff, { ...DEFAULT_CLOSURE_SETTINGS, handoffInvolvement: 'not_involved' }).fieldChanges).toContainEqual({ field: 'involvement', before: 'owner', after: 'not_involved' });
  });
});

describe('deterministic closures and Drive (R-UI-1, R-UI-15)', () => {
  it('a reply after the ask closes the ask', () => {
    const d = applySignal(citem({ kind: 'ask', closureKind: 'manual_only' }), S.reply_me!);
    expect(d.transition!.to).toBe('done');
    expect(d.resolution!.resolution).toBe('done_by_me');
    expect(d.reason).toBe('Done by you: you replied in the thread after the ask');
  });

  it('DONE-2: the closed reason drops the writer prefixes, and an asker\'s "Resolved by" reads once', () => {
    const mine = applySignal(citem({ kind: 'ask', closureKind: 'manual_only' }), { ...S.reply_me!, reason: "triage: My reply 'Yep here you go!' after the ask" });
    expect(mine.reason).toBe("Done by you: your reply 'Yep here you go!' after the ask");
    const att = applySignal(citem({ kind: 'ask', closureKind: 'manual_only' }), { ...S.reply_me!, reason: 'delivered_with_attachment: link (doc); done_check: shared the editable doc' });
    expect(att.reason).toBe('Done by you: shared the editable doc · with link (doc)');
    const other = applySignal(citem({ kind: 'ask', closureKind: 'manual_only' }), { ...S.reply_me!, actor: { name: 'PERSON_A', isMe: false }, reason: 'done_check: Resolved by PERSON_A: asker will get it from PERSON_B instead' });
    expect(other.reason).toBe('Resolved by PERSON_A: asker will get it from PERSON_B instead');
  });

  it('a reply on a non-ask task is only progress', () => {
    expect(applySignal(citem({ kind: 'task', closureKind: 'manual_only' }), S.reply_me!).transition!.to).toBe('in_progress');
  });

  it('"I\'ll send an email" then the email is sent with the deck: the commitment closes', () => {
    const d = applySignal(citem({ kind: 'commitment', closureKind: 'email_sent' }), S.email_sent!);
    expect(d.transition!.to).toBe('done');
    expect(d.labels.map((l) => l.text)).toEqual(['Closed for you · Done by you: you sent it with the file attached', 'Sent with the file attached']);
  });

  it('a Drive-only edit is progress; "updates made" is likely done, never auto-done', () => {
    expect(applySignal(citem({ kind: 'deliverable' }), S.drive_edit!).transition).toMatchObject({ to: 'in_progress', reason: 'In progress: you edited the file' });
    const yes = applySignal(citem({ kind: 'deliverable', status: 'in_progress' }), S.drive_yes!);
    expect(yes.transition!.to).toBe('likely_done');
    expect(yes.labels[0]!.text).toBe('Likely done · Confirm: requested updates made in the file (edited by you)');
  });

  it('Drive edits by someone else are context; their "updates made" proposes done_by_other', () => {
    const other: Signal = { ...S.drive_edit!, editedByMe: false, editorName: 'Kim' } as Signal;
    expect(applySignal(citem(), other)).toMatchObject({ kind: 'none', recordAs: 'context' });
    const yes: Signal = { ...S.drive_yes!, editedByMe: false, editorName: 'Kim' } as Signal;
    const after = applyDecision(citem(), applySignal(citem(), yes)).item;
    expect(after.likelyDone!.proposedResolution).toBe('done_by_other');
  });

  it('partial updates pull a likely-done deliverable back to in progress', () => {
    expect(applySignal(ROWS.likely_done!, S.drive_partial!).transition).toMatchObject({ from: 'likely_done', to: 'in_progress' });
  });

  it('a Slack "done" from me closes it, with the deck linked', () => {
    const d = applySignal(citem({ kind: 'deliverable', closureKind: 'deliverable_judged' }), S.done_sure!);
    expect(d.transition!.to).toBe('done');
    expect(d.fieldChanges.some((c) => c.field === 'deliverableRefs')).toBe(false);
  });

  it('a contradiction steps a likely-done item back to where it was', () => {
    const d = applySignal(ROWS.likely_done!, S.contradiction!);
    expect(d.transition).toMatchObject({ from: 'likely_done', to: 'in_progress' });
    expect(d.labels[0]!.text).toBe('Not done: Dana: the pricing slide is still old');
  });
});

describe('reopen vs sibling (R-UI-20), boundary at reopen.window_days', () => {
  const doneAgo = (days: number, extraMs = 0) => citem({ status: 'done', doneAt: new Date(Date.parse(daysBefore(days)) - extraMs).toISOString(), doneBy: 'user', resolution: 'done_by_me', reopenedCount: 1 });

  it('same deliverable, closed exactly 14 days ago: reopens', () => {
    const d = applySignal(doneAgo(14), S.requirement!);
    expect(d.kind).toBe('transition');
    expect(d.transition).toMatchObject({ from: 'done', to: 'open' });
    expect(d.reopenDecision).toEqual({
      outcome: 'reopened',
      ruleKey: 'same_deliverable_recent',
      explanation: 'Reopened: new requirement from Sam (same deliverable, closed 14d ago)',
      daysSinceClosed: 14,
      windowDays: 14,
    });
    expect(d.labels).toEqual([{ kind: 'reopened', text: 'Reopened: new requirement from Sam · Undo' }]);
    const after = applyDecision(doneAgo(14), d).item;
    expect(after).toMatchObject({ status: 'open', doneAt: null, resolution: null, reopenedCount: 2, lastReopenedAt: T0 });
  });

  it('one millisecond past the window: a sibling under the same initiative and parent', () => {
    const item = doneAgo(14, 1);
    const d = applySignal(item, S.requirement!);
    expect(d.kind).toBe('sibling');
    expect(d.transition).toBeNull();
    expect(d.sibling).toEqual({
      kind: 'ask',
      title: 'Add the pricing slide',
      status: 'open',
      initiativeId: 'ini-acme-p2',
      parentId: 'w0',
      relation: { kind: 'follow_up_of', toWorkItemId: 'w1' },
      involvement: 'owner',
      originEvidenceId: 'ev-req',
      label: { kind: 'new_sibling', text: 'New task: new requirement from Sam · Undo' },
    });
    expect(d.reopenDecision).toMatchObject({ outcome: 'new_sibling', ruleKey: 'outside_window' });
    expect(d.reopenDecision!.explanation).toBe('New task: new requirement from Sam (original closed 14d ago)');
    // The done item is untouched.
    expect(applyDecision(item, d).item).toEqual(item);
  });

  it('a different deliverable opens a sibling even when recent', () => {
    const d = applySignal(doneAgo(2), { ...S.requirement!, deliverableRef: 'file-other' } as Signal);
    expect(d.kind).toBe('sibling');
    expect(d.reopenDecision).toMatchObject({ ruleKey: 'different_deliverable' });
    expect(d.reopenDecision!.explanation).toBe('New task: new requirement from Sam (different deliverable)');
    // …and the scanner's sameDeliverable verdict wins over the file comparison.
    expect(applySignal(doneAgo(2), { ...S.requirement!, deliverableRef: 'file-other', sameDeliverable: true } as Signal).kind).toBe('transition');
  });

  it('a message from before the close never reopens it: attached as context, the skipped reopen says why', () => {
    // you closed it an hour after the ask was posted; a thread re-read linked the ask only now
    const closedAfter = citem({ status: 'done', doneAt: plus(60), doneBy: 'user', resolution: 'done_by_me' });
    for (const sig of [S.requirement!, S.contradiction!, S.loop_back!]) {
      const d = applySignal(closedAfter, sig);
      expect(d).toMatchObject({ kind: 'none', transition: null, sibling: null, recordAs: 'context' });
      expect(d.labels).toEqual([{ kind: 'already_done', text: 'Already done: this message is from before it was closed' }]);
      expect(d.reopenDecision).toMatchObject({ outcome: 'ignored', ruleKey: 'older_than_close' });
      expect(applyDecision(closedAfter, d).item).toMatchObject({ status: 'done', doneAt: plus(60), resolution: 'done_by_me' });
    }
    // the same second as the close counts as before it; a dismissed item works the same way
    expect(applySignal(citem({ status: 'done', doneAt: T0, doneBy: 'user', resolution: 'done_by_me' }), S.requirement!).kind).toBe('none');
    expect(applySignal(citem({ status: 'dismissed', dismissedAt: plus(1) }), S.loop_back!).kind).toBe('none');
    // one second after the close it is new: it reopens as before
    expect(applySignal(citem({ status: 'done', doneAt: new Date(Date.parse(T0) - 1000).toISOString(), doneBy: 'user', resolution: 'done_by_me' }), S.requirement!).kind).toBe('transition');
  });

  it('honours a user’s reopen window setting', () => {
    expect(applySignal(doneAgo(10), S.requirement!, { ...DEFAULT_CLOSURE_SETTINGS, reopenWindowDays: 7 }).kind).toBe('sibling');
    expect(applySignal(doneAgo(10), S.requirement!).kind).toBe('transition');
  });

  it('new requirements on a live item stay inline (the NBA re-runs)', () => {
    expect(applySignal(citem({ status: 'in_progress' }), S.requirement!)).toMatchObject({
      kind: 'none',
      labels: [{ kind: 'new_requirement', text: 'New requirement from Sam: Add the pricing slide' }],
    });
  });
});

describe('handed off: context only, except a direct ask → looped back in (R-UI-22)', () => {
  const handedOff = ROWS['done (handed off, 3d)']!;

  it('new info on a handed-off item is recorded as context and changes nothing', () => {
    for (const k of ['origin', 'progress', 'done_sure', 'requirement', 'session_waiting', 'email_sent'] as const) {
      const d = applySignal(handedOff, S[k]!);
      expect(d).toMatchObject({ kind: 'none', recordAs: 'context' });
      expect(d.labels[0]!.text).toBe('Context only: handed off to Kim');
    }
  });

  it('a direct ask reopens it, makes me owner again and says why', () => {
    const d = applySignal(handedOff, S.loop_back!);
    expect(d.transition).toMatchObject({ from: 'done', to: 'open' });
    expect(d.labels).toEqual([{ kind: 'looped_back_in', text: 'Looped back in: Dana asked you directly · Undo' }]);
    expect(d.reopenDecision).toMatchObject({ outcome: 'reopened', ruleKey: 'loop_back_recent' });
    const after = applyDecision(handedOff, d).item;
    expect(after).toMatchObject({ status: 'open', involvement: 'owner', resolution: null, loopedBackIn: { at: T0, byPersonName: 'Dana', evidenceId: 'ev-loop' } });
  });

  it('…or opens a sibling when the original is old', () => {
    const d = applySignal(ROWS['done (handed off, 20d)']!, S.loop_back!);
    expect(d.kind).toBe('sibling');
    expect(d.sibling!.title).toBe('Can you walk me through the pricing?');
    expect(d.sibling!.label).toEqual({ kind: 'looped_back_in', text: 'Looped back in: Dana asked you directly · Undo' });
    expect(d.reopenDecision!.ruleKey).toBe('loop_back_outside_window');
  });

  it('reads the scanner\'s `loop_back:` origin prefix as a direct ask', () => {
    const raw: Signal = { type: 'evidence', role: 'origin', confidence: 'sure', evidenceId: 'ev-dm', at: T0, source: 'slack', reason: 'loop_back: Dana asked you directly in DM' };
    const n = normalizeSignal(raw);
    expect(n).toMatchObject({ type: 'loop_back', from: { name: 'Dana' }, evidenceId: 'ev-dm' });
    expect(applySignal(handedOff, raw).labels[0]!.text).toBe('Looped back in: Dana asked you directly · Undo');
  });

  it('a watcher on a live item is made owner without a status change', () => {
    const watching = citem({ status: 'in_progress', involvement: 'watcher' });
    const d = applySignal(watching, S.loop_back!);
    expect(d.kind).toBe('update');
    expect(d.fieldChanges.map((c) => [c.field, c.after])).toContainEqual(['involvement', 'owner']);
  });
});

describe('user-locked fields become proposals (R-UI-20)', () => {
  it('a locked status turns an auto-close into a ProposalDiff, never a write', () => {
    const locked = citem({ status: 'in_progress', userLockedFields: ['state'] });
    const d = applySignal(locked, S.done_sure!);
    expect(d.kind).toBe('proposal');
    expect(d.transition).toBeNull();
    expect(d.fieldChanges).toEqual([]);
    expect(d.resolution).toBeNull();
    expect(d.proposals[0]).toEqual({
      entityType: 'work_items',
      entityId: 'w1',
      groupId: 'w1:ev-done',
      field: 'status',
      currentValue: 'in_progress',
      proposedValue: 'done',
      reason: 'Done by you: you posted "done, see deck" in #acme-ext',
      evidenceId: 'ev-done',
      baseVersion: 3,
      confidence: 'sure',
    });
    expect(d.proposals.map((p) => p.field)).toEqual(expect.arrayContaining(['status', 'doneAt', 'doneBy', 'resolution']));
    expect(new Set(d.proposals.map((p) => p.groupId)).size).toBe(1);
    expect(applyDecision(locked, d).item).toEqual(locked);
    expect(d.labels[0]!.kind).toBe('proposal');
  });

  it('a reopen on a locked item is proposed, and the reopen decision is recorded as ignored', () => {
    const lockedDone = { ...ROWS['done (mine, 3d)']!, userLockedFields: ['status'] };
    const d = applySignal(lockedDone, S.requirement!);
    expect(d.kind).toBe('proposal');
    expect(d.reopenDecision!.outcome).toBe('ignored');
  });

  it('only the locked side field is proposed; the rest of the change applies', () => {
    const handedOff = { ...ROWS['done (handed off, 3d)']!, userLockedFields: ['involvement'] };
    const d = applySignal(handedOff, S.loop_back!);
    expect(d.kind).toBe('transition');
    expect(d.fieldChanges.some((c) => c.field === 'involvement')).toBe(false);
    expect(d.proposals).toHaveLength(1);
    expect(d.proposals[0]).toMatchObject({ field: 'involvement', currentValue: 'watcher', proposedValue: 'owner' });
  });

  it('a transition that needs a locked field (waiting reason) is proposed whole, never half-applied', () => {
    const d = applySignal(citem({ status: 'in_progress', userLockedFields: ['waitingReason'] }), S.session_waiting!);
    expect(d.kind).toBe('proposal');
    expect(d.proposals.map((p) => p.field)).toEqual(['status', 'waitingReason', 'waitingSince']);
    expect(d.runState).toBe('waiting_on_you');
  });

  it('a sibling never touches the locked item, so it still opens', () => {
    const lockedOld = { ...ROWS['done (mine, 20d)']!, userLockedFields: ['status'] };
    expect(applySignal(lockedOld, S.requirement!).kind).toBe('sibling');
  });
});

describe('Claude sessions (R-UI-1)', () => {
  it('waiting → waiting_on_me with the reason; the run is waiting on you', () => {
    const d = applySignal(citem({ status: 'in_progress' }), S.session_waiting!);
    expect(d.transition!.to).toBe('waiting_on_me');
    expect(d.fieldChanges).toContainEqual({ field: 'waitingReason', before: undefined, after: 'Session asked: approve the plan?' });
    expect(d.runState).toBe('waiting_on_you');
    expect(d.labels[0]!.text).toBe('Waiting on you: Session asked: approve the plan?');
  });

  it('done → done_review for app runs, plus a likely-done check on the item', () => {
    const d = applySignal(ROWS.waiting_on_me!, S.session_done!);
    expect(d.runState).toBe('done_review');
    expect(d.transition!.to).toBe('likely_done');
    expect(d.fieldChanges).toContainEqual({ field: 'likelyDoneFromStatus', before: undefined, after: 'waiting_on_me' });
    expect(d.labels.map((l) => l.kind)).toEqual(['likely_done', 'run_done_review']);
  });

  it('the deterministic claude_session_completed closure test closes it ("built the demo org")', () => {
    const d = applySignal(citem({ kind: 'commitment', status: 'in_progress', closureKind: 'claude_session_completed' }), S.session_done!);
    expect(d.transition).toMatchObject({ to: 'done', autonomy: 'L4_auto' });
    expect(d.runState).toBe('done_review');
  });

  it('a session I started myself finishes as plain done; a failure is surfaced', () => {
    expect(applySignal(citem(), { ...S.session_done!, launchedByApp: false } as Signal).runState).toBe('done');
    const f = applySignal(ROWS.waiting_on_me!, S.session_failed!);
    expect(f).toMatchObject({ runState: 'failed', transition: { to: 'in_progress' } });
    expect(f.fieldChanges).toContainEqual({ field: 'waitingReason', before: 'Session asked: which org alias?', after: null });
  });
});

describe('snooze, dismiss, waiting on others, merged', () => {
  it('snoozed wakes at its time back to where it was, not before', () => {
    expect(applySignal(ROWS.snoozed!, { type: 'timer', evidenceId: null, at: plus(30) }).kind).toBe('none');
    const d = applySignal(ROWS.snoozed!, { type: 'timer', evidenceId: null, at: plus(60) });
    expect(d.transition).toMatchObject({ from: 'snoozed', to: 'in_progress', reason: 'Woke: snooze ended' });
    expect(applyDecision(ROWS.snoozed!, d).item).toMatchObject({ snoozedUntil: null, snoozedFromStatus: null });
  });

  it('snoozed wakes on a direct ask, and on any new info only if the user opted in', () => {
    expect(applySignal(ROWS.snoozed!, S.loop_back!).labels[0]!.text).toBe('Woke: Dana asked you directly');
    expect(applySignal(ROWS.snoozed!, S.origin!).kind).toBe('none');
    expect(applySignal(ROWS.snoozed!, S.origin!, { ...DEFAULT_CLOSURE_SETTINGS, snoozeWakeOnNewInfo: true }).transition!.to).toBe('in_progress');
  });

  it('dismissed stays dismissed unless looped back', () => {
    const dis = ROWS['dismissed (3d)']!;
    for (const k of ['done_sure', 'requirement', 'reply_them', 'session_waiting'] as const) expect(applySignal(dis, S[k]!).kind).toBe('none');
    expect(applySignal(dis, S.loop_back!).transition).toMatchObject({ from: 'dismissed', to: 'open' });
  });

  it('waiting on others reopens when they reply, or when the nudge is due', () => {
    const woo = ROWS.waiting_on_others!;
    expect(applySignal(woo, S.reply_them!)).toMatchObject({ transition: { to: 'open' }, labels: [{ text: 'Reply from Dana' }] });
    expect(applySignal(woo, S.timer!).labels[0]!.kind).toBe('nudge_due');
  });

  it('merged and duplicate items route new evidence to the survivor', () => {
    expect(applySignal(ROWS.merged!, S.done_sure!).redirectTo).toBe('w9');
    const dup = citem({ status: 'done', doneAt: daysBefore(1), resolution: 'duplicate', resolutionDetail: { inferred: false, relatedItemId: 'w7' } });
    expect(applySignal(dup, S.requirement!)).toMatchObject({ kind: 'none', redirectTo: 'w7' });
  });
});

describe('every case is undoable', () => {
  it('undo restores the exact item for transitions, updates and siblings', () => {
    const cases: Array<[keyof typeof ROWS, keyof typeof SIGNALS]> = [
      ['in_progress', 'done_sure'],
      ['done (mine, 3d)', 'requirement'],
      ['done (mine, 20d)', 'requirement'],
      ['done (handed off, 3d)', 'loop_back'],
      ['waiting_on_me', 'session_waiting'],
      ['snoozed', 'timer'],
      ['likely_done', 'contradiction'],
    ];
    for (const [row, sig] of cases) {
      const item = ROWS[row]!;
      const d = applySignal(item, S[sig]!);
      expect(d.undoable).toBe(true);
      const { item: after } = applyDecision(item, d);
      expect(undoDecision(after, d)).toEqual(item);
    }
  });

  it('labels carry Undo on reopen, sibling and loop-back (UI-SPEC §9)', () => {
    for (const [row, sig] of [['done (mine, 3d)', 'requirement'], ['done (mine, 20d)', 'requirement'], ['done (handed off, 3d)', 'loop_back']] as const) {
      expect(applySignal(ROWS[row]!, S[sig]!).labels[0]!.text.endsWith('· Undo')).toBe(true);
    }
  });

  it('keeps people placeholders, never ids, in user-facing text', () => {
    const d = applySignal(ROWS['done (mine, 3d)']!, { ...S.requirement!, actor: DANA } as Signal);
    expect(d.labels[0]!.text).toBe('Reopened: new requirement from Dana · Undo');
    expect(JSON.stringify(applySignal(citem(), { ...S.requirement!, actor: SAM } as Signal).labels)).not.toContain('p-sam');
  });
});
