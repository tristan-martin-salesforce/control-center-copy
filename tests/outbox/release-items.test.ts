/**
 * D-90 (W12-7): the two release items are ordinary Outbox drafts the user Approves, on the mock DataSource.
 *
 *   POST /outbox/releases   exactly two ready items (release.drive_upload, release.announce); a second publish of the
 *                           same version updates them in place, never a second pair; an applied one is kept
 *   release.drive_upload    no tool call in any mode; "Mark uploaded" hands it off (status sent) and calls nothing
 *   release.announce        the D-56 slack_send_message shape; dry run (the default) calls nothing; live it makes one
 *                           post, to the configured channel; Undo inside the window dispatches nothing
 *   channel unset           the row says what to set; dispatch refuses with that line, nothing recorded
 * Nothing leaves: the transport is the in-memory SimulatedOutboxTransport, and the allowlist is unchanged.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, Seed, type Draft, type RouteKey, type RouteOutput, type StageReleaseRequest } from '../../src/contract';
import { SendFlow } from '../../src/components/composer/send-flow';
import { actionApp, actionKindLabel } from '../../src/lib/actions';
import { adapterFor, defaultModeFor, SimulatedOutboxTransport } from '../../src/outbox';
import { releaseActionPayload, releaseDestinations, releaseRowFacts, type ReleaseHandoffInput } from '../../src/outbox/adapters/release-handoff';
import { MockDataSource } from '../../src/server/datasource/mock';
import { AppError } from '../../src/server/errors';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const FOLDER = '1AbCdEfGhIjKlMnOpQ';
const CHANNEL = 'C0ANNOUNCE01';

const body = (o: Partial<StageReleaseRequest> = {}): StageReleaseRequest => ({
  version: '2.1.0',
  channel: 'stable',
  artifactName: 'command-center-2.1.0-arm64.tgz',
  artifactPath: '/repo/dist/releases/command-center-2.1.0-arm64.tgz',
  feedPath: '/repo/dist/releases/manifest.json',
  installShPath: '/repo/dist/releases/install.sh',
  sha256: 'c'.repeat(64),
  bytes: 150_000_000,
  notes: '### Added\n- **time**: a thing\n\n### Fixed\n- a bug',
  folderId: '',
  announceChannel: '',
  announceChannelName: '',
  ...o,
});
const input = (o: Partial<ReleaseHandoffInput> = {}): ReleaseHandoffInput => ({ ...body(), folderId: FOLDER, announceChannel: CHANNEL, announceChannelName: '#command-center', ...o });

let ds: MockDataSource;
let transport: SimulatedOutboxTransport;
const env = { folder: process.env.CC_DISTRIBUTION_FOLDER_ID, channel: process.env.CC_DISTRIBUTION_CHANNEL, team: process.env.CC_TEAM_CONFIG };
const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));

beforeEach(() => {
  process.env.CC_TEAM_CONFIG = '/nonexistent/team.json';
  process.env.CC_DISTRIBUTION_FOLDER_ID = FOLDER;
  process.env.CC_DISTRIBUTION_CHANNEL = CHANNEL;
  ds = new MockDataSource({ seed: structuredClone(seed), delays: { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 1e8, reevalMs: 5 }, autoplay: false, clockMode: 'seed' });
  transport = new SimulatedOutboxTransport();
  ds.outbox.useTransport(transport);
});
afterEach(() => {
  ds.dispose();
  restore('CC_DISTRIBUTION_FOLDER_ID', env.folder);
  restore('CC_DISTRIBUTION_CHANNEL', env.channel);
  restore('CC_TEAM_CONFIG', env.team);
});

/** Parsed like the route handler, validated like its response. */
async function call<K extends RouteKey>(key: K, i: { params?: unknown; body?: unknown } = {}): Promise<RouteOutput<K>> {
  const def = routes[key] as { params?: { parse(v: unknown): unknown }; body?: { parse(v: unknown): unknown }; response: { safeParse(v: unknown): { success: boolean; error?: { issues: unknown[] } } } };
  const parsed: Record<string, unknown> = {};
  if (def.params) parsed.params = def.params.parse(i.params ?? {});
  if (def.body) parsed.body = def.body.parse(i.body ?? {});
  const out = await (ds[key as keyof MockDataSource] as (x: unknown) => Promise<unknown>).call(ds, parsed);
  const r = def.response.safeParse(out);
  if (!r.success) throw new Error(`${key} failed the contract: ${JSON.stringify(r.error?.issues.slice(0, 3))}`);
  return out as RouteOutput<K>;
}

