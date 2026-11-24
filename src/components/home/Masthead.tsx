'use client';
/**
 * One sentence for the day, one for the days ahead (the side column at wide widths), the date and since-you-left.
 * The Today / next-working-day toggle sits on the date line; late in the day (from an hour before the working day
 * ends, after it, or on a day off) a quiet "Plan tomorrow →" suggests it. Home never switches by itself.
 */
import { useState, type ReactNode } from 'react';
import type { HomeDay, HomeMasthead, HomeNextDay } from '@/contract';
import { useApi } from '@/client/hooks';
import { FillingIn } from '@/components/shell/FillingIn';
import { SinceList } from '@/components/shell/StatusPanels';
import { Popover, SegmentedToggle } from '@/ui';
import { Segments } from './ctx';
import { hmIn, longDateIn } from './model';

/**
 * "Since you left: 4 changed · 2 closed · 1 new" opens the list itself (the same SinceList as the sidebar's status
 * popover), in a small popover under the line. The digest loads on open.
 */
function SinceBody() {
  const digest = useApi('getSince');
  return (
    <div className="max-h-[min(32rem,70vh)] overflow-y-auto pt-3" data-testid="home-since-list">
      <h2 className="px-4 pb-2 text-body font-bold text-fg-heading">Since you left</h2>
      {digest.data ? <SinceList digest={digest.data} /> : digest.isError ? <p className="px-4 pb-3 text-caption text-muted">Couldn’t load what changed. Try again in a moment.</p> : <p className="px-4 pb-3 text-caption text-muted">Loading…</p>}
    </div>
  );
}

function SinceLine({ since }: { since: HomeMasthead['since'] }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      placement="bottom-end"
      width={420}
      label="Since you left"
      trigger={
        <button type="button" className="hm-since hm-since-btn" aria-haspopup="dialog" aria-expanded={open} data-testid="home-since" title="What changed while you were away">
          Since you left: <b>{since.changed}</b> changed · <b>{since.closed}</b> closed · <b>{since.new}</b> new
        </button>
      }
    >
      {open ? <SinceBody /> : null}
    </Popover>
  );
}

/** "tomorrow" / "Monday": the planned day inside a sentence. */
export const dayInSentence = (label: string) => (label === 'Tomorrow' ? 'tomorrow' : label);

export function DayToggle({ day, next, onDay }: { day: HomeDay; next: HomeNextDay; onDay: (d: HomeDay) => void }) {
  return (
    <span className="hm-day-toggle" title={`Plan ${next.short} ahead: its meetings, what is due, and today's open work`}>
      <SegmentedToggle<HomeDay>
        size="xs"
        label="Day shown on Home"
        value={day}
        onChange={onDay}
        options={[
          { value: 'today', label: 'Today' },
          { value: 'next', label: next.label },
        ]}
      />
    </span>
  );
}

export function Masthead({
  m,
  nowMs,
  stale,
  day = 'today',
  next = null,
  requested,
  onDay,
  viewToggle,
  children,
}: {
  /** Home ▸ Plan: the Home | Plan toggle, first on the date line. */
  viewToggle?: ReactNode;
  /** Under the sentence: the briefing's "what to move" line when the day is overbooked. */
  children?: ReactNode;
  m: HomeMasthead;
  nowMs: number;
  stale?: { onRetry: () => void } | null;
  /** The day the payload shows (not the one requested while it loads). */
  day?: HomeDay;
  next?: HomeNextDay | null;
  /** The toggle's value follows the request at once; the content follows the payload. */
  requested?: HomeDay;
  onDay?: (d: HomeDay) => void;
}) {
  const since = m.since;
  const plan = day === 'next';
  return (
    <section className="hm-mast" aria-label={plan ? `${next?.label ?? 'The next day'} in one sentence` : 'Today in one sentence'} data-home-panel="masthead" data-day={day}>
      <div className="hm-mast-date">
        {viewToggle}
        {next && onDay ? <DayToggle day={requested ?? day} next={next} onDay={onDay} /> : null}
        <span>
          {plan ? (
            <>
              Planning <b>{longDateIn(m.date, m.timezone)}</b> · starts {hmIn(m.date, m.timezone)} {m.tzLabel}
            </>
          ) : (
            <>
              <b>{longDateIn(m.date, m.timezone)}</b> · {hmIn(nowMs, m.timezone)} {m.tzLabel}
            </>
          )}
        </span>
        {!plan && next?.nudge && onDay ? (
          <span className="hm-plan-nudge" data-testid="home-plan-nudge">
            {/* true late on a working day and all day on a weekend ("wrapping up" at 09:00 on a Saturday was not) */}
            Look ahead ·{' '}
            <button type="button" className="hm-link" onClick={() => onDay('next')}>
              Plan {dayInSentence(next.label)} →
            </button>
          </span>
        ) : null}
        {stale ? (
          <span className="hm-stale" role="status">
            Couldn’t refresh ·{' '}
            <button type="button" className="hm-link" onClick={stale.onRetry}>
              Retry
            </button>
          </span>
        ) : null}
        {since.show ? <SinceLine since={since} /> : null}
      </div>
      <h2 className="hm-headline">
        {/* B-079: an empty day reads "Filling in" while the first scan runs */}
        {m.sentence[0]?.text.startsWith('Nothing needs you') ? (
          <FillingIn variant="note">
            <Segments segs={m.sentence} />
          </FillingIn>
        ) : (
          <Segments segs={m.sentence} />
        )}
      </h2>
      {children}
      {m.ahead.length ? (
        <p className="hm-dek">
          <Segments segs={m.ahead} />
        </p>
      ) : null}
    </section>
  );
}
