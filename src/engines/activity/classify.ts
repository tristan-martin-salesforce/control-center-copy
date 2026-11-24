/**
 * Meeting classification (port of ap/engine.py classify_meeting): keyword table -> edge rules ->
 * overrides -> external-attendee CF swap. Every decision carries a `reason` (tenet: Legible).
 */
import { meetingAccount, textAccount } from '@/engines/attribution/activity';
import { isDinnerTitle } from './event-kinds';
import { internalMeetingType, isInternalTaskType, namedInternalType } from './internal';
import type { AccountMapping, ActivityMappings, CalendarEvidence, Confidence } from './types';
import { CF_SWAP, INTERNAL_DOWNGRADE, MEETING_TYPE, TAXONOMY, isNeither } from './taxonomy';
import { hoursBetween, toMs } from './time';
import { roundQuarter } from './taxonomy';

type Rule3 = readonly [RegExp, string, string];
type Rule4 = readonly [RegExp, string, Confidence, string];

export const NEITHER_RULES: readonly Rule3[] = [
  [/peer cert/, 'Personal Development', 'peer certification'],
  [
    /keynote|town hall|tune in|live ?stream|road to dreamforce|\[mandatory\]|enablement|overview & sell|deal clinic|win wire|pricing models|meshmesh|agentic selling|claudeforce|customer zero|internal training|all hands|all org|\bou call\b|office hours/,
    'Sales Enablement',
    'enablement / all-hands / keynote stream',
  ],
  [
    /forecast|load balancing|team meeting|1:1|weekly sync|catch up|feedback|intro|mid-year|panel|bi-weekly|happy hr|dinner|geek out|spiff|pulse/,
    'Admin',
    'internal cadence / 1:1 / team meeting',
  ],
  [/life sciences|\blsc\b|lsjdo|j-lsdo|headless|\bace\b|consumption notes|d360 planning/, 'Asset Creation', 'demo-org / asset build with no customer named'],
];

export const TYPE_RULES: readonly Rule4[] = [
  [/consumption|estimat|flex credit|sizing|pricing/, 'Consumption Estimation', 'High', "keyword 'consumption/estimate/flex credits'"],
  [/dry run|rehearsal|practice run|\bprep\b/, 'Dry Run', 'High', "keyword 'dry run/prep'"],
  [/dreamforce 2 ?u|df2u/, 'Marketing Support', 'High', "canvas edge rule: 'Dreamforce' -> Marketing Support (DF2U customer event)"],
  [/workshop/, 'Workshop', 'High', "keyword 'workshop'"],
  [/\bpoc\b|proof of concept/, 'POC', 'High', "keyword 'POC'"],
  [/discovery|requirements|scoping/, 'Customer Discovery', 'High', "keyword 'discovery/scoping'"],
  [/debrief/, 'Account Planning', 'Medium', 'internal debrief'],
  [/demo|demonstration|overview|walkthrough|walk .* through|readout/, 'Customer Presentation', 'High', "keyword 'demo/overview/walkthrough'"],
  [
    /\bpov\b|arch|diagram|design|build|scripting|knowledge graph|connector|org changes|refine questions|block|story|research|review|companion org|private connect|lift/,
    'Solution Creation',
    'Medium',
    'internal prep/build/architecture for a named account',
  ],
  [/planning|strategy|sync|touchbase|touch base|\bkt\b|alignment|discussion|check-?in|call|team|follow ?up|connect/, 'Account Planning', 'Medium', 'internal account sync/planning'],
];

/**
 * The customer work a title names, when no account matched (the strong keywords of TYPE_RULES, a QBR, architecture
 * work): [pattern, type, reason, the word]. The broad catch-alls (sync, call, team, review) are left out: those are
 * internal cadence.
 */
const CUSTOMER_WORK: readonly Rule3[] = [
  ...TYPE_RULES.slice(0, 8).map(([p, t, , r]) => [p, t, r] as const),
  [/\bqbr\b|business review/, 'Account Planning', "keyword 'QBR'"],
  [/architect/, 'Solution Creation', "keyword 'architecture'"],
];

export function customerWorkOf(s: string): readonly [RegExp, string, string, string] | null {
  for (const [p, t, r] of CUSTOMER_WORK) {
    const m = p.exec(s);
    if (m) return [p, t, r, m[0]];
  }
  return null;
}

/**
 * The account a text (and its participants' domains) names: the attribution engine's answer (src/engines/attribution
 * activity.ts), which reads learned rules first, then the first account whose pattern the text matches, then a domain.
 */
export function resolveAccount(text: string, domains: readonly string[], m: ActivityMappings): AccountMapping | null {
  return textAccount('manual', text, domains, m);
}

/** The pre-engine resolver (the parity baseline in tests/attribution/parity.test.ts): text first, then a domain. */
export function legacyResolveAccount(text: string, domains: readonly string[], m: ActivityMappings): AccountMapping | null {
  const s = text.toLowerCase();
  for (const a of m.accounts) if (new RegExp(a.match, 'i').test(s)) return a;
  const ds = new Set(domains);
  for (const a of m.accounts) if ((a.domains ?? []).some((d) => ds.has(d))) return a;
  return null;
}