const releaseDrafts = async () => (await call('getOutbox')).groups.flatMap((g) => g.items).filter((i) => i.draft.destination.kind === 'action' && i.draft.destination.action.startsWith('release.'));
const preview = (d: Draft) => call('previewDraft', { params: { id: d.id }, body: { mode: 'send' } });
const dispatch = async (d: Draft) => {
  const p = await preview(d);
  return call('dispatchDraft', { params: { id: d.id }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } });
};
const liveSending = async () => {
  const s = await call('getSettings');
  await call('patchSettings', { params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun: false }, confirm: true } });
};

describe('the two items (pure)', () => {
  it('the hand-off has no tool call in any mode; the announcement is the D-56 slack_send_message shape', () => {
    const [upload, announce] = releaseDestinations(input());
    expect(upload.action).toBe('release.drive_upload');
    expect(announce.action).toBe('release.announce');
    const up = releaseActionPayload(upload);
    expect(up).toMatchObject({ mode: 'handoff', version: '2.1.0', folderId: FOLDER, sha256: 'c'.repeat(64) });
    expect(up).not.toHaveProperty('tool');
    for (const mode of ['send', 'draft'] as const) expect(() => adapterFor('release').toolCall(up, mode)).toThrow(/never uploads/);
    const an = releaseActionPayload(announce);
    expect(an).toMatchObject({ tool: 'slack_send_message', channel: CHANNEL, channelName: '#command-center', version: '2.1.0' });
    expect(an.text).toContain('*Command Center v2.1.0* is out.');
    expect(adapterFor('release').toolCall(an, 'send')).toEqual({ server: 'slack', tool: 'slack_send_message', args: { channel_id: CHANNEL, message: expect.stringContaining('Command Center v2.1.0') } });
    expect(actionApp('release.drive_upload')).toBe('Drive');
    expect(actionKindLabel(announce)).toBe('Release announcement');
    expect(defaultModeFor({ destination: announce, mode: 'draft', userLockedFields: [] }, null)).toBe('send');
  });

  it('the allowlist is not widened: the release channel calls only the existing slack_send_message (the size, 21, is pinned in the outbox guard test)', () => {
    const [, announce] = releaseDestinations(input());
    const call = adapterFor('release').toolCall(releaseActionPayload(announce), 'draft');
    expect([call.server, call.tool]).toEqual(['slack', 'slack_send_message']);
    expect(Object.keys(call.args).sort()).toEqual(['channel_id', 'message']);
  });

  it('channel or folder unset: the row says what to set, the payload is refused', () => {
    const [upload, announce] = releaseDestinations(input({ folderId: '', announceChannel: '' }));
    expect(releaseRowFacts(upload).missing).toBe('No Drive folder is set: add the folder’s id as distributionDriveFolderId in config/team.json.');
    expect(releaseRowFacts(announce).missing).toBe('No announcement channel is set: add the channel’s id as distributionAnnounceChannel in config/team.json.');
    expect(() => adapterFor('release').toolCall(releaseActionPayload(announce), 'send')).toThrow(/no announcement channel is set \(the announcement’s row in the Outbox says what to set\)/);
    // said once: the line says what to set; the title and the change lines don't repeat it
    expect(announce.target.label).toBe('Announce Command Center v2.1.0');
    expect([...upload.changes, ...announce.changes].filter((c) => /Drive folder|Post to/.test(c.label)).map((c) => c.after)).toEqual(['not set', 'not set']);
    expect(JSON.stringify([upload.target, announce.target, upload.changes, announce.changes])).not.toMatch(/config\/team\.json|no channel set/);
    // no row names a Settings section that does not exist
    expect(JSON.stringify([releaseRowFacts(upload), releaseRowFacts(announce)])).not.toMatch(/Settings ▸ distribution/);
  });
});

