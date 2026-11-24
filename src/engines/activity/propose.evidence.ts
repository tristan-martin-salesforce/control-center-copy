// Focus-frame and evidence entries for the activity plan. Split from propose.ts (max-lines); propose.ts re-exports the public names.
import { ENGAGED_SOURCES } from './blocks';
import { accountByKey } from './classify';
import { newEntry, stripWhatIfNeither } from './entry';
import { internalWorkType, isInternalTaskType } from './internal';
import type { OnsiteDay } from './onsite';
import { placeAcross } from './placement';
import { defaultMeetingType, isCF, roundQuarter } from './taxonomy';
import { HOUR, type Interval, MIN, localDay, subtractIntervals, toMs, toIsoSec } from './time';
import {
  overlapModeOf, type ActivityConfig, type ActivityEntry, type ActivityMappings, type EvidenceBundle,
  type OverlapMode, type RejectedProposal, type TimeBlock,
} from './types';
import { whatKindOf } from './propose.meetings';

/** The day's onsite type: the most-hours customer-facing type of its sessions, else Customer Discovery. */
function frameType(day: string, meetings: readonly ActivityEntry[], tz: string): string {
  const by = new Map<string, number>();
  for (const m of meetings) {
    if (m.status === 'excluded' || !m.tripKey || !m.seTaskType || !isCF(m.seTaskType) || localDay(toMs(m.startsAt), tz) !== day) continue;
    by.set(m.seTaskType, (by.get(m.seTaskType) ?? 0) + m.durationHours);
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'Customer Discovery';
}
type FramePiece = { dedupeKey: string; startsAt: string; endsAt: string };
export type FrameInput = { key: string; iv: Interval; accountKey: string | null; evidenceIds: string[] };
/**
 * The pieces of each onsite day that log. `count_once`: what the counted blocks left (the gaps between sessions).
 * `log_all_accepted`: the whole frame (D-18 amended): meetings during it log as their own rows too; only travel (and
 * the user's own non-meeting rows, already out of `frames`) takes time out of it. Keys follow the blocks' naming.
 */
export function framePieces(mode: OverlapMode, frames: readonly FrameInput[], blocks: readonly TimeBlock[], travel: readonly Interval[]): (day: string) => FramePiece[] {
  const mine = (day: string) => (k: string) => k === `onsite|${day}` || k.startsWith(`onsite|${day}#`);
  if (mode === 'count_once') return (day) => blocks.filter((b) => b.source === 'onsite' && b.countsAsHumanHours && mine(day)(b.dedupeKey));
  const all: FramePiece[] = [];
  for (const f of frames) {
    const free = subtractIntervals([f.iv], travel).filter((x) => x.end - x.start >= MIN);
    free.forEach((iv, i) => all.push({ dedupeKey: free.length === 1 ? f.key : `${f.key}#${i + 1}`, startsAt: toIsoSec(iv.start), endsAt: toIsoSec(iv.end) }));
  }
  return (day) => all.filter((p) => mine(day)(p.dedupeKey));
}
export function frameEntries(days: OnsiteDay[], piecesOf: (day: string) => FramePiece[], meetings: readonly ActivityEntry[], mappings: ActivityMappings, cfg: ActivityConfig): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const whole = overlapModeOf(cfg) === 'log_all_accepted';
  for (const d of days) {
    if (d.status === 'not_onsite' || !d.frame || d.signals.some((s) => s.kind === 'org62')) continue;
    const pieces = piecesOf(d.day);
    const acct = accountByKey(mappings, d.accountKey);
    const label = acct ? acct.whatName.split(' - ')[0]! : 'a customer';
    const type = frameType(d.day, meetings, cfg.timezone);
    const used = d.signals.filter((s) => s.used && s.kind !== 'flight').map((s) => s.label);
    for (const b of pieces) {
      const hours = roundQuarter((toMs(b.endsAt) - toMs(b.startsAt)) / HOUR);
      if (hours <= 0) continue;
      const flags: string[] = [];
      if (!d.whatId) flags.push('NEEDS WhatId: which account was this onsite for? Change account on the day chip');
      const e = newEntry({
        dedupeKey: b.dedupeKey,
        origin: 'calendar',
        subject: `Onsite: ${label}${d.city ? ` (${d.city})` : ''}`,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        durationHours: hours,
        seTaskType: type,
        meetingType: defaultMeetingType(type, null),
        whatKind: whatKindOf(d.whatId ?? ''),
        whatOrg62Id: d.whatId,
        whatName: d.whatName,
        accountKey: d.accountKey,
        customerFacing: isCF(type),
        customerRelated: true,
        confidence: d.status === 'confirmed' ? 'High' : 'Medium',
        reason: whole
          ? `onsite day${d.city ? ` in ${d.city}` : ''}: the whole day (${d.hoursLabel}); your meetings during it log too`
          : `onsite day${d.city ? ` in ${d.city}` : ''}: fills the time between your sessions (${d.hoursLabel})`,
        evidence: used.slice(0, 4).join(' · '),
        evidenceIds: d.signals.flatMap((s) => s.evidenceIds), // every signal's evidence (Provenance on everything; was 12)
        flags,
      });
      e.remote = false;
      e.tripKey = d.tripKey ?? `day|${d.day}`;
      out.push(e);
    }
  }
  return out;
}
// ------------------------------------------------------------------ solo work (engaged time)

