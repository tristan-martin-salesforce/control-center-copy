/**
 * The two release items on the Outbox (D-90, W12-7), pure: what their rows and Review cards show and which verb comes
 * first. The components (OutboxRow, OutboxReview, ReleaseParts) only render this.
 *
 *   release.drive_upload   Upload v<v> to the releases folder · folder · build · sha256 <12>
 *                          verbs: Copy upload instructions → (copied) Mark uploaded. No tool call: Mark uploaded tells
 *                          the app you put the files in Drive yourself (it records the hand-off; nothing is sent).
 *   release.announce       #channel · Command Center v<v> · the post's first line
 *                          verb: the usual Approve & send (preview, confirm, undo window, the dry run).
 * An item with no folder / channel says what to set once (its line, no chip) and offers no verb that would go nowhere.
 */
import type { Draft, OutboxItem } from '@/contract';
import { isReleaseHandoff, isReleaseItem, releaseRowFacts, type ReleaseRowFacts } from '@/outbox/adapters/release-handoff';

export interface ReleaseRowView extends ReleaseRowFacts {
  /** The why line: the post's first line (announce) or folder · build · sha (upload). */
  why: string;
  /** Meta chips, in order: the version, where it goes, the sha256 short. */
  chips: string[];
}

export const isReleaseDraft = (d: Pick<Draft, 'destination'>): boolean => isReleaseItem(d.destination);
export const isHandoffDraft = (d: Pick<Draft, 'destination'>): boolean => isReleaseHandoff(d.destination);

export function releaseRowView(d: Pick<Draft, 'destination' | 'plainText'>): ReleaseRowView | null {
  const dest = d.destination;
  if (!isReleaseItem(dest)) return null;
  const f = releaseRowFacts(dest);
  // what is not set is said once, by the row's line (`missing`): no chip or why part repeats it
  const chips = [`v${f.version}`, ...(f.where ? [f.kind === 'upload' ? 'Drive folder' : f.where] : []), ...(f.shaShort ? [`sha256 ${f.shaShort}`] : [])];
  const first = (dest.text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const why = f.kind === 'announce' ? first.replace(/\*/g, '') : [f.where ? 'Drive folder' : null, (dest.input as { artifactName?: string }).artifactName, f.shaShort ? `sha256 ${f.shaShort}` : null].filter(Boolean).join(' · ');
  return { ...f, why, chips };
}

/** The upload row's verbs, before and after you copied the instructions. */
export function handoffVerbs(copied: boolean, missing: string | null): { primary: 'copy' | 'mark'; markDisabled: boolean } {
  return { primary: copied && !missing ? 'mark' : 'copy', markDisabled: !!missing };
}

/** The approve key / Review approve of a release item: the hand-off is marked uploaded, an announcement is sent as usual. */
export const releaseApproveKind = (it: Pick<OutboxItem, 'draft'>): 'mark' | 'send' | null => (!isReleaseDraft(it.draft) ? null : isHandoffDraft(it.draft) ? 'mark' : 'send');
