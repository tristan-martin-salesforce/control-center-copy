'use client';
/**
 * Budgets ▸ What the Assistant remembers (SEC-8, 17-security-review.md): every pinned note and every preference, the
 * entries that ride into later turns on their own, each with the message it came from (thread title, date and your
 * first words) and Forget. GET /chat/memory?scope=pinned; Forget is POST /chat/memory/:id/delete, the route the
 * Assistant panel uses. Forgetting can't be undone (say it again to keep it), so it takes a second click, like Data's
 * "Clean up now".
 */
import { useRef, useState } from 'react';
import type { ChatMemoryEntry } from '@/contract';
import { api } from '@/client/api';
import { useApi } from '@/client/hooks';
import { toast } from '@/client/toast';
import { Button, Skeleton, useTimeZone } from '@/ui';
import { Block } from './form';

/** "Nov 5, 00:50" in the user's time zone. */
export function memoryWhen(iso: string, tz?: string): string {
  return new Intl.DateTimeFormat('en-US', { ...(tz ? { timeZone: tz } : {}), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** The plain-words source line of an entry. */
export function memorySourceLine(e: Pick<ChatMemoryEntry, 'kind' | 'source'>, tz?: string): string {
  const what = e.kind === 'preference' ? 'Every thread' : 'Pinned in its thread';
  if (!e.source) return `${what} · the message it came from is no longer here`;
  return `${what} · from your message in “${e.source.threadTitle}”, ${memoryWhen(e.source.at, tz)}`;
}

function MemoryRow({ e, tz, onForgot }: { e: ChatMemoryEntry; tz?: string; onForgot: () => void }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forget = async () => {
    if (!armed) return setArmed(true);
    setBusy(true);
    setError(null);
    try {
      await api('deleteChatMemory', { params: { id: e.id }, body: {} });
      toast({ key: `memory:${e.id}`, title: 'Forgotten', body: 'The Assistant no longer sees it. Say it again to keep it.', durationMs: 4000 });
      onForgot();
    } catch (err) {
      setError((err as Error).message);
      setArmed(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex min-w-0 items-start gap-3 py-2" data-memory={e.id} data-memory-kind={e.kind}>
      <div className="min-w-0 flex-1">
        <p className="text-body text-fg" data-memory-text>
          {e.text}
        </p>
        <p className="text-caption text-muted" data-memory-source>
          {memorySourceLine(e, tz)}
        </p>
        {e.source?.excerpt ? (
          <p className="truncate text-caption text-faint" title={e.source.excerpt}>
            “{e.source.excerpt}”
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-caption text-danger-700">
            Couldn’t forget it: {error}
          </p>
        ) : null}
      </div>
      <Button variant={armed ? 'danger' : 'secondary'} size="sm" loading={busy} onClick={() => void forget()} onBlur={() => !busy && setArmed(false)} data-memory-forget={armed ? 'confirm' : 'first'}>
        {armed ? 'Forget for good' : 'Forget'}
      </Button>
    </li>
  );
}

export function AssistantMemoryBlock() {
  const tz = useTimeZone();
  const q = useApi('listChatMemory', { query: { scope: 'pinned' } });
  const entries = q.data?.entries ?? [];
  const listRef = useRef<HTMLDivElement | null>(null);
  // The row and its button leave with the entry, so focus moves to the next entry's Forget (else the one before,
  // else the list) instead of falling to the page.
  const forgot = async (id: string) => {
    const ids = entries.map((e) => e.id);
    const i = ids.indexOf(id);
    const next = ids[i + 1] ?? ids[i - 1] ?? null;
    await q.refetch();
    const target = next ? listRef.current?.querySelector<HTMLElement>(`[data-memory="${next}"] [data-memory-forget]`) : null;
    (target ?? listRef.current)?.focus();
  };
  return (
    <Block id="budgets-memory" title="What the Assistant remembers" help="Your preferences and pinned notes go into every later message on their own. Each one shows the message it came from; Forget removes it.">
      <div data-testid="assistant-memory" ref={listRef} tabIndex={-1} className="outline-none">
        {q.isError && !q.data ? (
          <p role="alert" className="text-caption text-danger-700">
            Couldn’t read the Assistant’s memory: {q.error.message}{' '}
            <button type="button" className="font-bold hover:underline" onClick={() => void q.refetch()}>
              Retry
            </button>
          </p>
        ) : !q.data ? (
          <Skeleton variant="line" count={2} />
        ) : entries.length ? (
          <ul className="flex flex-col divide-y divide-line">
            {entries.map((e) => (
              <MemoryRow key={e.id} e={e} tz={tz} onForgot={() => void forgot(e.id)} />
            ))}
          </ul>
        ) : (
          <p className="text-body text-muted" data-memory-empty>
            Nothing kept. When you ask the Assistant to remember something for every thread, it shows here with the message it came from.
          </p>
        )}
      </div>
    </Block>
  );
}
