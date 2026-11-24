/**
 * Evidence -> time blocks, with overlap resolution (D-17 hours are human hours, D-18 meetings win,
 * then focused work, then Slack; no double counting). Solo work is engaged time built from my own actions (engaged.ts:
 * prompts, Slack messages and emails sent, Drive edits, commits), never a session's or a burst's length.
 *
 * Counted blocks never overlap each other: blocks are the wall clock. Anything that loses an overlap is kept as an
 * overlay (`isOverlay`, not counted) so the UI can still shade it. Agent/background time is never counted.
 *
 * Only rows that will log resolve overlaps (D-18 amended): a meeting that will not log (Admin, a `skip`, a rule or
 * user dismissal; `BlockOptions.nonLogging`) fills only the time nothing else claims, so it never makes another row
 * lose. Whether a meeting that lost here still logs is the entries' call (propose.ts, `ActivityConfig.overlaps`).
 */
import { accountFor, channelAccount, meetingAccount } from '@/engines/attribution/activity';
import { accountByKey, resolveAccount } from './classify';
import { type EngagedAction, type EngagedKind, engagedParams, engagedStretches } from './engaged';
import {
  MIN,
  type Interval,
  addDays,
  localDay,
  subtractIntervals,
  toIsoSec,
  toMs,
  unionIntervals,
  zonedToMs,
} from './time';
import {
  PRECEDENCE,
  type ActivityConfig,
  type ActivityMappings,
  type CalendarEvidence,
  type EvidenceBundle,
  type TimeBlock,
  type TimeBlockSource,
} from './types';

export interface BlockOptions {
  /** Meeting ranking for double-booked slots (higher wins). Default: CF first, then longer. */
  meetingRank?: (ev: CalendarEvidence) => number;
  /**
   * Travel (a flight plus its airport buffer, already split at local midnight). Ranks with meetings, after every
   * meeting, so a call taken at the gate is the call and the flight keeps the rest.
   */
  travel?: { key: string; iv: Interval; accountKey: string | null; evidenceIds: string[] }[];
  /** Onsite frames (one per day, never overnight): below meetings and travel, above focused work and Slack. */
  frames?: { key: string; iv: Interval; accountKey: string | null; evidenceIds: string[] }[];
  /** Keys of meetings, travel and onsite frames that will not log (`cal|<id>|<start>`, `onsite|<day>`): they yield to everything that does. */
  nonLogging?: ReadonlySet<string>;
  /** Calendar events that are no meeting at all (personal blocks: lunch, a hold of my own): they make no block. */
  notMeetings?: ReadonlySet<string>;
  /**
   * Counted time solo work never double-counts, though it makes no block: the user's own rows and Org62 Events (other
   * than the user's own solo-work rows, which the new estimate replaces). Meetings, travel and frames ignore it.
   */
  yieldTo?: readonly Interval[];
}

/** An interval cut at local midnights. */
function atMidnight(x: Interval, tz: string): Interval[] {
  const out: Interval[] = [];
  let s = x.start;
  for (let i = 0; i < 8 && s < x.end; i++) {
    const e = Math.min(x.end, zonedToMs(addDays(localDay(s, tz), 1), '00:00', tz));
    out.push({ start: s, end: e });
    s = e;
  }
  return out;
}

/** The time block source of an engaged piece, by the kind most of its actions are. */
const SOURCE_OF: Readonly<Record<EngagedKind, TimeBlockSource>> = {
  prompt: 'claude_hands_on',
  segment: 'claude_hands_on',
  git: 'git',
  drive: 'doc_edit',
  slack: 'slack_burst',
  // email has no block source of its own (the enum is the database's): an estimate of my own time
  email: 'estimate',
};

/** The block sources solo work (engaged time) comes in. */
export const ENGAGED_SOURCES: ReadonlySet<TimeBlockSource> = new Set(['claude_hands_on', 'doc_edit', 'git', 'slack_burst', 'estimate']);

/**
 * My own actions in an evidence bundle, attributed (D-64): a prompt to its session's account (the session's mapping,
 * else its title, else its repo's mapping), else its repo; a Slack message to its channel's account (the mapping, else
 * the channel name); a Drive edit to the account its title names; an email to the account of its recipients' domains or
 * subject; a commit to its repo's account. Anything else is internal (unmapped Drive docs, unmapped Slack and email).
 */
