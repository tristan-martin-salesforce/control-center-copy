/**
 * Renderer for the team's review / dashboard canvas. Port of ap/canvas.py `render`.
 * Output only: this lane never writes the canvas.
 *
 * Line grammar (one per item, key `#ref`):
 *   - [ ] #ref · Tue 10/07 10:30 · 0.5h · Subject · Task Type · Related To · CF
 */
import { type Org62EventPayload, refOf, toOrg62Event } from './entry';
import { lightningLink, slackbotPrompt } from './handoff';
import { type QuarterProgress, type WeekRollup } from './rollup';
import { STATE_FOLDER_DISPLAY } from '@/lib/state-folder-name';
import { toMs } from './time';
import type { ActivityConfig, ActivityEntry } from './types';

export interface DcGapRow {
  oppName: string;
  closeDate: string;
  /** e.g. "AI + Data Architect 100%" or "none". */
  myDc: string;
  vdp: string;
  gaps: string[];
}

export interface ReviewInput {
  entries: readonly ActivityEntry[];
  progress: QuarterProgress;
  weeks: readonly WeekRollup[];
  /** The last N confirmed rows (status logged/verified) with their Org62 ids. */
  recentlyConfirmed?: readonly { entry: ActivityEntry; org62EventId: string }[];
  dcGaps?: readonly DcGapRow[] | null;
  dcSeenAt?: string | null;
  nowIso: string;
  cfg: ActivityConfig;
  /** Footer text, e.g. the approved-exception note. */
  footerNote?: string;
  handedOffAt?: Readonly<Record<string, string>>;
}

/** "Tue 10/07 10:30" in the configured timezone. */
export function fmtLocal(ms: number, tz: string, withWeekday = true): string {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = x.value;
  return `${withWeekday ? p.weekday + ' ' : ''}${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

const hFmt = (h: number) => String(h);

function shortWhat(e: ActivityEntry): string {
  if (!e.whatOrg62Id) return '⚠️ Related To?';
  return (e.whatName || e.whatOrg62Id).slice(0, 38);
}

const WARN_KEYS = ['NEEDS', 'OOO', 'placeholder', 'optional', 'hold', 'confirm'];

/** One review-canvas line. */
export function reviewLine(e: ActivityEntry, cfg: Pick<ActivityConfig, 'timezone'>, checked = false): string {
  const t = fmtLocal(toMs(e.startsAt), cfg.timezone);
  const guess = e.origin === 'evidence' && !e.userLockedFields.includes('durationHours');
  const hours = `${guess ? '~' : ''}${hFmt(e.durationHours)}h`;
  const type = e.seTaskType ?? '';
  const bits = [
    `#${refOf(e)}`,
    t,
    hours,
    e.subject.slice(0, 70).replace(/\|/g, '/'),
    type + (e.meetingType && (type === 'Workshop' || type === 'POC') ? ` / ${e.meetingType}` : ''),
    shortWhat(e),
  ];
  if (e.customerFacing) bits.push('CF');
  const warn = e.flags.filter((f) => WARN_KEYS.some((k) => f.includes(k)) && !(f.startsWith('NEEDS WhatId') && !e.whatOrg62Id && e.origin === 'evidence'));
  if (e.origin === 'evidence' && e.evidence) bits.push(`_${e.evidence.slice(0, 110)}_`);
  if (warn[0]) bits.push(`⚠️ ${warn[0].slice(0, 90)}`);
  return `- [${checked ? 'x' : ' '}] ${bits.join(' · ')}`;
}

const sumH = (rows: readonly ActivityEntry[]) => rows.reduce((s, r) => s + r.durationHours, 0);
const byStart = (a: ActivityEntry, b: ActivityEntry) => toMs(a.startsAt) - toMs(b.startsAt) || a.dedupeKey.localeCompare(b.dedupeKey);

