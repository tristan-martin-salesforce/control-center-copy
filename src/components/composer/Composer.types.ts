// Composer's handle, props and state types. Split from Composer.tsx (max-lines); Composer.tsx re-exports the public names.
import type { Ref } from 'react';

import type { Destination, DispatchMode, DispatchResult, Draft, Person, TipTapDoc } from '@/contract';
import type { SendOutcome, SendState } from './send-flow';
import { stagedLabel, stagedWhere } from '@/components/lists/outbox';

/** "Saved as Slack draft · find it in Slack ▸ Drafts": a saved draft waits in its app for you to send it. */
export function stagedLine(destination: Draft['destination'], channel: string): string {
  const where = stagedWhere(destination);
  return `${stagedLabel(destination) ?? `Saved as ${channel} draft`}${where ? ` · find it ${where}` : ''}`;
}
export interface ComposerHandle {
  focus(): void;
  /** Append a paragraph as if typed (marks the draft touched, schedules autosave). Doesn't move focus. */
  appendText(text: string): void;
  /** Save now. Resolves true when nothing is left unsaved. */
  flush(): Promise<boolean>;
  /** Same as the primary button: opens the confirm for the current Draft/Send mode. */
  send(): void;
  /** Cancel a running send countdown (no-op otherwise). */
  undo(): void;
  getDoc(): TipTapDoc | null;
}
/** What the host draws when it owns the primary (`primaryPlacement="external"`). */
export interface ComposerPrimaryState {
  label: string;
  icon: 'send' | 'edit';
  disabled: boolean;
  loading: boolean;
  /** Why it can't send yet ("Write something first"). */
  blockedReason: string | null;
  mode: DispatchMode;
  /** While the undo window runs, the host shows the countdown with Undo in place of the button. */
  countdown: { deadline: number; durationMs: number; label: string; dryRun: boolean } | null;
  /** "Rendering…" / "Sending to Slack…" while dispatching. */
  busyLabel: string | null;
  /** Final or read-only: no primary at all. */
  hidden: boolean;
}
export interface ComposerProps {
  /** Load the draft by id (GET /drafts/:id). */
  draftId?: string;
  /** Or pass it (seeds the cache; the composer still saves to PATCH /drafts/:id). */
  draft?: Draft;
  /** Preview-only: no editing, no sending. */
  readOnly?: boolean;
  /** People on this work: mention candidates (with Slack ids / emails) and switch targets. Merged with the item's initiative people. */
  people?: Person[];
  /** Extra destinations offered by the destination chip. */
  destinations?: Destination[];
  /** Start in "Preview as recipient". */
  defaultPreview?: boolean;
  /** Start with "View payload" open. */
  defaultShowPayload?: boolean;
  autoFocus?: boolean;
  onSaved?: (draft: Draft) => void;
  /** Dispatch finished (dry run, staged or sent). `result` is null when the backend answered `dry_run` (423). */
  onDispatched?: (result: DispatchResult | null, outcome: SendOutcome) => void;
  onSendStateChange?: (state: SendState) => void;
  className?: string;
  ref?: Ref<ComposerHandle>;
  /** Compact chrome (ComposerInline). */
  variant?: 'full' | 'inline';
  /** Inline only: "Open full composer". */
  onExpand?: () => void;
  /** `external`: don't draw the Send/Push button or the countdown; report them through onPrimaryChange. */
  primaryPlacement?: 'footer' | 'external';
  onPrimaryChange?: (state: ComposerPrimaryState) => void;
}
export type PersonLike = Pick<Person, 'id' | 'name'> & Partial<Pick<Person, 'email' | 'slackHandle' | 'isExternal'>>;
export const FINAL_STATUSES: Draft['status'][] = ['sending', 'sent', 'staged', 'verified'];