export function ownActions(ev: EvidenceBundle, m: ActivityMappings): EngagedAction[] {
  const out: EngagedAction[] = [];
  const acctOfRepo = (repo: string): string | null => m.repos[repo] ?? null;
  for (const c of ev.claude) {
    // the session's own account, else the engine over its title and repo (a learned repo rule; the repo mapping after a title match)
    const acct = c.accountKey ?? (accountFor({ kind: 'claude', text: c.title ?? '', repo: c.repoKey }, m, { repoKey: acctOfRepo(c.repoKey) })?.key ?? null);
    const base = { evidenceId: c.sessionId, accountKey: acct ?? null, repoKey: c.repoKey };
    const seen = new Set<number>();
    for (const t of c.turns ?? []) {
      const at = toMs(t.at);
      if (seen.has(at)) continue;
      seen.add(at);
      const run = toMs(t.runEndsAt);
      out.push({ ...base, kind: 'prompt', at, ...(Number.isFinite(run) && run > at ? { runEndsAt: run } : {}) });
    }
    for (const p of c.promptTimes ?? []) {
      const at = toMs(p);
      if (seen.has(at)) continue;
      seen.add(at);
      out.push({ ...base, kind: 'prompt', at });
    }
    for (const seg of c.humanSegments ?? []) out.push({ ...base, kind: 'segment', at: toMs(seg.startsAt), until: toMs(seg.endsAt) });
  }
  for (const d of ev.drive) {
    const acct = resolveAccount(d.title, [], m)?.key ?? null;
    if (d.sessionStart && d.sessionEnd) out.push({ kind: 'segment', at: toMs(d.sessionStart), until: toMs(d.sessionEnd), evidenceId: d.fileId, accountKey: acct, repoKey: null });
    else out.push({ kind: 'drive', at: toMs(d.editedAt), evidenceId: d.fileId, accountKey: acct, repoKey: null });
  }
  for (const g of ev.git) out.push({ kind: 'git', at: toMs(g.at), evidenceId: g.sha, accountKey: acctOfRepo(g.repoKey), repoKey: g.repoKey });
  // the Slack burst mapper (src/engines/attribution): a learned channel rule, the confirmed channel map, else its name
  const chanAcct = (channelId: string, name?: string | null): string | null => channelAccount(channelId, name, m);
  if (ev.slackMessages) for (const s of ev.slackMessages) out.push({ kind: 'slack', at: toMs(s.at), evidenceId: s.id, accountKey: chanAcct(s.channelId, s.channelName), repoKey: null });
  else for (const b of ev.slack) out.push({ kind: 'slack', at: toMs(b.startsAt), until: toMs(b.endsAt), evidenceId: b.id, accountKey: chanAcct(b.channelId), repoKey: null });
  for (const e of ev.emails ?? []) {
    const ext = (e.domains ?? []).filter((d) => !m.internalDomains.includes(d) && !m.ignoreDomains.includes(d));
    out.push({ kind: 'email', at: toMs(e.at), evidenceId: e.id, accountKey: resolveAccount(e.subject ?? '', ext, m)?.key ?? null, repoKey: null });
  }
  return out.filter((a) => Number.isFinite(a.at));
}

interface Cand {
  key: string;
  source: TimeBlockSource;
  attention: TimeBlock['attention'];
  precedence: number;
  /** 0: rows that log; 1: meetings that will not log (they claim only what is left). */
  tier: number;
  order: number; // tie-break inside one precedence
  iv: Interval;
  accountKey: string | null;
  repoKey: string | null;
  evidenceIds: string[];
  counts: boolean; // false for background
  /** Solo work (engaged time): it yields to `BlockOptions.yieldTo` too. */
  evidence?: boolean;
}

/**
 * Meetings he actually attended: accepted (or organized), not deleted, not all-day, not OOO/focus. Flights are
 * travel, and markers (12 h+ or across midnight) and hotel stays are never meetings (event-kinds.ts).
 */
