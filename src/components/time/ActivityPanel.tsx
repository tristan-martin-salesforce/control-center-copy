'use client';
/**
 * Details renderer for an activity-log row (docked right panel; Time ▸ Needs you, Log it, the week's rows, the Ledger):
 *
 *   Read only      when the row can't change here, why, and where it can (on a canvas waiting for Apply: its review;
 *                  in Org62: Org62; handed to Slackbot: nowhere until Org62 has it)
 *   Suggestion     what the app suggests while the row needs an opportunity (an opp, or internal work), why, how
 *                  sure, rules or AI, and Accept
 *   Fields         every field the row logs with, editable here and saved like the inline ones (PATCH /activity/:id,
 *                  optimistic): opportunity (Internal near the top, Org62 search), task type, hours, CF / CR,
 *                  description; D-66's "Description in Org62" note (autosaved, your edit locked)
 *   How it came in each source item with its link, why the app proposed it, how sure it was, and what is off, in
 *                  plain English (never the engine's canvas notes)
 *   Where it stands status, the canvas it is on, logged and verified stamps
 *
 * Footer: the one thing the row waits on (Approve, Review & apply its canvas, Log again / Leave out). Human hours only.
 * Nothing is written to Org62 from here.
 */
import { useEffect, useState } from 'react';
import type { ActivityEntry } from '@/contract';
import { useApi } from '@/client/hooks';
import { useAutosave } from '@/client/save';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { usePromptWording } from '@/components/domain/ResultLinks';
import { ACTIVITY_META, StatusBadge } from '@/components/domain';
import { TONE_TO_BADGE } from '@/components/domain/lib';
import { clock, dayLabel } from '@/components/domain/lib/time';
import { useDetails } from '@/components/deals/context-frame';
import { Facts, PanelSection, PanelShell, useCachedFind } from '@/components/deals/panel-shell';
import { Button, cn, EmptyState, InlineStatus, useNow, useTimeZone } from '@/ui';
import { READBACK_BADGE, readbackState } from './derive';
import { RelogActions } from './RelogActions';
import { EXCLUDED_REASON_LABEL, EXCLUDED_WORD } from './log-derive';
import { completeForApprove, rowLock } from './rows-derive';
import { DescriptionInput, HoursField, LockNote, MeetingTypeField, OppField, RowEvidence, SuggestionLine, TaskTypeField, useRowSave, type Pickers } from './RowParts';
import { LandingPill, WriteList } from './LandingParts';
import { navigate } from '@/components/shell/router';
import { hasTarget } from '@/lib/time-internal';

export function ActivityPanel({ id, label }: { id: string; label?: string }) {
  const tz = useTimeZone();
  const now = useNow(60_000).toISOString();
  const wording = usePromptWording();
  const { open } = useDetails();
  const e = useCachedFind<ActivityEntry>('time', (data) => {
    const w = data as { entries?: ActivityEntry[] };
    return Array.isArray(w.entries) ? (w.entries.find((x) => x.id === id) ?? null) : null;
  });
  // the canvases (why a row on one is read only): this week's payload, which the Time page has loaded
  const week = useApi('getTime', { query: { week: undefined } }, { staleTime: 30_000 });
  if (!e) {
    return (
      <PanelShell from="Activity log row" title={label ?? 'Activity row'}>
        <EmptyState size="inline" icon="clock" title="Not loaded here" body="Log rows load on the Activity page: To log, or History with every row." action={<Button size="sm" variant="secondary" onClick={() => navigate('/activity?view=log')}>Open the log</Button>} />
      </PanelShell>
    );
  }
  return <Loaded e={e} tz={tz} now={now} canvases={week.data?.logCanvases} pick={{ taskTypeRequired: wording.taskType, taskTypes: wording.taskTypes, internalActivity: wording.internal }} recordTypeName={wording.recordTypeName} openCanvas={(draftId) => open({ kind: 'draft', id: draftId, label: 'Logging batch' })} />;
}