const ESTIMATE_RE = /estimat|consumption|calculator|flex|sizing|burn/;
/** What one day's engaged time in one bucket was made of (the row's evidence line). */
function engagedSummary(blocks: readonly TimeBlock[], ev: EvidenceBundle): string {
  const ids = new Set(blocks.flatMap((b) => b.evidenceIds));
  const within = (t: string) => blocks.some((b) => toMs(b.startsAt) <= toMs(t) && toMs(t) < toMs(b.endsAt));
  // distinct prompt times (a forked session repeats its parent's prompts)
  const prompts = new Set(ev.claude.filter((c) => ids.has(c.sessionId)).flatMap((c) => [...(c.turns ?? []).map((t) => toMs(t.at)), ...(c.promptTimes ?? []).map(toMs)].filter((t) => within(new Date(t).toISOString())))).size;
  const slack = (ev.slackMessages ?? []).filter((m) => ids.has(m.id)).length;
  const docs = new Set(ev.drive.filter((d) => ids.has(d.fileId)).map((d) => d.fileId)).size;
  const emails = (ev.emails ?? []).filter((m) => ids.has(m.id)).length;
  const bits = [
    prompts ? `${prompts} prompt${prompts === 1 ? '' : 's'}` : null,
    slack ? `${slack} Slack message${slack === 1 ? '' : 's'}` : null,
    docs ? `${docs} Drive edit${docs === 1 ? '' : 's'}` : null,
    emails ? `${emails} email${emails === 1 ? '' : 's'} sent` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(', ') : 'your own actions';
}
/**
 * Engaged solo time → rows, one per local day and bucket (the account, else the repo, else unmapped Drive docs, else
 * unmapped Slack and email), its hours the day's engaged minutes in that bucket rounded once to 0.25 h (D-40). The row
 * sits in the day's free time from its first engaged minute (meetings, travel, onsite days, Org62 Events, the user's
 * rows and rows placed before it are busy), split into `#2`, `#3` … only where one free gap is too short. No caps: the
 * only bound is the signals (2026-11-14).
 */
export function evidenceEntries(
  blocks: readonly TimeBlock[],
  mappings: ActivityMappings,
  cfg: ActivityConfig,
  evidence: EvidenceBundle,
  rejected: RejectedProposal[],
  busyByDay: Map<string, Interval[]>,
): ActivityEntry[] {
  const titles = new Map(evidence.drive.map((d) => [d.fileId, d.title]));
  const sessionTitles = new Map(evidence.claude.map((c) => [c.sessionId, c.title ?? '']));
  type G = { day: string; bucket: string; blocks: TimeBlock[] };
  const groups = new Map<string, G>();
  for (const b of blocks) {
    if (!b.countsAsHumanHours || !ENGAGED_SOURCES.has(b.source)) continue;
    const comms = b.source === 'slack_burst' || b.source === 'estimate';
    const bucket = b.accountKey ? `acct:${b.accountKey}` : b.repoKey ? `repo:${b.repoKey}` : comms ? 'comms:unmapped' : 'docs:unmapped';
    const k = `${b.localDay}|${bucket}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { day: b.localDay, bucket, blocks: [] }));
    g.blocks.push(b);
  }
  const out: ActivityEntry[] = [];
  const firstOf = (g: G) => g.blocks.reduce((m, b) => Math.min(m, toMs(b.startsAt)), Infinity);
  // the earliest work of the day is placed first, at its own time
  for (const g of [...groups.values()].sort((a, b) => a.day.localeCompare(b.day) || firstOf(a) - firstOf(b) || a.bucket.localeCompare(b.bucket))) {
    const ms = (b: TimeBlock) => toMs(b.endsAt) - toMs(b.startsAt);
    const hours = roundQuarter(g.blocks.reduce((s, b) => s + ms(b), 0) / HOUR);
    const key = `wb|${g.day}|${g.bucket}`;
    const first = firstOf(g);
    const acct = g.bucket.startsWith('acct:') ? accountByKey(mappings, g.bucket.slice(5)) : null;
    const repos = [...new Set(g.blocks.map((b) => b.repoKey).filter((x): x is string => !!x))].sort();
    const docTitles = [...new Set(g.blocks.flatMap((b) => b.evidenceIds.map((id) => titles.get(id)).filter((t): t is string => !!t)))].sort();
    const sessTitles = [...new Set(g.blocks.flatMap((b) => b.evidenceIds.map((id) => sessionTitles.get(id)).filter((t): t is string => !!t)))].sort();
    if (hours < cfg.evidence.minBlockH) {
      rejected.push({ dedupeKey: key, subject: g.bucket, startsAt: new Date(first).toISOString(), hours, reason: 'below_minimum', note: `under ${cfg.evidence.minBlockH} h` });
      continue;
    }
    const comms = g.bucket === 'comms:unmapped';
    const neither = !acct ? (repos.map((r) => mappings.neitherRepos[r]).find(Boolean) ?? null) : null;
    const text = [...repos, ...docTitles, ...sessTitles].join(' ').toLowerCase();
    let ttype = ESTIMATE_RE.test(text) ? 'Consumption Estimation' : 'Solution Creation';
    if (neither) ttype = neither;
    // D-64: work no account or opp matched is internal-only work. A repo or Drive docs: Asset Creation unless it names
    // learning or enablement (a repo mapped to an internal type keeps it); Slack and email that name no account: Admin
    // (internal coordination). A mapped repo, session, channel or doc keeps its account and opp (above).
    const internalType: { type: string; reason: string } | null =
      !acct && cfg.internalActivity && (!neither || isInternalTaskType(neither))
        ? neither && isInternalTaskType(neither)
          ? { type: neither, reason: `${repos[0] ?? 'repo'} mapped to ${neither}` }
          : comms
            ? { type: 'Admin', reason: 'Slack and email that name no account (internal coordination)' }
            : internalWorkType(text)
        : null;
    if (internalType) ttype = internalType.type;
    const kinds = new Set(g.blocks.map((b) => b.source));
    const commsLabel = kinds.has('slack_burst') && kinds.has('estimate') ? 'Slack and email' : kinds.has('estimate') ? 'Email' : 'Slack';
    const label = acct
      ? acct.whatName.split(' - ')[0]!
      : repos[0]
        ? repos[0]
        : comms
          ? internalType
            ? commsLabel
            : `Unmapped ${commsLabel}`
          : internalType
            ? docTitles.length === 1
              ? docTitles[0]!
              : `${docTitles.length} Drive docs`
            : `${docTitles.length} unmapped doc(s)`;
    const what = internalType
      ? comms
        ? 'internal coordination'
        : `internal ${internalType.type === 'Personal Development' ? 'learning' : internalType.type === 'Sales Enablement' ? 'enablement' : 'asset build'}`
      : ttype === 'Consumption Estimation'
        ? 'off-calendar estimate work'
        : 'off-calendar build/prep';
    const sources = [...new Set(g.blocks.map((b) => b.source))].sort();
    const evBits = [`engaged ${hours} h (${engagedSummary(g.blocks, evidence)}; ${sources.join(', ')})`];
    if (docTitles.length) evBits.push(`edited ${docTitles.length} doc(s): ${docTitles.slice(0, 3).join('; ')}`);
    const placed = placeAcross(g.day, hours, first, busyByDay.get(g.day) ?? [], cfg.timezone);
    if (placed.unplaced > 0)
      rejected.push({ dedupeKey: key, subject: `${label}: ${what}`, startsAt: new Date(first).toISOString(), hours: placed.unplaced, reason: 'duplicate', note: 'no free time left that day: the rest is already logged' });
    // a row that will not log (a Neither repo's work) takes no time from the rows after it
    if (internalType || !neither) busyByDay.set(g.day, [...(busyByDay.get(g.day) ?? []), ...placed.pieces]);
    const parts = placed.pieces.length;
    placed.pieces.forEach((iv, i) => {
      const flags = ['GUESS: hours estimated from evidence; adjust with `=> 1.5h`'];
      if (parts > 1) flags.push(`${hours} h that day, in ${parts} parts around your meetings (part ${i + 1})`);
      let e = newEntry({
        dedupeKey: i === 0 ? key : `${key}#${i + 1}`,
        origin: 'evidence',
        subject: `${label}: ${what}`,
        startsAt: toIsoSec(iv.start),
        endsAt: toIsoSec(iv.end),
        durationHours: roundQuarter((iv.end - iv.start) / HOUR),
        seTaskType: ttype,
        whatKind: acct ? whatKindOf(acct.whatId) : 'none',
        whatOrg62Id: acct?.whatId || null,
        whatName: acct?.whatName ?? null,
        accountKey: acct?.key ?? null,
        confidence: 'Low',
        reason: internalType
          ? `internal: ${internalType.reason}; no account or opp matched (engaged time from your own actions)`
          : 'engaged time from your own actions (prompts, Slack, Drive, email)',
        evidence: evBits.join(' · '),
        evidenceIds: [...new Set(g.blocks.flatMap((b) => b.evidenceIds))],
        flags,
        ...(internalType ? { internal: true } : {}),
      });
      if (internalType) {
        // complete: no WhatId by design, an internal type, so it never asks for an opp (it waits for your Log)
      } else if (neither) {
        e.status = 'excluded';
        e.excludedReason = 'neither_type';
        e.flags.push(`${repos[0] ?? 'evidence'}: '${neither}' work (demo org / tooling), Neither CF nor CR. Add \`=> 006…\` if it was for a deal`);
      } else if (!acct) {
        e.flags.push('NEEDS WhatId: which account/opp was this for? write `=> 006…` or `=> skip`');
      }
      e = stripWhatIfNeither(e);
      out.push(e);
    });
  }
  return out;
}
