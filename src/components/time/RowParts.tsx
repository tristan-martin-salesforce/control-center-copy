'use client';
/**
 * The pieces a Time row shows wherever it is (Needs you, Log it ▸ Ready to log, a row's details): its suggestion with
 * Accept, how it came in (its sources with links, why the app proposed it, its issues in plain English), the read-only
 * note with its reason, and the fields that save as you change them (opportunity, task type, hours, CF / CR,
 * description). Color is state only: the suggestion is the AI color, a missing field the warning color, a read-only
 * note neutral.
 */
import { useState } from 'react';
import type { ActivityEntry } from '@/contract';
import { isOverlapInfo } from '@/engines/activity/overlap-flags';
import { plainIssues } from './plain';
import { clock, dayLabel } from '@/components/domain/lib/time';
import { Button, cn, FieldConflict, Icon, SourceChip } from '@/ui';
import { mergeField } from '@/components/lists/live-merge';
import { usePatchRows, type Shown } from './bulk';
import { OppPicker } from './OppPicker';
import { OppRundown } from './OppRundown';
import { fixPatch, type FixPatch } from './path-derive';
import { acceptPatch, acceptShown, pct, suggestionLabel, sureWord, type RowLock } from './rows-derive';
import { hasTarget } from '@/lib/time-internal';

export const FIELD = 'h-9 w-full min-w-0 rounded-md border bg-surface-input px-2 text-body text-fg hover:border-line-strong focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-70';
export const FIELD_CALM = 'border-line-input';
export const FIELD_NEEDS = 'border-dashed border-warning-500 text-warning-700';
/** A click on these inside a row is a field's, not the row's (which opens its details). */
export const STOP = 'input,select,textarea,button,a,label,[role="combobox"],[role="listbox"],[role="menu"],[data-no-open]';

/** What the pickers offer: the persona's task types, whether a type is needed, and the Internal choice. */
export interface Pickers {
  taskTypeRequired: boolean;
  taskTypes: string[];
  internalActivity: boolean;
}

const ORIGIN: Record<string, string> = { calendar: 'your calendar', slack: 'Slack', drive: 'Drive', claude: 'a Claude session', gmail: 'Gmail', gemini: 'Gemini notes', org62: 'Org62', vdp: 'VDP', manual: 'you' };

/** One save of a row's field (optimistic; a held row the fix completes is approved with it). */
export function useRowSave(e: ActivityEntry, taskTypeRequired: boolean) {
  const { one } = usePatchRows();
  return (p: FixPatch, shown?: Shown) => void one(e, fixPatch(e, p, taskTypeRequired), shown);
}

/**
 * The app's suggestion for a row that needs an opportunity: what (an opp and its account, or internal work), why, how
 * sure, rules or AI, and Accept (one click). The rest of the choices are the row's own opportunity picker.
 */
export function SuggestionLine({ e, taskTypeRequired, compact, onAccepted }: { e: ActivityEntry; taskTypeRequired: boolean; compact?: boolean; onAccepted?: () => void }) {
  const { one } = usePatchRows();
  const [busy, setBusy] = useState(false);
  const s = e.suggestion;
  if (!s) return null;
  const patch = acceptPatch(e, taskTypeRequired);
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption', compact ? '' : 'rounded-md bg-surface-muted px-2.5 py-1.5')} data-testid="row-suggestion" data-suggestion-kind={s.kind} data-basis={s.basis}>
      <span className="inline-flex shrink-0 items-center gap-1 font-bold text-ai-700">
        <span aria-hidden>✦</span>
        {s.basis === 'ai' ? 'AI suggests' : 'Suggested'}
      </span>
      <span className="min-w-0 font-bold break-words text-fg">{suggestionLabel(s)}</span>
      <span className="min-w-0 break-words text-muted">{`${s.reason} · ${pct(s.confidence)}, ${sureWord(s.confidence)}`}</span>
      {patch ? (
        <Button
          size="xs"
          variant="secondary"
          loading={busy}
          className="ml-auto"
          data-testid="accept-suggestion"
          title={s.kind === 'internal' ? 'Log it as internal work: Related To empty, an internal type' : `Log it to ${s.oppName ?? 'this opportunity'}`}
          onClick={async () => {
            setBusy(true);
            await one(e, patch, acceptShown(s));
            setBusy(false);
            onAccepted?.();
          }}
        >
          Accept
        </Button>
      ) : null}
      <Alternates e={e} taskTypeRequired={taskTypeRequired} onAccepted={onAccepted} />
    </div>
  );
}

