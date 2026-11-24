'use client';
/**
 * Approve from the Outbox: the border (UI-SPEC §7, §8). Approve never sends. It asks the server for the
 * exact payload (POST /drafts/:id/preview), shows the composer's ConfirmSendDialog, and only after an
 * explicit Confirm starts the 10 s "Sending… Undo" window; dispatch fires when that runs out. In dry run
 * the dispatch only renders the payload and the result says so. All of that is the composer's SendFlow
 * state machine, so the Outbox and the composer cannot disagree about what "confirmed" means.
 *
 * "Approve all N" is a queue of the same flow, one draft at a time: each draft gets its own preview and its
 * own Confirm. Cancelling a confirm, undoing a countdown or any error stops the queue; nothing is batched
 * past the border. A failed dispatch retries through a fresh preview and confirm (confirm tokens are
 * single-use), never by re-posting the spent token.
 *
 * The drain mode (ReviewQueue, OutboxReview.tsx) approves through `approveAndWait`: the same flow, one draft at a
 * time, and a promise that settles when the flow does (done → the outcome; cancelled, undone or failed → an error, so
 * the card comes back as a Retry card). `undoPending` takes back what has not left yet: the countdown on screen and
 * the drafts still waiting their turn; a draft already dispatched cannot be undone and says so.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Draft } from '@/contract';
import { api } from '@/client/api';
import { ConfirmSendDialog, SendCountdownToast, SendFlow, type SendState } from '@/components/composer';
import { channelName } from '@/components/composer/destination';
import { actionApp } from '@/lib/actions';

export interface OutboxQueue {
  /** 1-based position of the draft being approved. */
  index: number;
  total: number;
}

export interface OutboxSend {
  /** Open the confirm for this draft (preview first; nothing is sent). */
  approve: (draft: Draft) => void;
  /** Approve several, one preview + confirm each. */
  approveAll: (drafts: Draft[]) => void;
  /** Stop the queue after the current draft (the current confirm stays open until you answer it). */
  stopQueue: () => void;
  queue: OutboxQueue | null;
  state: SendState;
  /** The draft the flow is working on (for inline errors and results on the right row). */
  target: Draft | null;
  /** Retry after a failed preview / retryable dispatch (a fresh preview + confirm). */
  retry: () => void;
  /** Clear a finished or failed flow. */
  reset: () => void;
  /** Mount once: the confirm dialog and the floating undo countdown. */
  overlays: React.ReactNode;
  /** Approve and wait until the flow settles (drain mode); approves queue behind each other. */
  approveAndWait: (draft: Draft) => Promise<SendState['outcome']>;
  /** Take back these drafts if they have not left yet; resolves with the ids that had already gone out. */
  undoPending: (ids: string[]) => string[];
}

/** Why a drain approve did not go out (the Retry card's line). */
export function notSentMessage(state: Pick<SendState, 'phase' | 'undone' | 'error'>): string {
  if (state.phase === 'error') return `${state.error?.message ?? 'Something went wrong.'} Nothing was sent.`;
  return state.undone ? 'Undone before it left. Nothing was sent.' : 'You cancelled the confirm. Nothing was sent.';
}

