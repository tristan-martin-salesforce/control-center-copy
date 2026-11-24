/**
 * The activity engine's account mapper, through the attribution engine (R1). Before, three guessers decided which
 * account (and opp) a piece of evidence is about, each with its own rules (lane 06 TA-1):
 *
 *   1. the calendar mapper: `classifyMeeting` and the meeting blocks (src/engines/activity/classify.ts, blocks.ts):
 *      the projection's account, else the first account whose name pattern the title matches, else a domain;
 *   2. the Slack burst mapper: `ownActions` (blocks.ts): the channel map (never filled: TA-3), else the channel name;
 *   3. the canvas pre-fill: a Time row's suggestion (src/lib/time-suggest.ts `ruleSuggestion`, now
 *      src/engines/attribution/row.ts), which is what pre-fills the logging canvas and the Needs you row.
 *
 * 1 and 2 now call `accountFor` here; 3 calls `rowAttribution` (row.ts). With no learned rule and no channel map the
 * answer is the old one (the title's first matching account wins over a domain; the channel map over the channel's
 * name; the projection's account over a title match): tests/attribution/parity.test.ts measures it over sample-data.
 * What is new: learned rules (a series, channel, domain, contact or repo the user corrected) and the user-confirmed
 * channel map (channel_account_maps) are read first, and a learned opp rule narrows the account's WhatId to that opp.
 */
import type { AccountMapping, ActivityMappings } from '@/engines/activity/types';
import { attribute, type AttributeExtra } from './score';
import type { LearnedRule, Signal, World } from './types';

/** What the activity engine gets from the database besides the account table: learned rules and the opps they name. */
export interface LearnedMappings {
  rules: LearnedRule[];
  /** App opp id → its WhatId, name, account key and whether I'm on it (a learned opp rule sets the row's WhatId). */
  opps: Record<string, { accountKey: string | null; whatId: string; whatName: string; team: boolean; isOpen: boolean }>;
}

/** The projection's own account (its resolver, or the user's locked mapping): ahead of a title match, behind a learned rule. */
const PROJECTION_WEIGHT = 0.82;
/** A repo's mapped account: behind a title match (the old order: the session's account, its title, its repo). */
const REPO_WEIGHT = 0.6;

const worlds = new WeakMap<ActivityMappings, World>();

/** The activity mappings as the engine's World (built once per mappings object). */
export function worldOfMappings(m: ActivityMappings): World {
  const have = worlds.get(m);
  if (have) return have;
  const res = m.accounts.map((a) => ({ key: a.key, re: new RegExp(a.match, 'i') }));
  const learnedOpps = m.learned?.opps ?? {};
  const w: World = {
    accounts: m.accounts.map((a) => ({ id: a.key, name: a.whatName, domains: a.domains ?? [] })),
    opps: Object.entries(learnedOpps).map(([id, o]) => ({ id, accountId: o.accountKey, name: o.whatName, isOpen: o.isOpen, isMine: o.team, myDc: false })),
    channels: Object.fromEntries(Object.entries(m.channels ?? {}).map(([id, accountId]) => [id, { accountId }])),
    rules: m.learned?.rules ?? [],
    internalDomains: m.internalDomains,
    partnerDomains: m.partnerDomains,
    ignoreDomains: m.ignoreDomains,
    today: '9999-12-31',
    // the old order: the first account whose pattern the text matches (the patterns are sorted longest first)
    matchText: (text) => {
      const s = text.toLowerCase();
      const hit = res.find((r) => r.re.test(s));
      return hit ? [{ accountId: hit.key, via: 'name' as const }] : [];
    },
  };
  worlds.set(m, w);
  return w;
}

const byKey = (m: ActivityMappings, key: string | null | undefined) => (key ? (m.accounts.find((a) => a.key === key) ?? null) : null);

export interface AccountForOptions {
  /** The account the projection (or the user) already gave this evidence. */
  projectionKey?: string | null;
  /** The repo mapping's account (Claude sessions, commits). */
  repoKey?: string | null;
}

/**
 * The account (as the activity engine's AccountMapping) a signal is about, or null. A learned opp rule returns the
 * account with that opp as its WhatId.
 */
export function accountFor(sig: Signal, m: ActivityMappings, o: AccountForOptions = {}): AccountMapping | null {
  const world = worldOfMappings(m);
  const extra: AttributeExtra[] = [];
  if (o.projectionKey && byKey(m, o.projectionKey)) extra.push({ accountId: o.projectionKey, reason: { code: 'explicit', weight: PROJECTION_WEIGHT, text: 'The projection mapped it' } });
  if (o.repoKey && byKey(m, o.repoKey)) extra.push({ accountId: o.repoKey, reason: { code: 'explicit', weight: REPO_WEIGHT, text: 'Its repo is mapped there' } });
  const r = attribute(sig, world, { extra, limit: 3, spread: false });
  const top = r.candidates.find((c) => c.kind !== 'internal');
  if (!top) return null;
  if (top.kind === 'opp' && top.oppId) {
    const opp = m.learned?.opps[top.oppId];
    const acct = byKey(m, opp?.accountKey ?? top.accountId);
    if (!opp || !acct) return acct;
    return { ...acct, whatId: opp.whatId, whatType: 'Opportunity', whatName: opp.whatName, team: opp.team };
  }
  return byKey(m, top.accountId);
}

/** The calendar mapper: the meeting's account (projection first, then its title, then its attendees' domains). */
export function meetingAccount(ev: { summary: string; attendeeDomains: readonly string[]; accountKey?: string | null; seriesId?: string | null }, m: ActivityMappings): AccountMapping | null {
  return accountFor({ kind: 'calendar', text: ev.summary, domains: ev.attendeeDomains, seriesId: ev.seriesId ?? null }, m, { projectionKey: ev.accountKey ?? null });
}

/** The Slack burst mapper: a channel's account (the confirmed map or a learned rule, else the channel's name). */
export function channelAccount(channelId: string, name: string | null | undefined, m: ActivityMappings): string | null {
  return accountFor({ kind: 'slack', text: '', channel: { id: channelId, name: name ?? null } }, m)?.key ?? null;
}

/** Any other text (a doc title, an email subject with its recipients' domains, a session title). */
export function textAccount(kind: Signal['kind'], text: string, domains: readonly string[], m: ActivityMappings, o: AccountForOptions = {}): AccountMapping | null {
  return accountFor({ kind, text, domains }, m, o);
}
