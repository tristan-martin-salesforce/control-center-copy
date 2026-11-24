'use client';
/**
 * ReviewQueue: the drain mode (02-ui-research P1, P3, P10, P11; 01-ui-audit R2). Full height, one card at a time:
 *
 *   Review drafts                     3 of 11  ▰▰▱▱▱▱▱▱▱▱▱            [Approve all sure 4]  [Exit]
 *   ┌ the card (renderCard): proposal, confidence, why, evidence ───────────────────────────┐
 *   └────────────────────────────────────────────────────────────────────────────────────────┘
 *   a Approve · e Edit · s Snooze · x Dismiss · k Back · j Skip · z Undo
 *                                                       Approved 6 · Undo      (the open batch)
 *
 * Generic over `items` and an `adapter` of actions, so Outbox, Needs you, Triage and DC claims share it. Order is
 * stable (review-queue-model.ts); arrivals join the end, marked new. Undo (z or the toast) reverts only the open
 * batch. The end is a terminal screen: "That's everything", what happened, and when the next check runs.
 * Nothing here sends: `approve` is the adapter's existing approve path (*tenet: Nothing leaves without approval*: the
 * Outbox adapter keeps its preview, confirm and undo window).
 */
import { useEffect, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, cn, Kbd } from '@/ui';
import { actOn, actOnMany, closeBatch, failOn, initQueue, moveCursor, pendingOf, progressOf, summaryOf, syncQueue, undoBatch, type QueueModel, type ReviewVerb } from './review-queue-model';

export type { ReviewVerb } from './review-queue-model';

type Act<T> = (item: T) => void | Promise<unknown>;

export interface ReviewAdapter<T> {
  approve: Act<T>;
  snooze?: Act<T>;
  dismiss?: Act<T>;
  /** `e` when there is no inline editor (open the panel, the composer). */
  edit?: (item: T) => void;
  /** Revert one batch (the open one). */
  undo: (batch: { verb: ReviewVerb; items: T[] }) => void | Promise<unknown>;
  /** Button labels ("Approve & send", "Accept", "Claim"). */
  labels?: Partial<Record<ReviewVerb, string>>;
  /** Past tense for the toast and the summary ("Approved", "Claimed"). */
  past?: Partial<Record<ReviewVerb, string>>;
}

export interface ReviewCardContext {
  position: number;
  total: number;
  /** 'new': arrived while you drained · 'gone': handled elsewhere. */
  state?: 'new' | 'gone';
  error?: string;
}

export interface ReviewQueueProps<T extends { id: string }> {
  title: string;
  items: T[];
  adapter: ReviewAdapter<T>;
  renderCard: (item: T, ctx: ReviewCardContext) => ReactNode;
  /** Inline editor for `e` (typed text is never touched by live updates). */
  renderEditor?: (item: T, close: () => void) => ReactNode;
  /** "Approve all sure (N)": one batch, after one confirm that lists them. */
  bulk?: { label: string; filter: (item: T) => boolean; describe: (item: T) => string };
  /** The terminal screen's clock: "Next check in N min". */
  nextCheckMin?: number | null;
  onExit?: () => void;
  /** How long the batch toast (and its Undo) stays. Default 8 s. */
  toastMs?: number;
  /** Take focus on mount so the keys work at once (default true; a gallery turns it off). */
  autoFocus?: boolean;
  className?: string;
}

type Msg = { t: 'sync'; ids: string[] } | { t: 'act'; id: string; verb: ReviewVerb } | { t: 'many'; ids: string[]; verb: ReviewVerb } | { t: 'fail'; id: string; message: string } | { t: 'undo' } | { t: 'close' } | { t: 'move'; dir: 1 | -1 };

function reduce(m: QueueModel, a: Msg): QueueModel {
  switch (a.t) {
    case 'sync':
      return syncQueue(m, a.ids);
    case 'act':
      return actOn(m, a.id, a.verb);
    case 'many':
      return actOnMany(m, a.ids, a.verb);
    case 'fail':
      return failOn(m, a.id, a.message);
    case 'undo':
      return undoBatch(m);
    case 'close':
      return closeBatch(m);
    case 'move':
      return moveCursor(m, a.dir);
  }
}

const VERB_LABEL: Record<ReviewVerb, string> = { approve: 'Approve', snooze: 'Snooze', dismiss: 'Dismiss' };
const VERB_PAST: Record<ReviewVerb, string> = { approve: 'Approved', snooze: 'Snoozed', dismiss: 'Dismissed' };
const EDITABLE = 'input,textarea,select,[contenteditable="true"]';
const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong. Nothing was changed.');

