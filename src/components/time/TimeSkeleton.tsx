'use client';
/**
 * Time's loading skeleton, data-free, in the shape of Log hours (docs/archive/2026-build/time-redesign.md): the context head
 * (sentence · week arrows), the quarter header, then the path's sections, so nothing jumps when /time lands.
 * TimePage renders the body (the selected week's part) while the week loads; the route's loading.tsx and the shell's
 * pending-navigation skeleton render the whole page.
 */
import { ContextPage } from '@/components/deals/context-frame';
import { ActivityHead } from './ActivityHead';
import { Button, IconButton, Skeleton } from '@/ui';

const noop = () => {};

/** The selected week's part while it loads (TimePage's Suggested section). */
export function TimeBodySkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-3" aria-busy="true">
      <Skeleton variant="block" className="h-9 w-72 max-w-full" />
      <Skeleton variant="block" className="h-6 w-full max-w-xl" />
      <Skeleton variant="block" className="h-8 w-48" />
    </div>
  );
}

export function TimeSkeleton() {
  return (
    <ContextPage label="Time">
      <ActivityHead
        sentence="Loading the week…"
        actions={
          <div className="flex items-center gap-1">
            <IconButton icon="chevronleft" label="Previous week" onClick={noop} />
            <Button size="sm" variant="quiet" disabled>
              This week
            </Button>
            <IconButton icon="chevronright" label="Next week" onClick={noop} />
          </div>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6" aria-busy="true">
        <Skeleton variant="block" className="h-44 w-full" />
        <TimeBodySkeleton />
        <Skeleton variant="block" className="h-24 w-full" />
        <Skeleton variant="block" className="h-40 w-full" />
      </div>
    </ContextPage>
  );
}
