'use client';
/**
 * Right pane: the agent's plan as a diff (pattern 8). "+2 added · 1 moved · 1 deferred", Accept all (⇧A)
 * and Undo per row. Nothing applies until you accept; before that, Undo takes a change out of the plan
 * (struck through, Redo puts it back). After Accept all, Undo reverts that one change (proposal and
 * re-order through their audit entries; slot changes in the local plan).
 * Below it: a small "Since you left" summary that expands into the digest in place.
 * Below a 1,600 px main container the pane collapses to a vertical tab (click or `p`).
 */
import { forwardRef, useState } from 'react';
import type { SinceEntry } from '@/contract';
import { Button, EmptyState, KbdHint, PanelError, Skeleton } from '@/ui';
import { useToday } from './ctx';
import type { PlanChange, PlanSummary } from './plan';
import { hhmm, minuteOfDay } from './time';
import { useSheetQuery } from './useSheetQuery';

const MARK: Record<PlanChange['kind'], { glyph: string; label: string }> = {
  added: { glyph: '+', label: 'Added' },
  moved: { glyph: '→', label: 'Moved' },
  updated: { glyph: '~', label: 'Updated' },
  deferred: { glyph: '↓', label: 'Deferred' },
  rerank: { glyph: '⇅', label: 'Re-order' },
};

export interface AgentPlanProps {
  changes: PlanChange[];
  summary: PlanSummary;
  excluded: ReadonlySet<string>;
  acceptedAt: string | null;
  proposedAt: string;
  accepting: boolean;
  onAcceptAll: () => void;
  onToggle: (c: PlanChange) => void;
  onOpen: (c: PlanChange) => void;
  hlItemId: string | null;
  onHover: (itemId: string | null) => void;
  since: { changed: number; closed: number; new: number } | null;
  onAskAssistant: () => void;
  state: 'ready' | 'empty' | 'loading' | 'error';
  onRetry: () => void;
}

const SINCE_GROUPS: Array<{ kinds: SinceEntry['kind'][]; label: string }> = [
  { kinds: ['waiting', 'failed'], label: 'Needs you' },
  { kinds: ['reopened'], label: 'Reopened' },
  { kinds: ['closed'], label: 'Closed for you' },
  { kinds: ['new'], label: 'New' },
  { kinds: ['changed'], label: 'Changed' },
  { kinds: ['brief'], label: 'Briefs' },
];

/** Entries per digest group before "Show all N" (caps audit F-13: every entry is one click away). */
const SINCE_FIRST = 8;

