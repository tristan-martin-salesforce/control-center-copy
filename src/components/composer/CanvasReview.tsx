'use client';
/**
 * The logging canvas review before Apply (2026-11-13 audit B2): every row Slackbot will write, by kind, read from the
 * work order itself (GET /drafts/:id/canvas-review). Events, Deal contributions, VDP use cases and updates, each with
 * its count and the fields Slackbot sets; one search over all of them. Remove takes a row off the canvas (it goes back
 * to waiting); Edit changes the fields the app owns, kept on the row's record. Both are one undoable change (the toast's
 * Undo), and both change the item's version, so Apply previews and confirms the canvas as it is now.
 *
 * Wide (the panel at full width) the rows are tables; narrow (the dock, ~560 px) each row is a card. Text is rendered as
 * text (React escapes it). Color is state only: neutral rows, the AI color nowhere here (these are your rows).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import type { CanvasReview as Review, CanvasReviewDc, CanvasReviewEvent, CanvasReviewUpdate, CanvasReviewUseCase, Draft, EditCanvasRowRequest } from '@/contract';
import { api, ApiError, queryKey } from '@/client/api';
import { useApi } from '@/client/hooks';
import { toast } from '@/client/toast';
import { usePromptWording } from '@/components/domain/ResultLinks';
import { Button, Icon, IconButton, Overlay, Skeleton, useTimeZone } from '@/ui';
import { fieldDef } from '@/lib/landings/fields';
import { cx } from './_bits';

/** A use case's Org62 field in plain words (src/lib/landings/fields.ts: "Name", "Agent type"), never its API name. */
const ucLabel = (field: string) => fieldDef('use_case', 'org62', field).label;

