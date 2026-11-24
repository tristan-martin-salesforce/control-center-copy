/**
 * P3 · Triage, Outbox and Briefs logic: optimistic patches, Outbox status semantics (nothing pending looks
 * sent; a dry run never looks like a delivery), the approve border (never dispatches without a confirm),
 * highlight undo memory, and the watch form rules.
 */
import { describe, expect, it, vi } from 'vitest';

import { eventually } from '../support/until';
import { isOpenHighlight, withBriefsUnread, withHighlightStatus, withoutTriageItem, withTriageCount, withWorthALook } from '@/components/lists/cache-patches';
import { approveLabel, canApprove, failureOf, lastDryRun, outboxStatus, plainFailure, sentBreakdown, sentResultUrl, stagedLabel, stagedWhere } from '@/components/lists/outbox';
import { SendFlow, outcomeOf, type SendFlowDeps } from '@/components/composer/send-flow';
import { confirmLabel, confirmTitle } from '@/components/composer/ConfirmSendDialog';
import { forgetHighlightChange, highlightChangeOf, rememberHighlightChange } from '@/components/briefs/highlight-undo';
import { BLANK_WATCH, cadenceLabel, normaliseWatch } from '@/components/briefs/watch-form';
import { readingPaneFlags, readingPaneState } from '@/components/briefs/reading-pane';
import type { Brief, BriefsPayload, DispatchResult, Draft, DraftPreview, TodayPayload, TriagePayload } from '@/contract';

const draft = (over: Record<string, unknown> = {}) =>
  ({ id: 'd1', version: 4, status: 'ready', mode: 'send', attempts: [], verification: null, scheduledFor: null, ...over }) as unknown as Draft;

describe('Triage optimistic patches', () => {
  const payload = {
    count: 3,
    groups: [
      { group: 'asks_promises', label: 'Asks & promises', items: [{ id: 'a' }, { id: 'b' }] },
      { group: 'mappings', label: 'Mappings', items: [{ id: 'c' }] },
    ],
  } as unknown as TriagePayload;

  it('removes the item and drops the count (accept, dismiss and merge all leave the list)', () => {
    const next = withoutTriageItem(payload, 'b');
    expect(next.groups[0]!.items.map((i) => i.id)).toEqual(['a']);
    expect(next.count).toBe(2);
    expect(payload.count).toBe(3);
  });

  it('is a no-op for an id that is not there', () => {
    expect(withoutTriageItem(payload, 'zzz')).toBe(payload);
  });

  it('moves the nav badge in step and never goes negative', () => {
    const today = { triageCount: 1, navCounts: { triage: 1, agentsWaiting: 0, outbox: 3, briefsUnread: 2 } } as unknown as TodayPayload;
    expect(withTriageCount(today, -1).navCounts.triage).toBe(0);
    expect(withTriageCount(today, -5).navCounts.triage).toBe(0);
    expect(withTriageCount(today, 2).triageCount).toBe(3);
    expect(withBriefsUnread(today, -1).navCounts).toMatchObject({ briefsUnread: 1, outbox: 3 });
  });
});