function Loaded({ e, tz, now, canvases, pick, recordTypeName, openCanvas }: { e: ActivityEntry; tz?: string; now: string; canvases: Parameters<typeof rowLock>[1]; pick: Pickers; recordTypeName: string; openCanvas: (draftId: string) => void }) {
  const save = useRowSave(e, pick.taskTypeRequired);
  const meta = ACTIVITY_META[e.status];
  // a dismissed row says who took it out: the engine (Excluded), a newer row (Dropped) or you (Dismissed)
  const statusLabel = e.status === 'dismissed' ? EXCLUDED_WORD[e.excludedReason ?? 'dismissed'] : meta.label;
  const rb = readbackState(e, now);
  const lock = rowLock(e, canvases, tz);
  const locked = !!lock;
  const approve = completeForApprove(e, pick.taskTypeRequired) && !locked;
  const needsOpp = !hasTarget(e);
  return (
    <PanelShell
      testId="panel-activity"
      from={`Activity log · ${dayLabel(`${e.date}T12:00:00Z`, 'UTC')}`}
      title={e.description || 'Activity row'}
      sub={`${clock(e.start, tz)}–${clock(e.end, tz)} · ${e.durationH} h of your time · an Org62 ${recordTypeName.replace(/s$/, '')} once logged`}
      badge={
        e.canvasDraftId ? (
          <StatusBadge tone="neutral">In a batch: waiting for your Apply</StatusBadge>
        ) : rb ? (
          <StatusBadge tone={rb === 'missing' || rb === 'deleted' ? 'danger' : 'warning'} icon="warning">
            {READBACK_BADGE[rb]}
          </StatusBadge>
        ) : (
          <StatusBadge tone={TONE_TO_BADGE[meta.tone]} dashed={meta.dashed}>
            {statusLabel}
          </StatusBadge>
        )
      }
      footer={
        lock?.kind === 'on_canvas' && lock.canvas ? (
          <>
            <Button variant="primary" size="md" onClick={() => openCanvas(lock.canvas!.draftId)}>
              Review & apply the batch
            </Button>
            <span className="ml-auto text-caption text-muted">Edit or remove the row in the batch review, then Apply.</span>
          </>
        ) : rb === 'missing' || rb === 'deleted' ? (
          <>
            <RelogActions e={e} size="md" now={now} />
            <span className="ml-auto text-caption text-muted">{rb === 'deleted' ? 'Its Org62 Event was deleted there.' : 'Its batch ran, and Org62 has no Event for it.'} Log again puts it in the next batch.</span>
          </>
        ) : approve ? (
          <>
            <Button variant="primary" size="md" onClick={() => save({ status: 'approved' })} data-testid="panel-approve">
              Approve
            </Button>
            <span className="ml-auto text-caption text-muted">It moves to To log ▸ Ready to log. Fields save as you change them.</span>
          </>
        ) : (
          <span className="text-caption text-muted">{locked ? 'Nothing here changes Org62.' : needsOpp ? 'Pick the opportunity (or Internal) above: it saves at once.' : 'Every field saves as you change it. Nothing is written to Org62 from here.'}</span>
        )
      }
    >
      {lock ? <LockNote lock={lock} onOpenCanvas={openCanvas} /> : null}
      {e.suggestion && !locked ? (
        <PanelSection title="Suggested">
          <SuggestionLine e={e} taskTypeRequired={pick.taskTypeRequired} />
          <p className="mt-1.5 text-caption text-muted">{e.suggestion.basis === 'ai' ? 'The cheap model’s judgment from the row’s words, sources and your opportunities. Accept, or pick another below.' : 'From what the app already knows about this row. Accept, or pick another below.'}</p>
        </PanelSection>
      ) : null}
      <PanelSection title={locked ? 'Fields (read only)' : 'Fields'}>
        <div className="grid min-w-0 grid-cols-[8rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 text-body" data-testid="panel-fields">
          <span className="text-caption text-muted">Opportunity</span>
          <span className="min-w-0" data-no-open>
            <OppField e={e} pick={pick} save={save} disabled={locked} />
            {/* D-103 (c): why it logs there, one plain sentence from the facts */}
            {e.groundwork ? (
              <span className="mt-1 block text-caption text-muted" data-testid="row-groundwork" data-code={e.groundwork.code}>
                {e.groundwork.text}
              </span>
            ) : null}
          </span>
          <span className="text-caption text-muted">Task type</span>
          <TaskTypeField e={e} pick={pick} disabled={locked} onSave={(t) => save({ taskType: t })} />
          <span className="text-caption text-muted">Hours</span>
          <span className="w-28">
            <HoursField e={e} disabled={locked} onSave={(h) => save({ durationH: h })} />
          </span>
          <span className="text-caption text-muted">Meeting type</span>
          <MeetingTypeField e={e} disabled={locked} onSave={(m) => save({ meetingType: m })} />
          <span className="text-caption text-muted">Description</span>
          <DescriptionInput e={e} disabled={locked} onSave={(d) => save({ description: d })} />
          <span className="text-caption text-muted">Account</span>
          <span className="min-w-0 break-words text-fg">{e.internal ? 'None: internal work' : (e.accountName ?? '—')}</span>
        </div>
      </PanelSection>
      {e.fromOrg62 ? null : <NoteSection entry={e} locked={locked} />}
      <PanelSection title="How it came in">
        <RowEvidence e={e} tz={tz} />
      </PanelSection>
      <PanelSection title="Where it stands">
        <Facts
          rows={[
            ['Status', e.canvasDraftId ? `${statusLabel} · in a batch waiting for your Apply` : statusLabel],
            ...(lock?.canvas && lock.kind !== 'on_canvas' ? [['Canvas', lock.canvas.title] as [string, string]] : []),
            ...(e.status === 'dismissed' ? [['Why excluded', EXCLUDED_REASON_LABEL[e.excludedReason ?? 'dismissed']] as [string, string]] : []),
            ...(e.fromOrg62 ? [['Org62', 'Read from an Org62 Event: logged, nothing to confirm'] as [string, string]] : e.loggedAt ? [['Logged', `${dayLabel(e.loggedAt, tz)} ${clock(e.loggedAt, tz)}`] as [string, string]] : []),
            ...(e.verifiedAt ? [['Verified', `${dayLabel(e.verifiedAt, tz)} ${clock(e.verifiedAt, tz)}`] as [string, string]] : []),
          ]}
        />
      </PanelSection>
      <WhereItLanded id={e.id} tz={tz} />
    </PanelShell>
  );
}

