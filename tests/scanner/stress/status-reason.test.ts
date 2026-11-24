/** STAT-1 (placeholders only): a connector's status reason names the failing scope and the cause in plain words. */
import { describe, expect, it } from 'vitest';

import { statusReason } from '../../../src/scanner/runtime/status-reason';

describe('statusReason (STAT-1)', () => {
  it.each([
    ['slack', 'channel:C0PLACEHOLD', 'prefix tripwire: first call prompt 41948 tokens > 40000', 'config', 'Channel scans: prompt over the size limit'],
    ['org62', 'events', 'cost cap exceeded (SDK maxBudgetUsd)', 'config', 'Org62 events: a run hit its cost cap'],
    ['claude_sessions', 'all', 'run ended without a cursor (cc_finish)', 'unknown', 'Claude sessions: a run stopped before finishing'],
    ['drive', 'tracked', "google get_spreadsheet_info failed [bad_request]: Error calling tool 'get_spreadsheet_info'", 'unknown', "Drive files: a file couldn't be read"],
    ['gemini_notes', 'poll', 'google get_doc_as_markdown failed [not_found]: …', 'unknown', "Meeting notes: a file couldn't be found"],
    ['gmail', 'inbox', 'ETIMEDOUT', 'transient', 'Inbox: temporarily unavailable, retrying'],
    ['org62', 'events', 'watchdog: run exceeded 180000 ms', 'transient', 'Org62 events: a run took longer than its time limit'],
    ['slack', 'inbox', 'assistant error authentication_failed', 'auth', 'Slack inbox: needs re-auth'],
  ] as const)('%s %s → %s', (connector, scope, message, cls, want) => {
    expect(statusReason(connector, scope, message, cls)).toBe(want);
  });

  it('names a blocked tool', () => {
    expect(statusReason('slack', 'inbox', 'disallowed tool call: mcp__slack__slack_send_message', 'config', 'mcp__slack__slack_send_message')).toBe('Slack inbox: a tool call outside the read-only allowlist was blocked (mcp__slack__slack_send_message)');
  });

  it('never carries ids or message text', () => {
    const r = statusReason('slack', 'thread:D0PLACEHOLD:1793800000.000100', 'run failed: PLACEHOLDER secret text', 'unknown');
    expect(r).toBe('Thread re-reads: a run failed');
  });
});
