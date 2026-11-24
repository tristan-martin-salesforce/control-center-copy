/**
 * BE-REEVAL pure parts: evidence rows → closure signals (reason prefixes), user_settings → ClosureSettings,
 * and one re-eval pass (sequential decisions + planner + follow-ups). No database.
 */
import { describe, expect, it } from 'vitest';

import { changeKindOf, closureSettingsFrom, parseReason, signalFromEvidence, type EvidenceLink } from '@/engines/closure/signals';
import { runReevalPass } from '@/engines/reeval/pass';
import { DEFAULT_CLOSURE_SETTINGS, type ClosureItem } from '@/engines/types';

const T0 = '2026-11-05T15:00:00.000Z';
const daysBefore = (n: number) => new Date(Date.parse(T0) - n * 86_400_000).toISOString();
const ME = { name: 'Tristan', isMe: true };
const DANA = { id: 'p-dana', name: 'Dana' };

const link = (over: Partial<EvidenceLink> = {}): EvidenceLink => ({
  id: 'ev1',
  role: 'completion',
  confidence: 'sure',
  reason: 'said done in Slack: sent the deck',
  at: T0,
  linkedAt: T0,
  source: 'slack',
  actor: ME,
  ...over,
});

const item = (over: Partial<ClosureItem> = {}): ClosureItem => ({
  id: 'w1',
  version: 2,
  kind: 'task',
  status: 'open',
  title: 'Send ACME the pilot deck',
  initiativeId: 'ini-1',
  involvement: 'owner',
  closureKind: 'manual_only',
  ...over,
});

const pass = (i: ClosureItem, links: EvidenceLink[], settings = DEFAULT_CLOSURE_SETTINGS) =>
  runReevalPass({ item: i, signals: links.map(signalFromEvidence), settings, draft: { hasDraft: false, draftUserLocked: false } });

describe('signalFromEvidence (reason prefixes, SCANNER.md §4)', () => {
  it('parses snake_case prefixes', () => {
    expect(parseReason('requirements_change: add a pricing slide')).toEqual({ prefix: 'requirements_change', text: 'add a pricing slide' });
    expect(parseReason('Loop_Back:Dana asked you directly')).toEqual({ prefix: 'loop_back', text: 'Dana asked you directly' });
    expect(parseReason('no prefix here')).toEqual({ prefix: null, text: 'no prefix here' });
    expect(parseReason(null)).toEqual({ prefix: null, text: '' });
  });

  it('a completion stays evidence with its confidence', () => {
    const s = signalFromEvidence(link());
    expect(s).toMatchObject({ type: 'evidence', role: 'completion', confidence: 'sure', evidenceId: 'ev1', source: 'slack', reason: 'said done in Slack: sent the deck' });
    expect(changeKindOf(s)).toBe('evidence_completion');
  });

  it('contradiction + requirements_change: → requirements_change with the delta as summary', () => {
    const s = signalFromEvidence(link({ role: 'contradiction', confidence: 'likely', reason: 'requirements_change: add a data-residency slide', actor: DANA }));
    expect(s).toMatchObject({ type: 'requirements_change', summary: 'add a data-residency slide', confidence: 'likely' });
    expect(changeKindOf(s)).toBe('requirements_change');
  });

  it('strips the completion pass prefix from what the user sees (done_check:)', () => {
    const s = signalFromEvidence(link({ role: 'completion', confidence: 'sure', reason: 'done_check: you sent the deck in the thread' }));
    expect(s).toMatchObject({ type: 'evidence', role: 'completion', reason: 'you sent the deck in the thread' });
  });

  it('origin + loop_back: → loop_back from the author (or the name in the reason)', () => {
    const s = signalFromEvidence(link({ role: 'origin', reason: 'loop_back: Dana asked you directly in DM', actor: DANA }));
    expect(s).toMatchObject({ type: 'loop_back', from: DANA });
    expect(changeKindOf(s)).toBe('loop_back');
    const anon = signalFromEvidence(link({ role: 'origin', reason: 'loop_back: Kim asked you directly', actor: undefined }));
    expect(anon).toMatchObject({ type: 'loop_back', from: { name: 'Kim' } });
  });

  it('Drive completion is an "updates made" digest (never Sure), drive_judge partial is partial', () => {
    expect(signalFromEvidence(link({ source: 'drive', reason: 'drive_judge: verdict=done; confidence=0.85', fileRef: 'f1' }))).toMatchObject({ type: 'drive_digest', updatesMade: 'yes', editedByMe: true, fileId: 'f1' });
    expect(signalFromEvidence(link({ role: 'progress', reason: 'drive_judge: verdict=partial; missing=[x]', source: 'drive', actor: DANA }))).toMatchObject({ type: 'drive_digest', updatesMade: 'partial', editedByMe: false, editorName: 'Dana' });
    expect(signalFromEvidence(link({ role: 'progress', reason: 'drive_judge: verdict=cannot_tell', source: 'drive' }))).toMatchObject({ type: 'drive_digest', updatesMade: 'unknown' });
  });

  it('context reasons stay context', () => {
    expect(signalFromEvidence(link({ role: 'context', reason: 'requirements_update: date moved' }))).toMatchObject({ type: 'evidence', role: 'context' });
    expect(signalFromEvidence(link({ role: 'context', reason: 'handoff: to Kim' }))).toMatchObject({ type: 'evidence', role: 'context' });
  });
});

