'use client';
/**
 * ActivityRow (Activity ▸ To log ▸ Week, History's editable rows; R-UI-6): one editable activity-log row, a
 * configuration of the kit ActionRow (docs/UX.md "Component kit"): the start and end as the lead, the description as
 * the title, the state and what is off as the why line, its sources and the autosave state as chips; opportunity
 * (WhatId), task type, hours and customer-facing or prep as the trailing controls; the day and the description's
 * editor as the expansion (Space or the chevron). Autosave per row (§8): the row calls onChange with a patch on
 * change/blur and the parent debounces, saves optimistically and renders <InlineStatus> into `statusSlot`. Times are
 * shown and edited in the profile timezone. Colour only where the row needs you (a missing opportunity is amber, a
 * failed check red, a suggestion violet). `ActivityRowHeader` and the grid exports stay for the kit gallery.
 */
import type { ActivityEntry, SourceRef } from '@/contract';
import { isOverlapInfo } from '@/engines/activity/overlap-flags';
import { plainIssue, plainIssues } from '@/components/time/plain';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ActionRow } from '@/components/kit/ActionRow';
import { cn, Combobox, Icon } from '@/ui';
import { SourceChip, StatusBadge, TONE_TO_BADGE, useClock } from './lib';
import { clock, zonedIso } from './lib/time';
import { ACTIVITY_META } from './vocab';
import g from './activity-row.module.css';
import { hasTarget } from '@/lib/time-internal';

export type ActivityPatch = Partial<Pick<ActivityEntry, 'date' | 'start' | 'end' | 'durationH' | 'taskType' | 'oppId' | 'meetingType' | 'description' | 'internal'>>;

/** The row grid (./activity-row.module.css): one, two or three lines by the width of the list it sits in. */
export const ACTIVITY_COLS = g.grid;
/** Put on the list (table) that holds the rows: the container the row grid follows. */
export const ACTIVITY_ROWS = g.rows;
/** Grid areas, for rows that render their own cells (the Ledger's read-only rows). */
export const ACTIVITY_AREA = { when: g.when, hours: g.hours, desc: g.desc, opp: g.opp, type: g.type, cfcr: g.cfcr, status: g.status } as const;

export interface ActivityRowProps {
  entry: ActivityEntry;
  /** SE task-type vocabulary (team pack). The current value is always kept. */
  taskTypes?: string[];
  /**
   * D-55: the persona's Events need an SE task type (the SE's Solutions Events; default). Without (an AE's Sales
   * Events) an empty type is calm "Not needed", never the amber "needs you".
   */
  taskTypeRequired?: boolean;
  /** Opportunities to map to (WhatId), when no `oppField` is given: a local type-to-filter combobox. */
  opps?: Array<{ id: string; label: string }>;
  /**
   * The Opportunity field itself (Time: OppPicker, ranked for the row with an Org62 search). Gets the field's look
   * (calm, or the amber "needs opp" pair) and whether the row is editable.
   */
  oppField?: (p: { className: string; disabled: boolean }) => ReactNode;
  /** Autosave status ("Saved · 2s ago" / "Saving…" / "Couldn't save · Retry"): FE-1a InlineStatus. */
  statusSlot?: ReactNode;
  readOnly?: boolean;
  className?: string;
  onChange?: (patch: ActivityPatch, entry: ActivityEntry) => void;
  onOpenSource?: (s: SourceRef, entry: ActivityEntry) => void;
  /** Selected (the row open in the details panel). */
  selected?: boolean;
  /** Lit for a moment ("show it" from elsewhere). */
  highlight?: boolean;
  /** A click outside the fields, or Enter: open it in the details panel. */
  onOpen?: (entry: ActivityEntry) => void;
}

/** A field's look without a width (cn only joins classes, so a width added after `w-full` would lose to it). */
const FIELD_BOX = 'h-9 min-w-0 rounded-md border bg-transparent px-2 text-body hover:border-line focus:border-accent focus:bg-surface-input focus:outline-none disabled:hover:border-transparent';
const FIELD = `${FIELD_BOX} w-full`;
/** The calm field colours; a field that needs you swaps in the warning pair instead (one class per property). */
const CALM = 'border-transparent text-fg';
const NO_PICKER = '[&::-webkit-calendar-picker-indicator]:hidden';
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

