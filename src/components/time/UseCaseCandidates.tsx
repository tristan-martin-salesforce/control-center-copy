'use client';
/**
 * Activity ▸ Needs you ▸ Use cases to add (src/engines/use-cases, GET /use-cases/candidates): use cases the app noticed
 * in your notes, meetings, Slack and mail with a customer. Each row: the use case, the opp (and why), its evidence,
 * and what Accept stages. Accept drafts the VDP item and the Org62 row for your next logging canvas (both Outbox items
 * you apply: nothing is sent from here); Edit sets the words or the opp first; Reject says why. When the app is unsure
 * of the opp, the row asks with the top 3 to pick from; the pick teaches it. Every decision has Undo in its toast.
 */
import { useState } from 'react';
import type { UseCaseCandidate, UseCaseRejectReason } from '@/contract';
import { useApi } from '@/client/hooks';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { ActionRow } from '@/components/kit';
import { Button, cn, Skeleton } from '@/ui';
import { useFeature } from '@/client/persona';
import { oppOwnerWord, recentWork } from './dc-derive';
import { plainWords } from './plain';

const REJECT: ReadonlyArray<{ reason: UseCaseRejectReason; label: string }> = [
  { reason: 'not_use_case', label: 'Not a use case' },
  { reason: 'wrong_opp', label: 'Wrong opp' },
  { reason: 'duplicate', label: 'Duplicate' },
  { reason: 'already_in_org62', label: 'Already in Org62' },
];

const SOURCE: Record<UseCaseCandidate['source'], string> = { gemini_note: 'Meeting notes', meeting: 'Meeting', slack_burst: 'Slack', mail_thread: 'Mail', manual: 'Added by you' };

type Body = { decision: 'accept' | 'edit' | 'reject'; oppId?: string; title?: string; problem?: string; outcome?: string; reason?: UseCaseRejectReason };