/**
 * The attribution engine's alternates (its ranked top 3 after the suggestion), one click each, and the rundown of
 * opps when the engine is unsure (under the settle line, or a close second): the likely opps with my recent work.
 */
function Alternates({ e, taskTypeRequired, onAccepted }: { e: ActivityEntry; taskTypeRequired: boolean; onAccepted?: () => void }) {
  const { one } = usePatchRows();
  const [rundown, setRundown] = useState(false);
  const alts = (e.suggestions ?? []).filter((x) => x.kind === 'opp' && x.oppId && x.oppId !== e.suggestion?.oppId).slice(0, 2);
  const unsure = (e.suggestion?.confidence ?? 0) < 0.75 || alts.length > 0;
  if (!alts.length && !unsure) return null;
  const take = async (oppId: string, shown: Parameters<typeof one>[2]) => {
    await one(e, fixPatch(e, { oppId }, taskTypeRequired), shown);
    onAccepted?.();
  };
  return (
    <div className="flex w-full min-w-0 flex-col gap-1" data-testid="row-alternates" data-no-open>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {alts.length ? <span className="text-muted">or</span> : null}
        {alts.map((a) => (
          <button key={a.oppId} type="button" className="max-w-full truncate rounded-full border border-line px-2 py-0.5 text-fg hover:bg-surface hover:underline" title={a.reason} onClick={() => void take(a.oppId!, acceptShown(a))} data-testid="accept-alternate">
            {`${suggestionLabel(a)} · ${pct(a.confidence)}`}
          </button>
        ))}
        {unsure ? (
          <button type="button" className="font-bold text-link hover:underline" aria-expanded={rundown} onClick={() => setRundown((v) => !v)} data-testid="rundown-toggle">
            {rundown ? 'Hide the rundown' : 'Not sure? See the likely opps'}
          </button>
        ) : null}
      </div>
      {rundown ? <OppRundown e={e} onPick={(oppId) => void take(oppId, undefined)} /> : null}
    </div>
  );
}

/** "Read only: In Org62 since Tue, Nov 12: change it in Org62, the app follows" (neutral: nothing is wrong). */
export function LockNote({ lock, onOpenCanvas }: { lock: RowLock; onOpenCanvas?: (draftId: string) => void }) {
  return (
    <p className="flex min-w-0 items-start gap-1.5 text-caption text-muted" data-testid="row-lock" data-lock={lock.kind}>
      <Icon name="lock" size="xs" className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">
        <span className="font-bold text-fg">Read only: </span>
        {lock.why}
        {lock.canvas && onOpenCanvas && lock.kind === 'on_canvas' ? (
          <>
            {' '}
            <button type="button" className="font-bold text-link hover:underline" onClick={() => onOpenCanvas(lock.canvas!.draftId)}>
              Open the review
            </button>
          </>
        ) : null}
      </span>
    </p>
  );
}

/** The row's issues as sentences (overlap notes are information: muted, never a warning). */
export function IssueLines({ e, max }: { e: ActivityEntry; max?: number }) {
  const warn = plainIssues(e, (i) => !isOverlapInfo(i) && !/^GUESS:/i.test(i));
  const info = plainIssues(e, (i) => isOverlapInfo(i) || /^GUESS:/i.test(i));
  const shown = max ? warn.slice(0, max) : warn;
  if (!shown.length && !info.length) return null;
  return (
    <ul className="min-w-0 space-y-0.5 text-caption">
      {shown.map((t) => (
        <li key={t} className="flex min-w-0 items-start gap-1 text-warning-700">
          <Icon name="warning" size="xs" className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{t}</span>
        </li>
      ))}
      {(max ? info.slice(0, Math.max(0, max - shown.length)) : info).map((t) => (
        <li key={t} className="min-w-0 break-words text-muted">
          {t}
        </li>
      ))}
    </ul>
  );
}

