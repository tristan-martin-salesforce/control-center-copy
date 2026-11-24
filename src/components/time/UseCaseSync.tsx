'use client';
/**
 * D-67: Time ▸ Log it ▸ "Use cases in Org62": the use cases only you can settle on the Org62 side (a value to change
 * there by hand, a record deleted there, a duplicate, one Org62 has before its VDP exists), each with its Org62 link
 * and, where there is a choice, Add it again / Leave it (D-61 decisions, with Undo). Quiet when there is nothing.
 */
import { useCallback, useState } from 'react';

import { api } from '@/client/api';
import { useApi } from '@/client/hooks';
import { usePersona } from '@/client/persona';
import { toast } from '@/client/toast';
import { featureActive } from '@/personas/gates';
import { Button } from '@/ui';

import { ucRows, type UcRow } from './use-case-derive';

export function UseCaseSync() {
  const persona = usePersona();
  const on = featureActive(persona, 'vdp');
  const sync = useApi('getUseCaseSync', undefined, { enabled: on });
  const [busy, setBusy] = useState<string | null>(null);
  const rows = on ? ucRows(sync.data) : [];

  const act = useCallback(async (r: UcRow, a: UcRow['actions'][number]) => {
    setBusy(r.key);
    try {
      if (a.kind === 'undo') await api('clearNeedDecision', { body: { rule: a.rule, subjectIds: [r.key] } });
      else await api('decideNeed', { body: { rule: a.rule, subjectIds: [r.key], kind: 'not_needed', reason: a.kind === 'readd' ? 'Add it to Org62 again' : 'Leave it as it is', label: r.title } });
      toast({ key: `uc:${r.key}`, tone: 'success', title: a.kind === 'readd' ? `${r.title}: goes in your next batch` : a.kind === 'leave' ? `${r.title}: left as it is` : `${r.title}: back on the list` });
    } catch (err) {
      toast({ key: `uc:${r.key}`, tone: 'error', title: 'Could not save that', body: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }, []);

  if (!rows.length) return null;
  const open = rows.filter((r) => !r.quiet).length;
  return (
    <section id="time-use-cases" aria-labelledby="time-use-cases-h" data-testid="time-use-cases" className="flex min-w-0 scroll-mt-4 flex-col rounded-lg bg-surface">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3 pb-2">
        <h3 id="time-use-cases-h" className="text-body-lg font-bold text-fg-heading">
          Use cases in Org62
        </h3>
        {open ? <span className="text-caption text-muted tabular-nums">{open} need you</span> : null}
        <span className="min-w-0 basis-full text-caption text-muted">VDP and Org62 both keep your use cases. These differ in a way only you can settle: nothing changes in either system until you do.</span>
      </div>
      <ul className="min-w-0 space-y-2 px-4 pb-3" aria-label="Use cases in Org62">
        {rows.map((r) => (
          <li key={r.key} className={r.quiet ? 'text-muted' : undefined} data-testid="time-use-case-row">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-bold">{r.title}</span>
              <span className="text-caption">{r.label}</span>
              {r.where ? <span className="text-caption text-muted">{r.where}</span> : null}
              {r.org62Url ? (
                <a className="text-caption text-link hover:underline" href={r.org62Url} target="_blank" rel="noreferrer">
                  Org62 ↗
                </a>
              ) : null}
              {r.vdpUrl ? (
                <a className="text-caption text-link hover:underline" href={r.vdpUrl} target="_blank" rel="noreferrer">
                  VDP ↗
                </a>
              ) : null}
            </div>
            <p className="text-caption">{r.why}</p>
            {r.actions.length ? (
              <div className="mt-1 flex gap-2">
                {r.actions.map((a) => (
                  <Button key={a.kind} size="sm" variant={a.kind === 'readd' ? 'secondary' : 'ghost'} disabled={busy === r.key} onClick={() => void act(r, a)}>
                    {a.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