export function renderReviewCanvas(input: ReviewInput): string {
  const { cfg, progress: q, nowIso } = input;
  const all = input.entries.filter((e) => e.operation === 'create');
  const pend = all.filter((e) => e.status === 'proposed' || e.status === 'needs_input').sort(byStart);
  const ready = all.filter((e) => e.status === 'approved' || e.status === 'synced_to_canvas').sort(byStart);
  const out: string[] = [];
  out.push('::: {.callout}');
  out.push(
    `**${q.quarter}** · deadline ![](slack_date:${q.deadline.slice(0, 10)}) (${q.daysToDeadline} days) · **${q.logged.cr.toFixed(1)} CR / ${q.logged.cf.toFixed(1)} CF h logged** of ~${q.target} · ${pend.length} drafts to review (${sumH(pend).toFixed(1)} h) · ${ready.length} approved, waiting to be loaded`,
  );
  out.push(`Updated ${nowIso.slice(0, 16).replace('T', ' ')} UTC by the activity autopilot. Drafts only: nothing here is written to Org62 for you.`);
  out.push(':::');
  out.push('');
  out.push(
    '**How to use:** tick a box to approve it as shown. To change something, add `=>` at the end of the line: `=> skip`, `=> Customer Discovery`, `=> 1.5h`, `=> 006…` (Related To), or combine them, e.g. `=> Workshop, 1h`. The next run (weekdays 5:30pm, Fri 9am) picks up your ticks and builds the batch below.',
  );
  out.push('');

  // 1. Ready to load
  out.push(`# :inbox_tray: Ready to load into Org62 (${ready.length})`);
  out.push('');
  if (ready.length) {
    const rows = ready.map((e) => toOrg62Event(e, cfg));
    out.push(`${ready.length} approved events, ${rows.reduce((s, r) => s + r.Duration__c, 0).toFixed(2)} h. Pick one way to load them. Each one disappears from here once the read-back finds it in Org62.`);
    out.push('');
    out.push('1. **Slackbot:** paste the prompt below into Slackbot (it can write to Org62; Claude can\'t).');
    out.push(`2. **Data Loader:** Insert → Event → the newest \`batch-*.csv\` in \`${STATE_FOLDER_DISPLAY}/autopilot/outbox/\`.`);
    out.push('3. **One by one:** click a link, check the form, Save.');
    out.push('');
    out.push('```');
    out.push(slackbotPrompt(rows.slice(0, 20), cfg));
    out.push('```');
    out.push('');
    ready.forEach((e, i) => {
      const row = rows[i] as Org62EventPayload;
      const handed = input.handedOffAt?.[e.dedupeKey];
      out.push(`- [open #${refOf(e)}](${lightningLink(row, cfg)}) ${row.Subject.slice(0, 60).replace(/\|/g, '/')} · ${fmtLocal(toMs(e.startsAt), cfg.timezone, false)} · ${row.Duration__c}h · ${row.SE_Task_Type__c}${handed ? ` (handed off ${handed.slice(0, 10)})` : ''}`);
    });
  } else out.push('Nothing approved yet. Tick items below.');
  out.push('');

  // 2. Needs input
  const needs = pend.filter((e) => e.status === 'needs_input');
  out.push(`# :warning: Needs your input (${needs.length})`);
  out.push('');
  if (needs.length) out.push(...needs.map((e) => reviewLine(e, cfg)));
  else out.push('Nothing waiting on you.');
  out.push('');

  // 3. Review: meetings, by week (newest first)
  const meets = pend.filter((e) => e.status === 'proposed' && e.origin === 'calendar');
  out.push(`# :calendar: Review: meetings (${meets.length}, ${sumH(meets).toFixed(1)} h)`);
  out.push('');
  const byWeek = new Map<string, ActivityEntry[]>();
  for (const e of meets) {
    const k = weekKey(e, cfg.timezone);
    byWeek.set(k, [...(byWeek.get(k) ?? []), e]);
  }
  for (const wk of [...byWeek.keys()].sort().reverse()) {
    const rows = byWeek.get(wk)!;
    out.push(`### Week of ![](slack_date:${wk}) · ${rows.length} · ${sumH(rows).toFixed(1)} h`);
    out.push('');
    out.push(...rows.map((e) => reviewLine(e, cfg)));
    out.push('');
  }
  if (!meets.length) {
    out.push('All caught up.');
    out.push('');
  }

  // 4. Review: evidence blocks
  const wbs = pend.filter((e) => e.status === 'proposed' && (e.origin === 'evidence' || e.origin === 'build_estimate'));
  out.push(`# :hammer_and_wrench: Review: estimated work blocks (${wbs.length}, ${sumH(wbs).toFixed(1)} h)`);
  out.push('');
  out.push('Off-calendar work inferred from Claude Code activity and Drive edits. **`~` hours are guesses.** Fix them with `=> 2h`. Rows without a Related To are in *Needs your input*: add `=> 006…` or `=> skip`.');
  out.push('');
  out.push(...(wbs.length ? wbs.map((e) => reviewLine(e, cfg)) : ['None proposed.']));
  out.push('');
  const nei = all.filter((e) => e.status === 'excluded' && e.origin === 'evidence' && e.excludedReason === 'neither_type' && e.startsAt.slice(0, 10) >= q.start).sort((a, b) => byStart(b, a)).slice(0, 15);
  if (nei.length) {
    out.push('### Probably not loggable (demo-org / tooling work)');
    out.push('');
    out.push('Add `=> 006…` and tick if one of these was really for a deal.');
    out.push('');
    out.push(...nei.map((e) => reviewLine(e, cfg)));
    out.push('');
  }

  // 5. Coming up
  const up = all.filter((e) => e.status === 'upcoming').sort(byStart).slice(0, 25);
  out.push(`# :crystal_ball: Coming up (${up.length})`);
  out.push('');
  out.push('Pre-classified. They move to review after they happen. Tick early to approve them in advance.');
  out.push('');
  out.push(...(up.length ? up.map((e) => reviewLine(e, cfg)) : ['Nothing on the calendar.']));
  out.push('');

  // 6. Deal Contributions & VDP
  out.push('# :handshake: Deal Contributions & VDP');
  out.push('');
  const gaps = (input.dcGaps ?? []).filter((g) => g.gaps.length);
  if (!input.dcGaps || !input.dcSeenAt) out.push("DC data hasn't been read from Org62 yet. The next scheduled run fills this in.");
  else if (gaps.length) {
    out.push('|Opportunity|Close|Your DC|VDP|Gap|');
    out.push('|---|---|---|---|---|');
    for (const g of gaps) out.push(`|${g.oppName.slice(0, 45)}|${g.closeDate}|${g.myDc}|${g.vdp}|${g.gaps.join('; ')}|`);
    out.push('');
    out.push(`Read from Org62 ${input.dcSeenAt.slice(0, 10)}.`);
  } else out.push(":white_check_mark: Every opp you're on or logged time against has your DC with a VDP link.");
  out.push('');

  // 7. Hours
  out.push('# :bar_chart: Hours this quarter');
  out.push('');
  const wk = input.weeks.filter((w) => w.logged.cr || w.logged.cf).slice(-12);
  if (wk.length) {
    const labels = wk.map((w) => w.week.slice(5).replace('-', '/'));
    const chart = {
      title: 'Logged hours per week',
      chart: {
        type: 'bar',
        series: [
          { name: 'CR h', data: wk.map((w, i) => ({ label: labels[i], value: w.logged.cr })) },
          { name: 'CF h', data: wk.map((w, i) => ({ label: labels[i], value: w.logged.cf })) },
        ],
        axis_config: { categories: labels, x_label: 'Week of', y_label: 'Hours' },
      },
    };
    out.push('```data_visualization');
    out.push(JSON.stringify(chart));
    out.push('```');
    out.push('');
  }
  out.push('|Bucket|CR (= CC) h|CF h|');
  out.push('|---|---|---|');
  for (const [label, v] of [
    ['Logged in Org62', q.logged],
    ['Approved, not loaded yet', q.approved],
    ['To review', q.toReview],
    ['Needs input', q.needsInput],
    ['Upcoming', q.upcoming],
  ] as const)
    out.push(`|${label}|${v.cr.toFixed(2)}|${v.cf.toFixed(2)}|`);
  if (q.legacyUncountedHours) out.push(`|Legacy-record-type events (not counted)|${q.legacyUncountedHours.toFixed(2)}|n/a|`);
  out.push('');
  out.push(`Gap to ~${q.target} CC: **${q.gapToTarget.toFixed(1)} h**. Calendar-backed work rarely gets there on its own. Add off-calendar deal work as work blocks.`);
  out.push('');
  const recent = (input.recentlyConfirmed ?? []).slice(0, 8);
  if (recent.length) {
    out.push('### :white_check_mark: Recently confirmed in Org62');
    out.push('');
    for (const { entry: e, org62EventId } of recent) out.push(`- ${fmtLocal(toMs(e.startsAt), cfg.timezone, false).slice(0, 5)} · ${e.subject.slice(0, 70).replace(/\|/g, '/')} · ${e.seTaskType} · \`${org62EventId}\``);
    out.push('');
  }
  out.push('---');
  out.push(`Source: \`tools/activity-autopilot\` in the command-center repo.${input.footerNote ? ' ' + input.footerNote : ''}`);
  return out.join('\n');
}

function weekKey(e: ActivityEntry, tz: string): string {
  // Monday (local) of the entry's week, matching the Python `_week_key`.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(toMs(e.startsAt)));
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = (t.getUTCDay() + 6) % 7;
  return new Date(t.getTime() - dow * 86_400_000).toISOString().slice(0, 10);
}
