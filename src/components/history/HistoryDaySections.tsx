'use client';
/**
 * One day's record, section by section: Finished · Sent and approved · Time logged · Meetings · Agent runs ·
 * Org62 logged · New items. Sections disappear when empty (DESIGN-V2 principle 2). Every row opens its existing
 * Details renderer in the docked panel (work_item, draft, activity_entry, calendar_event, agent_run, tool_run).
 *
 * Colour is state only, at most one signal per row: red for what broke (a failed send, a failed Org62 read-back),
 * violet for what the engine or chat did for you, green for a verified send. Dry runs say so in words.
 * Agent time is reported apart as a background lane and never added to your hours.
 */
import { useId, type ReactNode } from 'react';
import type { HistoryDay } from '@/contract';
import { ContextRow, SectionHead, type Edge } from '@/components/deals/context-frame';
import { AppLink } from '@/components/shell/AppLink';
import { cn, fmtClock, StatePill } from '@/ui';
import { activityStatusLabel, fmtH, fmtMin, kindLabel, longDay, runKindLabel, runStateLabel, type RowRef, type SectionId } from './derive';

export interface DaySectionsProps {
  day: HistoryDay;
  sections: SectionId[];
  tz?: string;
  /** The keyboard / click selection (a row id). */
  selected: string | null;
  /** The entity open in Details (its id), for the "in panel" treatment. */
  openId: string | null;
  rows: Map<string, RowRef>;
  onOpen: (rowId: string) => void;
}

const span = (a: string, b: string | null, tz?: string) => (b ? `${fmtClock(a, tz)}–${fmtClock(b, tz)}` : fmtClock(a, tz));
const dot = (...xs: Array<string | null | undefined | false>) => xs.filter(Boolean).join(' · ');

