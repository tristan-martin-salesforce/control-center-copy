'use client';
// Missed opportunities: one row, its dismiss form, the verdict sections and the stacked layout. Split from MissedView.tsx (max-lines).
import { useState } from 'react';

import type { MissedOpp, MissedPayload } from '@/contract';
import { queryKey } from '@/client/api';
import type { OptimisticCache } from '@/client/optimistic';
import { StatusBadge } from '@/components/domain/lib/v2';
import { Button, cn, Popover } from '@/ui';
import { ContextRow, Pane, SectionHead, type Edge } from './context-frame';
import { EvidenceChips, NotesBlock, PromptDraft } from './missed-parts';
import { fmtAmount, fmtDate } from './format';
import { DISMISS_REASONS, missedNotes, type MissedNotes } from './missed';

export const SCOPE = 'page:missed';
/**
 * Missed opps carry no `version`, so the generic entity patch (which needs one) can't find them: patch the sweep
 * payload directly. It sits under the snapshotted `deals` topic, so a failure still rolls back.
 */
export function patchMissed(cache: OptimisticCache, id: string, patch: Partial<MissedOpp>) {
  cache.setQuery<MissedPayload>(queryKey('getMissed'), (old) => (old ? { ...old, missed: old.missed.map((m) => (m.id === id ? { ...m, ...patch } : m)) } : old));
}
// ── Small pieces ────────────────────────────────────────────────────────────────────────────

// ── Dismiss with a reason ───────────────────────────────────────────────────────────────────

function DismissForm({ count = 1, onSubmit, onCancel }: { count?: number; onSubmit: (reason: string, note: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason) onSubmit(reason, note.trim());
      }}
    >
      <p className="text-body font-bold text-fg-heading">{count > 1 ? `Dismiss ${count} opps: why aren't they yours?` : "Dismiss: why isn't this yours?"}</p>
      <div role="radiogroup" aria-label="Reason" className="flex flex-wrap gap-1.5">
        {DISMISS_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={reason === r}
            onClick={() => setReason(r)}
            className={cn(
              'h-8 rounded-md border px-2.5 text-caption focus-visible:outline-none focus-visible:shadow-focus',
              reason === r ? 'border-accent bg-selected font-bold text-fg-heading' : 'border-line-strong bg-surface text-fg hover:bg-surface-muted',
            )}
          >
            {r}
          </button>
        ))}
      </div>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Add a note (optional)"
        aria-label="Note"
        className="h-9 rounded-md border border-line-input bg-surface-input px-2.5 text-body text-fg placeholder:text-muted focus:border-accent focus:outline-none"
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-caption text-muted">{reason ? 'You can undo this.' : 'Pick a reason.'}</span>
        <Button size="sm" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!reason}>
          {count > 1 ? `Dismiss ${count}` : 'Dismiss'}
        </Button>
      </div>
    </form>
  );
}
// ── Row ─────────────────────────────────────────────────────────────────────────────────────