/**
 * How the row came in: each source it was built from (its kind, label, when, and a link to the item where there is
 * one), why the app proposed it as it did, how sure the app was, and what is off.
 */
export function RowEvidence({ e, tz }: { e: ActivityEntry; tz?: string }) {
  const first = e.sources[0]?.kind;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="row-evidence">
      <p className="text-caption text-muted">
        {e.fromOrg62
          ? 'Read from an Org62 Event you (or Slackbot) logged.'
          : `Proposed from ${first ? ORIGIN[first] : 'what you did'}${e.sources.length > 1 ? ` and ${e.sources.length - 1} more ${e.sources.length === 2 ? 'source' : 'sources'}` : ''} · ${e.confidence === 'sure' ? 'the app was sure' : e.confidence === 'likely' ? 'likely' : 'a guess'}${e.why ? ` · ${e.why}` : ''}.`}
      </p>
      {e.sources.length ? (
        <ul className="min-w-0 divide-y divide-line rounded-md border border-line" aria-label="Sources">
          {e.sources.map((s, i) => (
            <li key={`${s.kind}:${s.externalId ?? s.label}:${i}`} className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-caption">
              <SourceChip source={s.kind} compact />
              <span className="min-w-0 flex-1 break-words text-fg">{s.label}</span>
              {s.at ? <span className="shrink-0 text-muted tabular-nums">{`${dayLabel(s.at, tz)} ${clock(s.at, tz)}`}</span> : null}
              {s.url ? (
                <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 font-bold text-link hover:underline" data-testid="source-link">
                  Open <Icon name="new_window" size="xs" />
                </a>
              ) : (
                <span className="shrink-0 text-faint" title="The source gave no link">
                  no link
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-caption text-muted">No source items: you added this row, or it came from a rule.</p>
      )}
      <IssueLines e={e} />
    </div>
  );
}

/** The task type select (the persona's types; the row's own kept). */
export function TaskTypeField({ e, pick, disabled, onSave, className }: { e: ActivityEntry; pick: Pickers; disabled?: boolean; onSave: (t: string) => void; className?: string }) {
  const types = e.taskType && !pick.taskTypes.includes(e.taskType) ? [e.taskType, ...pick.taskTypes] : pick.taskTypes;
  const needs = pick.taskTypeRequired && !e.taskType;
  return (
    <select aria-label="Task type" disabled={disabled} value={e.taskType ?? ''} onChange={(ev) => ev.target.value && onSave(ev.target.value)} className={cn(FIELD, needs ? FIELD_NEEDS : FIELD_CALM, className)} title={pick.taskTypeRequired ? (e.taskType ?? 'Choose the task type') : 'Your role logs Events with no task type'}>
      <option value="">{pick.taskTypeRequired ? 'Choose type…' : 'Not needed'}</option>
      {types.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

/**
 * Hours in quarter steps, saved on blur (and Enter). Live (docs/UX.md "Live updates"): a change made elsewhere updates
 * the field in place, unless you have typed hours of your own; then your text stays and "Changed elsewhere: keep mine
 * / take theirs" shows under it (before, a background refresh replaced what you were typing).
 */
export function HoursField({ e, disabled, onSave, className }: { e: ActivityEntry; disabled?: boolean; onSave: (h: number) => void; className?: string }) {
  const [v, setV] = useState(String(e.durationH));
  const [focused, setFocused] = useState(false);
  /** The row and the server hours this edit started from. */
  const [base, setBase] = useState({ id: e.id, h: e.durationH });
  const typed = Number(v);
  const m = base.id === e.id ? mergeField({ base: base.h, local: Number.isFinite(typed) ? typed : NaN, server: e.durationH, editing: focused }) : null;
  if (base.id !== e.id) {
    setBase({ id: e.id, h: e.durationH });
    setV(String(e.durationH));
  } else if (m && (m.kind === 'adopt' || m.kind === 'agree')) {
    setBase({ id: e.id, h: e.durationH });
    if (m.kind === 'adopt') setV(String(e.durationH));
  }
  const conflict = m?.kind === 'conflict' ? m.theirs : null;
  const commit = () => {
    setFocused(false);
    const n = Math.round(Number(v) * 4) / 4;
    // nothing typed (or typed back): take the server's hours, never write the old value over a change made elsewhere
    if (!Number.isFinite(n) || n < 0 || n === base.h) {
      setBase({ id: e.id, h: e.durationH });
      setV(String(e.durationH));
      return;
    }
    if (n !== e.durationH && !conflict) onSave(n);
  };
  return (
    <span className="inline-flex min-w-0 flex-col items-end gap-0.5">
    <input
      type="number"
      aria-label="Hours"
      step={0.25}
      min={0}
      disabled={disabled}
      value={v}
      onFocus={() => setFocused(true)}
      onChange={(ev) => setV(ev.target.value)}
      onBlur={commit}
      onKeyDown={(ev) => ev.key === 'Enter' && commit()}
      className={cn(FIELD, 'text-right tabular-nums', e.durationH <= 0 ? FIELD_NEEDS : FIELD_CALM, className)}
    />
    {conflict !== null ? (
      <FieldConflict
        theirs={`${conflict} h`}
        onKeepMine={() => {
          setBase({ id: e.id, h: e.durationH });
          const n = Math.round(Number(v) * 4) / 4;
          if (Number.isFinite(n) && n >= 0 && n !== e.durationH) onSave(n);
        }}
        onTakeTheirs={() => {
          setBase({ id: e.id, h: e.durationH });
          setV(String(e.durationH));
        }}
      />
    ) : null}
    </span>
  );
}

/** CF / CR: two quiet words, the chosen one filled. */
export function MeetingTypeField({ e, disabled, onSave }: { e: ActivityEntry; disabled?: boolean; onSave: (m: 'CF' | 'CR') => void }) {
  return (
    <span className="inline-flex h-9 items-center gap-0.5" role="radiogroup" aria-label="Customer-facing or customer-related">
      {(['CF', 'CR'] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={e.meetingType === m}
          disabled={disabled}
          title={m === 'CF' ? 'Customer-facing' : 'Customer-related (internal prep)'}
          onClick={() => onSave(m)}
          className={cn('h-8 rounded-sm px-2.5 text-caption font-bold focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed', e.meetingType === m ? 'border border-line-strong bg-selected text-fg-heading' : 'text-muted hover:bg-surface-muted hover:text-fg')}
        >
          {m}
        </button>
      ))}
    </span>
  );
}

/** The description (the Event's Subject), saved on blur and Enter. */
export function DescriptionInput({ e, disabled, onSave }: { e: ActivityEntry; disabled?: boolean; onSave: (d: string) => void }) {
  const [v, setV] = useState(e.description);
  const [base, setBase] = useState(`${e.id}@${e.version}`);
  if (base !== `${e.id}@${e.version}`) {
    setBase(`${e.id}@${e.version}`);
    setV(e.description);
  }
  const commit = () => {
    const t = v.trim();
    if (t && t !== e.description) onSave(t);
    else setV(e.description);
  };
  return <input aria-label="Description" disabled={disabled} value={v} maxLength={255} onChange={(ev) => setV(ev.target.value)} onBlur={commit} onKeyDown={(ev) => ev.key === 'Enter' && commit()} className={cn(FIELD, FIELD_CALM)} />;
}

/** The opportunity field of a row: the picker (suggestion first, Internal near the top, Org62 search). */
export function OppField({ e, pick, disabled, save, className }: { e: ActivityEntry; pick: Pickers; disabled?: boolean; save: (p: FixPatch, shown?: Shown) => void; className?: string }) {
  const needs = !hasTarget(e);
  const { one } = usePatchRows();
  return (
    <OppPicker
      entry={e}
      disabled={disabled}
      placeholder={e.suggestion ? 'Choose an opportunity…' : undefined}
      className={cn(FIELD, 'h-auto min-h-9 py-1', needs ? FIELD_NEEDS : FIELD_CALM, className)}
      onPick={(oppId, shown) => save({ oppId }, { oppName: shown.oppName, accountName: shown.accountName ?? undefined })}
      onInternal={pick.internalActivity ? () => save({ internal: true }, { oppName: null, accountName: null }) : undefined}
      // D-103 (c): an account from Org62 the app has: the row logs to the account itself
      onAccount={(id, name) => void one(e, { target: { kind: 'account', id } }, { oppName: null, accountName: name })}
    />
  );
}