/**
 * A row whose WhatId is an opp I'm not on the team of (and hold no DC on). It waits for the user: the scan holds it
 * (needs_input: Time ▸ Needs you, "Check and approve"), and no batch, chat staging or hands-off approval takes it
 * until the user approves it. `NOT_ON_TEAM_MARKER` is the stable part every check matches.
 */
export const NOT_ON_TEAM_MARKER = 'opp you are not on the team for';
export const NOT_ON_TEAM_FLAG = `${NOT_ON_TEAM_MARKER}; confirm`;
/** Whether a row's flags (or a Time row's issues) hold it for the user: an opp I'm not on. */
export const heldNotOnTeam = (flags: readonly string[] | null | undefined): boolean => (flags ?? []).some((f) => f.includes(NOT_ON_TEAM_MARKER));
/** Why a batch leaves such a row out (Time ▸ Log's skipped list). */
export const NOT_ON_TEAM_SKIP = 'opp you are not on the team for: check and approve it on Activity';

export const accountByKey = (m: ActivityMappings, key: string | null | undefined): AccountMapping | null =>
  (key ? m.accounts.find((a) => a.key === key) : null) ?? null;

export interface MeetingDraft {
  subject: string;
  startsAt: string;
  endsAt: string;
  hours: number;
  extDomains: string[];
  cf: boolean;
  flags: string[];
  evidence: string;
  accountKey: string | null;
  whatId: string;
  whatType: string;
  whatName: string;
  seTaskType: string;
  meetingType: string;
  confidence: Confidence;
  reason: string;
  /** Set when the row is not loggable (Neither type, skip override). */
  skipReason?: string;
  /** D-64: internal-only work (no customer, no account, no opp): logs with no WhatId and an internal task type. */
  internal?: boolean;
}

/** External = not internal, partner or ignored. Any external attendee forces CF. */
export function externalDomains(domains: readonly string[], m: ActivityMappings): string[] {
  const skip = new Set([...m.internalDomains, ...m.partnerDomains, ...m.ignoreDomains]);
  return [...new Set(domains)].filter((d) => !skip.has(d)).sort();
}

export interface ClassifyOptions {
  /** Settings ▸ Time: a dinner with customers is customer-facing (default) or not counted. */
  dinnersCustomerFacing?: boolean;
  /** D-64 (the persona's `internalActivity`): a meeting with no customer, account or opp that names internal work logs as internal. */
  internalActivity?: boolean;
}