export interface RowCtx {
  today: string;
  selected: string | null;
  /** The #1 row (first Claim row still to review): its verb is filled while nothing is selected. */
  firstId: string | null;
  openId: string | null;
  picked: Set<string>;
  expanded: Set<string>;
  newIds: Set<string>;
  dismissOpenId: string | null;
  canUndo: (id: string) => boolean;
  onSelect: (m: MissedOpp) => void;
  onPick: (m: MissedOpp) => void;
  onClaim: (m: MissedOpp) => void;
  onDismiss: (m: MissedOpp, reason: string, note: string) => void;
  onUndo: (m: MissedOpp) => void;
  onOpenTask: (m: MissedOpp) => void;
  onToggle: (id: string) => void;
  setDismissOpenId: (id: string | null) => void;
}
function edgeOf(m: MissedOpp, notes: MissedNotes): Edge {
  if (m.status === 'claimed') return 'success';
  if (m.status !== 'new') return 'none';
  if (notes.lock) return 'danger';
  if (notes.lockSoon || notes.stranded) return 'warning';
  return 'none';
}
function MissedRow({ m, c }: { m: MissedOpp; c: RowCtx }) {
  const notes = missedNotes(m, c.today);
  const isNew = m.status === 'new';
  const expanded = c.expanded.has(m.id);
  const selected = c.selected === m.id;
  const edge = edgeOf(m, notes);
  const badge =
    m.status === 'claimed' ? (
      <StatusBadge tone="success" icon="check">
        Claimed
      </StatusBadge>
    ) : m.status === 'dismissed' ? (
      <StatusBadge tone="neutral">Dismissed</StatusBadge>
    ) : edge === 'danger' ? (
      <StatusBadge tone="danger" icon="lock">
        Locked
      </StatusBadge>
    ) : notes.lockSoon ? (
      <StatusBadge tone="warning" icon="clock">
        Locks soon
      </StatusBadge>
    ) : notes.stranded ? (
      <StatusBadge tone="warning" icon="warning">
        Stranded DC
      </StatusBadge>
    ) : null;
  const verb = isNew
    ? { label: 'Claim', kbd: 'a', onClick: () => c.onClaim(m) }
    : m.status === 'claimed' && m.claimedWorkItemId
      ? { label: 'Open task', onClick: () => c.onOpenTask(m) }
      : c.canUndo(m.id)
        ? { label: 'Undo', icon: 'undo', onClick: () => c.onUndo(m) }
        : undefined;
  return (
    <ContextRow
      rowId={m.id}
      aria-label={`${m.verdict === 'claim' ? 'Claim' : 'Check'}: ${m.oppName}`}
      title={
        <span className="inline-flex max-w-full min-w-0 items-baseline gap-2">
          <span className={cn('truncate', m.status === 'dismissed' && 'text-muted line-through decoration-line-strong')} title={m.oppName}>
            {m.oppName}
          </span>
          {c.newIds.has(m.id) ? <span className="shrink-0 text-caption font-normal text-link">New</span> : null}
        </span>
      }
      meta={
        <>
          <span className="text-body text-fg">{fmtAmount(m.amount)}</span>
          <span className={notes.lock && isNew ? 'text-danger-700' : undefined}>{fmtDate(m.closeDate)}</span>
        </>
      }
      why={
        <>
          <span className="text-fg">{m.accountName}</span>
          {` · ${m.stage.replace(/^\d+\s*-\s*/, '')}`}
          {m.status === 'dismissed' && m.dismissReason ? ` · ${m.dismissReason}` : m.evidence[0] ? ` · ${m.evidence[0]}` : ''}
        </>
      }
      badge={badge}
      edge={edge}
      selected={selected}
      emphasized={!c.selected && c.firstId === m.id}
      inPanel={c.openId === m.id && selected}
      dimmed={m.status === 'dismissed'}
      lead={
        isNew ? (
          <input
            type="checkbox"
            checked={c.picked.has(m.id)}
            onChange={() => c.onPick(m)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${m.oppName}`}
            className="mt-1 size-4 cursor-pointer accent-[var(--color-accent)]"
          />
        ) : (
          <span className="block size-4" />
        )
      }
      verb={verb}
      secondary={
        <>
          <Button size="xs" variant="quiet" onClick={() => c.onToggle(m.id)} aria-expanded={expanded}>
            {expanded ? 'Less' : `Evidence ${m.evidence.length}`}
          </Button>
          {isNew ? (
            <Popover
              open={c.dismissOpenId === m.id}
              onOpenChange={(o) => c.setDismissOpenId(o ? m.id : null)}
              placement="bottom-end"
              width={380}
              label="Dismiss with a reason"
              trigger={
                <Button size="xs" variant="quiet" aria-label={`Dismiss ${m.oppName}`}>
                  Dismiss…
                </Button>
              }
            >
              {({ close }) => (
                <DismissForm
                  onCancel={close}
                  onSubmit={(reason, note) => {
                    close();
                    c.onDismiss(m, reason, note);
                  }}
                />
              )}
            </Popover>
          ) : m.status === 'claimed' && m.claimedWorkItemId && c.canUndo(m.id) ? (
            // the verb is Open task here; otherwise the verb is already Undo (one Undo per row)
            <Button size="xs" variant="quiet" icon="undo" onClick={() => c.onUndo(m)}>
              Undo
            </Button>
          ) : null}
        </>
      }
      below={
        <>
          {expanded ? <EvidenceChips evidence={m.evidence} /> : null}
          {isNew || expanded ? <NotesBlock notes={notes} /> : null}
          {m.otherDcs.length && expanded ? <p className="mt-1 text-caption text-muted">Other DCs: {m.otherDcs.join(', ')}</p> : null}
          {m.status === 'claimed' && m.claimedWorkItemId ? <PromptDraft m={m} /> : null}
        </>
      }
      onClick={() => c.onSelect(m)}
    />
  );
}
// ── Section ─────────────────────────────────────────────────────────────────────────────────

export function VerdictSection({
  verdict,
  rows,
  c,
  onClaimMany,
  onDismissMany,
  onPickAll,
  batchDismissOpen,
  setBatchDismissOpen,
  className,
}: {
  verdict: 'claim' | 'check';
  rows: MissedOpp[];
  c: RowCtx;
  onClaimMany: (ms: MissedOpp[]) => void;
  onDismissMany: (ms: MissedOpp[], reason: string, note: string) => void;
  onPickAll: (ms: MissedOpp[], on: boolean) => void;
  batchDismissOpen: string | null;
  setBatchDismissOpen: (v: string | null) => void;
  className?: string;
}) {
  const open = rows.filter((m) => m.status === 'new');
  const picked = open.filter((m) => c.picked.has(m.id));
  const title = verdict === 'claim' ? 'Claim' : 'Check first';
  const sub = verdict === 'claim' ? 'clearly yours, no DC' : 'ambiguous: look before claiming';
  return (
    <Pane
      as="section"
      aria-label={title}
      className={className}
      head={
        <SectionHead
          title={title}
          count={open.length}
          sub={sub}
          action={
            picked.length ? (
              <>
                <Button size="xs" variant="quiet" onClick={() => onClaimMany(picked)} data-testid={`batch-claim-${verdict}`}>
                  Claim {picked.length} selected
                </Button>
                <Popover
                  open={batchDismissOpen === verdict}
                  onOpenChange={(o) => setBatchDismissOpen(o ? verdict : null)}
                  placement="bottom-end"
                  width={380}
                  label="Dismiss the selected opps"
                  trigger={
                    <Button size="xs" variant="quiet">
                      Dismiss {picked.length}…
                    </Button>
                  }
                >
                  {({ close }) => (
                    <DismissForm
                      count={picked.length}
                      onCancel={close}
                      onSubmit={(reason, note) => {
                        close();
                        onDismissMany(picked, reason, note);
                      }}
                    />
                  )}
                </Popover>
                <Button size="xs" variant="quiet" onClick={() => onPickAll(open, false)}>
                  Clear
                </Button>
              </>
            ) : open.length > 1 ? (
              <Button size="xs" variant="quiet" onClick={() => onPickAll(open, true)}>
                Select all {open.length}
              </Button>
            ) : undefined
          }
        />
      }
      bodyClassName="pb-3"
    >
      {rows.length ? (
        <div role="list" aria-label={title}>
          {rows.map((m) => (
            <MissedRow key={m.id} m={m} c={c} />
          ))}
        </div>
      ) : (
        <p className="px-5 py-3 text-body text-muted">Nothing to {verdict === 'claim' ? 'claim' : 'check'} with these filters.</p>
      )}
    </Pane>
  );
}
/** Below 1,500 px of main width (or with the panel open): one scrolling pane, Claim then Check. */
export function StackedSections({
  claimRows,
  checkRows,
  c,
  runMany,
  pickAll,
  batchDismissOpen,
  setBatchDismissOpen,
}: {
  claimRows: MissedOpp[];
  checkRows: MissedOpp[];
  c: RowCtx;
  runMany: (ms: MissedOpp[], kind: 'claim' | 'dismiss', reason?: string, note?: string) => Promise<void>;
  pickAll: (ms: MissedOpp[], on: boolean) => void;
  batchDismissOpen: string | null;
  setBatchDismissOpen: (v: string | null) => void;
}) {
  const head = (verdict: 'claim' | 'check', rows: MissedOpp[]) => {
    const open = rows.filter((m) => m.status === 'new');
    const picked = open.filter((m) => c.picked.has(m.id));
    return (
      <SectionHead
        title={verdict === 'claim' ? 'Claim' : 'Check first'}
        count={open.length}
        sub={verdict === 'claim' ? 'clearly yours, no DC' : 'ambiguous: look before claiming'}
        action={
          picked.length ? (
            <>
              <Button size="xs" variant="quiet" onClick={() => void runMany(picked, 'claim')} data-testid={`batch-claim-${verdict}`}>
                Claim {picked.length} selected
              </Button>
              <Popover
                open={batchDismissOpen === verdict}
                onOpenChange={(o) => setBatchDismissOpen(o ? verdict : null)}
                placement="bottom-end"
                width={380}
                label="Dismiss the selected opps"
                trigger={
                  <Button size="xs" variant="quiet">
                    Dismiss {picked.length}…
                  </Button>
                }
              >
                {({ close }) => (
                  <DismissForm
                    count={picked.length}
                    onCancel={close}
                    onSubmit={(reason, note) => {
                      close();
                      void runMany(picked, 'dismiss', reason, note);
                    }}
                  />
                )}
              </Popover>
              <Button size="xs" variant="quiet" onClick={() => pickAll(open, false)}>
                Clear
              </Button>
            </>
          ) : open.length > 1 ? (
            <Button size="xs" variant="quiet" onClick={() => pickAll(open, true)}>
              Select all {open.length}
            </Button>
          ) : undefined
        }
      />
    );
  };
  return (
    <Pane aria-label="Missed opportunities" bodyClassName="pb-3">
      {claimRows.length ? (
        <section aria-label="Claim">
          <div className="sticky top-0 z-[1] bg-surface">{head('claim', claimRows)}</div>
          <div role="list" aria-label="Claim">
            {claimRows.map((m) => (
              <MissedRow key={m.id} m={m} c={c} />
            ))}
          </div>
        </section>
      ) : null}
      {checkRows.length ? (
        <section aria-label="Check first" className="mt-3">
          <div className="sticky top-0 z-[1] bg-surface">{head('check', checkRows)}</div>
          <div role="list" aria-label="Check first">
            {checkRows.map((m) => (
              <MissedRow key={m.id} m={m} c={c} />
            ))}
          </div>
        </section>
      ) : null}
    </Pane>
  );
}
