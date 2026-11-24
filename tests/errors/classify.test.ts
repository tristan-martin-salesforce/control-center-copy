/**
 * 08 R2 / 11 R5: classify(connector, err) on recorded error strings (placeholders only), per source, ahead of the
 * shared signatures; the retry policy (parse drift pauses, unknown stops after N); the status line reads the code.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { classify, failureDecision, unknownRetryLimit } from '../../src/errors/classify';
import { ParseDrift } from '../../src/errors/drift';
import { reasonOf } from '../../src/errors/render';
import { ParseDrift as GoogleParseDrift } from '../../src/connectors/google/parse';
import { parseSlackChannel, parseSlackSearch, parseSlackThread } from '../../src/connectors/slack/parse';
import { classifyError, probeFromError } from '../../src/llm/errors';
import { statusReason } from '../../src/scanner/runtime/status-reason';

afterEach(() => void delete process.env.CC_LLM_GATEWAY);

const code = (connector: string | null, err: unknown, gatewayConfigured = false) => classify(connector, err, { gatewayConfigured }).code;

describe('Claude Code (every relayed read)', () => {
  it.each([
    ['slack', 'Error: spawn /Users/me/.local/bin/claude ENOENT', 'DEP.CLAUDE.MISSING'],
    ['org62', 'Claude Code executable not found at /x/claude', 'DEP.CLAUDE.MISSING'],
    ['slack', "error: unknown option '--max-budget-usd'", 'DEP.CLAUDE.TOO_OLD'],
    ['slack', 'Claude AI usage limit reached|1793900000', 'RATE.LLM.USAGE_LIMIT'],
    ['org62', 'API Error: 400 {"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}', 'RATE.LLM.CREDIT'],
    ['slack', 'Invalid API key · Please run /login', 'AUTH.LLM.SIGNED_OUT'],
    ['slack', 'model_not_found: claude-placeholder', 'AUTH.LLM.MODEL_ACCESS'],
  ])('%s: %s → %s', (c, msg, want) => expect(code(c, msg)).toBe(want));

  it('an invalid key is the gateway only when a gateway is configured (CONN-6: never "sign in to devbar" otherwise)', () => {
    expect(code('slack', 'Invalid API key · Fix external API key', true)).toBe('AUTH.LLM.GATEWAY_KEY');
    expect(code('slack', 'Invalid API key · Fix external API key', false)).toBe('AUTH.LLM.SIGNED_OUT');
    process.env.CC_LLM_GATEWAY = '0';
    const p = probeFromError('slack', 'assistant error authentication_failed', 'now');
    expect(p.reauth?.command).toBe('claude');
    expect(p.reauth?.instructions).not.toMatch(/devbar/);
    expect(statusReason('slack', 'inbox', 'authentication_failed', 'auth', undefined, code('slack', 'authentication_failed'))).toBe("Slack inbox: Claude Code isn't signed in");
  });
});

describe('Slack and Org62 through Claude Code MCP', () => {
  it.each([
    ['slack', 'config: MCP server slack is not declared in the user Claude config', 'MCP.SERVER_NOT_DECLARED'],
    ['org62', 'config: MCP server Org62-Sobject-Read is not declared in the user Claude config', 'MCP.SERVER_NOT_DECLARED'],
    ['slack', 'mcp server slack status needs-auth', 'AUTH.SLACK.SIGNED_OUT'],
    ['slack', 'slack_search returned an error: token_expired', 'AUTH.SLACK.EXPIRED'],
    ['org62', 'INVALID_SESSION_ID: Session expired or invalid', 'AUTH.ORG62.EXPIRED'],
    ['org62', 'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded', 'RATE.ORG62.REQUEST_LIMIT'],
    ['org62', 'MALFORMED_QUERY: unexpected token', 'DATA.SOQL_INVALID'],
    ['slack', 'ratelimited', 'RATE.SLACK'],
    ['slack', 'channel_not_found', 'DATA.SLACK_SCOPE'],
  ])('%s: %s → %s', (c, msg, want) => expect(code(c, msg)).toBe(want));
});

describe('Google through devbar (CONN-5)', () => {
  it.each([
    ['gmail', 'Error: spawn devbar ENOENT', 'DEP.DEVBAR.MISSING'],
    ['calendar', 'google list_calendars failed [daemon_down]: connect ECONNREFUSED 127.0.0.1:13316', 'DEP.DEVBAR.DAEMON_DOWN'],
    ['drive', 'devbar is signed out', 'AUTH.GOOGLE.DEVBAR_SIGNED_OUT'],
    ['gmail', 'google-workspace-readonly connector is disconnected', 'AUTH.GOOGLE.CONNECTOR_MISSING'],
    ['gmail', 'google search_gmail_messages failed [auth]: invalid_grant', 'AUTH.GOOGLE.EXPIRED'],
    ['gmail', 'google get_events failed [gateway_down]: This application is down for maintenance', 'NET.GATEWAY_DOWN'],
    ['calendar', 'Streamable HTTP error: Error POSTing to endpoint: upstream request failed', 'NET.GATEWAY_DOWN'],
    ['drive', 'google get_drive_file_content failed [no_access]: forbidden', 'DATA.FILE_UNAVAILABLE'],
    ['gmail', 'google search failed [rate_limited]: userRateLimitExceeded', 'RATE.GOOGLE'],
  ])('%s: %s → %s', (c, msg, want) => expect(code(c, msg)).toBe(want));

  it('missing and down are different codes with different next steps', () => {
    expect(classify('gmail', 'spawn devbar ENOENT').action?.label).not.toBe('Restart devbar');
    expect(classify('gmail', 'connect ECONNREFUSED 127.0.0.1:13316').action).toMatchObject({ kind: 'reauth', ref: 'devbar_restart' });
  });
});

describe('VDP', () => {
  it.each([
    ['VDP requires re-auth (cookie_expired): the Okta gateway cookie expired 3 min ago', 'AUTH.VDP.COOKIE_EXPIRED'],
    ['VDP requires re-auth (sso_redirect): the gateway redirected to the sign-in page', 'AUTH.VDP.COOKIE_EXPIRED'],
    ['VDP requires re-auth (pat_revoked): HTTP 401 unauthorized while the gateway cookie is valid', 'AUTH.VDP.PAT_REVOKED'],
    ['VDP requires re-auth (pat_missing): the VDP PAT is missing (an admin issues it)', 'AUTH.VDP.NO_PAT'],
    ['VDP is unreachable (ENOTFOUND; corporate network or Zscaler needed)', 'NET.VPN_REQUIRED'],
    ['Okta needs MFA; skipped (--no-window)', 'AUTH.VDP.MFA'],
    ['No python3 on this Mac has Playwright.', 'DEP.PYTHON.NO_PLAYWRIGHT'],
    ['VDP rate limited get_vdp (429 too many requests; 60 calls a minute)', 'RATE.VDP'],
  ])('%s → %s', (msg, want) => expect(code('vdp', msg)).toBe(want));

  it('the Zscaler hint reaches Health (it read "temporarily unavailable" before)', () => {
    const msg = 'VDP is unreachable (ENOTFOUND; corporate network or Zscaler needed)';
    expect(statusReason('vdp', 'mine', msg, classifyError(msg).errorClass, undefined, code('vdp', msg))).toBe('VDP plans: needs the corporate network: turn on Zscaler, retrying');
  });
});

describe('parse drift (CONN-9)', () => {
  it('a Google or Slack ParseDrift is DATA.PARSE_DRIFT, paused, not retried', () => {
    expect(code('gmail', new GoogleParseDrift('gmail.search', 'header says messages found but none parsed'))).toBe('DATA.PARSE_DRIFT');
    expect(code('gmail', 'ParseDrift: parser drift in gmail.batch: header says messages retrieved but none parsed')).toBe('DATA.PARSE_DRIFT');
    expect(code('slack', new ParseDrift('slack.search', 'x'))).toBe('DATA.PARSE_DRIFT');
    expect(failureDecision('DATA.PARSE_DRIFT', 1)).toEqual({ kind: 'pause', code: 'DATA.PARSE_DRIFT' });
    expect(statusReason('gmail', 'inbox', 'ParseDrift: parser drift in gmail.search', 'config', undefined, 'DATA.PARSE_DRIFT')).toBe(`Inbox: ${reasonOf('DATA.PARSE_DRIFT')}`);
  });

  it('Slack text with its own markers that parses to nothing throws; empty or error text does not', () => {
    const broken = JSON.stringify({ results: '### Result 1 of 3\nChannel: something new\nNo ts here\n---\n', pagination_info: '' });
    expect(() => parseSlackSearch(broken)).toThrow(ParseDrift);
    expect(parseSlackSearch(JSON.stringify({ results: '', pagination_info: '' })).messages).toEqual([]);
    expect(parseSlackSearch('No results found.').messages).toEqual([]);
    expect(() => parseSlackThread('=== THREAD PARENT MESSAGE ===\nsomething unreadable', 'C0PLACEHOLD')).toThrow(ParseDrift);
    expect(() => parseSlackChannel('=== Message from PERSON at 10:00 ===\n(no ts line)', 'C0PLACEHOLD')).toThrow(ParseDrift);
    expect(parseSlackChannel('channel_not_found', 'C0PLACEHOLD').messages).toEqual([]);
  });
});

describe('unknown stops retrying after N (default 5, CC_UNKNOWN_MAX_RETRIES)', () => {
  it('retries, then stops as BUG.UNKNOWN_STOPPED with Report this', () => {
    expect(code('slack', 'something odd happened')).toBe('BUG.UNKNOWN');
    expect(unknownRetryLimit({})).toBe(5);
    expect(unknownRetryLimit({ CC_UNKNOWN_MAX_RETRIES: '2' })).toBe(2);
    for (let n = 1; n < 5; n++) expect(failureDecision('BUG.UNKNOWN', n, 5)).toEqual({ kind: 'retry' });
    expect(failureDecision('BUG.UNKNOWN', 5, 5)).toEqual({ kind: 'pause', code: 'BUG.UNKNOWN_STOPPED' });
    expect(classify('slack', 'x').errorClass).toBe('unknown');
  });

  it('sign-ins and outages keep the runtime own handling', () => {
    expect(failureDecision('AUTH.SLACK.EXPIRED', 9)).toEqual({ kind: 'retry' });
    expect(failureDecision('NET.GATEWAY_DOWN', 9)).toEqual({ kind: 'retry' });
    expect(failureDecision('RATE.LLM.USAGE_LIMIT', 9)).toEqual({ kind: 'retry' });
    expect(failureDecision('MCP.SERVER_NOT_DECLARED', 1)).toEqual({ kind: 'pause', code: 'MCP.SERVER_NOT_DECLARED' });
  });
});
