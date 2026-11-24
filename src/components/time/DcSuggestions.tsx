'use client';
/**
 * Activity ▸ Needs you ▸ DCs to claim (the attribution engine's daily batch, src/engines/attribution/dc.ts): each
 * suggested Deal Contribution with why (the reasons as chips), its evidence (links), its share of one engagement when
 * several opps share it, the covered AE, and the split it would claim. Accept drafts a DC request that rides your next
 * logging canvas (an Outbox item you Apply: nothing is sent from here); Edit sets the split, the role or the comment
 * first; Reject keeps it out until more work lands. Ticked rows (the pre-ticked ones, strong evidence) take "Claim N"
 * in one click; pre-ticked is never claimed for you. Every decision has Undo in its toast and teaches the engine.
 */
import { useMemo, useState } from 'react';
import type { DcSuggestion, DcSuggestionContext } from '@/contract';
import { useApi } from '@/client/hooks';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { Button, cn, Skeleton } from '@/ui';
import { claimable, dcFacts, dcGroups, dcSplitWords, defaultTicked } from './dc-derive';

export function DcSuggestions() {
  const q = useApi('getDcSuggestions');
  const decide = useOptimisticMutation({
    route: 'decideDcSuggestion',
    topics: ['time', 'deals'],
    toast: (r, input) => (input.body?.decision === 'reject' ? { title: `Not suggested again: ${r.entity.suggestion.oppName}`, body: 'Unless 2 h more land on it, or you join its team.' } : { title: `DC request drafted: ${r.entity.suggestion.oppName}`, body: 'It goes in your next batch. Nothing is sent until you Apply it.' }),
  });
  const refresh = useOptimisticMutation({ route: 'refreshDcSuggestions', topics: ['time'] });
  const list = useMemo(() => q.data?.suggestions ?? [], [q.data]);
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const on = ticked ?? defaultTicked(list);
  const [editing, setEditing] = useState<string | null>(null);
  if (q.isLoading) return <Skeleton variant="block" className="h-24 w-full" />;
  if (!q.data?.enabled) return null;
  const take = claimable(list, on);
  const toggle = (id: string) => {
    const next = new Set(on);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked(next);
  };
  const claimAll = async () => {
    for (const s of take) await decide.mutateAsync({ params: { id: s.id }, body: { decision: 'accept' } }).catch(() => undefined);
    setTicked(null);
  };
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="dc-suggestions">
      {!list.length ? (
        <p className="text-caption text-muted" data-testid="dc-suggestions-none">
          No DC to claim right now. The app suggests one where you did the work (meetings with the customer, hours logged, Slack, docs) or cover the AE, on the products that count ({q.data.dcProducts.join(', ') || 'every product'}).
        </p>
      ) : (
        <>
          {dcGroups(list).map((g) => (
            <div key={g.key} className="min-w-0 overflow-hidden rounded-md border border-line bg-surface" data-testid="dc-group">
              {g.rows.length > 1 ? <p className="border-b border-line bg-surface-muted px-4 py-1.5 text-caption text-muted">{`${g.accountName ?? 'One account'}: one engagement, ${g.rows.length} opportunities. Each can earn a DC; your hours stay on the opp you logged them to.`}</p> : null}
              <ul>
                {g.rows.map((s) => (
                  <DcRow key={s.id} s={s} ticked={on.has(s.id)} onTick={() => toggle(s.id)} busy={decide.isPending} editing={editing === s.id} onEdit={() => setEditing(editing === s.id ? null : s.id)} onDecide={(body) => decide.mutate({ params: { id: s.id }, body })} />
                ))}
              </ul>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={!take.length || decide.isPending} onClick={() => void claimAll()} data-testid="dc-claim-ticked">
              {take.length ? `Claim ${take.length} ${take.length === 1 ? 'DC' : 'DCs'}` : 'Claim the ticked DCs'}
            </Button>
            <span className="text-caption text-muted">Each becomes a DC request in your next batch; nothing goes to Org62 until you Apply it.</span>
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2 text-caption text-muted">
        <span>{q.data.generatedAt ? `Suggested ${new Date(q.data.generatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'Suggested daily'}</span>
        <Button size="xs" variant="ghost" disabled={refresh.isPending} onClick={() => refresh.mutate({ body: {} })} data-testid="dc-refresh">
          Refresh
        </Button>
      </div>
    </div>
  );
}

function DcRow({ s, ticked, onTick, busy, editing, onEdit, onDecide }: { s: DcSuggestion; ticked: boolean; onTick: () => void; busy: boolean; editing: boolean; onEdit: () => void; onDecide: (b: { decision: 'accept' | 'edit' | 'reject'; split?: number; comment?: string }) => void }) {
  const [split, setSplit] = useState<number>(s.splitPercent ?? 50);
  const [comment, setComment] = useState('');
  return (
    <li className={cn('min-w-0 border-t border-line px-4 py-2.5 first:border-t-0', ticked ? 'bg-selected' : '')} data-testid="dc-suggestion" data-pre-ticked={s.preTicked ? '' : undefined}>
      <div className="flex min-w-0 items-start gap-3">
        <input type="checkbox" checked={ticked} disabled={s.splitPercent === null} onChange={onTick} aria-label={`Claim ${s.oppName}`} className="mt-1 size-4 accent-[var(--color-accent)]" data-testid="dc-tick" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="min-w-0 font-bold break-words text-fg">{s.oppName}</span>
            <span className="text-caption text-muted">{dcFacts(s)}</span>
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="dc-why">
            {s.reasons.map((r) => (
              <span key={`${r.code}:${r.text}`} className={cn('rounded-full px-2 py-0.5 text-caption', r.code === 'split_question' ? 'bg-warning-50 text-warning-700' : 'bg-ai-50 text-ai-700')} data-reason={r.code}>
                {r.text}
              </span>
            ))}
            {s.coveredAe ? <span className="rounded-full bg-surface-muted px-2 py-0.5 text-caption text-fg">{`AE you cover: ${s.coveredAe}`}</span> : null}
            {dcContextChips(s.context).map((c) => (
              <span key={c.key} className="rounded-full bg-surface-muted px-2 py-0.5 text-caption text-fg" data-context={c.key}>
                {c.text}
              </span>
            ))}
            {!s.preTicked && s.splitPercent !== null ? <span className="text-caption text-muted">light evidence: not ticked</span> : null}
          </div>
          {s.evidence.length ? (
            <p className="flex min-w-0 flex-wrap gap-x-3 text-caption text-muted" data-testid="dc-evidence">
              {s.evidence.map((e) =>
                e.url ? (
                  <a key={`${e.label}:${e.at}`} href={e.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                    {e.label}
                  </a>
                ) : (
                  <span key={`${e.label}:${e.at}`}>{e.label}</span>
                ),
              )}
            </p>
          ) : null}
          {dcContextDetails(s.context).length ? (
            <ul className="space-y-0.5 text-caption text-muted" data-testid="dc-context">
              {dcContextDetails(s.context).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {editing ? (
            <form
              className="flex flex-wrap items-center gap-2 pt-1"
              onSubmit={(ev) => {
                ev.preventDefault();
                onDecide({ decision: 'edit', split, ...(comment.trim().length >= 3 ? { comment: comment.trim() } : {}) });
              }}
            >
              <label className="flex items-center gap-1 text-caption text-muted">
                Split
                <input type="number" min={1} max={100} value={split} onChange={(e) => setSplit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} className="h-7 w-16 rounded-md border border-line bg-surface px-2 text-caption text-fg" aria-label="Split percent" />%
              </label>
              <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What you did (the DC's comment; empty: the reasons above)" aria-label="DC comment" className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-caption text-fg" />
              <Button size="xs" variant="primary" type="submit" disabled={busy}>
                Claim with these
              </Button>
            </form>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-caption text-muted">{dcSplitWords(s)}</span>
          {s.groupSize > 1 ? <span className="text-caption text-muted">{`${s.sharePercent}% of the work`}</span> : null}
          <div className="flex gap-1">
            {s.splitPercent !== null ? (
              <Button size="xs" variant="secondary" disabled={busy} onClick={() => onDecide({ decision: 'accept' })} data-testid="dc-accept">
                Accept
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" disabled={busy} onClick={onEdit} data-testid="dc-edit">
              Edit
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => onDecide({ decision: 'reject' })} data-testid="dc-reject">
              Reject
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}

const names = (xs: readonly string[]) => (xs.length > 2 ? `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more` : xs.join(', '));
const pct = (n: number | null | undefined) => (n === null || n === undefined ? null : `${n}%`);

/** D-103 (b): the row's context chips, in plain words ("Specialist Forecast", never its acronym). */
export function dcContextChips(c: DcSuggestionContext | undefined): Array<{ key: string; text: string }> {
  if (!c) return [];
  const out: Array<{ key: string; text: string }> = [];
  if (c.dcs.length) out.push({ key: 'dcs', text: `${c.dcs.length} Data & AI ${c.dcs.length === 1 ? 'DC' : 'DCs'}: ${names(c.dcs.map((d) => d.ownerName))}` });
  if (c.via === 'sfr' && c.viaAe) out.push({ key: 'via', text: `via ${c.viaAe}’s forecast` });
  else if (c.via === 'team') out.push({ key: 'via', text: 'via opp team' });
  return out;
}

/** The details under the row: whose Specialist Forecast names it, who else holds a DC, which specialists are on it. */
export function dcContextDetails(c: DcSuggestionContext | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.via === 'sfr' && c.viaAe) out.push(`${c.viaAe}’s Specialist Forecast names this opportunity`);
  for (const d of c.dcs) {
    const extra = [d.role ?? null, pct(d.split)].filter((x): x is string => !!x);
    out.push(`Data & AI DC: ${d.ownerName}${extra.length ? ` (${extra.join(', ')})` : ''}`);
  }
  if (c.specialists.length) out.push(`Specialists on it: ${c.specialists.map((p) => (p.isMe ? `${p.name} (you)` : p.name)).join(', ')}`);
  return out;
}
