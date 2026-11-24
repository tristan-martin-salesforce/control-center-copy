'use client';
/**
 * Item header (UI-SPEC §12): where it sits (account · initiative ▸ task), the one state badge, the
 * autosaved title and purpose, the meeting it serves, a quiet meta row (owner · due · start by · effort ·
 * new evidence, all autosaved) and the persistent status line (reopened, looped back in, …).
 *
 * v2 (DESIGN-V2): sentence case, no object tiles or eyebrows, neutral account tags, one color signal.
 *   page  → 28 px title over a quiet meta row, the actions (quiet) on the right;
 *   sheet → the same stack for a ~560 px column;
 *   panel → the docked panel's head: "Do now · 1 of 3" · account · badge, a 22 px title, the purpose.
 */
import { AppLink } from '@/components/shell/AppLink';
import type { ReactNode, Ref } from 'react';
import type { CalendarEvent, Effort, WorkItem } from '@/contract';
import { kindLabel } from '@/components/domain';
import { looksDoneEvidence } from '@/engines/home/looks-done';
import { cn, Icon, IconButton, StaleMark } from '@/ui';
import { INVOLVEMENT_LABEL } from '../lib/derive';
import { stateBadge } from '../lib/panel-derive';
import { fmtWhen } from '../lib/tz';
import { NeutralTag, StateBadge } from '../panel/bits';
import { EffortField, TextField, WhenField } from './fields';

export interface ItemHeaderProps {
  variant: 'sheet' | 'page' | 'panel';
  item: WorkItem;
  meeting: CalendarEvent | null;
  now: string;
  tz?: string;
  meName?: string;
  breadcrumb?: boolean;
  /** Panel: "Do now · 1 of 3", "Reply and approve", … */
  sectionLine?: string;
  saveField: (field: 'title' | 'purpose' | 'due' | 'startBy', value: string | null, basis: string | null) => Promise<unknown>;
  saveEffort: (value: Effort, basis: Effort) => Promise<unknown>;
  /** Quiet actions (page: right of the title; sheet: under the meta row; panel: none, they live in the footer). */
  actions?: ReactNode;
  /** Undo for the transient reopen / loop-back label (the audit entry that caused it). */
  onUndoStatus?: () => void;
  onShowEvidence?: () => void;
  /** Panel: ⇧↵ opens the full page. */
  onOpenPage?: () => void;
  titleRef?: Ref<HTMLInputElement & HTMLTextAreaElement>;
}

function minutesUntil(at: string, now: string) {
  return Math.round((Date.parse(at) - Date.parse(now)) / 60_000);
}

function relIn(min: number): string {
  const a = Math.abs(min);
  const t = a >= 60 ? `${Math.floor(a / 60)}h${a % 60 ? `${String(a % 60).padStart(2, '0')}m` : ''}` : `${a}m`;
  return min >= 0 ? `in ${t}` : `${t} ago`;
}

/** account · Initiative ▸ Task. Accounts are a neutral tag (color is an indicator, never identity). */
export function Breadcrumb({ item, className }: { item: WorkItem; className?: string }) {
  const ini = item.refs.initiative;
  return (
    <nav aria-label="Breadcrumb" className={cn('flex min-w-0 items-center gap-1.5 text-caption text-muted', className)}>
      {item.refs.account ? (
        <span className="shrink-0">
          <NeutralTag href={item.refs.account.href} title={`Account: ${item.refs.account.label}`}>
            {item.refs.account.label}
          </NeutralTag>
        </span>
      ) : null}
      {ini ? (
        <AppLink href={ini.href ?? `/initiatives/${ini.id}`} className="min-w-0 truncate text-muted hover:text-link hover:underline" title={`Initiative: ${ini.label}`}>
          {ini.label}
        </AppLink>
      ) : (
        <span className="shrink-0 text-faint">{item.kind === 'training' ? 'Training' : 'No initiative'}</span>
      )}
      <Icon name="chevronright" size="xs" className="shrink-0 text-faint" />
      <span className="min-w-0 truncate text-fg" aria-current="page">
        {item.title}
      </span>
    </nav>
  );
}