const FIELD = 'h-8 w-full min-w-0 rounded-md border border-line-input bg-surface-input px-2 text-body text-fg hover:border-line-strong focus:border-accent focus:outline-none';
const AREA = 'min-h-20 w-full min-w-0 rounded-md border border-line-input bg-surface-input px-2 py-1.5 text-body text-fg hover:border-line-strong focus:border-accent focus:outline-none';
// Rows become table rows from a 52rem-wide review container (`@min-[52rem]/review:`, written out in full where used:
// Tailwind only sees class names that appear whole in the source).

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Bytes in decimal KB, as the cap is set (900,000 bytes = 900 KB; Slack's limit is 1 MiB). */
const kb = (b: number) => (b < 1000 ? `${b} B` : `${Math.round(b / 100) / 10} KB`);

function whenOf(startUtc: string, endUtc: string, tz: string | undefined): string {
  const s = new Date(startUtc);
  const e = new Date(endUtc);
  if (!Number.isFinite(s.getTime())) return startUtc;
  const day = s.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
  const t = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  return `${day} · ${t(s)}–${Number.isFinite(e.getTime()) ? t(e) : ''}`;
}

/** A long cell: two lines, then "More" opens the rest in place. */
function Long({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return <span className="text-faint">(empty)</span>;
  const long = text.length > 160 || text.includes('\n');
  return (
    <span className="block min-w-0">
      <span className={cx('block whitespace-pre-wrap break-words', !open && long ? 'line-clamp-2' : '')}>{text}</span>
      {long ? (
        <button type="button" className="text-caption font-bold text-muted hover:text-fg hover:underline" aria-expanded={open} aria-label={`${open ? 'Less' : 'More'} of ${label}`} onClick={() => setOpen((x) => !x)}>
          {open ? 'Less' : 'More'}
        </button>
      ) : null}
    </span>
  );
}

interface Col<R> {
  label: string;
  /** Grid track at wide widths. */
  track: string;
  cell: (r: R) => ReactNode;
  /** The row's title on a card (narrow). */
  title?: boolean;
}

/** One kind's rows: a table when wide, cards when narrow (CSS container query; the same DOM). */
function Rows<R extends { key: string }>({ kind, cols, rows, actions, editing, editor }: { kind: string; cols: Col<R>[]; rows: R[]; actions: (r: R) => ReactNode; editing: string | null; editor: (r: R) => ReactNode }) {
  // a fixed actions track, so the header and every row share the same columns
  const tracks = `${cols.map((c) => c.track).join(' ')} 9.5rem`;
  return (
    <div role="table" aria-label={kind} className="min-w-0 rounded-md border border-line">
      <div role="row" className={cx('hidden gap-x-3 border-b border-line bg-surface-muted px-3 py-1.5 text-caption font-bold text-muted', '@min-[52rem]/review:grid')} style={{ gridTemplateColumns: tracks }}>
        {cols.map((c) => (
          <span role="columnheader" key={c.label}>
            {c.label}
          </span>
        ))}
        <span role="columnheader" className="sr-only">
          Actions
        </span>
      </div>
      {rows.map((r) => (
        <div key={r.key} data-review-row={r.key} className="border-b border-line last:border-b-0">
          <div role="row" className={cx('grid grid-cols-1 gap-x-3 gap-y-1 px-3 py-2 text-body', '@min-[52rem]/review:[grid-template-columns:var(--tracks)] @min-[52rem]/review:items-start')} style={{ ['--tracks' as string]: tracks }}>
            {cols.map((c) => (
              <div role="cell" key={c.label} className={cx('min-w-0 [overflow-wrap:anywhere]', c.title ? 'font-bold text-fg' : 'text-fg', '@min-[52rem]/review:font-normal')}>
                {!c.title ? <span className={cx('mr-1.5 text-caption text-muted', '@min-[52rem]/review:hidden')}>{c.label}</span> : null}
                {c.cell(r)}
              </div>
            ))}
            <div role="cell" className={cx('flex flex-wrap items-center gap-1 pt-1', '@min-[52rem]/review:justify-end @min-[52rem]/review:pt-0')}>
              {actions(r)}
            </div>
          </div>
          {editing === r.key ? <div className="border-t border-line bg-surface-muted px-3 py-3">{editor(r)}</div> : null}
        </div>
      ))}
    </div>
  );
}

function Section({ title, count, sub, children, testId }: { title: string; count: number; sub?: string; children: ReactNode; testId: string }) {
  if (!count) return null;
  return (
    <section className="space-y-2" data-testid={testId}>
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-body font-bold text-fg-heading">
        {title}
        <span className="text-caption font-normal text-muted tabular-nums">
          {count}
          {sub ? ` · ${sub}` : ''}
        </span>
      </h3>
      {children}
    </section>
  );
}

const matches = (q: string, ...vals: Array<string | number | null | undefined | string[]>) => {
  if (!q) return true;
  const hay = vals.flat().filter((v) => v !== null && v !== undefined).join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
};

export function CanvasReview({ draft }: { draft: Pick<Draft, 'id' | 'version'> }) {
  const q = useApi('getCanvasReview', { params: { id: draft.id } });
  const [wide, setWide] = useState(false);
  if (q.isLoading) return <Skeleton variant="block" className="h-40 w-full" />;
  if (q.error || !q.data) return <p className="text-caption text-danger-700">{`Couldn't read the canvas rows: ${q.error?.message ?? 'nothing came back'}`}</p>;
  return (
    <>
      <ReviewBody review={q.data} onWide={() => setWide(true)} />
      {/* the same review at full width: tables, for a big batch (the dock is ~520 px: cards) */}
      <Overlay open={wide} onClose={() => setWide(false)} labelledBy="cc-canvas-review-title" className="w-[min(96rem,96vw)]">
        <div className="flex h-14 items-center gap-3 border-b border-line px-5">
          <h2 id="cc-canvas-review-title" className="min-w-0 truncate text-title text-fg-heading">
            {q.data.title}
          </h2>
          <IconButton icon="close" label="Close" size="sm" className="ml-auto" onClick={() => setWide(false)} data-autofocus />
        </div>
        <div className="cc-scroll max-h-[calc(88vh-3.5rem)] overflow-y-auto px-5 py-4">{wide ? <ReviewBody review={q.data} /> : null}</div>
      </Overlay>
    </>
  );
}

function ReviewBody({ review, onWide }: { review: Review; onWide?: () => void }) {
  const qc = useQueryClient();
  const tz = useTimeZone();
  const wording = usePromptWording();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const id = review.draftId;

  const after = (r: { entity: Review; auditId: string | null }, title: string, body: string) => {
    qc.setQueryData(queryKey('getCanvasReview', { params: { id } }), r.entity);
    void qc.invalidateQueries({ queryKey: queryKey('getDraft', { params: { id } }) });
    void qc.invalidateQueries({ queryKey: ['time'] });
    void qc.invalidateQueries({ queryKey: ['deals'] });
    toast({ key: `canvas-review:${id}`, title, body, ...(r.auditId ? { undo: { auditId: r.auditId } } : {}) });
  };
  const fail = (title: string, err: unknown) => {
    toast({ key: `canvas-review:${id}`, tone: 'error', title, body: err instanceof Error ? err.message : undefined, durationMs: null });
    if (err instanceof ApiError && err.code === 'conflict') void qc.invalidateQueries({ queryKey: queryKey('getCanvasReview', { params: { id } }) });
  };

  const remove = async (key: string, what: string, back: string) => {
    setBusy(key);
    try {
      const r = await api('removeCanvasRows', { params: { id }, body: { ifVersion: review.version, keys: [key] } });
      after(r, `Removed from this canvas: ${what}`, back);
      if (editing === key) setEditing(null);
    } catch (err) {
      fail("Couldn't remove the row", err);
    } finally {
      setBusy(null);
    }
  };
  const save = async (key: string, body: Omit<EditCanvasRowRequest, 'ifVersion' | 'key'>, what: string) => {
    setBusy(key);
    try {
      const r = await api('editCanvasRow', { params: { id }, body: { ifVersion: review.version, key, ...body } as EditCanvasRowRequest });
      after(r, `Edited: ${what}`, 'Kept on its record; the canvas shows it now. Apply previews the canvas as it is.');
      setEditing(null);
    } catch (err) {
      fail("Couldn't save the edit", err);
    } finally {
      setBusy(null);
    }
  };

  const ev = review.events.filter((e) => matches(search, e.subject, e.taskType, e.oppName, e.accountName, e.whatId, e.note, e.meetingType, whenOf(e.startUtc, e.endUtc, tz)));
  const dcs = review.dcs.filter((d) => matches(search, d.oppName, d.role, d.comment, d.recordId, String(d.split)));
  const ucs = review.useCases.filter((u) => matches(search, u.name, u.oppName, u.opportunityId, u.product, u.agentTypes, u.entitlement, u.stage, u.goLive, u.businessProblem, u.kpis, u.notes));
  const ups = review.updates.filter((u) => matches(search, u.object, u.recordId, u.field, u.newValue, u.currentValue, u.why));
  const fc = review.forecast.filter((f) => matches(search, f.recordId, f.notes, f.dealRole));
  const shown = ev.length + dcs.length + ucs.length + ups.length + fc.length;
  const total = review.events.length + review.dcs.length + review.useCases.length + review.updates.length + review.forecast.length;
  const can = review.editable;

  const actions = (key: string, what: string, back: string, editable = true) =>
    can ? (
      <>
        {editable ? (
          <Button size="xs" variant="ghost" icon="edit" disabled={!!busy} aria-expanded={editing === key} onClick={() => setEditing(editing === key ? null : key)} data-action="edit-row">
            Edit
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" icon="close" loading={busy === key} disabled={!!busy && busy !== key} onClick={() => void remove(key, what, back)} title={`Take it off this canvas: ${back}`} data-action="remove-row">
          Remove
        </Button>
      </>
    ) : null;

  return (
    <div className="@container/review min-w-0 space-y-4" data-testid="canvas-review" data-version={review.version}>
      <div className="space-y-2">
        <p className="min-w-0 text-body text-fg" data-testid="canvas-review-summary">
          <span className="font-bold">Slackbot will write:</span>{' '}
          {[review.counts.events ? `${plural(review.counts.events, 'Event')} · ${review.counts.hours} h` : null, review.counts.dcs ? plural(review.counts.dcs, 'Deal Contribution') : null, review.useCases.length ? plural(review.useCases.length, 'VDP use case') : null, review.updates.length ? plural(review.updates.length, 'update') : null, review.counts.forecast ? plural(review.counts.forecast, 'forecast row') : null].filter(Boolean).join(' · ')}
          <span className="ml-2 text-caption text-muted tabular-nums" title="Slack takes up to 1 MiB of markdown per canvas; the app stops at 900 KB for a margin, and only past it splits a batch into parts">
            {kb(review.bytes)} of {kb(review.maxBytes)}
          </span>
        </p>
        <div className="flex items-center gap-2">
          <label className="relative min-w-0 flex-1 @min-[52rem]/review:max-w-96">
            <span className="sr-only">Search the rows</span>
            <Icon name="search" size="sm" className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted" />
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the rows" className={cx(FIELD, 'pl-7')} data-testid="canvas-review-search" />
          </label>
          {onWide ? (
            <Button size="xs" variant="ghost" icon="expand_alt" onClick={onWide} data-action="review-wide" title="See every row as tables, at full width">
              Open wide
            </Button>
          ) : null}
        </div>
      </div>
      {!can && review.readOnlyWhy ? <p className="text-caption text-muted">{`Read only: ${review.readOnlyWhy}.`}</p> : null}
      {search && shown < total ? <p className="text-caption text-muted" aria-live="polite">{`${shown} of ${total} rows match`}</p> : null}

      <Section title="Events" count={ev.length} sub={`${Math.round(ev.reduce((s, e) => s + e.hours, 0) * 100) / 100} h`} testId="review-events">
        <Rows<CanvasReviewEvent>
          kind="Events"
          rows={ev}
          editing={editing}
          cols={[
            { label: 'Subject', track: 'minmax(10rem,1.3fr)', title: true, cell: (e) => e.subject },
            { label: 'When', track: '9.5rem', cell: (e) => <span className="tabular-nums">{whenOf(e.startUtc, e.endUtc, tz)}</span> },
            { label: 'Task type', track: '8rem', cell: (e) => e.taskType || <span className="text-faint">(none)</span> },
            { label: 'Hours', track: '3.5rem', cell: (e) => <span className="tabular-nums">{e.hours}</span> },
            { label: 'Opportunity', track: 'minmax(8rem,1fr)', cell: (e) => (e.whatId ? <span title={e.whatId}>{e.oppName ?? e.whatId}{e.accountName ? <span className="block text-caption text-muted">{e.accountName}</span> : null}</span> : <span className="text-muted">Internal (Related To empty)</span>) },
            { label: 'Meeting type', track: '7rem', cell: (e) => e.meetingType || <span className="text-faint">—</span> },
            { label: 'Description', track: 'minmax(12rem,2fr)', cell: (e) => <Long text={e.note} label={`the description of ${e.subject}`} /> },
          ]}
          actions={(e) => actions(e.key, e.subject, 'it stays approved and goes on your next canvas', !!e.entry)}
          editor={(e) => <EventEditor e={e} taskTypes={wording.taskTypes} taskTypeRequired={wording.taskType} busy={busy === e.key} onCancel={() => setEditing(null)} onSave={(b) => void save(e.key, { event: b }, e.subject)} />}
        />
      </Section>

      <Section title="Deal contributions" count={dcs.length} testId="review-dcs">
        <Rows<CanvasReviewDc>
          kind="Deal contributions"
          rows={dcs}
          editing={editing}
          cols={[
            { label: 'Opportunity', track: 'minmax(10rem,1.3fr)', title: true, cell: (d) => d.oppName },
            { label: 'Kind', track: '6rem', cell: (d) => (d.kind === 'add' ? 'New DC' : 'Change') },
            { label: 'Role', track: '9rem', cell: (d) => d.role },
            { label: 'Split', track: '5rem', cell: (d) => <span className="tabular-nums">{d.kind === 'change' && d.fromSplit !== null ? `${d.fromSplit}% → ${d.split}%` : `${d.split}%`}</span> },
            { label: 'Comment', track: 'minmax(12rem,2fr)', cell: (d) => <Long text={d.comment} label={`the comment on ${d.oppName}`} /> },
          ]}
          actions={(d) => actions(d.key, `the DC on ${d.oppName}`, 'the request waits for your next canvas', !!d.requestId)}
          editor={(d) => <DcEditor d={d} busy={busy === d.key} onCancel={() => setEditing(null)} onSave={(b) => void save(d.key, { dc: b }, `the DC on ${d.oppName}`)} />}
        />
      </Section>

      <Section title="VDP use cases" count={ucs.length} testId="review-use-cases">
        <Rows<CanvasReviewUseCase>
          kind="VDP use cases"
          rows={ucs}
          editing={editing}
          cols={[
            { label: 'Name', track: 'minmax(10rem,1.2fr)', title: true, cell: (u) => u.name },
            { label: 'Opportunity', track: 'minmax(8rem,1fr)', cell: (u) => <span title={u.opportunityId}>{u.oppName ?? u.opportunityId}</span> },
            { label: 'Product', track: '6.5rem', cell: (u) => u.product },
            { label: 'Stage', track: '8rem', cell: (u) => u.stage || <span className="text-faint">(none)</span> },
            { label: 'Go-live', track: '6rem', cell: (u) => <span className="tabular-nums">{u.goLive || '—'}</span> },
            {
              label: 'Details',
              track: 'minmax(12rem,2fr)',
              cell: (u) => (
                <details className="min-w-0 text-body">
                  <summary className="cursor-pointer text-caption font-bold text-muted hover:text-fg">{`${u.agentTypes.join('; ') || 'No type'} · ${u.entitlement}`}</summary>
                  <dl className="mt-1 space-y-1.5">
                    <dt className="text-caption text-muted">Business problem</dt>
                    <dd><Long text={u.businessProblem} label="the business problem" /></dd>
                    <dt className="text-caption text-muted">KPIs</dt>
                    <dd><Long text={u.kpis} label="the KPIs" /></dd>
                    <dt className="text-caption text-muted">Notes</dt>
                    <dd><Long text={u.notes} label="the notes" /></dd>
                    <dd className="text-caption break-words text-muted">{u.source}</dd>
                  </dl>
                </details>
              ),
            },
          ]}
          actions={(u) => actions(u.key, u.name, 'it waits for your next canvas')}
          editor={(u) => <UseCaseEditor u={u} options={review.options} busy={busy === u.key} onCancel={() => setEditing(null)} onSave={(b) => void save(u.key, { useCase: b }, `the use case ${u.name}`)} />}
        />
      </Section>

      <Section title="Updates" count={ups.length} testId="review-updates">
        <Rows<CanvasReviewUpdate>
          kind="Updates"
          rows={ups}
          editing={editing}
          cols={[
            { label: 'Record', track: 'minmax(9rem,1fr)', title: true, cell: (u) => <span className="break-all">{`${u.object} ${u.recordId}`}</span> },
            { label: 'Field', track: '9rem', cell: (u) => u.field },
            { label: 'Old → new', track: 'minmax(9rem,1fr)', cell: (u) => <span className="tabular-nums">{`${u.currentValue || '(blank)'} → ${u.newValue}`}</span> },
            { label: 'Why', track: 'minmax(12rem,2fr)', cell: (u) => <Long text={u.why} label={`why ${u.field} changes`} /> },
          ]}
          actions={(u) => actions(u.key, `${u.field} on ${u.recordId}`, 'it waits for your next canvas', u.editable)}
          editor={(u) => <UpdateEditor u={u} stages={review.options.ucStages} busy={busy === u.key} onCancel={() => setEditing(null)} onSave={(v) => void save(u.key, { update: { newValue: v } }, `${u.field} on ${u.recordId}`)} />}
        />
      </Section>

      <Section title="Forecast rows" count={fc.length} testId="review-forecast">
        <Rows
          kind="Forecast rows"
          rows={fc}
          editing={null}
          cols={[
            { label: 'Record', track: 'minmax(9rem,1fr)', title: true, cell: (f) => f.recordId },
            { label: 'Deal role', track: '8rem', cell: (f) => f.dealRole || <span className="text-faint">(unchanged)</span> },
            { label: 'Forecast notes', track: 'minmax(14rem,3fr)', cell: (f) => <Long text={f.notes} label="the forecast notes" /> },
          ]}
          actions={() => null}
          editor={() => null}
        />
      </Section>
      {search && !shown ? <p className="text-body text-muted">No row matches “{search}”.</p> : null}
    </div>
  );
}

// ------------------------------------------------------------------ editors (the fields the app owns)

function EditorShell({ children, busy, onCancel, onSave, hint }: { children: ReactNode; busy: boolean; onCancel: () => void; onSave: () => void; hint?: string }) {
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="grid grid-cols-1 gap-3 @min-[36rem]/review:grid-cols-2">{children}</div>
      {hint ? <p className="text-caption text-muted">{hint}</p> : null}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" type="submit" loading={busy}>
          Save
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={cx('block min-w-0 space-y-1', wide ? '@min-[36rem]/review:col-span-2' : '')}>
      <span className="block text-caption font-bold text-muted">{label}</span>
      {children}
    </label>
  );
}

function EventEditor({ e, taskTypes, taskTypeRequired, busy, onCancel, onSave }: { e: CanvasReviewEvent; taskTypes: string[]; taskTypeRequired: boolean; busy: boolean; onCancel: () => void; onSave: (b: NonNullable<EditCanvasRowRequest['event']>) => void }) {
  const [taskType, setTaskType] = useState(e.taskType);
  const [hours, setHours] = useState(String(e.hours));
  const [oppId, setOppId] = useState(e.entry?.oppId ?? '');
  const [note, setNote] = useState(e.note);
  const opps = useApi('getOppOptions', { query: { entryId: e.entryId ?? undefined } }, { enabled: !!e.entryId, staleTime: 60_000 });
  const list = useMemo(() => (opps.data?.opps ?? []).filter((o) => o.isOpen || o.id === e.entry?.oppId), [opps.data, e.entry?.oppId]);
  return (
    <EditorShell
      busy={busy}
      onCancel={onCancel}
      hint="Subject and times stay the meeting's. The meeting type follows the task type (Workshop → Data Cloud Workshop, POC → Proof of Concept). The edit is kept on the Time row."
      onSave={() =>
        onSave({
          entryVersion: e.entry!.version,
          ...(taskType !== e.taskType ? { taskType } : {}),
          ...(Number(hours) !== e.hours ? { durationH: Number(hours) } : {}),
          ...(oppId && oppId !== e.entry?.oppId ? { oppId } : {}),
          ...(note !== e.note ? { note } : {}),
        })
      }
    >
      {taskTypeRequired ? (
        <Field label="Task type">
          <select className={FIELD} value={taskType} onChange={(x) => setTaskType(x.target.value)}>
            {[...new Set([e.taskType, ...taskTypes].filter(Boolean))].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label="Hours (0.25 steps)">
        <input className={FIELD} type="number" min={0.25} max={24} step={0.25} value={hours} onChange={(x) => setHours(x.target.value)} />
      </Field>
      {e.whatId ? (
        <Field label="Opportunity (WhatId)" wide>
          <select className={FIELD} value={oppId} onChange={(x) => setOppId(x.target.value)} disabled={opps.isLoading}>
            {e.entry?.oppId ? null : <option value="">Choose an opportunity…</option>}
            {list.map((o) => (
              <option key={o.id} value={o.id}>
                {`${o.name}${o.accountName ? ` · ${o.accountName}` : ''}`}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <Field label={`Description in Org62 (${note.length}/1000; the CC# key follows it)`} wide>
        <textarea className={AREA} maxLength={1000} value={note} onChange={(x) => setNote(x.target.value)} />
      </Field>
    </EditorShell>
  );
}

function DcEditor({ d, busy, onCancel, onSave }: { d: CanvasReviewDc; busy: boolean; onCancel: () => void; onSave: (b: NonNullable<EditCanvasRowRequest['dc']>) => void }) {
  const [split, setSplit] = useState(String(d.split));
  const [role, setRole] = useState(d.role);
  const [comment, setComment] = useState(d.comment);
  return (
    <EditorShell busy={busy} onCancel={onCancel} hint="Kept on the DC request (Deals ▸ DCs shows it the same)." onSave={() => onSave({ ...(Number(split) !== d.split ? { split: Number(split) } : {}), ...(role !== d.role ? { role } : {}), ...(comment !== d.comment ? { comment } : {}) })}>
      <Field label="Split %">
        <input className={FIELD} type="number" min={1} max={100} step={1} value={split} onChange={(x) => setSplit(x.target.value)} />
      </Field>
      <Field label="Role on the opportunity">
        <input className={FIELD} value={role} maxLength={80} onChange={(x) => setRole(x.target.value)} />
      </Field>
      <Field label="Comment" wide>
        <textarea className={AREA} maxLength={1000} value={comment} onChange={(x) => setComment(x.target.value)} />
      </Field>
    </EditorShell>
  );
}

function UseCaseEditor({ u, options, busy, onCancel, onSave }: { u: CanvasReviewUseCase; options: Review['options']; busy: boolean; onCancel: () => void; onSave: (b: NonNullable<EditCanvasRowRequest['useCase']>) => void }) {
  const [v, setV] = useState({ name: u.name, product: u.product, entitlement: u.entitlement, stage: u.stage, goLive: u.goLive, businessProblem: u.businessProblem, kpis: u.kpis, notes: u.notes });
  const [types, setTypes] = useState<string[]>(u.agentTypes);
  const set = (k: keyof typeof v) => (x: { target: { value: string } }) => setV((s) => ({ ...s, [k]: x.target.value }));
  const changed = Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== (u as unknown as Record<string, string>)[k]));
  const typesChanged = types.join(';') !== u.agentTypes.join(';');
  const pick = (vals: readonly string[], cur: string) => [...new Set([cur, ...vals].filter(Boolean))];
  return (
    <EditorShell busy={busy} onCancel={onCancel} hint="Org62's values only. Kept for this use case, so the next canvas has it too; Notes keeps its source line and CC-UC# key last." onSave={() => onSave({ ...changed, ...(typesChanged ? { agentTypes: types } : {}) })}>
      <Field label={ucLabel('Use_Case_Name__c')} wide>
        <input className={FIELD} maxLength={255} value={v.name} onChange={set('name')} />
      </Field>
      <Field label={ucLabel('Product__c')}>
        <select className={FIELD} value={v.product} onChange={set('product')}>
          {pick(options.ucProducts, v.product).map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </Field>
      <Field label={ucLabel('Entitlement_Leveraged__c')}>
        <select className={FIELD} value={v.entitlement} onChange={set('entitlement')}>
          {pick(options.ucEntitlements, v.entitlement).map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </Field>
      <Field label={ucLabel('Stage__c')}>
        <select className={FIELD} value={v.stage} onChange={set('stage')}>
          <option value="">(not set)</option>
          {options.ucStages.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </Field>
      <Field label={ucLabel('Go_Live_Date__c')}>
        <input className={FIELD} type="date" value={v.goLive} onChange={set('goLive')} />
      </Field>
      <fieldset className="min-w-0 space-y-1 @min-[36rem]/review:col-span-2">
        <legend className="text-caption font-bold text-muted">{ucLabel('Use_Case_Agent_Type__c')}</legend>
        <div className="flex max-h-32 flex-wrap gap-x-3 gap-y-1 overflow-y-auto">
          {options.ucAgentTypes.map((t) => (
            <label key={t} className="inline-flex items-center gap-1.5 text-body">
              <input type="checkbox" checked={types.includes(t)} onChange={(x) => setTypes((s) => (x.target.checked ? [...s, t] : s.filter((y) => y !== t)))} />
              {t}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label={ucLabel('Business_Problem_Solved__c')} wide>
        <textarea className={AREA} maxLength={32_768} value={v.businessProblem} onChange={set('businessProblem')} />
      </Field>
      <Field label={ucLabel('Business_Problem_KPIs__c')} wide>
        <textarea className={AREA} maxLength={32_768} value={v.kpis} onChange={set('kpis')} />
      </Field>
      <Field label={ucLabel('Notes__c')} wide>
        <textarea className={AREA} maxLength={32_000} value={v.notes} onChange={set('notes')} />
      </Field>
    </EditorShell>
  );
}

function UpdateEditor({ u, stages, busy, onCancel, onSave }: { u: CanvasReviewUpdate; stages: string[]; busy: boolean; onCancel: () => void; onSave: (v: string) => void }) {
  const [v, setV] = useState(u.newValue);
  return (
    <EditorShell busy={busy} onCancel={onCancel} onSave={() => onSave(v)} hint="Kept for this record and field, so the next canvas has it too.">
      <Field label={`${ucLabel(u.field)}: new value`}>
        {u.field === 'Stage__c' ? (
          <select className={FIELD} value={v} onChange={(x) => setV(x.target.value)}>
            {stages.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        ) : u.field === 'Go_Live_Date__c' ? (
          <input className={FIELD} type="date" value={v} onChange={(x) => setV(x.target.value)} />
        ) : (
          <input className={FIELD} type="number" min={0.25} max={24} step={0.25} value={v} onChange={(x) => setV(x.target.value)} />
        )}
      </Field>
    </EditorShell>
  );
}