export function ActivityRowHeader({ className }: { className?: string }) {
  return (
    <div role="row" className={cn(g.grid, g.head, 'min-h-10 border-b border-line bg-surface-muted px-4 py-2 text-caption font-bold text-muted', className)}>
      <span className={cn(g.when, 'px-1.5')}>When</span>
      <span className={cn(g.hours, 'px-1.5 text-right')}>Hours</span>
      <span className={cn(g.desc, 'px-1.5')}>
        Description<span className={g.narrowOnly}> · opportunity</span>
      </span>
      <span className={cn(g.opp, g.wideOnly, 'px-1.5')}>Opportunity</span>
      <span className={cn(g.type, g.wideOnly, 'px-1.5')}>Task type</span>
      <span className={cn(g.cfcr, g.wideOnly)}>CF / CR</span>
      <span className={g.status}>Status</span>
    </div>
  );
}

/** Activity's status words, in plain words (D-87): where the row is on its way to Org62, never the pipeline's names. */
const PLAIN_STATUS: Partial<Record<ActivityEntry['status'], string>> = {
  proposed: 'Suggested',
  synced_to_canvas: 'On its way to Org62',
  verified: 'Checked in Org62',
  verify_failed: 'Not in Org62',
};

export const activityStatusLabel = (s: ActivityEntry['status']): string => PLAIN_STATUS[s] ?? ACTIVITY_META[s].label;

/**
 * The one status column: a word, coloured only when the row needs you (amber needs input, red failed) or the app
 * proposed it (violet, no box); done rows are a muted word with a green check; the rest plain text.
 */
export function ActivityStatusWord({ status, label }: { status: ActivityEntry['status']; label?: string }) {
  const meta = ACTIVITY_META[status];
  const text = label ?? activityStatusLabel(status);
  if (meta.tone === 'warn' || meta.tone === 'risk')
    return (
      <StatusBadge tone={TONE_TO_BADGE[meta.tone]} icon="warning">
        {text}
      </StatusBadge>
    );
  if (meta.tone === 'ai')
    return (
      <span className="inline-flex items-center gap-1 text-caption font-bold whitespace-nowrap text-ai-700">
        <span aria-hidden>✦</span>
        {text}
      </span>
    );
  if (meta.tone === 'ok')
    return (
      <span className="inline-flex items-center gap-1 text-caption whitespace-nowrap text-fg">
        <Icon name="check" size="xs" className="text-success-700" />
        {text}
      </span>
    );
  return <span className={cn('text-caption whitespace-nowrap', meta.tone === 'brand' ? 'text-fg' : 'text-muted')}>{text}</span>;
}

function fromEntry(e: ActivityEntry, tz?: string) {
  return { date: e.date, start: clock(e.start, tz), end: clock(e.end, tz), durationH: String(e.durationH), description: e.description };
}

/** The fallback Opportunity field: the given opps, filtered by what you type (the Time page passes OppPicker instead). */
function LocalOppField({ entry, opps, className, disabled, onPick }: { entry: ActivityEntry; opps: Array<{ id: string; label: string }>; className: string; disabled: boolean; onPick: (id: string | null) => void }) {
  const [q, setQ] = useState('');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const options = [
    ...opps.filter((o) => words.every((w) => o.label.toLowerCase().includes(w))).map((o) => ({ key: o.id, label: o.label })),
    ...(entry.oppId && !words.length ? [{ key: '', label: 'No opportunity', group: 'Other' }] : []),
  ];
  return (
    <Combobox
      label="Opportunity"
      value={entry.oppId ? (entry.oppName ?? entry.oppId) : 'Needs opp…'}
      title={entry.accountName ?? undefined}
      disabled={disabled}
      triggerClassName={className}
      options={options}
      query={q}
      onQueryChange={setQ}
      selectedKey={entry.oppId}
      onPick={(o) => onPick(o.key || null)}
      placeholder="Find an opportunity"
      empty="No opportunity matches."
    />
  );
}

