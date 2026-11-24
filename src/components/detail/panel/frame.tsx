'use client';
/** ItemDetail's frame pieces: the loading skeleton per variant and the panel footer's ONE filled primary. */
import type { ReactNode } from 'react';
import { SendCountdownToast } from '@/components/composer';
import { Button, Skeleton } from '@/ui';
import { usePrimaryClaim, type PrimarySpec } from '../lib/primary';

export type ItemDetailVariant = 'panel' | 'sheet' | 'page';

export function DetailSkeleton({ variant }: { variant: ItemDetailVariant }) {
  if (variant === 'page') {
    return (
      <div className="flex h-full flex-col" aria-busy aria-label="Loading task">
        <div className="border-b border-line px-6 py-5">
          <Skeleton variant="line" className="w-64" />
          <Skeleton variant="line" className="mt-3 w-2/3" />
          <div className="mt-3 flex gap-6">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} variant="line" className="w-24" />
            ))}
          </div>
        </div>
        <div className="grid flex-1 content-start items-start gap-6 p-6 @5xl/detail:grid-cols-2">
          <Skeleton variant="card" />
          <Skeleton variant="row" count={6} />
        </div>
      </div>
    );
  }
  if (variant === 'panel') {
    return (
      <div className="flex h-full flex-col" aria-busy aria-label="Loading task">
        <div className="space-y-3 border-b border-line px-6 py-4">
          <Skeleton variant="line" className="w-48" />
          <Skeleton variant="line" className="w-3/4" />
          <Skeleton variant="line" className="w-2/3" />
        </div>
        <div className="space-y-6 px-6 py-4">
          <Skeleton variant="line" count={3} />
          <Skeleton variant="block" className="h-24 w-full" />
          <Skeleton variant="row" count={3} />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3" aria-busy aria-label="Loading task">
      <Skeleton variant="line" className="w-1/2" />
      <Skeleton variant="line" count={2} />
      <Skeleton variant="block" className="h-20 w-full" />
      <Skeleton variant="card" />
    </div>
  );
}

/**
 * The panel footer's ONE filled action: the next step's claim (NBA, composer Send/Push, a countdown, a busy line), else
 * the item's own verb (Accept, Confirm done, Reopen), else Done. The kit DetailPanel places it beside Later ▾ / Done ▾.
 */
/** A primary of the item's own (`action` is its data-action: done, accept, confirm, reopen). */
export type OwnPrimary = PrimarySpec & { action?: string };

export function PanelPrimary({ fallback, forced, children }: { fallback: OwnPrimary; forced: OwnPrimary | null; children?: ReactNode }) {
  const claim = usePrimaryClaim();
  const spec: PrimarySpec = forced ?? claim ?? fallback;
  const fromNba = !forced && !!claim;
  return (
    <>
      {children}
      {spec.countdown ? (
        <SendCountdownToast deadline={spec.countdown.deadline} durationMs={spec.countdown.durationMs} label={spec.countdown.label} dryRun={spec.countdown.dryRun} onUndo={spec.countdown.onUndo} className="max-w-full min-w-72" />
      ) : spec.busyLabel ? (
        <span role="status" className="inline-flex h-9 items-center gap-2 rounded-md bg-surface-muted px-3 text-body text-muted">
          <span aria-hidden className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent" />
          {spec.busyLabel}
        </span>
      ) : (
        <Button
          variant="primary"
          size="md"
          disabled={spec.disabled}
          loading={spec.loading}
          title={spec.disabled && spec.hint ? spec.hint : spec.kbd === 'mod+enter' ? `${spec.label} (⌘↵)` : undefined}
          onClick={() => spec.run()}
          data-nba-primary={fromNba || undefined}
          data-panel-primary
          data-action={!fromNba && (forced ?? fallback).action ? (forced ?? fallback).action : undefined}
        >
          {spec.label}
        </Button>
      )}
    </>
  );
}