export function ReviewQueue<T extends { id: string }>({ title, items, adapter, renderCard, renderEditor, bulk, nextCheckMin, onExit, toastMs = 8_000, autoFocus = true, className }: ReviewQueueProps<T>) {
  const [m, send] = useReducer(reduce, items, (xs: T[]) => initQueue(xs.map((x) => x.id)));
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** Every row seen (acted rows leave `items`, but Undo and the summary still need them). */
  const seen = useRef(new Map<string, T>());
  for (const it of items) seen.current.set(it.id, it);

  const idsKey = items.map((x) => x.id).join('\u0000');
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    send({ t: 'sync', ids: idsKey ? idsKey.split('\u0000') : [] });
  }, [idsKey]);
  useEffect(() => {
    if (autoFocus) root.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const batchKey = m.batch ? `${m.batch.n}:${m.batch.ids.length}` : '';
  useEffect(() => {
    if (!batchKey) return;
    const t = setTimeout(() => send({ t: 'close' }), toastMs);
    return () => clearTimeout(t);
  }, [batchKey, toastMs]);

  const verbs: ReviewVerb[] = ['approve', ...(adapter.snooze ? (['snooze'] as const) : []), ...(adapter.dismiss ? (['dismiss'] as const) : [])];
  const label = (v: ReviewVerb) => adapter.labels?.[v] ?? VERB_LABEL[v];
  const past = (v: ReviewVerb) => adapter.past?.[v] ?? VERB_PAST[v];
  const current = m.cursor ? seen.current.get(m.cursor) ?? null : null;
  const gone = !!current && m.gone.includes(current.id);
  const progress = progressOf(m);
  const pending = pendingOf(m);
  const sure = bulk ? pending.filter((id) => !m.gone.includes(id)).map((id) => seen.current.get(id)).filter((x): x is T => !!x && bulk.filter(x)) : [];

  const act = (verb: ReviewVerb) => {
    const fn = adapter[verb];
    if (!current || gone || !fn) return;
    setEditing(null);
    setNotice(null);
    send({ t: 'act', id: current.id, verb });
    const item = current;
    Promise.resolve()
      .then(() => fn(item))
      .catch((e: unknown) => send({ t: 'fail', id: item.id, message: errorText(e) }));
  };
  const approveMany = () => {
    const take = sure;
    setConfirming(false);
    if (!take.length) return;
    send({ t: 'many', ids: take.map((x) => x.id), verb: 'approve' });
    for (const item of take)
      Promise.resolve()
        .then(() => adapter.approve(item))
        .catch((e: unknown) => send({ t: 'fail', id: item.id, message: errorText(e) }));
  };
  const undo = () => {
    const b = m.batch;
    if (!b) return;
    const back = b.ids.map((id) => seen.current.get(id)).filter((x): x is T => !!x);
    send({ t: 'undo' });
    Promise.resolve()
      .then(() => adapter.undo({ verb: b.verb, items: back }))
      .catch((e: unknown) => setNotice(`Couldn't undo: ${errorText(e)}`));
  };
  const edit = () => {
    if (!current || gone) return;
    if (renderEditor) setEditing(current.id);
    else adapter.edit?.(current);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest(EDITABLE)) return;
    const k = e.key;
    if (k === 'Escape') {
      if (confirming) setConfirming(false);
      else if (editing) setEditing(null);
      else onExit?.();
    } else if (confirming) return;
    else if (k === 'a') act('approve');
    else if (k === 's' && adapter.snooze) act('snooze');
    else if (k === 'x' && adapter.dismiss) act('dismiss');
    else if (k === 'e') edit();
    else if (k === 'j' || k === 'ArrowDown') send({ t: 'move', dir: 1 });
    else if (k === 'k' || k === 'ArrowUp') send({ t: 'move', dir: -1 });
    else if (k === 'z') undo();
    else return;
    e.preventDefault();
  };

  const toast = m.batch ? (
    <div role="status" data-testid="review-toast" className="pointer-events-auto inline-flex items-center gap-3 rounded-full border border-line-strong bg-surface-raised py-1.5 pr-2 pl-4 text-body text-fg shadow-pop">
      <span>
        <b className="font-bold text-fg-heading">
          {past(m.batch.verb)} {m.batch.ids.length}
        </b>
      </span>
      <Button size="xs" variant="quiet" onClick={undo} kbd="z" data-testid="review-undo">
        Undo
      </Button>
    </div>
  ) : null;

  return (
    <div ref={root} tabIndex={-1} onKeyDown={onKeyDown} data-review-queue="" aria-label={title} role="region" className={cn('relative flex h-full min-h-0 flex-col bg-bg text-fg outline-none', className)}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-6 py-4">
        {/* h2: the drain opens inside a page whose topbar holds the one h1 */}
        <h2 className="text-heading font-bold text-fg-heading">{title}</h2>
        <span className="text-body text-muted tabular-nums" data-testid="review-progress">
          {!progress.total ? 'All clear' : current ? `${progress.position} of ${progress.total}` : `${progress.total} of ${progress.total}`}
        </span>
        <span role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className="flex h-1.5 min-w-24 flex-1 basis-40 gap-0.5 overflow-hidden rounded-full">
          {m.order.map((id) => (
            <span key={id} className={cn('h-full flex-1', m.acted[id] ? 'bg-accent' : id === m.cursor ? 'bg-ink-400' : 'bg-line-strong')} />
          ))}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {bulk && sure.length > 1 && current ? (
            <Button size="sm" variant="secondary" onClick={() => setConfirming(true)} data-testid="review-bulk">
              {bulk.label} {sure.length}
            </Button>
          ) : null}
          {onExit ? (
            <Button size="sm" variant="quiet" onClick={onExit} kbd="esc">
              Exit
            </Button>
          ) : null}
        </span>
      </header>

      <div className="cc-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {confirming && bulk ? (
          <section className="mx-auto max-w-3xl rounded-lg border border-line bg-surface p-5 shadow-raise" data-testid="review-confirm">
            <h3 className="text-body-lg font-bold text-fg-heading">
              {bulk.label} {sure.length}?
            </h3>
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-body text-fg">
              {sure.map((x) => (
                <li key={x.id}>{bulk.describe(x)}</li>
              ))}
            </ul>
            <div className="mt-4 flex gap-2">
              <Button variant="primary" size="sm" onClick={approveMany} data-testid="review-confirm-go">
                {label('approve')} {sure.length}
              </Button>
              <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </section>
        ) : current ? (
          <article key={current.id} data-review-card={current.id} data-state={gone ? 'gone' : m.fresh.includes(current.id) ? 'new' : undefined} className={cn('mx-auto max-w-3xl rounded-lg border border-line bg-surface shadow-raise', gone && 'opacity-70')}>
            {gone ? (
              <p role="status" className="flex items-center gap-3 border-b border-line px-5 py-2.5 text-body text-fg">
                <b className="font-bold">Handled elsewhere.</b> Nothing to do here.
                <Button size="xs" variant="quiet" kbd="j" onClick={() => send({ t: 'move', dir: 1 })} className="ml-auto">
                  Next
                </Button>
              </p>
            ) : null}
            {m.failed[current.id] ? (
              <p role="alert" data-testid="review-error" className="flex items-center gap-3 border-b border-line px-5 py-2.5 text-body text-danger-700">
                <span className="min-w-0 flex-1">{m.failed[current.id]}</span>
                <Button size="xs" variant="secondary" kbd="a" onClick={() => act('approve')}>
                  Retry
                </Button>
              </p>
            ) : null}
            <div className="p-5">{renderCard(current, { position: progress.position, total: progress.total, state: gone ? 'gone' : m.fresh.includes(current.id) ? 'new' : undefined, error: m.failed[current.id] })}</div>
            {editing === current.id && renderEditor ? <div className="border-t border-line p-5">{renderEditor(current, () => setEditing(null))}</div> : null}
          </article>
        ) : (
          <section className="mx-auto flex max-w-3xl flex-col items-center gap-2 py-8 text-center" data-testid="review-done">
            <h3 className="text-heading font-bold text-fg-heading">That&apos;s everything.</h3>
            <p className="text-body text-muted">
              {(Object.entries(summaryOf(m)) as Array<[ReviewVerb, number]>)
                .filter(([, n]) => n > 0)
                .map(([v, n]) => `${n} ${past(v).toLowerCase()}`)
                .join(' · ') || 'Nothing waiting.'}
            </p>
            {nextCheckMin != null ? <p className="text-caption text-muted">Next check in {nextCheckMin} min.</p> : null}
            {onExit ? (
              <Button variant="secondary" size="sm" onClick={onExit} className="mt-2">
                Done
              </Button>
            ) : null}
          </section>
        )}
        {notice ? (
          <p role="alert" className="mx-auto mt-3 max-w-3xl text-body text-danger-700">
            {notice}
          </p>
        ) : null}
      </div>

      {current && !confirming ? (
        <footer className="flex flex-wrap items-center justify-center gap-1 border-t border-line px-6 py-3" aria-label="Keys">
          {verbs.map((v) => (
            <KeyButton key={v} k={v === 'approve' ? 'a' : v === 'snooze' ? 's' : 'x'} label={label(v)} onClick={() => act(v)} disabled={gone} primary={v === 'approve'} />
          ))}
          {renderEditor || adapter.edit ? <KeyButton k="e" label="Edit" onClick={edit} disabled={gone} /> : null}
          <KeyButton k="k" label="Back" onClick={() => send({ t: 'move', dir: -1 })} />
          <KeyButton k="j" label="Skip" onClick={() => send({ t: 'move', dir: 1 })} />
          <KeyButton k="z" label="Undo" onClick={undo} disabled={!m.batch} />
        </footer>
      ) : null}
      {toast ? <div className="pointer-events-none absolute inset-x-0 bottom-20 flex justify-center">{toast}</div> : null}
    </div>
  );
}

function KeyButton({ k, label, onClick, disabled, primary }: { k: string; label: string; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-key={k}
      className={cn(
        'inline-flex h-9 items-center gap-2 rounded-md px-3 text-body font-bold focus-visible:shadow-focus focus-visible:outline-none disabled:cursor-default disabled:opacity-50',
        primary ? 'bg-accent text-on-accent enabled:hover:bg-accent-hover' : 'text-fg enabled:hover:bg-surface-muted',
      )}
    >
      <Kbd tone={primary ? 'inverse' : 'default'}>{k}</Kbd>
      {label}
    </button>
  );
}