export function ActivityRow({ entry, taskTypes = [], taskTypeRequired = true, opps = [], oppField, statusSlot, readOnly, className, onChange, onOpenSource, selected, highlight, onOpen }: ActivityRowProps) {
  const { tz } = useClock();
  const [base, setBase] = useState(`${entry.id}@${entry.version}`);
  const [d, setD] = useState(() => fromEntry(entry, tz));
  const [open, setOpen] = useState(false);
  if (base !== `${entry.id}@${entry.version}`) {
    setBase(`${entry.id}@${entry.version}`);
    setD(fromEntry(entry, tz));
  }
  // "overlaps '<other>' 12:30–13:00 (both log)" is information (D-18 amended): muted, never a warning
  const notes = entry.issues.filter(isOverlapInfo);
  const warnings = entry.issues.filter((i) => !isOverlapInfo(i));
  const locked = new Set(entry.userLockedFields);
  const types = entry.taskType && !taskTypes.includes(entry.taskType) ? [entry.taskType, ...taskTypes] : taskTypes;
  const oppList = entry.oppId && !opps.some((o) => o.id === entry.oppId) ? [{ id: entry.oppId, label: entry.oppName ?? entry.oppId }, ...opps] : opps;
  const emit = (p: ActivityPatch) => onChange?.(p, entry);
  // D-64: internal-only work has no opportunity by design
  const needsOpp = !hasTarget(entry);
  const disabled = !!readOnly || entry.status === 'logged' || entry.status === 'verified';
  // the opportunity wraps to two lines (OppPicker), so its field grows with it
  const oppClass = cn(FIELD, 'h-auto min-h-9 py-1', needsOpp ? 'border-dashed border-warning-500 text-warning-700' : CALM);
  const meta = ACTIVITY_META[entry.status];

  const commitTimes = () => {
    if (!HHMM.test(d.start) || !HHMM.test(d.end) || !d.date) {
      setD(fromEntry(entry, tz));
      return;
    }
    const start = zonedIso(d.date, d.start, tz);
    const end = zonedIso(d.date, d.end, tz);
    if (start !== entry.start || end !== entry.end || d.date !== entry.date) {
      const hours = Math.max(0, Math.round(((Date.parse(end) - Date.parse(start)) / 3_600_000) * 4) / 4);
      setD((x) => ({ ...x, durationH: String(hours) }));
      emit({ date: d.date, start, end, durationH: hours });
    }
  };

  // ActionRow (the kit's one row): the when as the lead, the description as the title, the state and what is off as
  // the why line, sources and the save state as chips; opportunity, task type, hours and customer-facing or
  // customer-related as the trailing controls; the day and the description's editor as the expansion (Space).
  return (
    <ActionRow
      id={entry.id}
      title={entry.description || 'Activity row'}
      className={cn(highlight && 'shadow-[inset_0_0_0_1px_var(--color-accent)]', className)}
      edge={entry.status === 'verify_failed' ? 'danger' : needsOpp || meta.tone === 'warn' ? 'warning' : meta.tone === 'ai' ? 'ai' : 'none'}
      dashed={entry.status === 'proposed'}
      lead={
        <span className="flex items-center gap-0.5 pt-0.5">
          <input inputMode="numeric" aria-label="Start (24 h)" placeholder="hh:mm" disabled={disabled} value={d.start} onChange={(e) => setD({ ...d, start: e.target.value })} onBlur={commitTimes} className={cn(FIELD_BOX, CALM, 'w-[3.75rem] shrink-0 px-1 text-center tabular-nums')} />
          <span className="text-faint">–</span>
          <input inputMode="numeric" aria-label="End (24 h)" placeholder="hh:mm" disabled={disabled} value={d.end} onChange={(e) => setD({ ...d, end: e.target.value })} onBlur={commitTimes} className={cn(FIELD_BOX, CALM, 'w-[3.75rem] shrink-0 px-1 text-center tabular-nums')} />
        </span>
      }
      why={
        <span className="inline-flex min-w-0 items-center gap-2">
          <ActivityStatusWord status={entry.status} />
          {warnings.length ? (
            <span className="inline-flex min-w-0 items-center gap-1 text-caption text-warning-700" title={plainIssues(entry).join(' · ')}>
              <Icon name="warning" size="xs" className="shrink-0" />
              <span className="truncate">{plainIssue(warnings[0]!, entry) ?? warnings[0]}</span>
            </span>
          ) : notes.length ? (
            <span className="truncate text-caption text-muted" title={notes.join(' · ')} data-testid="activity-overlap-note">
              {notes[0]}
            </span>
          ) : null}
        </span>
      }
      whyTitle={[activityStatusLabel(entry.status), ...plainIssues(entry)].join(' · ')}
      chips={
        <>
          {entry.sources.slice(0, 2).map((s, i) => (
            <SourceChip key={`${s.kind}:${i}`} source={s} compact onOpen={onOpenSource ? (src) => onOpenSource(src, entry) : undefined} />
          ))}
          {statusSlot ? <span className="min-w-0 truncate text-caption text-muted">{statusSlot}</span> : null}
        </>
      }
      extra={
        <span className="flex min-w-0 flex-wrap items-center gap-2 pt-1" data-no-open>
          <span className="w-64 max-w-full min-w-0">{oppField ? oppField({ className: oppClass, disabled }) : <LocalOppField entry={entry} opps={oppList} className={oppClass} disabled={disabled} onPick={(id) => emit({ oppId: id })} />}</span>
          <select
            aria-label="Task type"
            disabled={disabled}
            value={entry.taskType ?? ''}
            onChange={(e) => emit({ taskType: e.target.value || null })}
            title={taskTypeRequired ? (entry.taskType ?? undefined) : 'Your role logs Events with no task type'}
            className={cn(FIELD_BOX, 'w-44', entry.taskType ? CALM : taskTypeRequired ? 'border-transparent text-warning-700' : 'border-transparent text-faint')}
          >
            <option value="">{taskTypeRequired ? 'Choose type…' : 'Not needed'}</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="number"
            aria-label="Hours"
            step={0.25}
            min={0}
            disabled={disabled}
            value={d.durationH}
            onChange={(e) => setD({ ...d, durationH: e.target.value })}
            onBlur={() => {
              const v = Math.round(Number(d.durationH) * 4) / 4;
              if (Number.isFinite(v) && v !== entry.durationH) emit({ durationH: v });
            }}
            className={cn(FIELD_BOX, CALM, 'w-16 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none', locked.has('durationH') && 'font-bold')}
          />
          {/* two quiet words; only the chosen one is filled (no box around the pair) */}
          <span className="inline-flex h-8 items-center gap-0.5" role="radiogroup" aria-label="Customer-facing or customer-related">
            {(['CF', 'CR'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={entry.meetingType === m}
                disabled={disabled}
                title={m === 'CF' ? 'Customer-facing' : 'Customer-related (internal prep)'}
                onClick={() => emit({ meetingType: m })}
                className={cn('h-7 rounded-sm px-2 text-caption font-bold focus-visible:outline-none focus-visible:shadow-focus', entry.meetingType === m ? 'border border-line-strong bg-selected text-fg-heading' : 'text-muted hover:bg-surface-muted hover:text-fg')}
              >
                {m === 'CF' ? 'Customer' : 'Prep'}
              </button>
            ))}
          </span>
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Hide the day and description' : 'Edit the day and description'}
            title={open ? 'Hide' : 'The day and the description'}
            onClick={() => setOpen((v) => !v)}
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-muted hover:text-fg focus-visible:shadow-focus focus-visible:outline-none"
            data-testid="activity-expand"
          >
            <Icon name={open ? 'chevrondown' : 'chevronright'} size="xs" />
          </button>
        </span>
      }
      expanded={open}
      onExpandedChange={setOpen}
      expansion={
        <div className="grid min-w-0 gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
          <label className="flex flex-col gap-1 text-caption text-muted">
            Day
            <input type="date" aria-label="Date" disabled={disabled} value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} onBlur={commitTimes} className={cn(FIELD_BOX, 'border-line-input bg-surface-input', NO_PICKER, 'w-[9rem] tabular-nums')} />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-caption text-muted">
            Description (the Event’s Subject)
            <DescriptionField value={d.description} disabled={disabled} onChange={(v) => setD({ ...d, description: v })} onCommit={() => d.description !== entry.description && emit({ description: d.description })} />
          </label>
        </div>
      }
      selected={selected}
      onOpen={onOpen ? () => onOpen(entry) : undefined}
    />
  );
}

