'use client';
/**
 * Engine proposal on a user-touched draft: "New info → update draft? Apply / Keep mine" (R-UI-20).
 * Never an overwrite. Local stand-in for the shared `ProposalDiff` (UI-SPEC §5.3).
 */
import type { Proposal } from '@/contract';
import { Button, Icon } from '@/ui';
import { cx } from './_bits';
import type { DiffOp } from './text-diff';

export function DiffText({ ops, className }: { ops: DiffOp[]; className?: string }) {
  return (
    <p className={cx('text-body whitespace-pre-wrap text-fg', className)}>
      {ops.map((o, i) =>
        o.op === 'equal' ? (
          <span key={i}>{o.text}</span>
        ) : o.op === 'insert' ? (
          <ins key={i} className="rounded-sm bg-success-50 text-success-700 no-underline decoration-success-500">
            {o.text}
          </ins>
        ) : (
          <del key={i} className="rounded-sm bg-danger-50 text-danger-700 line-through">
            {o.text}
          </del>
        ),
      )}
    </p>
  );
}

/** Collapse long equal runs so the change is what you read. */
function trimEqual(ops: DiffOp[], keep = 80): DiffOp[] {
  return ops.map((o, i) => {
    if (o.op !== 'equal' || o.text.length <= keep * 2) return o;
    const first = i === 0;
    const last = i === ops.length - 1;
    if (first) return { ...o, text: `…${o.text.slice(-keep)}` };
    if (last) return { ...o, text: `${o.text.slice(0, keep)}…` };
    return { ...o, text: `${o.text.slice(0, keep)} … ${o.text.slice(-keep)}` };
  });
}

export interface DraftProposalProps {
  proposal: Proposal;
  onApply: () => void;
  onKeepMine: () => void;
  busy?: 'apply' | 'reject' | null;
  /** The proposal was computed before the user's latest edits; applying replaces them. */
  stale?: boolean;
  error?: string | null;
}

export function DraftProposal({ proposal, onApply, onKeepMine, busy, stale, error }: DraftProposalProps) {
  const ops = proposal.textDiff ?? [];
  return (
    <section data-testid="draft-proposal" aria-label="Proposed change to your draft" className="rounded-lg border-agentic p-3">
      <div className="flex items-start gap-2">
        <Icon name="sparkles" size="sm" className="mt-0.5 text-ai-700" />
        <div className="min-w-0 flex-1">
          <p className="text-caption font-bold text-ai-700">Proposed change</p>
          <p className="mt-0.5 text-body text-fg">
            {proposal.reason.replace(/^New info:\s*/i, 'New info: ')}. You edited this draft, so it wasn’t changed. Update it?
          </p>
          {ops.length ? <DiffText ops={trimEqual(ops)} className="mt-2 rounded-md bg-surface-muted px-2.5 py-2" /> : null}
          {stale ? (
            <p className="mt-2 flex items-center gap-1 text-caption text-warning-700">
              <Icon name="warning" size="xs" />
              Made before your latest edits. Applying replaces them.
            </p>
          ) : null}
          {error ? <p className="mt-2 text-caption text-danger-700">{error}</p> : null}
          <div className="mt-2.5 flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={onApply} loading={busy === 'apply'} disabled={busy != null}>
              <Icon name="check" size="xs" />
              Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={onKeepMine} loading={busy === 'reject'} disabled={busy != null}>
              Keep mine
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

export interface ConflictBannerProps {
  /** Word diff, theirs → yours. */
  diff: DiffOp[];
  onKeepMine: () => void;
  onTakeTheirs: () => void;
  busy?: boolean;
}

/** 409: "Changed elsewhere: keep yours / take theirs" (UI-SPEC §10). */
/** Only the words that differ, side by side: what their version has and what yours has. */
function ConflictSides({ diff }: { diff: DiffOp[] }) {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  const theirs = diff.filter((d) => d.op === 'delete').map((d) => clean(d.text)).filter(Boolean);
  const yours = diff.filter((d) => d.op === 'insert').map((d) => clean(d.text)).filter(Boolean);
  if (!theirs.length && !yours.length) return null;
  const col = (title: string, parts: string[], tone: string) => (
    <div className="min-w-0 rounded-md bg-surface px-2.5 py-2">
      <p className="mb-1 text-caption text-muted">{title}</p>
      {parts.length ? (
        // every differing span (caps audit F-13: the choice is keep or take, so nothing is hidden); a long list scrolls
        <ul className="max-h-48 space-y-0.5 overflow-y-auto" data-conflict-spans>
          {parts.map((t, i) => (
            <li key={i} className={cx('text-body', tone)}>
              “{t.length > 140 ? `${t.slice(0, 140)}…` : t}”
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body text-faint">Nothing extra</p>
      )}
    </div>
  );
  return (
    <div className="mt-2 grid grid-cols-1 gap-2 @[32rem]:grid-cols-2">
      {col('Only in theirs', theirs, 'text-fg')}
      {col('Only in yours', yours, 'text-fg')}
    </div>
  );
}

export function ConflictBanner({ diff, onKeepMine, onTakeTheirs, busy }: ConflictBannerProps) {
  return (
    <section data-testid="conflict-banner" role="alert" className="rounded-lg border border-warning-200 bg-warning-50 p-3">
      <div className="flex items-start gap-2">
        <Icon name="warning" size="sm" className="mt-0.5 text-warning-700" />
        <div className="min-w-0 flex-1">
          <p className="text-body font-bold text-fg">Changed elsewhere</p>
          <p className="text-body text-fg">This draft was changed somewhere else while you were editing. Your edits aren’t saved yet.</p>
          <ConflictSides diff={diff} />
          <div className="mt-2.5 flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={onKeepMine} loading={busy} data-testid="keep-mine">
              Keep yours
            </Button>
            <Button size="sm" variant="ghost" onClick={onTakeTheirs} disabled={busy} data-testid="take-theirs">
              Take theirs
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
