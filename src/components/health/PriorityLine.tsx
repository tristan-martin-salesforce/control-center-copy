'use client';
/**
 * Health's one priority line (lane 07 R8): how often priority@2 (in shadow) agrees with the shown Top 3 over 7 days,
 * the biggest disagreement, and at most one suggested rule from your moves, with one click (*Suggest, then learn*):
 * Apply nudges one persona weight within bounds (undoable), Dismiss keeps it as it is.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '@/client/api';
import { toast } from '@/client/toast';
import type { HealthPayload } from '@/contract';
import { Button } from '@/ui';
import { AppLink } from '@/components/shell/AppLink';
import { healthPlain } from './plain';
import { RANKING_SETTINGS_HREF } from './settings-links';

export function PriorityLine({ p }: { p: NonNullable<HealthPayload['priority']> }) {
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: (d: { id: string; decision: 'apply' | 'dismiss' }) => api('decidePriorityRule', { params: { id: d.id }, body: { decision: d.decision } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['health'] });
      void qc.invalidateQueries({ queryKey: ['today'] });
      toast({ key: 'priority-rule', tone: 'success', title: r.entity.status === 'applied' ? 'Rule applied: the next re-rank uses it' : 'Rule dismissed' });
    },
    onError: () => toast({ key: 'priority-rule', tone: 'error', title: 'That didn’t save. Nothing changed.' }),
  });
  const top = p.disagreements[0];
  return (
    <section aria-label="Ranking" data-health-priority className="grid gap-1 text-caption text-muted">
      <p className="tabular-nums">
        {healthPlain(p.line)}
        {top ? ` · biggest difference: “${top.title}” #${top.v1Rank ?? '–'} now, #${top.v2Rank ?? '–'} under the new ranking` : ''}{' '}
        <AppLink href={RANKING_SETTINGS_HREF} className="font-bold text-link hover:underline" data-settings-link="priority-engine">
          Change in Settings
        </AppLink>
      </p>
      {p.suggestion ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-fg" data-priority-suggestion>
          <span>{p.suggestion.text}</span>
          <Button size="xs" variant="secondary" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.suggestion!.id, decision: 'apply' })}>
            Rank it the way I do
          </Button>
          <Button size="xs" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.suggestion!.id, decision: 'dismiss' })}>
            Keep as is
          </Button>
        </p>
      ) : null}
    </section>
  );
}
