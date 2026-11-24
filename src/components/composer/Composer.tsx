'use client';
/**
 * Composer (UI-SPEC §7, R-UI-5): one TipTap document, per-destination capability profiles, preview from the
 * serialized payload, autosave with ifVersion, proposals instead of overwrites, and the border:
 * Draft ↔ Send → confirm → 10 s undo → dispatch → read-back. Nothing leaves without an explicit
 * Send/Push plus a confirm.
 *
 * Keys (when focus is inside): ⌘↵ primary · ⌥P preview · ⌘⇧C switch channel · ⌘/ AI chips · Esc blur ·
 * ⌘Z undo during the countdown.
 *
 * v2 (DESIGN-V2): calm chrome, reading text ≤ 68ch at 16/24, the destination as a neutral label, one
 * filled primary. `primaryPlacement="external"` hands the primary (and the countdown's Undo) to the host,
 * e.g. the docked panel's sticky footer, through `onPrimaryChange`; the Draft/Send toggle stays here.
 */
import { useApi } from '@/client/hooks';
import { Button, Icon } from '@/ui';
import { cx } from './_bits';
import type { ComposerProps } from './Composer.types';
import { ComposerBody } from './Composer.body';
export type { ComposerHandle, ComposerPrimaryState, ComposerProps } from './Composer.types';

export function Composer(props: ComposerProps) {
  const id = props.draftId ?? props.draft?.id ?? '';
  const q = useApi('getDraft', { params: { id } }, { enabled: !!id, initialData: props.draft });
  const inline = props.variant === 'inline';
  if (!id) return <ComposerShell inline={inline} className={props.className} message="No draft to show." />;
  if (!q.data) {
    if (q.isError) {
      return (
        <ComposerShell inline={inline} className={props.className} tone="risk" message={`This draft couldn't load: ${q.error.message}`}>
          <Button size="sm" variant="secondary" onClick={() => void q.refetch()}>
            Retry
          </Button>
        </ComposerShell>
      );
    }
    return <ComposerSkeleton inline={inline} className={props.className} />;
  }
  return <ComposerBody key={id} {...props} initial={q.data} server={q.data} />;
}

function ComposerShell({ inline, className, message, tone, children }: { inline?: boolean; className?: string; message: string; tone?: 'risk'; children?: React.ReactNode }) {
  return (
    <section className={cx('flex items-center gap-3 rounded-lg border border-line bg-surface px-4', inline ? 'h-16' : 'h-40', className)}>
      <Icon name={tone === 'risk' ? 'error' : 'info'} size="sm" className={tone === 'risk' ? 'text-danger-700' : 'text-muted'} />
      <p className={cx('text-body', tone === 'risk' ? 'text-danger-700' : 'text-muted')}>{message}</p>
      {children}
    </section>
  );
}

export function ComposerSkeleton({ inline, className }: { inline?: boolean; className?: string }) {
  return (
    <section aria-busy aria-label="Loading draft" className={cx('rounded-lg border border-line bg-surface', className)}>
      <div className={cx('flex items-center gap-2 border-b border-line px-3', inline ? 'h-10' : 'h-11')}>
        <span className="h-7 w-48 animate-pulse rounded-md bg-surface-sunken" />
        <span className="ml-auto h-4 w-20 animate-pulse rounded-sm bg-surface-sunken" />
      </div>
      <div className="space-y-2 px-4 py-4">
        <span className="block h-3 w-3/4 animate-pulse rounded-sm bg-surface-sunken" />
        <span className="block h-3 w-2/3 animate-pulse rounded-sm bg-surface-sunken" />
        <span className="block h-3 w-1/2 animate-pulse rounded-sm bg-surface-sunken" />
      </div>
      <div className="flex h-12 items-center justify-end gap-2 border-t border-line px-3">
        <span className="h-8 w-28 animate-pulse rounded-md bg-surface-sunken" />
      </div>
    </section>
  );
}
