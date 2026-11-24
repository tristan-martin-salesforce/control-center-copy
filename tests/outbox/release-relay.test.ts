/**
 * D-90 (W12-7): the live path of a release announcement. It reuses the D-56 relay as its own `release` channel: one
 * top-level slack_send_message, only to the configured announcement channel, only with a spent confirm, only when the
 * worker wired it. The hand-off never reaches a transport. Fakes only: nothing leaves.
 */
import { describe, expect, it } from 'vitest';

import { confirmDelivery, liveOutboxTransport, OutboxGateway, OutboxLiveDisabledError, payloadHash, releaseRelay, type OutboxTransport } from '../../src/outbox';
import { releaseActionPayload, releaseDestinations } from '../../src/outbox/adapters/release-handoff';
import type { ToolCall } from '../../src/outbox/types';

const CHANNEL = 'C0ANNOUNCE01';
const FEEDBACK = 'C0FEEDBACK01';
const [upload, announce] = releaseDestinations({
  version: '2.1.0',
  channel: 'stable',
  artifactPath: '/r/a.tgz',
  feedPath: '/r/manifest.json',
  installShPath: '/r/install.sh',
  artifactName: 'a.tgz',
  sha256: 'c'.repeat(64),
  bytes: 1,
  notes: '- a thing',
  folderId: '1AbCdEfGhIjKlMnOpQ',
  announceChannel: CHANNEL,
});

function recorder() {
  const calls: ToolCall[] = [];
  const t: OutboxTransport = { callTool: async (c) => (calls.push(c), { text: JSON.stringify({ ok: true, channel: c.args.channel_id, ts: '1730000000.000100' }) }) };
  return { calls, t };
}

const proofFor = (draftId: string, payload: Record<string, unknown>) => {
  const token = `tok-${draftId}`;
  return confirmDelivery({ draftId, draftVersion: 1, mode: 'send', payloadHash: payloadHash(payload), confirmToken: token, expectedToken: token, at: new Date().toISOString() });
};

describe('the release relay', () => {
  it('posts an approved announcement once, to the configured channel, through the gateway', async () => {
    const inner = recorder();
    const gw = new OutboxGateway(liveOutboxTransport({ vdp: null, canvas: null, release: { channel: () => CHANNEL, transport: inner.t } }));
    const payload = releaseActionPayload(announce);
    await gw.write({ draftId: 'd1', channel: 'release', mode: 'send', payload }, proofFor('d1', payload));
    expect(inner.calls).toEqual([{ server: 'slack', tool: 'slack_send_message', args: { channel_id: CHANNEL, message: expect.any(String) } }]);
  });

  it('fails closed without the worker wiring, and refuses another channel, a non-release send or no confirm', async () => {
    const payload = releaseActionPayload(announce);
    const off = new OutboxGateway(liveOutboxTransport({ vdp: null, canvas: null }));
    await expect(off.write({ draftId: 'd2', channel: 'release', mode: 'send', payload }, proofFor('d2', payload))).rejects.toBeInstanceOf(OutboxLiveDisabledError);

    const inner = recorder();
    const relay = releaseRelay({ channel: () => 'C0SOMEWHERE9', transport: inner.t });
    const call = { server: 'slack', tool: 'slack_send_message', args: { channel_id: CHANNEL, message: 'hi' } };
    await expect(relay.callTool(call, { channel: 'release' })).rejects.toThrow(/only the configured announcement channel/);
    const right = releaseRelay({ channel: () => CHANNEL, transport: inner.t });
    await expect(right.callTool(call, { channel: 'slack' })).rejects.toThrow(/carried for a release announcement only/);
    await expect(right.callTool(call, { channel: 'release' })).rejects.toThrow(); // no spent proof
    const none = releaseRelay({ channel: () => null, transport: inner.t });
    await expect(none.callTool(call, { channel: 'release' })).rejects.toThrow(/no announcement channel is configured/);
    expect(inner.calls).toEqual([]);
  });

  it('the feedback relay is unchanged beside it: its read-back goes to its own relay, the announcement to its own', async () => {
    const rel = recorder();
    const fb = recorder();
    const live = liveOutboxTransport({ vdp: null, canvas: null, release: { channel: () => CHANNEL, transport: rel.t }, feedback: { channel: () => FEEDBACK, transport: fb.t } });
    await live.callTool({ server: 'slack', tool: 'slack_read_thread', args: { channel_id: FEEDBACK, message_ts: '1.1' } });
    await live.callTool({ server: 'slack', tool: 'slack_read_thread', args: { channel_id: CHANNEL, message_ts: '1.2' } });
    expect(fb.calls.map((c) => c.args.channel_id)).toEqual([FEEDBACK]);
    expect(rel.calls.map((c) => c.args.channel_id)).toEqual([CHANNEL]);
  });

  it('the upload hand-off never reaches a transport: the gateway refuses it before any call', async () => {
    const inner = recorder();
    const gw = new OutboxGateway(liveOutboxTransport({ vdp: null, canvas: null, release: { channel: () => CHANNEL, transport: inner.t } }));
    const payload = releaseActionPayload(upload);
    for (const mode of ['send', 'draft'] as const) await expect(gw.write({ draftId: 'd3', channel: 'release', mode, payload }, proofFor('d3', payload))).rejects.toThrow(/never uploads/);
    expect(inner.calls).toEqual([]);
  });
});