export function useOutboxSend({ dryRun, undoSec, onDone }: { dryRun: boolean; undoSec: number; onDone?: (d: Draft, outcome: SendState['outcome']) => void }): OutboxSend {
  const targetRef = useRef<Draft | null>(null);
  const undoMsRef = useRef(undoSec * 1000);
  undoMsRef.current = undoSec * 1000;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const [target, setTarget] = useState<Draft | null>(null);
  const [flow] = useState(
    () =>
      new SendFlow({
        preview: (mode) => api('previewDraft', { params: { id: targetRef.current!.id }, body: { mode } }),
        dispatch: (req) => api('dispatchDraft', { params: { id: targetRef.current!.id }, body: req }),
        undoMs: () => undoMsRef.current,
      }),
  );
  const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState);

  const approve = useCallback(
    (draft: Draft) => {
      if (flow.locked) return;
      targetRef.current = draft;
      setTarget(draft);
      void flow.open(draft.mode);
    },
    [flow],
  );

  // ---- the queue ----------------------------------------------------------------------------
  const rest = useRef<Draft[]>([]);
  const [queue, setQueue] = useState<OutboxQueue | null>(null);
  const queueRef = useRef<OutboxQueue | null>(null);
  queueRef.current = queue;
  const stopQueue = useCallback(() => {
    rest.current = [];
    setQueue(null);
  }, []);
  const approveAll = useCallback(
    (drafts: Draft[]) => {
      if (flow.locked || !drafts.length) return;
      rest.current = drafts.slice(1);
      setQueue(drafts.length > 1 ? { index: 1, total: drafts.length } : null);
      approve(drafts[0]!);
    },
    [approve, flow],
  );

  // Tell the page when a dispatch settles (once per completion), and move the queue along.
  const outcome = state.outcome;
  const prevPhase = useRef(state.phase);
  useEffect(() => {
    const was = prevPhase.current;
    prevPhase.current = state.phase;
    if (was === state.phase) return;
    const d = targetRef.current;
    if (state.phase === 'done' && d) doneRef.current?.(d, outcome);
    const q = queueRef.current;
    if (!q) return;
    if (state.phase === 'done') {
      const next = rest.current.shift();
      if (!next) return setQueue(null);
      setQueue({ index: q.index + 1, total: q.total });
      // Next tick: let the finished row show its result first.
      setTimeout(() => approve(next), 0);
    } else if (state.phase === 'idle' || state.phase === 'error') {
      // Cancelled, undone or failed: stop. Nothing else goes out without its own confirm.
      stopQueue();
    }
  }, [state.phase, outcome, approve, stopQueue]);

  // ---- drain mode: approve and wait ----------------------------------------------------------------
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const settle = useRef<{ id: string; resolve: (o: SendState['outcome']) => void; reject: (e: Error) => void } | null>(null);
  const skip = useRef(new Set<string>());
  const sent = useRef(new Set<string>());
  const approveAndWait = useCallback(
    (draft: Draft) => {
      const run = () =>
        new Promise<SendState['outcome']>((resolve, reject) => {
          if (skip.current.delete(draft.id)) return resolve(null);
          if (flow.locked) return reject(new Error('Another send is still in progress. Nothing was sent; try again in a moment.'));
          settle.current = { id: draft.id, resolve, reject };
          approve(draft);
        });
      const p = chain.current.then(run, run);
      chain.current = p.catch(() => undefined);
      return p;
    },
    [approve, flow],
  );
  const undoPending = useCallback(
    (ids: string[]) => {
      const gone: string[] = [];
      for (const id of ids) {
        if (sent.current.has(id)) gone.push(id);
        else if (settle.current?.id === id) {
          if (flow.getState().phase === 'countdown') flow.undo();
          else flow.cancel();
        } else skip.current.add(id);
      }
      return gone;
    },
    [flow],
  );
  useEffect(() => {
    const w = settle.current;
    if (!w) return;
    if (state.phase === 'done') {
      sent.current.add(w.id);
      settle.current = null;
      w.resolve(state.outcome);
    } else if (state.phase === 'idle' || state.phase === 'error') {
      // idle before the first open() of this waiter is the flow resetting; only settle once it has started
      if (state.phase === 'idle' && !state.undone && state.preview === null && targetRef.current?.id !== w.id) return;
      settle.current = null;
      w.reject(new Error(notSentMessage(state)));
    }
  }, [state]);

  const dest = target?.destination;
  const overlays = (
    <>
      {dest ? (
        <ConfirmSendDialog
          open={state.phase === 'previewing' || state.phase === 'confirming'}
          mode={state.mode}
          destination={dest}
          preview={state.preview}
          loading={state.phase === 'previewing'}
          dryRun={dryRun}
          undoSec={undoSec}
          onConfirm={() => flow.confirm()}
          onCancel={() => flow.cancel()}
        />
      ) : null}
      {state.phase === 'countdown' && state.deadline && dest ? (
        <SendCountdownToast
          variant="floating"
          deadline={state.deadline}
          durationMs={state.undoMs}
          dryRun={dryRun}
          label={dest.kind === 'action' ? `Applying to ${actionApp(dest.action)}: ${dest.target.label}` : state.mode === 'send' ? `Sending to ${dest.kind === 'slack' ? dest.channelName : 'email'}` : `Pushing ${channelName(dest)} draft`}
          onUndo={() => flow.undo()}
        />
      ) : null}
    </>
  );

  return { approve, approveAll, stopQueue, queue, state, target, retry: () => void flow.retry(), reset: () => flow.reset(), overlays, approveAndWait, undoPending };
}
