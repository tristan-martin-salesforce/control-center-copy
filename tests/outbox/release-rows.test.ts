/**
 * D-90 (W12-7): what the Outbox shows for the two release items, and the Review drain's verbs for them (pure).
 *   upload    v<v> · Drive folder · sha256 <12>; Copy upload instructions first, then Mark uploaded (off while no folder)
 *   announce  v<v> · #channel · sha256 <12>, the post's first line; the usual Approve
 *   drain     approving the hand-off marks it uploaded (never the send flow); approving the post is the send flow
 */
import { describe, expect, it, vi } from 'vitest';

import type { Draft, OutboxItem } from '../../src/contract';
import { releaseDestinations, sortOutboxNewestFirst, type ReleaseHandoffInput } from '../../src/outbox/adapters/release-handoff';
import { outboxAdapter } from '../../app/outbox/_outbox/OutboxReview';
import { handoffVerbs, releaseApproveKind, releaseRowView } from '../../app/outbox/_outbox/release';

const input = (o: Partial<ReleaseHandoffInput> = {}): ReleaseHandoffInput => ({
  version: '2.1.0',
  channel: 'stable',
  artifactPath: '/r/command-center-2.1.0-arm64.tgz',
  feedPath: '/r/manifest.json',
  installShPath: '/r/install.sh',
  artifactName: 'command-center-2.1.0-arm64.tgz',
  sha256: 'abcdef0123456789'.repeat(4),
  bytes: 1,
  notes: '### Added\n- a thing',
  folderId: '1AbCdEfGhIjKlMnOpQ',
  announceChannel: 'C0ANNOUNCE01',
  announceChannelName: '#command-center',
  ...o,
});
const item = (dest: Draft['destination']): OutboxItem => ({ draft: { id: 'd1', destination: dest, plainText: '' } as Draft, group: 'pending_approval', workItem: null, previewText: '', history: [], source: null });

describe('release rows', () => {
  it('the upload: version, folder, sha256 short; Copy upload instructions, then Mark uploaded', () => {
    const [upload] = releaseDestinations(input());
    const v = releaseRowView({ destination: upload, plainText: '' })!;
    expect(v).toMatchObject({ kind: 'upload', version: '2.1.0', where: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQ', shaShort: 'abcdef012345', missing: null });
    expect(v.chips).toEqual(['v2.1.0', 'Drive folder', 'sha256 abcdef012345']);
    expect(v.why).toBe('Drive folder · command-center-2.1.0-arm64.tgz · sha256 abcdef012345');
    expect(v.copyText).toContain('Claude Code can do it with your Drive connector');
    expect(handoffVerbs(false, null)).toEqual({ primary: 'copy', markDisabled: false });
    expect(handoffVerbs(true, null)).toEqual({ primary: 'mark', markDisabled: false });
    expect(handoffVerbs(true, 'set the folder')).toEqual({ primary: 'copy', markDisabled: true });
  });

  it('the announcement: version, channel, the post’s first line; unset channel says what to set', () => {
    const [, announce] = releaseDestinations(input());
    const v = releaseRowView({ destination: announce, plainText: '' })!;
    expect(v).toMatchObject({ kind: 'announce', where: '#command-center', missing: null, why: 'Command Center v2.1.0 is out.' });
    expect(v.chips).toEqual(['v2.1.0', '#command-center', 'sha256 abcdef012345']);
    const [, none] = releaseDestinations(input({ announceChannel: '' }));
    expect(releaseRowView({ destination: none, plainText: '' })).toMatchObject({ where: null, chips: ['v2.1.0', 'sha256 abcdef012345'], missing: expect.stringMatching(/^No announcement channel is set: add the channel’s id/) });
    expect(releaseRowView({ destination: { kind: 'slack', target: 'channel', channelId: 'C1', channelName: '#x', threadTs: null }, plainText: '' })).toBeNull();
  });

  it('the drain: approving the hand-off marks it uploaded, approving the post runs the send flow', async () => {
    const [upload, announce] = releaseDestinations(input());
    expect(releaseApproveKind(item(upload))).toBe('mark');
    expect(releaseApproveKind(item(announce))).toBe('send');
    const send = { approveAndWait: vi.fn(async () => 'dry_run' as const), undoPending: vi.fn(() => []) };
    const markUploaded = vi.fn(async () => undefined);
    const refetch = vi.fn();
    const a = outboxAdapter({ send, markUploaded, reject: vi.fn(), undoAudit: vi.fn(), edit: vi.fn(), refetch, dryRun: true }, new Map());
    const up = { ...item(upload), id: 'd1' };
    const an = { ...item(announce), id: 'd2' };
    expect(await a.approve(up)).toBe('sent');
    expect(markUploaded).toHaveBeenCalledTimes(1);
    expect(send.approveAndWait).not.toHaveBeenCalled();
    expect(await a.approve(an)).toBe('dry_run');
    expect(send.approveAndWait).toHaveBeenCalledTimes(1);
    expect(markUploaded).toHaveBeenCalledTimes(1);
  });
});

describe('release list order', () => {
  const at = (it: OutboxItem, updatedAt: string, id: string): OutboxItem => ({ ...it, draft: { ...it.draft, id, updatedAt } as Draft });
  it('newest first, a release’s two items together at the newer one’s place, the upload above the announcement', () => {
    const [upload, announce] = releaseDestinations(input());
    const slack = item({ kind: 'slack', target: 'channel', channelId: 'C1', channelName: '#x', threadTs: null });
    const list = [
      at(slack, '2026-11-21T10:00:00Z', 'older'),
      at(item(upload), '2026-11-21T11:00:00Z', 'up'),
      at(slack, '2026-11-21T11:30:00Z', 'between'),
      at(item(announce), '2026-11-21T12:00:00Z', 'an'), // the announcement edited later
      at(slack, '2026-11-21T13:00:00Z', 'newest'),
    ];
    expect(sortOutboxNewestFirst([...list]).map((i) => i.draft.id)).toEqual(['newest', 'up', 'an', 'between', 'older']);
    // same time (one publish): the upload still first, whatever order they were read in
    const tie = [at(item(announce), '2026-11-21T12:00:00Z', 'an'), at(item(upload), '2026-11-21T12:00:00Z', 'up')];
    expect(sortOutboxNewestFirst(tie).map((i) => i.draft.id)).toEqual(['up', 'an']);
  });
});