export function isAttendedMeeting(ev: CalendarEvidence): boolean {
  if (ev.deleted || ev.allDay) return false;
  if (ev.kind === 'ooo' || ev.kind === 'focus' || ev.kind === 'flight' || ev.kind === 'marker' || ev.kind === 'hotel' || ev.kind === 'working_location') return false;
  if (ev.selfResponse !== 'accepted' && !ev.organizerSelf) return false;
  // declined is declined, also on a meeting I organize (an instance of my own series)
  if (ev.selfResponse === 'declined') return false;
  if (ev.attended === false) return false;
  return true;
}

export function defaultMeetingRank(ev: CalendarEvidence, m: ActivityMappings): number {
  const skip = new Set([...m.internalDomains, ...m.partnerDomains, ...m.ignoreDomains]);
  const ext = ev.attendeeDomains.some((d) => !skip.has(d));
  const dur = (toMs(ev.endsAt) - toMs(ev.startsAt)) / MIN;
  return (ext ? 1e6 : 0) + dur;
}

function candidates(ev: EvidenceBundle, m: ActivityMappings, cfg: ActivityConfig, opts: BlockOptions): Cand[] {
  const out: Cand[] = [];

  // Meetings: ordered by rank so a double-booked loser is the one that becomes an overlay.
  const meets = ev.calendar.filter((c) => isAttendedMeeting(c) && !opts.notMeetings?.has(`cal|${c.id}|${c.startsAt}`));
  const rank = opts.meetingRank ?? ((x: CalendarEvidence) => defaultMeetingRank(x, m));
  meets
    .sort((a, b) => rank(b) - rank(a) || toMs(a.startsAt) - toMs(b.startsAt))
    .forEach((c, i) => {
      const acct = meetingAccount({ summary: c.summary, attendeeDomains: c.attendeeDomains, accountKey: c.accountKey ?? null, seriesId: c.seriesId ?? null }, m);
      const key = `cal|${c.id}|${c.startsAt}`;
      out.push({
        key,
        source: 'calendar',
        attention: 'meeting',
        precedence: PRECEDENCE.meeting,
        tier: opts.nonLogging?.has(key) ? 1 : 0,
        order: i,
        iv: { start: toMs(c.startsAt), end: toMs(c.endsAt) },
        accountKey: acct?.key ?? null,
        repoKey: null,
        evidenceIds: [c.id],
        counts: true,
      });
    });

  // Travel after every meeting; then the onsite frames, which fill what meetings and travel leave.
  (opts.travel ?? []).forEach((t, i) =>
    out.push({ key: t.key, source: 'travel', attention: 'meeting', precedence: PRECEDENCE.meeting, tier: opts.nonLogging?.has(t.key) ? 1 : 0, order: 10_000 + i, iv: t.iv, accountKey: t.accountKey, repoKey: null, evidenceIds: t.evidenceIds, counts: true }),
  );
  (opts.frames ?? []).forEach((f, i) =>
    out.push({ key: f.key, source: 'onsite', attention: 'meeting', precedence: PRECEDENCE.onsite, tier: opts.nonLogging?.has(f.key) ? 1 : 0, order: 10_000 + i, iv: f.iv, accountKey: f.accountKey, repoKey: null, evidenceIds: f.evidenceIds, counts: true }),
  );

  // Solo work: the engaged time of my own actions (engaged.ts), cut into attributed pieces; agent time never counts
  // beyond the model's partial share, and its sessions' background spans are shown as leverage only (D-17).
  const actions = ownActions(ev, m);
  engagedStretches(actions, engagedParams(cfg.evidence.engaged)).forEach((st, si) =>
    st.pieces.forEach((p, pi) => {
      const src = SOURCE_OF[p.kind];
      // never overnight: a stretch past midnight is two days' time
      for (const iv of atMidnight({ start: p.start, end: p.end }, cfg.timezone))
        out.push({
          key: `engaged|${p.bucket}|${toIsoSec(iv.start)}`,
          source: src,
          attention: src === 'slack_burst' || src === 'estimate' ? 'ambient' : 'focused',
          precedence: src === 'slack_burst' || src === 'estimate' ? PRECEDENCE.slack : PRECEDENCE.focused,
          tier: 0,
          order: 100 + si * 0.001 + pi * 0.000001,
          iv,
          accountKey: p.accountKey,
          repoKey: p.repoKey,
          evidenceIds: p.evidenceIds,
          counts: true,
          evidence: true,
        });
    }),
  );
  const bgByRepo = new Map<string, { iv: Interval[]; sessions: Set<string>; acct: string | null }>();
  for (const c of ev.claude) {
    const s = bgByRepo.get(c.repoKey) ?? { iv: [], sessions: new Set<string>(), acct: c.accountKey ?? m.repos[c.repoKey] ?? null };
    bgByRepo.set(c.repoKey, s);
    s.sessions.add(c.sessionId);
    for (const seg of c.backgroundSegments ?? []) s.iv.push({ start: toMs(seg.startsAt), end: toMs(seg.endsAt) });
  }
  for (const [repo, s] of [...bgByRepo].sort(([a], [b]) => a.localeCompare(b)))
    for (const iv of unionIntervals(s.iv))
      out.push({
        key: `claudebg|${repo}|${toIsoSec(iv.start)}`,
        source: 'claude_background',
        attention: 'background',
        precedence: PRECEDENCE.background,
        tier: 0,
        order: 900,
        iv,
        accountKey: s.acct,
        repoKey: repo,
        evidenceIds: [...s.sessions].sort(),
        counts: false,
      });
  return out.filter((c) => c.iv.end > c.iv.start);
}

