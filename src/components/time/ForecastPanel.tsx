'use client';
/**
 * One Specialist Forecast in the docked details panel (`specialist_forecast`, registered in
 * src/components/shell/detail-renderers.tsx): the record's facts, this week's note (the same editor as the queue),
 * its Deal Role fix, and what a draft reads: the current and last week's notes, the manager's notes, the opp's next
 * step and the meetings since the notes last changed. GET /time/forecast/records/:id; read-only mirror.
 */
import type { ReactNode } from 'react';
import { useApi } from '@/client/hooks';
import { clock, dayLabel } from '@/components/domain/lib/time';
import { PanelError, Skeleton, useTimeZone } from '@/ui';
import { ageLabel, NoteEditor, NotesAgeBadge, OrgLink, RoleFix, stageLabel, usd } from './ForecastParts';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-caption text-muted">{label}</dt>
      <dd className="truncate text-body text-fg">{children}</dd>
    </div>
  );
}

function Block({ title, children, empty }: { title: string; children: ReactNode; empty?: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h3 className="text-caption font-bold text-muted">{title}</h3>
      {children ?? <p className="text-caption text-muted">{empty ?? '—'}</p>}
    </section>
  );
}

export function ForecastPanel({ id }: { id: string }) {
  const q = useApi('getForecastRecord', { params: { id } });
  const view = useApi('getForecast');
  const tz = useTimeZone();
  if (q.isError && !q.data) return <PanelError title="Couldn't load this Specialist Forecast" error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  if (!d) return <Skeleton variant="block" className="m-4 h-64" />;
  const { row, record: r } = d;
  const v = view.data ?? { thresholds: d.thresholds, drafting: { running: [], perDraftUsd: 0.25, dayLeftUsd: 0 }, mode: 'live' as const, due: { label: '' } };
  return (
    <div className="flex min-w-0 flex-col gap-4 p-4" data-testid="forecast-panel">
      <header className="flex min-w-0 flex-col gap-1">
        <h2 className="text-lead font-bold text-fg-heading">{r.opportunityName ?? r.name}</h2>
        <p className="text-caption text-muted">{[r.accountName, r.name, r.fiscalQuarter].filter(Boolean).join(' · ')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <OrgLink url={r.url} label="Open the Specialist Forecast" />
          {d.opportunity?.url ? <OrgLink url={d.opportunity.url} label="Open the opp" /> : null}
        </div>
      </header>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Fact label="Amount">{usd(r.amount)}</Fact>
        <Fact label="Stage">{stageLabel(r.stage)}</Fact>
        <Fact label="Forecast">{r.forecastStatus ?? '—'}</Fact>
        <Fact label="Judgement">{r.judgement ?? '—'}</Fact>
        <Fact label="Close date">{r.closeDate ?? '—'}</Fact>
        <Fact label="Deal role">{r.dealRole ?? 'None'}</Fact>
        <Fact label="Notes changed">{r.notesUpdatedAt ? `${dayLabel(r.notesUpdatedAt, tz)} ${clock(r.notesUpdatedAt, tz)} · ${ageLabel(row)}` : 'not on record'}</Fact>
        <Fact label="Read">{`${dayLabel(r.syncedAt, tz)} ${clock(r.syncedAt, tz)}`}</Fact>
      </dl>
      {row.notesState === 'due' || row.notesState === 'overdue' ? (
        <div>
          <NotesAgeBadge row={row} dueLabel={view.data?.due.label ?? ''} />
        </div>
      ) : null}
      <Block title="This week's note">
        <NoteEditor row={row} view={v} />
      </Block>
      {row.roleFix || row.role.state !== 'none' ? (
        <Block title="Deal Role">
          <RoleFix row={row} />
        </Block>
      ) : null}
      <Block title="Current note" empty="No notes yet">
        {r.notes ? <p className="text-body whitespace-pre-wrap text-fg">{r.notes}</p> : null}
      </Block>
      <Block title="Last week's note" empty="Not seen yet: the mirror keeps the note before each change it reads">
        {r.prevNotes ? <p className="text-body whitespace-pre-wrap text-muted">{r.prevNotes}</p> : null}
      </Block>
      <Block title="Manager notes" empty="None">
        {r.mgrNotes ? <p className="text-body whitespace-pre-wrap text-muted">{r.mgrNotes}</p> : null}
      </Block>
      <Block title="Opportunity next step" empty="None">
        {r.oppNextStep ?? d.opportunity?.nextStep ? <p className="text-body text-muted">{r.oppNextStep ?? d.opportunity?.nextStep}</p> : null}
      </Block>
      <Block title="Meetings since the notes changed" empty="None in the app">
        {d.meetingsSince.length ? (
          <ul className="flex flex-col gap-0.5">
            {d.meetingsSince.map((m) => (
              <li key={m.id} className="truncate text-caption text-muted">
                <span className="tabular-nums">{`${dayLabel(m.start, tz)} `}</span>
                {m.title}
              </li>
            ))}
          </ul>
        ) : null}
      </Block>
    </div>
  );
}