export function DaySections({ day, sections, tz, selected, openId, rows, onOpen }: DaySectionsProps) {
  const row = (rowId: string, props: { title: ReactNode; why?: ReactNode; meta?: ReactNode; badge?: ReactNode; edge?: Edge; dimmed?: boolean }) => {
    const ref = rows.get(rowId);
    const inPanel = !!ref && openId === ref.entity.id;
    return (
      <ContextRow
        key={rowId}
        rowId={rowId}
        selected={selected === rowId || inPanel}
        inPanel={inPanel}
        onClick={() => onOpen(rowId)}
        aria-label={typeof props.title === 'string' ? props.title : undefined}
        {...props}
      />
    );
  };

  const out: ReactNode[] = [];
  for (const sec of sections) {
    if (sec === 'finished' && day.finished.length)
      out.push(
        <Section key={sec} title="Finished" count={day.finished.length} sub="closed this day, not undone">
          {day.finished.map((f) =>
            row(`fin:${f.itemId}:${f.at}`, {
              title: f.title,
              // the pill says who closed it for you; the why line keeps the rest ("Done by Dana · reason")
              why: dot(f.by === 'engine' || f.by === 'chat' ? f.label.replace(/^Closed (for you|from chat)( · )?/, '') : f.label, f.why, f.accountName, f.reopenedSince && 'reopened since'),
              meta: fmtClock(f.at, tz),
              badge: f.by === 'engine' || f.by === 'chat' ? <StatePill tone="ai" size="xs" label={f.by === 'engine' ? 'Closed for you' : 'From chat'} /> : undefined,
              dimmed: f.reopenedSince,
            }),
          )}
        </Section>,
      );

    if (sec === 'sent' && day.sent.length)
      out.push(
        <Section key={sec} title="Sent and approved" count={day.sent.length} sub="Outbox dispatches">
          {day.sent.map((s) =>
            row(`snd:${s.attemptId}`, {
              title: s.title,
              why: dot(s.destination, s.outcome === 'dry_run' || s.outcome === 'failed' || s.outcome === 'unconfirmed' ? null : s.verification === 'verified' ? 'Sent' : s.label),
              meta: fmtClock(s.at, tz),
              badge:
                s.outcome === 'failed' ? (
                  <StatePill tone="risk" size="xs" label="Failed · nothing sent" />
                ) : s.outcome === 'dry_run' ? (
                  <StatePill tone="neutral" size="xs" icon={false} label="Dry run · nothing sent" />
                ) : s.verification === 'verified' ? (
                  <StatePill tone="ok" size="xs" label={`Verified in ${s.channel === 'slack' ? 'Slack' : s.channel === 'action' ? (s.destination.split(' · ')[0] ?? 'the app') : 'Gmail'}`} />
                ) : s.outcome === 'unconfirmed' ? (
                  <StatePill tone="warn" size="xs" label="Not confirmed" />
                ) : undefined,
            }),
          )}
        </Section>,
      );

    if (sec === 'time' && (day.time.entries.length || day.time.agentMin || day.time.signals.focusMin + day.time.signals.driveMin + day.time.signals.slackMin)) {
      const t = day.time;
      out.push(
        // the Journal does not repeat the hours' totals (D-102, C8): Activity ▸ History is where they are counted
        <Section
          key={sec}
          title="Time logged"
          sub={
            <AppLink href="/activity?view=history" className="font-bold text-link hover:underline" data-testid="journal-time-link">
              Time logged: see Activity ▸ History
            </AppLink>
          }
        >
          {t.entries.map((e) => {
            const counted = e.status !== 'dismissed' && e.status !== 'upcoming';
            return row(`act:${e.id}`, {
              title: e.description || 'Activity row',
              why: dot(e.accountName ?? 'No account', e.taskType, e.meetingType, e.status !== 'verify_failed' && activityStatusLabel(e.status), !counted && 'not counted'),
              meta: (
                <>
                  <span>{span(e.start, e.end, tz)}</span>
                  <span className={cn('font-bold', counted ? 'text-fg' : 'text-faint line-through')}>{fmtH(e.durationH)}</span>
                </>
              ),
              badge: e.status === 'verify_failed' ? <StatePill tone="risk" size="xs" label="Verify failed" /> : undefined,
              dimmed: !counted,
            });
          })}
          <TimeFootnote day={day} />
        </Section>,
      );
    }

    if (sec === 'meetings' && day.meetings.length)
      out.push(
        <Section key={sec} title="Meetings" count={day.meetings.filter((m) => m.held).length} sub={day.meetings.some((m) => !m.held) ? `${day.meetings.length} on the calendar` : 'attended'}>
          {day.meetings.map((m) =>
            row(`mtg:${m.id}`, {
              title: m.title,
              why: dot(m.attendance === 'attended' ? 'Attended' : m.attendance === 'in_progress' ? 'In progress' : m.attendance === 'missed' ? 'Missed' : 'Later today', m.accountName, m.isCustomerFacing && 'customer-facing'),
              meta: span(m.start, m.end, tz),
              dimmed: !m.held,
            }),
          )}
        </Section>,
      );

    if (sec === 'runs' && day.runs.length)
      out.push(
        <Section key={sec} title="Agent runs" count={day.runs.length} sub={`${fmtMin(day.time.agentMin)} in the background · never your hours`}>
          {day.runs.map((r) =>
            row(`run:${r.id}`, {
              title: r.title,
              why: dot(runKindLabel(r.kind), runStateLabel(r.state), `${fmtMin(r.agentMin)} this day`, r.scheduled && 'scheduled'),
              meta: span(r.startedAt, r.finishedAt, tz),
              badge: r.state === 'failed' ? <StatePill tone="risk" size="xs" label="Failed" /> : r.state === 'waiting_on_you' ? <StatePill tone="brand" size="xs" label="Waiting on you" /> : undefined,
            }),
          )}
        </Section>,
      );

    if (sec === 'org62' && day.org62.length)
      out.push(
        <Section key={sec} title="Org62 logged" count={day.org62.length} sub="activity rows synced or submitted">
          {day.org62.map((o) =>
            row(`o62:${o.activityId}`, {
              title: o.description || 'Activity row',
              why: dot(o.status === 'verify_failed' ? null : o.label, o.accountName, o.workDay !== day.day && `work on ${longDay(o.workDay)}`),
              meta: (
                <>
                  <span>{fmtClock(o.at, tz)}</span>
                  <span className="font-bold text-fg">{fmtH(o.durationH)}</span>
                </>
              ),
              badge: o.status === 'verify_failed' ? <StatePill tone="risk" size="xs" label="Read-back failed" /> : undefined,
            }),
          )}
        </Section>,
      );

    if (sec === 'arrived' && day.arrived.length)
      out.push(
        <Section key={sec} title="New items" count={day.arrived.length} sub="arrived this day">
          {day.arrived.map((a) =>
            row(`new:${a.itemId}`, {
              title: a.title,
              why: dot(kindLabel(a.kind), a.source ? `from ${a.source === 'gmail' ? 'Gmail' : a.source === 'org62' ? 'Org62' : a.source[0]!.toUpperCase() + a.source.slice(1)}` : null, a.accountName, a.state === 'done' ? 'done now' : a.state === 'dismissed' ? 'dismissed' : null),
              meta: fmtClock(a.at, tz),
              dimmed: a.state === 'done' || a.state === 'dismissed',
            }),
          )}
        </Section>,
      );
  }
  return <>{out}</>;
}

function Section({ title, count, sub, children }: { title: string; count?: number; sub?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="pb-2" data-history-section={title}>
      <SectionHead id={id} title={title} count={count} sub={sub} />
      <div role="list" aria-labelledby={id}>
        {children}
      </div>
    </section>
  );
}

/** Signals the time engine saw that are not in the log, and the agent lane: shown, never counted. */
function TimeFootnote({ day }: { day: HistoryDay }) {
  const s = day.time.signals;
  const seen = [s.focusMin ? `focus ${fmtMin(s.focusMin)}` : '', s.driveMin ? `Drive edits ${fmtMin(s.driveMin)}` : '', s.slackMin ? `Slack ${fmtMin(s.slackMin)}` : ''].filter(Boolean);
  if (!seen.length && !day.time.agentMin) return null;
  return (
    <div className="mx-6 mt-1 mb-1 flex flex-col gap-0.5 text-caption text-muted">
      {seen.length ? <p>Also seen, not in the log: {seen.join(' · ')}. Not counted unless logged.</p> : null}
      {day.time.agentMin ? <p>Agent time: {fmtMin(day.time.agentMin)} in the background. It never counts as your hours.</p> : null}
    </div>
  );
}