export function SinceGroup({ label, entries }: { label: string; entries: SinceEntry[] }) {
  const ctx = useToday();
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, SINCE_FIRST);
  return (
    <section aria-label={label}>
      <h4 className="text-caption font-bold text-muted">
        {label} · {entries.length}
      </h4>
      <ul className="mt-1">
        {shown.map((e, i) => (
          <li key={`${e.at}${i}`} className="flex items-start gap-2 py-1">
            <span className="w-11 shrink-0 text-caption text-faint tabular-nums">{hhmm(minuteOfDay(e.at, ctx.tz))}</span>
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-caption text-fg hover:text-link hover:underline"
              title={e.title}
              onClick={() => ctx.openDetails({ kind: e.ref.type, id: e.ref.id, label: e.title })}
            >
              {e.title}
            </button>
            {e.auditId ? (
              <button type="button" className="shrink-0 text-caption font-bold text-link hover:underline" onClick={() => ctx.actions.undoAudit(e.auditId!, e.title)}>
                Undo
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {entries.length > SINCE_FIRST ? (
        <button type="button" className="mt-0.5 text-caption font-bold text-link hover:underline" onClick={() => setAll((v) => !v)} data-since-all>
          {all ? 'Show fewer' : `Show all ${entries.length}`}
        </button>
      ) : null}
    </section>
  );
}

function SinceDigest() {
  const q = useSheetQuery('getSince');
  if (q.isLoading) return <Skeleton count={5} className="mt-3" />;
  if (q.error || !q.data) return <PanelError title="The digest didn’t load" error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  if (!d.entries.length) return <EmptyState size="inline" title="Nothing changed while you were away." />;
  return (
    <div className="mt-3 space-y-3" data-since-digest>
      {SINCE_GROUPS.map((g) => {
        const entries = d.entries.filter((e) => g.kinds.includes(e.kind));
        if (!entries.length) return null;
        return <SinceGroup key={g.label} label={g.label} entries={entries} />;
      })}
    </div>
  );
}

export const AgentPlan = forwardRef<HTMLDivElement, AgentPlanProps>(function AgentPlan(p, scrollRef) {
  const ctx = useToday();
  const [digest, setDigest] = useState(false);
  const live = p.changes.filter((c) => !p.excluded.has(c.id));
  const accepted = !!p.acceptedAt;
  const s = p.summary;
  return (
    <aside className="td-pane td-plan" id="today-plan" aria-label="Agent's plan" data-today-plan>
      <div className="td-pane-head">
        <h2>
          <span className="text-ai-700">✦</span> Agent’s plan
        </h2>
        <div className="td-actions">
          <Button size="sm" variant="secondary" kbd="shift+a" disabled={accepted || !live.length || p.accepting} loading={p.accepting} onClick={p.onAcceptAll} data-accept-all>
            {accepted ? 'Accepted' : 'Accept all'}
          </Button>
        </div>
      </div>
      <p className="px-5 text-caption text-muted" data-plan-status>
        {accepted ? `Accepted ${hhmm(minuteOfDay(p.acceptedAt!, ctx.tz))} · Undo any change below` : `Proposed ${hhmm(minuteOfDay(p.proposedAt, ctx.tz))} for today · nothing applied yet`}
      </p>
      {p.changes.length ? (
        <div className="flex flex-wrap gap-x-[18px] gap-y-1.5 px-5 pt-3 pb-2 text-muted" data-plan-summary>
          {s.added ? (
            <span>
              <b className="text-body-lg text-fg-heading">+{s.added}</b> added
            </span>
          ) : null}
          {s.moved ? (
            <span>
              <b className="text-body-lg text-fg-heading">{s.moved}</b> moved
            </span>
          ) : null}
          {s.updated ? (
            <span>
              <b className="text-body-lg text-fg-heading">{s.updated}</b> updated
            </span>
          ) : null}
          {s.deferred ? (
            <span>
              <b className="text-body-lg text-fg-heading">{s.deferred}</b> deferred
            </span>
          ) : null}
          {s.rerank ? (
            <span>
              <b className="text-body-lg text-fg-heading">1</b> re-order
            </span>
          ) : null}
          {!s.added && !s.moved && !s.updated && !s.deferred && !s.rerank ? <span>Every change is taken out.</span> : null}
        </div>
      ) : null}
      <div className="td-scroll cc-scroll" ref={scrollRef}>
        {p.state === 'error' ? (
          <PanelError title="The plan didn’t load" error={new Error('Forced error (dev toolbar)')} onRetry={p.onRetry} />
        ) : p.state === 'loading' ? (
          <Skeleton count={5} className="mt-2" />
        ) : !p.changes.length || p.state === 'empty' ? (
          <p className="border-t border-line py-3 text-caption text-muted">No changes proposed. The day already fits as it is; the agent proposes a new plan when a meeting moves or new work lands.</p>
        ) : (
          <ol className="td-diff" aria-label="Proposed changes">
            {p.changes.map((c) => {
              const off = p.excluded.has(c.id);
              const m = MARK[c.kind];
              const err = c.proposal ? ctx.actions.errors[`proposal:${c.proposal.id}`] : c.kind === 'rerank' ? ctx.actions.errors['today:rerank'] : undefined;
              return (
                <li
                  key={c.id}
                  className="td-d"
                  data-change-id={c.id}
                  data-kind={c.kind}
                  data-excluded={off || undefined}
                  data-hl={c.itemId && c.itemId === p.hlItemId ? '' : undefined}
                  onMouseEnter={() => p.onHover(c.itemId)}
                  onMouseLeave={() => p.onHover(null)}
                >
                  <span className="td-mk" aria-label={m.label}>
                    {m.glyph}
                  </span>
                  <button type="button" className="td-d-t hover:underline" onClick={() => p.onOpen(c)} title={c.title}>
                    <span>{c.title}</span>
                  </button>
                  <div className="td-d-when">
                    {c.when.label}
                    {c.when.before || c.when.after ? ' · ' : ''}
                    {c.when.before ? (
                      <>
                        <s>{c.when.before}</s> →{' '}
                      </>
                    ) : null}
                    {c.when.after}
                    {c.when.note ? `, ${c.when.note}` : ''}
                  </div>
                  {c.why ? <div className="td-d-why">{c.why}</div> : null}
                  {err ? (
                    <div className="td-d-err" role="alert">
                      Couldn’t {err.verb}: {err.message}. Change rolled back.
                    </div>
                  ) : null}
                  <Button size="sm" variant="ghost" className="td-undo" onClick={() => p.onToggle(c)} aria-label={`${off ? 'Redo' : 'Undo'}: ${c.title}`}>
                    {off ? 'Redo' : 'Undo'}
                  </Button>
                </li>
              );
            })}
          </ol>
        )}

        {p.since ? (
          <div className="mt-3 border-t border-line pt-4" data-since>
            <h3 className="text-body font-bold text-fg-heading">Since you left</h3>
            <div className="mt-1.5 mb-0.5 flex gap-[22px]">
              {(
                [
                  ['changed', p.since.changed],
                  ['closed', p.since.closed],
                  ['new', p.since.new],
                ] as const
              ).map(([k, n]) => (
                <div key={k} className="flex items-baseline gap-1.5 text-muted">
                  <b className="text-title text-fg-heading tabular-nums">{n}</b>
                  {k}
                </div>
              ))}
            </div>
            <button type="button" className="pt-2 text-caption font-bold text-link hover:underline" aria-expanded={digest} onClick={() => setDigest(!digest)}>
              {digest ? 'Hide the digest' : 'Open the digest →'}
            </button>
            {digest ? <SinceDigest /> : null}
          </div>
        ) : null}

        <button type="button" onClick={p.onAskAssistant} className="mt-[18px] flex items-center gap-2 text-left text-caption text-muted hover:text-fg">
          Want a different plan? Tell the assistant <KbdHint combo="mod+j" />
        </button>
      </div>
    </aside>
  );
});

export function PlanTab({ open, count, onToggle }: { open: boolean; count: number; onToggle: () => void }) {
  return (
    <button type="button" className="td-plan-tab" aria-controls="today-plan" aria-expanded={open} title="Agent’s plan (p)" onClick={onToggle} data-plan-tab>
      <span className="text-ai-700">✦</span>
      {/* A straight apostrophe: the curly one turns into a dash in vertical writing mode. */}
      <span className="td-vt">{"Agent's plan"}</span>
      {count ? (
        <span className="td-badge" data-tone="ai" style={{ padding: '0 6px' }}>
          {count}
        </span>
      ) : null}
    </button>
  );
}