/**
 * The description: wraps to two lines (the full text is the tooltip, and a fade says there is more), and grows to
 * six while you edit it. Enter saves, like the one-line field it replaces; it never adds a line break.
 */
function DescriptionField({ value, disabled, onChange, onCommit }: { value: string; disabled: boolean; onChange: (v: string) => void; onCommit: () => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || 24;
      const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      const chrome = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + border;
      el.style.height = 'auto';
      const want = el.scrollHeight + border;
      if (!want) return; // not laid out (jsdom, hidden): keep the CSS height
      const max = (open ? 6 : 2) * lh + chrome;
      el.style.height = `${Math.min(want, max)}px`;
      setClipped(!open && want > max + 1);
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return;
      w = el.clientWidth;
      fit();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, open]);
  return (
    <textarea
      ref={ref}
      aria-label="Description"
      rows={1}
      disabled={disabled}
      value={value}
      title={value || undefined}
      data-clipped={clipped ? '' : undefined}
      onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))}
      onFocus={() => setOpen(true)}
      onBlur={() => {
        setOpen(false);
        onCommit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className={cn(FIELD, CALM, 'block h-9 resize-none overflow-hidden py-1.5 leading-6 break-words', 'data-[clipped]:[mask-image:linear-gradient(to_bottom,black_55%,transparent)]', 'focus:overflow-y-auto')}
    />
  );
}