/** The persistent, state-specific line: reopened / looped back in / likely done / waiting / stale / snoozed. */
function StatusLabel({ item, now, tz, onUndo }: { item: WorkItem; now: string; tz?: string; onUndo?: () => void }) {
  let tone: 'warn' | 'ai' | 'ready' | 'neutral' = 'neutral';
  let icon = 'info';
  let body: ReactNode = null;
  if (item.loopedBackIn) {
    tone = 'warn';
    icon = 'rotate';
    body = (
      <>
        <span className="font-bold">Looped back in:</span> {item.loopedBackIn.byPersonName} asked you directly
      </>
    );
  } else if (item.reopened && (item.state === 'reopened' || item.state === 'open')) {
    tone = 'warn';
    icon = 'rotate';
    body = (
      <>
        <span className="font-bold">Reopened:</span> {item.reopened.reason.replace(/^Reopened:\s*/i, '')}
      </>
    );
  } else if (item.state === 'likely_done' && item.likelyDone) {
    tone = 'ready';
    icon = 'check';
    body = (
      <>
        <span className="font-bold">Looks done:</span> {looksDoneEvidence(item)}
      </>
    );
  } else if (item.waiting && (item.state === 'waiting_on_me' || item.state === 'waiting_on_others')) {
    tone = item.waiting.on === 'me' ? 'warn' : 'neutral';
    icon = item.waiting.on === 'me' ? 'waits' : 'away';
    body = (
      <>
        <span className="font-bold">{item.waiting.on === 'me' ? 'Waiting on you:' : `Waiting on ${item.waiting.who?.name ?? 'others'}:`}</span> {item.waiting.reason}
      </>
    );
  } else if (item.state === 'snoozed' && item.snoozedUntil) {
    icon = 'clock';
    body = <>Snoozed until {fmtWhen(item.snoozedUntil, now, tz, { today: true })}</>;
  } else if (item.state === 'done' && item.closedReason && item.resolutionDetail?.inferred) {
    tone = 'ai';
    icon = 'check';
    body = (
      <>
        <span className="font-bold">Closed for you:</span> {item.closedReason}
      </>
    );
  }
  if (!body) return null;
  // The header badge is the one color signal; the status line stays neutral, with only its glyph tinted.
  const cls = 'border-line bg-surface-muted';
  const glyph = { warn: 'text-warning-700', ai: 'text-ai-700', ready: 'text-success-700', neutral: 'text-muted' }[tone];
  return (
    <p data-status-label className={cn('flex max-w-[68ch] items-start gap-2 rounded-md border px-3 py-2 text-caption', cls)}>
      <Icon name={icon} size="xs" className={cn('mt-0.5 shrink-0', glyph)} />
      <span className="min-w-0 text-fg">
        {body}
        {onUndo && (item.loopedBackIn || item.reopened) ? (
          <button type="button" onClick={onUndo} className="ml-1.5 rounded-sm font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none">
            Undo
          </button>
        ) : null}
      </span>
    </p>
  );
}

function Serves({ item, meeting, now, tz }: { item: WorkItem; meeting: CalendarEvent | null; now: string; tz?: string }) {
  const m = item.refs.meeting;
  if (!m) return null;
  const start = meeting?.start ?? m.start;
  const until = minutesUntil(start, now);
  const soon = until >= 0 && until <= 180;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-caption text-muted" data-serves>
      <Icon name="event" size="xs" className="shrink-0 text-muted" />
      <span className="shrink-0">Serves</span>
      <span className="min-w-0 truncate font-bold text-fg" title={m.label}>
        {m.label}
      </span>
      <span className="shrink-0 tabular-nums">
        · {fmtWhen(start, now, tz, { today: true })} <span className={cn(soon && 'font-bold text-warning-700')}>({relIn(until)})</span>
      </span>
    </span>
  );
}

function NewEvidence({ item, onShow }: { item: WorkItem; onShow?: () => void }) {
  if (!item.newEvidenceCount) return <span className="text-faint">None new</span>;
  return (
    <button type="button" onClick={onShow} className="inline-flex items-center gap-1.5 rounded-sm font-bold text-link tabular-nums hover:underline focus-visible:shadow-focus focus-visible:outline-none" data-new-evidence>
      <span aria-hidden className="size-2 rounded-full bg-accent" />
      {item.newEvidenceCount} new evidence
    </button>
  );
}

/** Owner (when it isn't you), involvement, kind and staleness, as quiet words. */
function WhoLine({ item, meName }: { item: WorkItem; meName?: string }) {
  const owner = item.owner && meName && item.owner.name !== meName ? item.owner.name : item.owner && !meName ? item.owner.name : null;
  const parts = [
    kindLabel(item),
    owner ? `Owner: ${owner}` : null,
    item.involvement !== 'owner' ? `You: ${INVOLVEMENT_LABEL[item.involvement].toLowerCase()}` : null,
  ].filter(Boolean);
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-caption text-muted" data-who>
      <span className="truncate">{parts.join(' · ')}</span>
      {item.stale ? <StaleMark reason={item.stale.reason} /> : null}
    </span>
  );
}