describe('Outbox status: nothing pending looks sent', () => {
  it('pending and scheduled are dashed and have not left the machine', () => {
    const p = outboxStatus(draft(), 'pending_approval');
    expect(p).toMatchObject({ label: 'Pending approval', dashed: true, left: false });
    const s = outboxStatus(draft({ status: 'scheduled', scheduledFor: '2026-11-06T16:00:00Z' }), 'scheduled', 'America/Denver');
    expect(s.dashed).toBe(true);
    expect(s.left).toBe(false);
    expect(s.label).toBe('Scheduled · Fri 6 Nov 09:00');
  });

  it('sent rows say verified or unverified, never just "sent ✓"', () => {
    expect(outboxStatus(draft({ status: 'verified', verification: { state: 'verified', at: 'x', detail: 'Verified in Slack ✓' } }), 'sent')).toMatchObject({ tone: 'ok', label: 'Verified', left: true, dashed: false });
    expect(outboxStatus(draft({ status: 'verify_failed', verification: { state: 'failed', at: 'x', detail: 'Read-back: not found' } }), 'sent')).toMatchObject({ tone: 'warn', label: 'Unverified', detail: 'Read-back: not found' });
    expect(outboxStatus(draft({ status: 'sent', verification: { state: 'pending', at: null, detail: 'Verifying by read-back…' } }), 'sent').label).toBe('Sent · verifying…');
    expect(outboxStatus(draft({ status: 'staged' }), 'sent').label).toBe('Draft saved');
  });

  it('a pushed draft says where it waits; a sent row links to what was sent', () => {
    const slack = { kind: 'slack', channelName: '#acme-ext' };
    const email = { kind: 'email', subject: 'Re: scope' };
    const staged = outboxStatus(draft({ status: 'staged', destination: slack, verification: { state: 'verified', at: 'x', detail: 'Verified in Slack ✓' } }), 'sent');
    expect(staged).toMatchObject({ label: 'Saved as Slack draft', detail: 'Find it in Slack ▸ Drafts · Verified in Slack ✓', left: true });
    expect(outboxStatus(draft({ status: 'staged', destination: email }), 'sent')).toMatchObject({ label: 'Saved as Gmail draft', detail: 'Find it in Gmail ▸ Drafts' });
    expect(stagedLabel({ kind: 'action' } as never)).toBeNull();
    expect(stagedWhere({ kind: 'slack' } as never)).toBe('in Slack ▸ Drafts');
    // View sent ↗: only a sent message with a recorded result; an applied action keeps "Open the result"
    expect(sentResultUrl({ resultUrl: 'https://slack.example.com/archives/C1/p1', destination: slack } as never, 'sent')).toBe('https://slack.example.com/archives/C1/p1');
    expect(sentResultUrl({ resultUrl: 'https://slack.example.com/archives/C1/p1', destination: slack } as never, 'pending_approval')).toBeNull();
    expect(sentResultUrl({ resultUrl: null, destination: slack } as never, 'sent')).toBeNull();
    expect(sentResultUrl({ resultUrl: 'https://canvas.example.com/c', destination: { kind: 'action' } } as never, 'sent')).toBeNull();
  });

  it('failed rows carry the reason inline', () => {
    const attempts = [
      { id: 'a1', at: 't1', mode: 'send', dryRun: false, outcome: 'failed', detail: 'channel_not_found' },
      { id: 'a2', at: 't2', mode: 'send', dryRun: false, outcome: 'failed', detail: 'rate_limited' },
    ];
    expect(failureOf(draft({ attempts }))).toBe('rate_limited');
    expect(outboxStatus(draft({ status: 'failed', attempts }), 'failed')).toMatchObject({ tone: 'risk', left: false });
    expect(outboxStatus(draft({ status: 'failed', attempts }), 'failed').detail).toMatch(/too many requests/);
    expect(failureOf(draft({ verification: { state: 'failed', at: null, detail: 'no read-back' } }))).toBe('no read-back');
  });

  it('a failure reads in plain words, never the raw error (01-ui-audit UI-7)', () => {
    const gmail = { kind: 'email' } as Draft['destination'];
    const slack = { kind: 'slack' } as Draft['destination'];
    expect(plainFailure('Gmail API 503: backendError', gmail)).toBe('Gmail had a temporary problem on its side. Retry sends it again.');
    expect(plainFailure('invalid_auth', slack)).toBe('Slack needs you to sign in again; then Retry.');
    expect(plainFailure('channel_not_found', slack)).toBe("Slack didn't take it. Retry, or open the row for what it said.");
    expect(plainFailure('The channel was archived before it went out.', slack)).toBe('The channel was archived before it went out.');
    expect(plainFailure(null, slack)).toBeNull();
  });

  it('a dry run is recorded as rendered, not delivered', () => {
    const d = draft({ attempts: [{ id: 'a1', at: '2026-11-05T17:02:00Z', mode: 'send', dryRun: true, outcome: 'rendered', detail: 'Dry run' }] });
    expect(lastDryRun(d)?.outcome).toBe('rendered');
    expect(outboxStatus(d, 'pending_approval').left).toBe(false);
    expect(lastDryRun(draft())).toBeNull();
  });

  it('Approve is only offered where nothing has been sent, and the label says dry run', () => {
    expect(canApprove('pending_approval')).toBe(true);
    expect(canApprove('failed')).toBe(true);
    expect(canApprove('sent')).toBe(false);
    expect(approveLabel(draft({ mode: 'send' }), 'pending_approval', true)).toBe('Approve & send (dry run)');
    expect(approveLabel(draft({ mode: 'draft' }), 'pending_approval', false)).not.toMatch(/push/);
    expect(approveLabel({ mode: 'draft', destination: { kind: 'slack' } as Draft['destination'] }, 'pending_approval', false)).toBe('Approve: draft in Slack');
    expect(approveLabel({ mode: 'draft', destination: { kind: 'email' } as Draft['destination'] }, 'pending_approval', true)).toBe('Approve: draft in Gmail (dry run)');
    expect(approveLabel(draft(), 'failed', false)).toBe('Retry');
  });

  it('draft mode says where the draft is saved, never "push" (01-ui-audit UI-16)', () => {
    const slack = { kind: 'slack', channelName: '#placeholder' } as unknown as Draft['destination'];
    expect(confirmLabel('draft', false, slack)).toBe('Save draft');
    expect(confirmLabel('draft', true, slack)).toBe('Save draft (dry run)');
    expect(confirmTitle('draft', slack)).toBe('Save a Slack draft for #placeholder?');
    expect(stagedLabel({ kind: 'slack' })).toBe('Saved as Slack draft');
  });

  it('summarises the Sent group', () => {
    expect(sentBreakdown([{ status: 'verified' }, { status: 'verified' }, { status: 'verify_failed' }, { status: 'sent' }] as Draft[])).toBe('2 verified · 1 unverified · 1 other');
  });
});

