/**
 * BE-CHAT client seams (src/client/chat): tool-progress folds into the live turn, a reload keeps the
 * persisted error part (its real message, not "No answer came back") and the stopped state, the SSE
 * parser accepts the new event, and the morning brief carries its server summary.
 */
import { describe, expect, it } from 'vitest';
import { ChatSseEvent, type ChatMessage } from '@/contract';
import { parseChatFrame } from '@/client/chat/sse';
import { reduceTurn, startTurn, viewOfServer } from '@/client/chat/turn';
import { briefSummaryOf, withBriefSummary } from '@/server/chat/brief';

const base = (over: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm1', threadId: 't1', role: 'assistant', at: '2026-11-05T16:00:00.000Z', text: '', parts: [], context: [], isMorningBrief: false, ...over });

describe('BE-CHAT client seams', () => {
  it('tool-progress updates the running row of the live turn, and the tool-result still ends it', () => {
    let t = startTurn({ threadId: 't1', text: 'rescan slack 2d', context: [], baseIds: [] });
    t = reduceTurn(t, { type: 'tool-start', id: 'x1', name: 'slack.scan', summary: 'Re-reading slack over the last 48 h (2d)' });
    t = reduceTurn(t, { type: 'tool-progress', id: 'x1', done: 1, total: 3 });
    expect(t.tools[0]).toMatchObject({ id: 'x1', ok: null, progress: { done: 1, total: 3 } });
    t = reduceTurn(t, { type: 'tool-progress', id: 'x1', done: 3, total: 3 });
    t = reduceTurn(t, { type: 'tool-result', id: 'x1', summary: 'Slack scan done: 12 seen', ok: true });
    expect(t.tools[0]).toMatchObject({ ok: true, summary: 'Slack scan done: 12 seen', progress: { done: 3, total: 3 } });
    // unknown ids are ignored
    expect(reduceTurn(t, { type: 'tool-progress', id: 'nope', done: 1, total: 3 }).tools).toEqual(t.tools);
  });

  it('a held tool-result (a guard held it for you) carries held to the live row and through a reload', () => {
    let t = startTurn({ threadId: 't1', text: 'what changed?', context: [], baseIds: [] });
    t = reduceTurn(t, { type: 'tool-start', id: 'r1', name: 'assistant.remember', summary: 'Remembering' });
    const ev = { type: 'tool-result' as const, id: 'r1', summary: 'Not kept', ok: false, held: true };
    expect(ChatSseEvent.safeParse(ev).success).toBe(true);
    t = reduceTurn(t, ev);
    expect(t.tools[0]).toMatchObject({ ok: false, held: true });
    const v = viewOfServer(base({ status: 'complete', parts: [{ type: 'tool', id: 'r1', name: 'assistant.remember', summary: 'Not kept', ok: false, held: true }] }));
    expect(v.tools[0]).toMatchObject({ ok: false, held: true });
    expect(viewOfServer(base({ status: 'complete', parts: [{ type: 'tool', id: 'r2', name: 'slack.search', summary: 'Failed', ok: false }] })).tools[0]!.held).toBeUndefined();
  });

  it('the SSE frame parser accepts tool-progress (contract event)', () => {
    const ev = { type: 'tool-progress', id: 'x1', done: 2, total: 3 };
    expect(ChatSseEvent.safeParse(ev).success).toBe(true);
    expect(parseChatFrame({ event: 'tool-progress', data: JSON.stringify(ev) })).toEqual(ev);
  });

  it('a reload keeps the persisted error part and the stopped state', () => {
    const err = { code: 'budget_exceeded' as const, message: 'Chat is paused: its daily budget ($3.00) is used up for today.', retryable: false };
    const v = viewOfServer(base({ status: 'error', parts: [{ type: 'error', error: err }] }));
    expect(v.error).toEqual(err);
    expect(viewOfServer(base({ status: 'stopped' })).stopped).toBe(true);
    expect(viewOfServer(base({ status: 'complete' }))).toMatchObject({ error: null, stopped: false });
    // live extras still win
    const live = { code: 'internal' as const, message: 'live', retryable: true };
    expect(viewOfServer(base({ parts: [{ type: 'error', error: err }] }), { error: live, stopped: false, toolArgs: {}, proposalSummaries: {} }).error).toEqual(live);
    // persisted progress on a tool row reaches the view
    const p = viewOfServer(base({ parts: [{ type: 'tool', id: 'x', name: 'slack.scan', summary: 's', ok: true, progress: { done: 3, total: 3 } }] }));
    expect(p.tools[0]).toMatchObject({ progress: { done: 3, total: 3 } });
  });

  it('the morning brief gets a one-line summary on read (lead sentence + priority count)', () => {
    const text = 'Good morning, Jordan. Two customer replies are overdue and the ACME build should start now.\n\n1. **Reply to Dana**\n2. Kick off the build\n3. Send the SOW';
    expect(briefSummaryOf(text)).toBe('Two customer replies are overdue and the ACME build should start now. 3 priorities.');
    expect(withBriefSummary(base({ isMorningBrief: true, text })).summary).toBe('Two customer replies are overdue and the ACME build should start now. 3 priorities.');
    expect(withBriefSummary(base({ text })).summary).toBeUndefined();
  });
});
