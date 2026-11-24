/**
 * A connector's status reason in plain words: which scope failed and why. It is written to `connectors.status_reason`
 * (Health's impact line, Settings ▸ Connectors). Before, it was the classifier's code, and a tripwire, a cost cap or a
 * stuck run all came out as "unknown" (STAT-1).
 *
 * 11 R5 / 08 R2: an error's words come from the error catalog. The caller passes the failure's catalog code
 * (src/errors/classify.ts), and the reason is that code's phrase (src/errors/render.ts `reasonOf`), so Health reads
 * what the catalog says ("VDP plans: needs the corporate network: turn on Zscaler, retrying") instead of re-parsing the
 * message. Without a code (rows and callers from before the catalog) the old message rules still apply. The runtime's
 * own statuses (a tripwire, a cost cap, a split) are not errors and keep their words.
 */
import { GATEWAY_DOWN_WORDS, GATEWAY_ERROR, GATEWAY_ERROR_WORDS } from '../../connectors/google/gateway';
import { isCatalogCode } from '../../errors/catalog';
import { reasonOf } from '../../errors/render';
import type { ConnectorId } from '../types';
import type { ErrorClass } from '../../llm/errors';

const SCOPE_LABEL: Partial<Record<ConnectorId, (scope: string) => string>> = {
  slack: (s) => (s === 'inbox' ? 'Slack inbox' : s.startsWith('channel:') ? 'Channel scans' : s.startsWith('thread:') ? 'Thread re-reads' : 'Slack'),
  org62: (s) => ({ opps: 'Org62 opportunities', events: 'Org62 events', dcs: 'Org62 deal contributions', book: 'Org62 book', missed_opps: 'Missed-opportunity sweep' })[s] ?? 'Org62',
  gmail: (s) => (s === 'sent' ? 'Sent mail' : s === 'inbox' ? 'Inbox' : 'Gmail'),
  calendar: () => 'Calendar',
  drive: () => 'Drive files',
  gemini_notes: () => 'Meeting notes',
  claude_sessions: () => 'Claude sessions',
  trainings: () => 'Trainings',
  watch: () => 'Channel briefs',
  vdp: () => 'VDP plans',
};

/** A scope in Health's words ("Inbox", "Slack inbox", "Org62 opportunities"); the connector id when it has none. */
export function scopeLabel(connector: ConnectorId, scope: string): string {
  return SCOPE_LABEL[connector]?.(scope) ?? connector;
}

/** The connectors that read Google through devbar's MCP gateway. */
const GOOGLE: ReadonlySet<ConnectorId> = new Set<ConnectorId>(['gmail', 'calendar', 'drive', 'gemini_notes', 'trainings']);

/** "Channel scans: prompt over the size limit" (at most 240 characters; no ids or message text, only a blocked tool's name). */
/** Codes whose old, finer wording stays (which file failed; maintenance vs an error page), or that say nothing new. */
const KEEP_MESSAGE_WORDS = new Set(['DATA.FILE_UNAVAILABLE', 'NET.GATEWAY_DOWN', 'BUG.UNKNOWN', 'BUG.TOOL_BLOCKED']);

export function statusReason(connector: ConnectorId, scope: string, message: string, errorClass: ErrorClass, blockedTool?: string, code?: string | null): string {
  const label = scopeLabel(connector, scope);
  const reason = (() => {
    if (/prefix tripwire/i.test(message)) return 'prompt over the size limit';
    if (/cost cap/i.test(message)) return 'a run hit its cost cap';
    // W0-7: the window could not be split further: retried in smaller pages, then paused (DATA.PROMPT_CAP)
    if (/DATA\.PROMPT_CAP/.test(message)) return 'one message set is too large to read, even in smaller pages; paused until you Rescan (Report this)';
    if (/prompt cap/i.test(message)) return /no split left/.test(message) ? 'one message set is too large to read in one request; retrying in smaller pages' : 'a run was split to keep each request under the long-prompt price tier';
    if (/max_turns|max turns/i.test(message)) return 'a run hit its turn limit';
    if (/watchdog|run exceeded \d+ ?ms/i.test(message)) return 'a run took longer than its time limit';
    if (/without (?:a cursor|cc_finish)/i.test(message)) return 'a run stopped before finishing';
    if (blockedTool || /disallowed tool/i.test(message)) return `a tool call outside the read-only allowlist was blocked${blockedTool ? ` (${blockedTool})` : ''}`;
    // the catalog's phrase for the failure's code (the scanner passes it; nothing re-parses the message)
    if (code && isCatalogCode(code) && !KEEP_MESSAGE_WORDS.has(code)) return reasonOf(code);
    // a maintenance page: the service is down, not the user's sign-in (Google reads go through devbar's MCP gateway)
    if (/\[gateway_down\]|down for maintenance|under maintenance/i.test(message)) return GOOGLE.has(connector) ? GATEWAY_DOWN_WORDS : 'the service is down for maintenance (not your sign-in), retrying';
    if (errorClass === 'auth') return 'needs re-auth';
    // E5: any other failed POST to the gateway is its outage too, whatever the run was classified as when it failed
    if (GATEWAY_ERROR.test(message)) return GOOGLE.has(connector) ? GATEWAY_ERROR_WORDS : "the service's gateway isn't answering (not your sign-in), retrying";
    if (errorClass === 'rate_limited') return 'rate limited, retrying';
    if (errorClass === 'transient') return 'temporarily unavailable, retrying';
    const g = /\[(not_found|no_access|bad_request)\]/.exec(message)?.[1];
    if (g === 'not_found') return "a file couldn't be found";
    if (g === 'no_access') return "a file isn't shared with you";
    if (g === 'bad_request') return "a file couldn't be read";
    if (/coverage/i.test(message)) return "a run's coverage didn't reach its cursor";
    return 'a run failed';
  })();
  return `${label}: ${reason}`.slice(0, 240);
}
