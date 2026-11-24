/**
 * Drafts and the Outbox, read side (R7 step 3): the Outbox page's groups and Activity's admin items.
 */
import type { OutboxGroup, OutboxItem, OutboxPayload } from '@/contract';
import { isAdminDraft } from '@/contract';
import { actionSummary } from '@/lib/actions';
import { sortOutboxNewestFirst } from '@/outbox/adapters/release-handoff';
import { draftHasSurface, personaOf } from '@/personas';
import { baseCandidates, draftSourceLink, groupBy } from '@/server/datasource/draft-source';

import type { ReadSource } from './source';

export function outboxGroupOf(status: string): OutboxGroup | null {
  if (status === 'ready') return 'pending_approval';
  if (status === 'scheduled') return 'scheduled';
  if (['sending', 'sent', 'staged', 'verified', 'verify_failed'].includes(status)) return 'sent';
  if (status === 'failed') return 'failed';
  return null;
}

const OUTBOX_LABEL: Record<OutboxGroup, string> = { pending_approval: 'Pending approval', scheduled: 'Scheduled', sent: 'Sent', failed: 'Failed' };

/** D-75: the applied admin items the payload carries for the assistant (newest first); Activity has the full history. */
const ADMIN_APPLIED_KEEP = 50;

/** GET /outbox. `me` is the user the draft-source candidates are relative to. */
export function buildOutbox(src: ReadSource, me: { name: string }): OutboxPayload {
  const groups: Record<OutboxGroup, OutboxItem[]> = { pending_approval: [], scheduled: [], sent: [], failed: [] };
  const evidenceOf = groupBy(src.all('evidence'), (e) => e.workItemId);
  // D-52, D-75: admin items (logging and forecast canvases, VDP changes) are Activity's, never the Outbox page's: the
  // ones to act on are `admin.items` (Activity reads them), the applied ones `admin.applied` (the assistant's history).
  // Messages and the feedback post (D-56) are the Outbox's own.
  const admin: OutboxItem[] = [];
  const applied: OutboxItem[] = [];
  // D-55: an inactive feature's items have no daily surface (VDP changes without VDP)
  const persona = personaOf(src.settings());
  for (const d of src.all('drafts').filter((x) => draftHasSurface(x, persona))) {
    const g = outboxGroupOf(d.status);
    if (!g) continue;
    const into = isAdminDraft(d) ? (g === 'pending_approval' || g === 'failed' ? admin : applied) : groups[g];
    const wi = d.workItemId ? src.get('workItems', d.workItemId) : undefined;
    into.push({
      draft: d,
      group: g,
      workItem: wi ? { id: wi.id, title: wi.title } : null,
      // the row's "Open in Slack / Gmail" from what the read source has (thread context, evidence); the panel reads the thread
      source: draftSourceLink({ draft: d, candidates: baseCandidates(d, wi ? (evidenceOf.get(wi.id) ?? []) : [], me), itemSources: wi?.sources ?? [] }),
      // A structured action previews its changes, before → after.
      previewText: d.destination.kind === 'action' ? actionSummary(d.destination) : d.plainText.split('\n').slice(0, 3).join('\n'),
      history: [
        { at: d.createdAt, label: 'Drafted' },
        ...d.attempts.map((a) => ({ at: a.at, label: `${a.dryRun ? 'Dry run' : a.mode === 'send' ? 'Sent' : 'Draft pushed'} · ${a.outcome}` })),
        ...(d.verification?.at ? [{ at: d.verification.at, label: d.verification.detail }] : []),
      ],
    });
  }
  // newest first; a release's upload above its announcement (the post links the upload)
  for (const g of Object.keys(groups) as OutboxGroup[]) sortOutboxNewestFirst(groups[g]);
  return {
    groups: (Object.keys(groups) as OutboxGroup[]).map((g) => ({ group: g, label: OUTBOX_LABEL[g], items: groups[g] })),
    counts: { pending_approval: groups.pending_approval.length, scheduled: groups.scheduled.length, sent: groups.sent.length, failed: groups.failed.length },
    dryRun: src.settings().sending.dryRun,
    admin: {
      items: admin.sort((a, b) => b.draft.updatedAt.localeCompare(a.draft.updatedAt)),
      pending: admin.filter((i) => i.group === 'pending_approval').length,
      failed: admin.filter((i) => i.group === 'failed').length,
      applied: applied.sort((a, b) => b.draft.updatedAt.localeCompare(a.draft.updatedAt)).slice(0, ADMIN_APPLIED_KEEP),
    },
  };
}
