/**
 * POST /outbox/releases (D-90, W12-7): one built release → its two Outbox items, shared by both DataSources through
 * `ReleaseStageHost` (so the mock and db answer alike):
 *
 *   1. release.drive_upload   a hand-off: the build, the feed and install.sh to put in the shared Drive folder, the
 *                             sha256, and "Copy upload instructions" (the exact prompt for Claude Code). No tool call,
 *                             ever: Apply ("Mark uploaded") marks it handed off and records a landing (kind `release`).
 *   2. release.announce       one Slack post to the announcement channel, in the D-56 `slack_send_message` shape: Approve
 *                             → preview → confirm → the undo window → dispatch, under the global dry run (on by default).
 *
 * The Drive folder and the channel are the server's (the `distribution` settings key, else config/team.json, else the env); the
 * request's own values count only when the server has none. Idempotent per version: a pending item of the same version
 * is rewritten in place (or left alone when it already says exactly this), an applied or handed-off one is kept, and a
 * rejected one is replaced by a new item. Nothing is sent here (*Nothing leaves without approval*).
 */
import type { ActionDestination, Draft, StageReleaseRequest, StageReleaseResult } from '@/contract';

import { RELEASE_UPLOAD_KIND, releaseDestinations, releaseVersionOf, type ReleaseHandoffInput } from './adapters/release-handoff';

export interface ReleaseDistribution {
  driveFolderId: string;
  announceChannel: string;
  announceChannelName: string;
}

export interface ReleaseStageHost {
  /** Every draft the user has (rejected and discarded ones included). */
  drafts(): Promise<readonly Draft[]>;
  distribution(): Promise<ReleaseDistribution>;
  dryRun(): Promise<boolean>;
  /** Save a new ready Outbox item (mode send) in an audited change set. */
  insert(dest: ActionDestination, audit: { action: string; summary: string }): Promise<Draft>;
  /** Rewrite a pending item in place (a new version, status ready, its attempts kept). */
  replace(cur: Draft, dest: ActionDestination, audit: { action: string; summary: string }): Promise<Draft>;
}

/** Still waiting on you: a second publish rewrites these. Anything else that is not gone was applied (or is going). */
const PENDING = new Set<Draft['status']>(['drafting', 'ready', 'scheduled', 'failed']);
const GONE = new Set<Draft['status']>(['rejected', 'discarded']);

/** The item of this action and version a second publish finds (the newest that is not rejected), or null. */
export function existingReleaseItem(drafts: readonly Draft[], action: ActionDestination['action'], version: string): Draft | null {
  const mine = drafts.filter((d) => d.destination.kind === 'action' && d.destination.action === action && releaseVersionOf(d.destination) === version && !GONE.has(d.status));
  return [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? null;
}

const same = (a: ActionDestination, b: ActionDestination) => JSON.stringify(a) === JSON.stringify(b);

/** The handoff input with the server's folder and channel (the request's only where the server has none). */
export function releaseInputFor(body: StageReleaseRequest, dist: ReleaseDistribution): ReleaseHandoffInput {
  return {
    version: body.version,
    channel: body.channel,
    artifactPath: body.artifactPath,
    feedPath: body.feedPath,
    installShPath: body.installShPath,
    artifactName: body.artifactName,
    sha256: body.sha256,
    bytes: body.bytes,
    notes: body.notes,
    folderId: dist.driveFolderId || body.folderId,
    announceChannel: dist.announceChannel || body.announceChannel,
    announceChannelName: dist.announceChannel ? dist.announceChannelName : body.announceChannelName,
  };
}

export async function stageRelease(h: ReleaseStageHost, body: StageReleaseRequest): Promise<StageReleaseResult> {
  const dests = releaseDestinations(releaseInputFor(body, await h.distribution()));
  const all = await h.drafts();
  const drafts: Draft[] = [];
  const outcomes: StageReleaseResult['outcomes'] = [];
  for (const dest of dests) {
    const what = dest.action === RELEASE_UPLOAD_KIND ? 'upload hand-off' : 'announcement';
    const cur = existingReleaseItem(all, dest.action, body.version);
    if (!cur) {
      drafts.push(await h.insert(dest, { action: 'release.stage', summary: `Release v${body.version}: the ${what} is in the Outbox` }));
      outcomes.push('created');
    } else if (!PENDING.has(cur.status)) {
      drafts.push(cur);
      outcomes.push('kept');
    } else if (cur.destination.kind === 'action' && same(cur.destination, dest)) {
      drafts.push(cur);
      outcomes.push('unchanged');
    } else {
      drafts.push(await h.replace(cur, dest, { action: 'release.restage', summary: `Release v${body.version}: the ${what} was updated by a second publish` }));
      outcomes.push('updated');
    }
  }
  return { version: body.version, drafts, outcomes, dryRun: await h.dryRun() };
}

/** The Outbox item a "Mark uploaded" leaves: handed off (status sent), with one attempt that says nothing was sent. */
export function handedOff(d: Draft, at: string, attemptId: string): Draft {
  const url = d.destination.kind === 'action' ? d.destination.target.url : null;
  return {
    ...d,
    mode: 'send',
    status: 'sent',
    resultUrl: url ?? d.resultUrl,
    verification: null,
    attempts: [...d.attempts, { id: attemptId, at, mode: 'send', dryRun: false, outcome: 'sent', detail: 'Marked uploaded: handed off, no tool call (the app sent nothing)' }],
  };
}
