// NbaCard's props and event types and its primary-action helpers. Split from NbaCard.tsx (max-lines); NbaCard.tsx re-exports the public names.
import type { ReactNode } from 'react';

import type {
  AgentRun, Draft, EntityRef, NbaAlternative, NbaCard as NbaCardVm, NbaVerb, NotNowReason, Proposal, SourceRef,
  WorkItem,
} from '@/contract';
import { VERB_LABEL } from './vocab';

export type NbaPrimaryKind = NbaVerb | 'accept' | 'open_in_claude';
export interface NbaPrimaryEvent {
  kind: NbaPrimaryKind;
  label: string;
  item: WorkItem;
  nba: NbaCardVm | null;
  draft: Draft | null;
  run: AgentRun | null;
  /** start_in_claude / open_in_claude: the claude:// deep link from the contract. The parent opens it. */
  url: string | null;
  /** answer: the chosen chip or typed reply. */
  answer?: string;
}
export type NbaSecondaryKey = 'edit' | 'shorter' | 'snooze' | 'done' | 'resolve' | 'not_done' | 'merge';
export interface NbaCardProps {
  item: WorkItem;
  nba?: NbaCardVm | null;
  draft?: Draft | null;
  run?: AgentRun | null;
  proposals?: Proposal[];
  /** Defaults to item.rank. */
  rank?: number | null;
  /** Controlled expansion; omit to let the card manage it (defaultExpanded). */
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** `triage` forces the dashed "Suggested" treatment (primary = Accept). */
  variant?: 'now' | 'triage';
  /** Collapsed cards show the draft's first line (UI-SPEC §4.3: from 1600 px up; the page decides). */
  draftLine?: boolean;
  /** Spine ↔ card hover link. */
  highlighted?: boolean;
  /** Override preview HTML (still sanitized). Default: derived from the serialized payload. */
  previewHtml?: string;
  /** v1 large start-by headline. v2 always shows the start-by as the badge; kept for compatibility. */
  headline?: boolean;
  now?: string;
  className?: string;

  /** v2: the selected card (j/k or click). Its one action is filled and its border turns accent. */
  selected?: boolean;
  /** v2: the #1 treatment (raised surface, accent top edge, 22 px title, filled action). Default: rank 1. */
  emphasis?: boolean;
  /** v2: the narrower "with panel" layout (smaller padding, no prep line, short effort note). */
  compact?: boolean;
  /** v2: the item is open in the docked panel; the panel footer holds the filled action. */
  inPanel?: boolean;
  /** v2: force the one action filled or quiet (default: filled when `selected` or `emphasis`). Pages pass
   *  `filled={false}` to #1 while another row holds the selection. */
  filled?: boolean;
  /** v2: the page knows the item is blocked (red badge + edge). */
  blocked?: boolean;
  /** v2: replaces the neutral tag's text (e.g. "Outbox" on an aggregate card). */
  tagLabel?: string;
  /** v2: extra content under the why line (prep checklist, a drafts list). Hidden in `compact` unless `extraInCompact`. */
  extra?: ReactNode;
  extraInCompact?: boolean;
  /** v2: replaces the foot's effort note (e.g. "Nothing sends until you approve"). */
  footNote?: ReactNode;
  /** v2: clamp the why line to this many lines (Home: 2 on the lead card, 1 on the others). Unset = the default (2 in compact). */
  whyLines?: 1 | 2 | 3;
  /** The snooze action's label (Home: "Move to Fri", where it wakes on the next working day). Default "Snooze". */
  snoozeLabel?: string;

  onPrimary?: (e: NbaPrimaryEvent) => void;
  onAlternative?: (alt: NbaAlternative, item: WorkItem) => void;
  onSecondary?: (key: NbaSecondaryKey, item: WorkItem) => void;
  onNotNow?: (reason: NotNowReason, item: WorkItem) => void;
  onOpenSource?: (source: SourceRef, item: WorkItem) => void;
  onOpenEntity?: (ref: EntityRef) => void;
  /** Click / Enter → Details (docked panel), ⇧Enter → full page. */
  onOpen?: (item: WorkItem, mode: 'sheet' | 'page') => void;
  onApplyProposal?: (proposal: Proposal) => void;
  onKeepMine?: (proposal: Proposal) => void;
  /** Undo a reopen / loop-back label. */
  onUndoReopen?: (item: WorkItem) => void;
  onHover?: (itemId: string | null) => void;
}
export const NOT_NOW: Array<{ reason: NotNowReason; label: string }> = [
  { reason: 'done_elsewhere', label: 'Done elsewhere' },
  { reason: 'not_mine', label: 'Not mine' },
  { reason: 'later', label: 'Later' },
  { reason: 'wrong_account', label: 'Wrong account' },
];
type Primary = { kind: NbaPrimaryKind; label: string; url: string | null } | null;
export function primaryFor(item: WorkItem, nba: NbaCardVm | null, run: AgentRun | null, triage: boolean): Primary {
  if (triage || item.state === 'suggested') return { kind: 'accept', label: 'Accept', url: null };
  if (item.state === 'likely_done') return { kind: 'confirm_done', label: 'Confirm done', url: null };
  if (item.state === 'waiting_on_me' && run?.kind === 'claude_session') return { kind: 'open_in_claude', label: 'Open in Claude', url: run.deepLink };
  if (!nba) return { kind: 'review', label: 'Review', url: null };
  if (nba.confidence === 'guess' && nba.alternatives.length) return null;
  const url = nba.verb === 'start_in_claude' ? run?.deepLink ?? nba.claudeLaunch?.url ?? null : null;
  return { kind: nba.verb, label: nba.primaryLabel || VERB_LABEL[nba.verb], url };
}
export function isInteractive(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && !!el.closest('button,a,input,textarea,select,label,[role="radio"],[role="tooltip"]');
}
/** Static classes so Tailwind sees them. */
export const WHY_CLAMP = { 1: 'line-clamp-1', 2: 'line-clamp-2', 3: 'line-clamp-3' } as const;