describe('Outbox approve flow (the border)', () => {
  const preview = { draftId: 'd1', version: 4, mode: 'send', confirmToken: 'ct_1', dryRun: true, payload: {}, rendition: {}, destination: {} } as unknown as DraftPreview;
  const result = (dryRun: boolean) =>
    ({ dryRun, draft: draft(), payload: {}, rendition: {}, auditId: 'au1', attempt: { id: 'a', at: 't', mode: 'send', dryRun, outcome: dryRun ? 'rendered' : 'sent' } }) as unknown as DispatchResult;

  function harness(dryRun: boolean) {
    const timers: Array<() => void> = [];
    const dispatch = vi.fn(async () => result(dryRun));
    const deps: SendFlowDeps = {
      preview: vi.fn(async () => preview),
      dispatch,
      undoMs: 10_000,
      now: () => 0,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => timers.splice(0, timers.length),
    };
    return { flow: new SendFlow(deps, 'send'), dispatch, timers };
  }

  it('Approve alone never dispatches: it only fetches the preview and waits for a confirm', async () => {
    const { flow, dispatch } = harness(true);
    await flow.open('send');
    expect(flow.getState().phase).toBe('confirming');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('Cancel and Undo both leave nothing sent', async () => {
    const a = harness(true);
    await a.flow.open('send');
    a.flow.cancel();
    expect(a.flow.getState().phase).toBe('idle');
    const b = harness(true);
    await b.flow.open('send');
    b.flow.confirm();
    expect(b.flow.getState().phase).toBe('countdown');
    b.flow.undo();
    expect(b.flow.getState().undone).toBe(true);
    expect(a.dispatch).not.toHaveBeenCalled();
    expect(b.dispatch).not.toHaveBeenCalled();
  });

  it('confirm starts the undo window; dispatch fires once when it runs out, and a dry run reports dry_run', async () => {
    const { flow, dispatch, timers } = harness(true);
    await flow.open('send');
    flow.confirm();
    expect(dispatch).not.toHaveBeenCalled();
    timers[0]!();
    await eventually(() => expect(flow.getState().phase).toBe('done'));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ ifVersion: 4, mode: 'send', confirmToken: 'ct_1' });
    expect(flow.getState().outcome).toBe('dry_run');
    expect(outcomeOf(result(true))).toBe('dry_run');
    expect(outcomeOf(result(false))).toBe('sent');
  });
});