export function classifyMeeting(ev: CalendarEvidence, m: ActivityMappings, localDate: string, opts: ClassifyOptions = {}): MeetingDraft {
  const ext = externalDomains(ev.attendeeDomains, m);
  const subject = ev.summary.trim();
  const s = subject.toLowerCase();
  const out: MeetingDraft = {
    subject,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    hours: roundQuarter(hoursBetween(toMs(ev.startsAt), toMs(ev.endsAt))),
    extDomains: ext,
    cf: ext.length > 0,
    flags: [],
    evidence: ev.hasGeminiNotes ? 'Gemini notes' : ev.hasRecording ? 'recording' : '',
    accountKey: null,
    whatId: '',
    whatType: '',
    whatName: '',
    seTaskType: 'Admin',
    meetingType: '',
    confidence: 'Low',
    reason: '',
  };
  // the projection's account (its resolver, or the user's locked mapping) wins over a fresh title match: several
  // accounts can share a customer's name, and one trip must log to one of them (onsite lane, root cause 6)
  // (src/engines/attribution: a learned series, domain or contact rule reads first, then the projection's, then the title)
  const acct = meetingAccount({ summary: subject, attendeeDomains: ev.attendeeDomains, accountKey: ev.accountKey ?? null, seriesId: ev.seriesId ?? null }, m);
  if (acct) {
    out.accountKey = acct.key;
    out.whatId = acct.whatId;
    out.whatType = acct.whatType;
    out.whatName = acct.whatName;
    if (!acct.whatId) out.flags.push('NEEDS WhatId: pick an opp from candidates');
    // D-103 (c): an account with no open opportunity is a settled target; the flag asks only when it has open opps
    else if (acct.whatType === 'Account' && acct.openOpps !== 0) out.flags.push('WhatId = account fallback (no single obvious opp)');
    else if (!acct.team) out.flags.push(NOT_ON_TEAM_FLAG);
  }

  let ttype: string | null = null;
  let conf: Confidence = 'Low';
  let reason = '';
  let noSwap = false;
  // A dinner with customers at the table: customer-facing by default (Settings ▸ Time), never Travel or Admin.
  const dinner = ev.kind !== 'flight' && isDinnerTitle(s) && ext.length > 0;
  if (dinner && opts.dinnersCustomerFacing !== false) {
    [ttype, conf, reason] = ['Customer Discovery', 'Medium', 'customer dinner: customer-facing (Settings ▸ Time)'];
  } else if (dinner) {
    [ttype, conf, reason] = ['Admin', 'Medium', 'customer dinner'];
    out.skipReason = 'customer dinner: not counted (Settings ▸ Time: dinners are off)';
    noSwap = true;
  } else if (ev.kind === 'flight') {
    // a flight is always Travel (2026-11-14): the trip's opp when it is a customer's, else internal (propose.ts)
    [ttype, conf, reason] = ['Travel', 'Medium', 'flight: Travel'];
  } else if (acct) {
    for (const [pat, t, c, r] of TYPE_RULES)
      if (pat.test(s)) {
        [ttype, conf, reason] = [t, c, r];
        break;
      }
    if (!ttype) [ttype, conf, reason] = ext.length ? ['Customer Discovery', 'Medium', 'external meeting, no keyword'] : ['Account Planning', 'Low', 'internal, account named, no keyword'];
    if (!ext.length && INTERNAL_DOWNGRADE[ttype]) {
      const nt = INTERNAL_DOWNGRADE[ttype]!;
      reason = `${reason}; internal-only, so ${ttype} -> ${nt} (no CF without a customer)`;
      ttype = nt;
    }
    if (ev.recurring && !ext.length && /sync|standup|weekly|check-?in|team/.test(s) && ttype === 'Account Planning')
      out.flags.push('canvas edge rule says Admin (recurring internal); kept Account Planning because it is account-specific');
    if (ev.organizerSelf && !ext.length && (ttype === 'Dry Run' || ttype === 'Account Planning') && /prep|planning|research|review|build|create|design|develop|architect|block/.test(s))
      [ttype, conf, reason] = ['Solution Creation', 'High', 'canvas edge rule: you organized, no externals, prep/build'];
  } else {
    // D-64 as amended 2026-11-14: a meeting with no customer, no account and no opp is internal-only activity (Related
    // To empty) with the Org62 precedent's type (Admin for 1:1s, syncs, wraps, all hands, office hours, enablement),
    // logged, never excluded. One whose title names customer work (prep, a QBR, consumption, a workshop) with no account
    // matched asks for its opp (Needs you), with the customer type that work would log as.
    if (opts.internalActivity && !ext.length && !ev.oppWhatId) {
      const work = namedInternalType(s) ? null : customerWorkOf(s);
      if (work) {
        [ttype, conf, reason] = [work[1], 'Low', `${work[2]}, but no account matched`];
        out.flags.push(`NEEDS WhatId: it names customer work (${work[3]}) but no account matched; pick its opp, or mark it Internal`);
        if (INTERNAL_DOWNGRADE[ttype]) {
          const nt = INTERNAL_DOWNGRADE[ttype]!;
          reason = `${reason}; internal-only, so ${ttype} -> ${nt} (no CF without a customer)`;
          ttype = nt;
        }
      } else {
        const internal = internalMeetingType(subject);
        [ttype, conf, reason] = [internal.type, 'Medium', `internal: ${internal.reason} (no customer, account or opp)`];
        out.internal = true;
      }
    }
    if (!ttype)
      for (const [pat, t, r] of NEITHER_RULES)
        if (pat.test(s)) {
          [ttype, conf, reason] = [t, 'Medium', r];
          break;
        }
    if (!ttype) [ttype, conf, reason] = ['Admin', 'Low', 'no account or keyword signal'];
  }

  for (const o of m.overrides) {
    if (!new RegExp(o.match, 'i').test(subject)) continue;
    if (o.date && !localDate.startsWith(o.date)) continue;
    ttype = o.type ?? ttype;
    reason = o.reason ?? reason;
    conf = o.conf ?? (o.type ? 'High' : conf);
    if (o.accountKey && o.whatId !== undefined) {
      out.internal = false;
      out.accountKey = o.accountKey;
      out.whatId = o.whatId;
      out.whatType = o.whatType ?? '';
      out.whatName = o.whatName ?? '';
    }
    if (o.meetingType) out.meetingType = o.meetingType;
    if (o.flag) out.flags.push(o.flag);
    if (o.skip) out.skipReason = o.skip;
    break;
  }

  let t = ttype ?? 'Admin';
  if (noSwap) {
    /* the user turned customer dinners off: no CF swap brings them back */
  } else if (ext.length && CF_SWAP[t]) {
    out.flags.push(`CF forced: external attendee (${ext.join(', ')}); ${t} -> ${CF_SWAP[t]}`);
    t = CF_SWAP[t]!;
  } else if (ext.length && isNeither(t)) {
    out.flags.push(`CF forced: external attendee (${ext.join(', ')}); Neither type -> Customer Discovery, review`);
    t = 'Customer Discovery';
  }
  // an override that names a customer type makes it the customer's work again
  if (out.internal && !isInternalTaskType(t)) out.internal = false;
  out.seTaskType = t;
  out.confidence = conf;
  out.reason = reason;
  out.meetingType = out.meetingType || MEETING_TYPE[t] || '';
  if (TAXONOMY[t]?.[0] === 0 && !out.skipReason && !out.internal) out.skipReason = `'${t}' is Neither CF nor CR (canvas): not loggable`;
  return out;
}