export function UseCaseCandidates() {
  const q = useApi('getUseCaseCandidates');
  const decide = useOptimisticMutation({
    route: 'decideUseCaseCandidate',
    topics: ['time', 'deals', 'outbox'],
    toast: (r, input) =>
      input.body?.decision === 'reject'
        ? { title: `Not added: ${r.entity.candidate.title}`, body: 'The app will not suggest it again.' }
        : input.body?.decision === 'edit'
          ? { title: `Saved: ${r.entity.candidate.title}`, body: r.entity.candidate.oppName ? `On ${r.entity.candidate.oppName}. Accept it when it reads right.` : 'Accept it when it reads right.' }
          : { title: `Staged: ${r.entity.candidate.title}`, body: [r.entity.vdpDraftId ? 'A VDP item is in your Outbox' : null, r.entity.org62Staged ? 'the Org62 row goes in your next batch' : null].filter(Boolean).join('; ') + '. Nothing is sent until you apply them.' },
  });
  const refresh = useOptimisticMutation({ route: 'refreshUseCaseCandidates', topics: ['time'] });
  const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <Skeleton variant="block" className="h-24 w-full" />;
  if (!q.data?.enabled) return null;
  const list = q.data.candidates;
  const run = (c: UseCaseCandidate, body: Body) => decide.mutate({ params: { id: c.id }, body });
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="uc-candidates">
      {!list.length ? (
        <p className="text-caption text-muted" data-testid="uc-candidates-none">
          No use case to add right now. The app reads your meeting notes, customer meetings, Slack and mail for what customers want to solve, and lists each here once.
        </p>
      ) : (
        // a grid: each candidate is a kit row (role row needs a grid around it)
        <div role="grid" className="min-w-0 overflow-hidden rounded-md border border-line bg-surface">
          {list.map((c) => (
            <CandidateRow key={c.id} c={c} busy={decide.isPending} open={open === c.id} onOpen={(v) => setOpen(v ? c.id : null)} onDecide={(b) => run(c, b)} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-caption text-muted">
        <span>{q.data.generatedAt ? `Read ${new Date(q.data.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Read after each scan'}</span>
        {q.data.counts.staged ? <span>{`· ${q.data.counts.staged} staged, waiting for your Apply`}</span> : null}
        <Button size="xs" variant="ghost" disabled={refresh.isPending} onClick={() => refresh.mutate({ body: {} })} data-testid="uc-refresh">
          Refresh
        </Button>
      </div>
    </div>
  );
}

function CandidateRow({ c, busy, open, onOpen, onDecide }: { c: UseCaseCandidate; busy: boolean; open: boolean; onOpen: (v: boolean) => void; onDecide: (b: Body) => void }) {
  const [title, setTitle] = useState(c.title);
  const [problem, setProblem] = useState(c.problem);
  const [outcome, setOutcome] = useState(c.outcome);
  const where = c.oppName ?? c.accountName ?? 'No opportunity yet';
  const ev = c.evidence.at(-1);
  const why = c.needsPick ? `${c.accountName ?? 'Which account'}: which opportunity? Pick one below` : `${where}${c.why[0] ? ` · ${plainWords(c.why[0])}` : ''}`;
  return (
    <ActionRow
      id={`uc-${c.id}`}
      title={c.title}
      dashed
      tint={c.basis === 'ai' ? 'ai' : null}
      edge={c.needsPick ? 'warning' : 'ai'}
      why={why}
      chips={
        <>
          {c.products.map((p) => (
            <span key={p} className="rounded-full bg-ai-50 px-2 py-0.5 text-caption text-ai-700">
              {p}
            </span>
          ))}
          {ev ? <span className="text-caption text-muted">{`${SOURCE[ev.kind]}: ${ev.label}${c.evidence.length > 1 ? ` (+${c.evidence.length - 1})` : ''}`}</span> : null}
        </>
      }
      meta={c.sends ? <span data-testid="uc-sends">{plainWords(c.sends)}</span> : null}
      source={ev?.url ? { label: `Open the ${SOURCE[ev.kind].toLowerCase()}`, url: ev.url } : null}
      verb={{ label: 'Accept', onClick: () => onDecide({ decision: 'accept' }), disabled: busy || c.needsPick, title: c.needsPick ? 'Pick the opportunity first' : (plainWords(c.sends) ?? undefined), testId: 'uc-accept' }}
      altVerb={{ label: 'Edit', onClick: () => onOpen(!open), disabled: busy, testId: 'uc-edit' }}
      overflow={REJECT.map((r) => ({ id: `reject-${r.reason}`, label: `Reject: ${r.label}`, icon: 'close', onClick: () => onDecide({ decision: 'reject', reason: r.reason }), disabled: busy, testId: `uc-reject-${r.reason}` }))}
      inlineOverflow={0}
      extra={
        c.needsPick || c.evidence.some((e) => e.quote) ? (
          <div className="flex min-w-0 flex-col gap-2 pt-1">
            {ev?.quote ? <p className="text-caption break-words text-muted italic" data-testid="uc-quote">{`“${ev.quote}”`}</p> : null}
            {c.needsPick ? <OppPick c={c} busy={busy} onPick={(oppId) => onDecide({ decision: 'edit', oppId })} /> : null}
          </div>
        ) : null
      }
      expansion={
        <form
          className="grid min-w-0 gap-2 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            onDecide({ decision: 'edit', ...(title.trim().length >= 3 ? { title: title.trim() } : {}), problem, outcome });
            onOpen(false);
          }}
        >
          <label className="grid gap-1 text-caption text-muted">
            Use case
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 rounded-md border border-line bg-surface px-2 text-body text-fg" aria-label="Use case title" />
          </label>
          <label className="grid gap-1 text-caption text-muted">
            The problem
            <textarea value={problem} onChange={(e) => setProblem(e.target.value)} rows={2} className="rounded-md border border-line bg-surface px-2 py-1 text-body text-fg" aria-label="The problem" />
          </label>
          <label className="grid gap-1 text-caption text-muted">
            The outcome (a KPI, if one was named)
            <input value={outcome} onChange={(e) => setOutcome(e.target.value)} className="h-8 rounded-md border border-line bg-surface px-2 text-body text-fg" aria-label="The outcome" />
          </label>
          <div className="flex gap-2">
            <Button size="xs" variant="primary" type="submit" disabled={busy}>
              Save
            </Button>
            <Button size="xs" variant="ghost" type="button" onClick={() => onOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      }
      expanded={open}
      onExpandedChange={onOpen}
      data-testid="uc-candidate"
      data-needs-pick={c.needsPick ? '' : undefined}
    />
  );
}

/** The rundown's top 3 when the app is unsure of the opp: one click picks it (a correction it learns). */
function OppPick({ c, busy, onPick }: { c: UseCaseCandidate; busy: boolean; onPick: (oppId: string) => void }) {
  const dc = useFeature('dealContributions');
  if (!c.alternates.length) return <p className="text-caption text-muted">No open opportunity on this account yet: Edit it once the opp is in the app.</p>;
  return (
    <ul className="grid min-w-0 gap-1 rounded-md border border-line bg-surface-muted p-1.5" data-testid="uc-opp-pick">
      {c.alternates.map((o) => (
        <li key={o.oppId} className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-sm px-1.5 py-1')}>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body text-fg">{o.name}</span>
            <span className="block text-caption text-muted">{[o.stage, o.closeDate ? `closes ${o.closeDate}` : null, oppOwnerWord(o, dc), recentWork(o)].filter(Boolean).join(' · ')}</span>
          </span>
          <Button size="xs" variant="secondary" disabled={busy} onClick={() => onPick(o.oppId)} data-testid="uc-pick">
            It goes here
          </Button>
        </li>
      ))}
    </ul>
  );
}