describe('Briefs', () => {
  const brief = { id: 'b1', highlights: [{ id: 'h1', status: 'new', promotedWorkItemId: null }, { id: 'h2', status: 'seen', promotedWorkItemId: null }] } as unknown as Brief;

  it('flips one highlight and leaves the rest', () => {
    const next = withHighlightStatus(brief, 'h1', 'promoted', 'w9');
    expect(next.highlights[0]).toMatchObject({ status: 'promoted', promotedWorkItemId: 'w9' });
    expect(next.highlights[1]!.status).toBe('seen');
    expect(brief.highlights[0]!.status).toBe('new');
    expect(withHighlightStatus(brief, 'h2', 'dismissed').highlights[1]!.status).toBe('dismissed');
  });

  it('keeps the list counts in step with a highlight leaving "worth a look"', () => {
    const p = { watched: [{ id: 'b1', worthALook: 2 }], opportunities: [{ id: 'b2', worthALook: 1 }], watches: [], counts: { unread: 1, worthALook: 3 } } as unknown as BriefsPayload;
    const next = withWorthALook(p, 'b1', -1);
    expect(next.watched[0]!.worthALook).toBe(1);
    expect(next.opportunities[0]!.worthALook).toBe(1);
    expect(next.counts.worthALook).toBe(2);
    expect(withWorthALook(next, 'b2', -5).opportunities[0]!.worthALook).toBe(0);
    expect(['new', 'seen'].every(isOpenHighlight)).toBe(true);
    expect(isOpenHighlight('promoted') || isOpenHighlight('dismissed')).toBe(false);
  });

  it('remembers the audit id behind a highlight change so the card Undo can reverse it', () => {
    expect(highlightChangeOf('h-test')).toBeNull();
    rememberHighlightChange('h-test', { auditId: 'au_7', kind: 'dismiss' });
    expect(highlightChangeOf('h-test')).toEqual({ auditId: 'au_7', kind: 'dismiss' });
    forgetHighlightChange('h-test');
    expect(highlightChangeOf('h-test')).toBeNull();
  });

  it('the reading pane loads while the list is pending, and only says "Pick a brief" for a real empty selection (B-073a)', () => {
    // List still pending: no openId can exist yet, so this used to fall through to "Pick a brief".
    expect(readingPaneState({ listPending: true, openId: null, briefPending: true, briefError: false })).toBe('loading');
    expect(readingPaneFlags('loading')).toEqual({ loading: true, error: false, empty: false });
    // List loaded, brief selected but its payload not here yet.
    expect(readingPaneState({ listPending: false, openId: 'b1', briefPending: true, briefError: false })).toBe('loading');
    expect(readingPaneState({ listPending: false, openId: 'b1', briefPending: false, briefError: true })).toBe('error');
    expect(readingPaneState({ listPending: false, openId: 'b1', briefPending: false, briefError: false })).toBe('ready');
    // Loaded list, nothing selected: the one real "Pick a brief".
    expect(readingPaneState({ listPending: false, openId: null, briefPending: true, briefError: false })).toBe('empty');
  });
});

describe('Manage watches form', () => {
  it('channels always carry one #', () => {
    expect(normaliseWatch({ ...BLANK_WATCH, target: 'team-updates' })).toEqual({ target: '#team-updates', label: '#team-updates' });
    expect(normaliseWatch({ ...BLANK_WATCH, target: '##sales  ' })).toEqual({ target: '#sales', label: '#sales' });
  });

  it('an empty or hash-only target is not saveable', () => {
    expect(normaliseWatch({ ...BLANK_WATCH, target: '   ' })).toBeNull();
    expect(normaliseWatch({ ...BLANK_WATCH, target: '#' })).toBeNull();
  });

  it('accounts store the id and show the name; searches keep the query', () => {
    expect(normaliseWatch({ targetKind: 'account', target: 'acc_1', label: '' }, 'ACME')).toEqual({ target: 'acc_1', label: 'ACME' });
    expect(normaliseWatch({ targetKind: 'search', target: '"Flex Credits" in:#sales', label: '' })).toEqual({ target: '"Flex Credits" in:#sales', label: '"Flex Credits" in:#sales' });
  });

  it('names the cadences the way the spec does', () => {
    expect(cadenceLabel('daily_0730')).toBe('Daily 7:30');
    expect(cadenceLabel('every_4h')).toBe('Every 4 h');
    expect(cadenceLabel('since_last_open')).toBe('Since last open');
  });
});