describe('closureSettingsFrom (user thresholds)', () => {
  it('defaults: reopen window 14 days, Sure auto-closes', () => {
    expect(closureSettingsFrom({})).toEqual(DEFAULT_CLOSURE_SETTINGS);
    expect(DEFAULT_CLOSURE_SETTINGS.reopenWindowDays).toBe(14);
  });
  it('reads the user_settings keys; malformed values fall back', () => {
    expect(closureSettingsFrom({ 'reopen.window_days': 7, 'close.auto_sure': false, 'snooze.wake_on_new_info': 'true', 'handoff.my_involvement': 'not_involved' })).toEqual({
      reopenWindowDays: 7,
      autoCloseSure: false,
      snoozeWakeOnNewInfo: true,
      handoffInvolvement: 'not_involved',
    });
    expect(closureSettingsFrom({ 'reopen.window_days': -3, 'close.auto_sure': 'maybe', 'handoff.my_involvement': 'owner' })).toEqual(DEFAULT_CLOSURE_SETTINGS);
    expect(closureSettingsFrom({ 'reopen.window_days': { value: 21 } }).reopenWindowDays).toBe(21);
  });
});

describe('runReevalPass', () => {
  it('said done in Slack (Sure) → done, auto-closed, NBA retired', () => {
    const p = pass(item(), [link()]);
    expect(p.final.status).toBe('done');
    expect(p.steps[0]!.decision.transition).toMatchObject({ from: 'open', to: 'done', autonomy: 'L4_auto', evidenceId: 'ev1' });
    expect(p.steps[0]!.decision.resolution?.resolution).toBe('done_by_me');
    expect(p.writes && p.transitioned).toBe(true);
    expect(p.followUps).toEqual([{ kind: 'nba.generate', target: { workItemId: 'w1' }, mode: 'retire', reason: expect.stringMatching(/Done by you/) }]);
    expect(p.plan.steps.map((s) => s.step)).toEqual(['status', 'priority']);
  });

  it('close.auto_sure off: Sure only proposes "likely done"', () => {
    const p = pass(item(), [link()], { ...DEFAULT_CLOSURE_SETTINGS, autoCloseSure: false });
    expect(p.final.status).toBe('likely_done');
  });

  it('likely completion → likely_done (a Confirm), not closed', () => {
    const p = pass(item(), [link({ confidence: 'likely' })]);
    expect(p.final.status).toBe('likely_done');
    expect(p.steps[0]!.decision.labels[0]!.kind).toBe('likely_done');
    expect(p.followUps[0]).toMatchObject({ mode: 'regenerate' });
  });

  it('decides each signal against the item the previous one left: progress then done', () => {
    const p = pass(item(), [link({ id: 'ev0', role: 'progress', confidence: 'likely', reason: 'on it' }), link()]);
    expect(p.steps.map((s) => s.decision.transition && `${s.decision.transition.from}→${s.decision.transition.to}`)).toEqual(['open→in_progress', 'in_progress→done']);
    expect(p.final.status).toBe('done');
  });

  it('progress only moves an open item to in_progress', () => {
    expect(pass(item(), [link({ role: 'progress', confidence: 'likely' })]).final.status).toBe('in_progress');
    const p = pass(item({ status: 'in_progress' }), [link({ role: 'progress', confidence: 'likely' })]);
    expect(p.writes).toBe(false);
  });

  it('a user-locked status turns the close into a proposal; the item does not move', () => {
    const p = pass(item({ userLockedFields: ['status', 'state'] }), [link()]);
    expect(p.steps[0]!.decision.kind).toBe('proposal');
    expect(p.steps[0]!.decision.proposals.find((x) => x.field === 'status')).toMatchObject({ currentValue: 'open', proposedValue: 'done' });
    expect(p.final.status).toBe('open');
    expect(p.writes).toBe(true);
    expect(p.followUps).toEqual([]);
  });

  it('new requirement after done: reopen within 14 days, a sibling after', () => {
    const req = link({ role: 'contradiction', confidence: 'likely', reason: 'requirements_change: add a pricing slide', actor: DANA });
    const recent = pass(item({ status: 'done', doneAt: daysBefore(3), doneBy: 'engine', resolution: 'done_by_me' }), [req]);
    expect(recent.steps[0]!.decision.reopenDecision).toMatchObject({ outcome: 'reopened', ruleKey: 'same_deliverable_recent' });
    expect(recent.final.status).toBe('open');
    const old = pass(item({ status: 'done', doneAt: daysBefore(20), doneBy: 'engine', resolution: 'done_by_me' }), [req]);
    expect(old.steps[0]!.decision.kind).toBe('sibling');
    expect(old.steps[0]!.decision.sibling).toMatchObject({ title: 'add a pricing slide', status: 'open', initiativeId: 'ini-1' });
    expect(old.steps[0]!.decision.reopenDecision).toMatchObject({ outcome: 'new_sibling', ruleKey: 'outside_window' });
    expect(old.final.status).toBe('done');
    expect(old.followUps).toEqual([{ kind: 'nba.generate', target: { siblingOfStep: 0 }, mode: 'regenerate', reason: expect.stringMatching(/New task/) }]);
  });

  it('a hand-off takes new info as context only; a direct ask loops me back in', () => {
    const handedOff = item({ status: 'done', doneAt: daysBefore(2), doneBy: 'user', resolution: 'handed_off', involvement: 'watcher', owner: { id: 'p-kim', name: 'Kim' } });
    const ctx = pass(handedOff, [link({ actor: DANA })]);
    expect(ctx.writes).toBe(false);
    expect(ctx.steps[0]!.decision.recordAs).toBe('context');
    const loop = pass(handedOff, [link({ role: 'origin', reason: 'loop_back: Dana asked you directly in DM', actor: DANA })]);
    expect(loop.final).toMatchObject({ status: 'open', involvement: 'owner' });
    expect(loop.steps[0]!.decision.labels[0]).toMatchObject({ kind: 'looped_back_in', text: expect.stringMatching(/Looped back in: Dana asked you directly/) });
    expect(loop.plan.steps.map((s) => s.step)).toEqual(['status', 'priority', 'nba']);
  });

  it('nothing new: no steps, no writes, no follow-ups', () => {
    const p = pass(item(), []);
    expect(p).toMatchObject({ steps: [], writes: false, transitioned: false, followUps: [], summary: 'Nothing new' });
  });
});