/**
 * D-70: where the row landed in Org62 and every write that put it there: the canvas that created its Event ("create ·
 * Duration 2 h") and any later one that updated it ("update · Duration 2 h → 3 h"), each with its state and why.
 */
function WhereItLanded({ id, tz }: { id: string; tz?: string }) {
  const q = useApi('getRecordLandings', { query: { kind: 'activity_event', id } }, { staleTime: 30_000 });
  const { open } = useDetails();
  const l = q.data?.landings.find((x) => x.destination === 'org62');
  if (!q.data || !l) return null;
  return (
    <PanelSection title="Where it landed">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-caption">
        <LandingPill dest="org62" landing={l} size="sm" />
        {l.externalId ? <span className="text-muted tabular-nums">{`Event ${l.externalId}`}</span> : null}
      </div>
      <WriteList writes={l.writes} tz={tz} showLabel={false} showCanvas onCanvas={(draftId) => open({ kind: 'draft', id: draftId, label: 'Logging batch' })} empty="Nothing written yet: it goes in your next batch once it is ready." />
    </PanelSection>
  );
}

/** D-66: the note the app drafts at most this long (yours may be longer). */
const NOTE_MAX = 300;
/** Statuses whose note is still yours to change: before the row is on a canvas or in Org62. */
const NOTE_EDITABLE = new Set<ActivityEntry['status']>(['upcoming', 'needs_input', 'proposed', 'approved']);

/**
 * D-66: "Description in Org62": the teammate's note the Event carries (its CC# key follows it there). Editable until
 * the row is handed off; it autosaves (1 s, and on blur), and your edit is locked.
 */
function NoteSection({ entry: e, locked }: { entry: ActivityEntry; locked: boolean }) {
  const editable = NOTE_EDITABLE.has(e.status) && !e.canvasDraftId && !locked;
  const yours = e.userLockedFields.includes('logNote');
  const [text, setText] = useState(e.logNote ?? '');
  const [dirty, setDirty] = useState(false);
  // a newer draft from the app (or Undo) shows when you are not typing
  useEffect(() => {
    if (!dirty) setText(e.logNote ?? '');
  }, [e.logNote, dirty]);
  const save = useOptimisticMutation({
    route: 'patchActivity',
    topics: ['time'],
    optimistic: (input, cache) => cache.patchEntity(e.id, (x) => ({ ...x, ...(input.body?.patch ?? {}), logNoteBasis: null, userLockedFields: [...new Set([...(x as ActivityEntry).userLockedFields, 'logNote'])] })),
    onError: () => {
      setDirty(false);
      setText(e.logNote ?? '');
    },
  });
  const autosave = useAutosave<string>(
    text,
    async (v) => {
      if (!dirty || v === (e.logNote ?? '')) return;
      await save.mutateAsync({ params: { id: e.id }, body: { ifVersion: save.versionOf(e.id) ?? e.version, patch: { logNote: v } } });
      setDirty(false);
    },
    { enabled: editable },
  );
  const basis = yours ? 'Yours: the app never rewrites it' : e.logNoteBasis === 'summary' ? 'Drafted by AI from the meeting notes' : e.logNoteBasis === 'template' ? "Drafted from the row's evidence" : null;
  return (
    <PanelSection title="Description in Org62">
      {editable ? (
        <textarea
          aria-label="Description in Org62"
          data-testid="activity-note"
          rows={4}
          maxLength={1000}
          value={text}
          placeholder="What you did and with whom, the use case, the next step"
          onChange={(ev) => {
            setDirty(true);
            setText(ev.target.value.replace(/\n/g, ' '));
          }}
          onBlur={() => void autosave.flush()}
          className={cn('w-full resize-y rounded-md border bg-surface-input px-2 py-1.5 text-body text-fg', !yours && e.logNoteBasis === 'summary' ? 'border-ai-200' : 'border-line-input')}
        />
      ) : (
        <p className="text-body break-words text-fg">{e.logNote || <span className="text-muted">No note: Org62 gets the CC# key alone.</span>}</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted">
        {basis ? <span className={cn(!yours && e.logNoteBasis === 'summary' && 'text-ai-700')}>{basis}</span> : null}
        {editable ? <span className={cn('tabular-nums', text.length > NOTE_MAX && 'text-warning-700')}>{text.length} / {NOTE_MAX}</span> : null}
        <span>{editable ? 'Logged with its CC# key at the end.' : e.canvasDraftId ? 'Read only here: it is in a batch waiting for your Apply (edit it in the batch review).' : 'Read only: it is in a batch or in Org62 now.'}</span>
        {editable ? <InlineStatus state={autosave.status.state} savedAt={autosave.status.savedAt} error={autosave.status.error} onRetry={() => void autosave.flush()} /> : null}
      </div>
    </PanelSection>
  );
}