export function buildTimeBlocks(
  evidence: EvidenceBundle,
  mappings: ActivityMappings,
  cfg: ActivityConfig,
  opts: BlockOptions = {},
): TimeBlock[] {
  const cands = candidates(evidence, mappings, cfg, opts).sort(
    (a, b) => a.tier - b.tier || b.precedence - a.precedence || a.order - b.order || a.iv.start - b.iv.start || a.key.localeCompare(b.key),
  );
  let claimed: Interval[] = [];
  const blocks: TimeBlock[] = [];
  const mk = (c: Cand, iv: Interval, key: string, overlay: boolean): TimeBlock => ({
    dedupeKey: key,
    source: c.source,
    startsAt: toIsoSec(iv.start),
    endsAt: toIsoSec(iv.end),
    localDay: localDay(iv.start, cfg.timezone),
    attention: c.attention,
    countsAsHumanHours: c.counts && !overlay,
    precedence: c.precedence,
    isOverlay: overlay,
    accountKey: c.accountKey,
    repoKey: c.repoKey,
    evidenceIds: c.evidenceIds,
  });
  for (const c of cands) {
    if (!c.counts) {
      blocks.push(mk(c, c.iv, c.key, false)); // background: shown as leverage, never claims time
      continue;
    }
    const free = subtractIntervals([c.iv], c.evidence && opts.yieldTo?.length ? unionIntervals([...claimed, ...opts.yieldTo]) : claimed).filter((x) => x.end - x.start >= MIN);
    const lost = subtractIntervals([c.iv], free).filter((x) => x.end - x.start >= MIN);
    free.forEach((iv, i) => blocks.push(mk(c, iv, free.length === 1 ? c.key : `${c.key}#${i + 1}`, false)));
    lost.forEach((iv, i) => blocks.push(mk(c, iv, `${c.key}~overlay${i + 1}`, true)));
    claimed = unionIntervals([...claimed, ...free]);
  }
  return blocks.sort((a, b) => toMs(a.startsAt) - toMs(b.startsAt) || a.dedupeKey.localeCompare(b.dedupeKey));
}

/** Counted human hours inside a set of blocks. */
export function humanHours(blocks: readonly TimeBlock[]): number {
  return blocks.filter((b) => b.countsAsHumanHours).reduce((s, b) => s + (toMs(b.endsAt) - toMs(b.startsAt)), 0) / 3_600_000;
}

/** Agent time that was NOT counted (the "leverage" figure, D-17). */
export function leverageHours(blocks: readonly TimeBlock[]): number {
  return blocks.filter((b) => b.attention === 'background').reduce((s, b) => s + (toMs(b.endsAt) - toMs(b.startsAt)), 0) / 3_600_000;
}

export { accountByKey };