describe('POST /outbox/releases on the mock', () => {
  it('creates exactly two pending items, in dry run; a second publish of the same version never duplicates', async () => {
    const r = await call('stageRelease', { body: body() });
    expect(r.entity.outcomes).toEqual(['created', 'created']);
    expect(r.entity.dryRun).toBe(true);
    expect(r.entity.drafts.map((d) => [d.destination.kind === 'action' && d.destination.action, d.status, d.mode])).toEqual([
      ['release.drive_upload', 'ready', 'send'],
      ['release.announce', 'ready', 'send'],
    ]);
    let pending = await releaseDrafts();
    expect(pending.map((i) => i.group)).toEqual(['pending_approval', 'pending_approval']);
    // the Outbox lists the upload first: you apply it first, and the announcement links it
    expect(pending.map((i) => i.draft.destination.kind === 'action' && i.draft.destination.action)).toEqual(['release.drive_upload', 'release.announce']);
    // never an admin item: the Outbox lists them
    expect((await call('getOutbox')).admin.items.some((i) => i.draft.destination.kind === 'action' && i.draft.destination.action.startsWith('release.'))).toBe(false);
    for (const it of pending) expect((await preview(it.draft)).dryRun).toBe(true);

    const again = await call('stageRelease', { body: body() });
    expect(again.entity.outcomes).toEqual(['unchanged', 'unchanged']);
    const changed = await call('stageRelease', { body: body({ notes: '### Fixed\n- another bug', sha256: 'd'.repeat(64) }) });
    expect(changed.entity.outcomes).toEqual(['updated', 'updated']);
    expect(changed.entity.drafts.map((d) => d.id)).toEqual(r.entity.drafts.map((d) => d.id));
    pending = await releaseDrafts();
    expect(pending).toHaveLength(2);
    expect(releaseRowFacts(pending.find((i) => i.draft.destination.kind === 'action' && i.draft.destination.action === 'release.drive_upload')!.draft.destination as never).shaShort).toBe('dddddddddddd');
    // another version is its own pair
    expect((await call('stageRelease', { body: body({ version: '2.1.1' }) })).entity.outcomes).toEqual(['created', 'created']);
    expect(await releaseDrafts()).toHaveLength(4);
    expect(transport.calls).toEqual([]);
  });

  it('the server folder and channel win over the request; the request fills in where the server has none', async () => {
    const a = (await call('stageRelease', { body: body({ announceChannel: 'C0OTHERCHAN9' }) })).entity.drafts[1]!;
    expect(a.destination.kind === 'action' && a.destination.input.channelId).toBe(CHANNEL);
    delete process.env.CC_DISTRIBUTION_CHANNEL;
    const b = (await call('stageRelease', { body: body({ version: '2.2.0', announceChannel: 'C0OTHERCHAN9' }) })).entity.drafts[1]!;
    expect(b.destination.kind === 'action' && b.destination.input.channelId).toBe('C0OTHERCHAN9');
  });

  it('Mark uploaded hands the upload off: status sent, nothing called, even with live send on; a second mark refuses', async () => {
    await liveSending();
    const [upload] = (await call('stageRelease', { body: body() })).entity.drafts;
    const r = await dispatch(upload!);
    expect(r.draft.status).toBe('sent');
    expect(r.attempt).toMatchObject({ outcome: 'sent', dryRun: false, detail: expect.stringContaining('no tool call') });
    expect(r.payload).not.toHaveProperty('tool');
    expect(transport.calls).toEqual([]);
    expect((await releaseDrafts()).find((i) => i.draft.id === upload!.id)!.group).toBe('sent');
    await expect(dispatch(upload!)).rejects.toBeInstanceOf(AppError);
    // a publish after the hand-off keeps it (never a second upload item) and still updates the pending announcement
    const again = await call('stageRelease', { body: body({ notes: '### Fixed\n- late' }) });
    expect(again.entity.outcomes).toEqual(['kept', 'updated']);
    expect(transport.calls).toEqual([]);
  });

  it('the announcement: dry run renders and calls nothing; live it posts once, to the configured channel', async () => {
    const [, announce] = (await call('stageRelease', { body: body() })).entity.drafts;
    const dry = await dispatch(announce!);
    expect(dry.dryRun).toBe(true);
    expect(dry.payload).toMatchObject({ tool: 'slack_send_message', channel: CHANNEL });
    expect(dry.draft.status).toBe('ready');
    expect(transport.calls).toEqual([]);
    await liveSending();
    const live = await dispatch((await call('getDraft', { params: { id: announce!.id } })) as Draft);
    expect(live.dryRun).toBe(false);
    expect(transport.calls.map((c) => [c.tool, c.args.channel_id])).toEqual([['slack_send_message', CHANNEL]]);
  });

  it('a failed announcement comes back as Retry (a fresh preview and confirm), nothing posted twice', async () => {
    await liveSending();
    const [, announce] = (await call('stageRelease', { body: body() })).entity.drafts;
    transport.failNextWith = 'channel_not_found';
    await expect(dispatch(announce!)).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect((await releaseDrafts()).find((i) => i.draft.id === announce!.id)!.group).toBe('failed');
    const ok = await dispatch((await call('getDraft', { params: { id: announce!.id } })) as Draft);
    expect(ok.dryRun).toBe(false);
    expect(transport.calls.filter((c) => c.tool === 'slack_send_message')).toHaveLength(2);
  });

  it('Undo inside the window: the announcement is never dispatched', async () => {
    await liveSending();
    const [, announce] = (await call('stageRelease', { body: body() })).entity.drafts;
    let fire: (() => void) | null = null;
    const flow = new SendFlow({
      preview: (mode) => call('previewDraft', { params: { id: announce!.id }, body: { mode } }),
      dispatch: (req) => call('dispatchDraft', { params: { id: announce!.id }, body: req }),
      undoMs: 10_000,
      setTimer: (fn) => ((fire = fn), 1),
      clearTimer: () => void (fire = null),
    });
    await flow.open('send');
    flow.confirm();
    expect(flow.getState().phase).toBe('countdown');
    flow.undo();
    expect(fire).toBeNull();
    expect(flow.getState()).toMatchObject({ phase: 'idle', undone: true, dispatches: 0 });
    expect(transport.calls).toEqual([]);
    expect((await call('getDraft', { params: { id: announce!.id } })).status).toBe('ready');
  });

  it('channel unset: the item is staged and says what to set; Approve refuses with that line, nothing recorded', async () => {
    delete process.env.CC_DISTRIBUTION_CHANNEL;
    const [, announce] = (await call('stageRelease', { body: body() })).entity.drafts;
    expect(releaseRowFacts(announce!.destination as never).missing).toMatch(/^No announcement channel is set: add the channel’s id as distributionAnnounceChannel in config\/team.json\.$/);
    await expect(dispatch(announce!)).rejects.toThrow(/^Not sent: no announcement channel is set \(the announcement’s row in the Outbox says what to set\)$/);
    expect((await call('getDraft', { params: { id: announce!.id } })).attempts).toEqual([]);
    expect(transport.calls).toEqual([]);
  });
});