export function ItemHeader(props: ItemHeaderProps) {
  const { variant, item, meeting, now, tz, meName, saveField, saveEffort, actions, onUndoStatus, onShowEvidence, titleRef } = props;
  // The badge is the one color signal (overdue, expired, start by…); the meta row stays neutral.
  const badge = stateBadge(item, now, tz);

  const title = (
    <TextField
      field="title"
      label="Title"
      value={item.title}
      required
      save={(v, b) => saveField('title', v, b)}
      inputRef={titleRef}
      wrap={variant !== 'page'}
      inputClassName={cn('font-bold text-fg-heading', variant === 'page' ? 'h-10 text-heading' : 'min-h-8 text-title')}
    />
  );
  const purpose = (
    <TextField
      field="purpose"
      label="Purpose"
      value={item.purpose ? item.purpose.replace(/^For:\s*/i, '') : null}
      placeholder="What is this for? (the meeting, deal or promise it serves)"
      save={(v, b) => saveField('purpose', v, b)}
      prefix={variant === 'panel' ? undefined : <span className="shrink-0 text-body font-bold text-muted">For:</span>}
      inputClassName="h-7 text-body text-muted focus:text-fg"
      className="min-w-0 flex-1"
    />
  );

  // The meta row: autosaved values, quiet, one line at 520 px. Effort reads "you 20m · agent ~20m" on its
  // own, and new evidence only shows when there is some.
  const meta: Array<{ key: string; label?: string; node: ReactNode }> = [
    { key: 'due', label: 'Due', node: <WhenField field="due" label="Due" value={item.due} now={now} tz={tz} compact save={(v, b) => saveField('due', v, b)} /> },
    { key: 'startBy', label: 'Start by', node: <WhenField field="startBy" label="Start by" value={item.startBy} now={now} tz={tz} compact save={(v, b) => saveField('startBy', v, b)} /> },
    { key: 'effort', node: <EffortField value={item.effort} compact save={saveEffort} /> },
    ...(item.newEvidenceCount ? [{ key: 'evidence', node: <NewEvidence item={item} onShow={onShowEvidence} /> }] : []),
  ];
  const metaRow = (
    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption" data-item-meta>
      {meta.map((f) => (
        <div key={f.key} className="flex min-w-0 items-center gap-1.5">
          <dt className={f.label ? 'shrink-0 text-muted' : 'sr-only'}>{f.label ?? (f.key === 'effort' ? 'Effort' : 'Evidence')}</dt>
          <dd className="flex min-h-7 min-w-0 items-center whitespace-nowrap text-fg">{f.node}</dd>
        </div>
      ))}
    </dl>
  );

  if (variant === 'panel') {
    return (
      <header className="shrink-0 space-y-2 border-b border-line px-6 pt-4 pb-4" data-item-header="panel">
        <div className="flex min-w-0 items-center gap-2 text-caption text-muted">
          {props.sectionLine ? <span className="shrink-0" data-section-line>{props.sectionLine}</span> : null}
          {item.refs.account ? (
            <NeutralTag href={item.refs.account.href} title={`Account: ${item.refs.account.label}`}>
              {item.refs.account.label}
            </NeutralTag>
          ) : item.refs.initiative ? (
            <NeutralTag href={item.refs.initiative.href ?? `/initiatives/${item.refs.initiative.id}`} title={`Initiative: ${item.refs.initiative.label}`}>
              {item.refs.initiative.label}
            </NeutralTag>
          ) : null}
          {badge ? <StateBadge badge={badge} /> : null}
          {props.onOpenPage ? (
            <span className="ml-auto shrink-0">
              <IconButton icon="expand_alt" label="Open full page (⇧↵)" size="sm" variant="ghost" onClick={props.onOpenPage} />
            </span>
          ) : null}
        </div>
        {title}
        {purpose}
        {/* The meeting it serves lives in Readiness below; the head stays three lines (mockup). */}
        {metaRow}
        <StatusLabel item={item} now={now} tz={tz} onUndo={onUndoStatus} />
      </header>
    );
  }

  if (variant === 'page') {
    return (
      <header className="shrink-0 border-b border-line px-6 pt-5 pb-4" data-item-header="page">
        <div className="flex items-start gap-6">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {props.breadcrumb !== false ? <Breadcrumb item={item} className="min-w-0" /> : null}
              {badge ? <StateBadge badge={badge} /> : null}
            </div>
            {/* the page's outline: the title is an editable field, so its heading is for screen readers (the
                sections below are h3s) */}
            <h2 className="sr-only">{item.title}</h2>
            {title}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <div className="flex min-w-[20rem] flex-1">{purpose}</div>
              <Serves item={item} meeting={meeting} now={now} tz={tz} />
            </div>
          </div>
          {actions ? <div className="shrink-0 pt-1">{actions}</div> : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
          {metaRow}
          <WhoLine item={item} meName={meName} />
        </div>
        <div className="empty:hidden [&>p]:mt-3">
          <StatusLabel item={item} now={now} tz={tz} onUndo={onUndoStatus} />
        </div>
      </header>
    );
  }

  return (
    <header className="space-y-2" data-item-header="sheet">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {props.breadcrumb !== false ? <Breadcrumb item={item} className="min-w-0" /> : null}
        {badge ? <StateBadge badge={badge} /> : null}
      </div>
      {title}
      {purpose}
      <Serves item={item} meeting={meeting} now={now} tz={tz} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {metaRow}
        <WhoLine item={item} meName={meName} />
      </div>
      <StatusLabel item={item} now={now} tz={tz} onUndo={onUndoStatus} />
      {actions}
    </header>
  );
}
