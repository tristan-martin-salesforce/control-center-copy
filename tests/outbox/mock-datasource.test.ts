/**
 * BE-OUTBOX · the mock DataSource's real dispatch path (preview → confirm token → dispatch → adapters →
 * read-back → Outbox), with a fake MCP transport swapped in. Contract-validated responses. Nothing leaves.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { eventually } from '../support/until';

import { routes, Seed, type DispatchMode, type RouteKey, type RouteOutput } from '../../src/contract';
import { payloadHash, SimulatedOutboxTransport } from '../../src/outbox';
import { MockDataSource } from '../../src/server/datasource/mock';
import { AppError } from '../../src/server/errors';
import { FakeMcp } from './fake';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const fast = { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 };

let ds: MockDataSource;
let fake: FakeMcp;
beforeEach(() => {
  ds = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
  fake = new FakeMcp();
  ds.outbox.useTransport(fake);
});
afterEach(() => ds.dispose());

/** Every response is validated against its contract schema, like the route handler does. */
async function call<K extends RouteKey>(key: K, input: unknown): Promise<RouteOutput<K>> {
  const out = await (ds[key as keyof MockDataSource] as (i: unknown) => Promise<unknown>).call(ds, input);
  const r = routes[key].response.safeParse(out);
  if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
  return out as RouteOutput<K>;
}

async function appError(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected an AppError');
}

async function liveMode() {
  const s = await ds.getSettings({} as never);
  await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun: false }, confirm: true } });
}

async function confirmAndDispatch(id: string, mode: DispatchMode) {
  const preview = await call('previewDraft', { params: { id }, body: { mode } });
  const res = await call('dispatchDraft', { params: { id }, body: { ifVersion: preview.version, mode, confirmToken: preview.confirmToken } });
  return { preview, res };
}

describe('Settings → Sending', () => {
  it('defaults: dry-run ON and both channels in draft mode', async () => {
    const s = await call('getSettings', {});
    expect(s.sending.dryRun).toBe(true);
    expect(s.sending.channels).toEqual({ slack: { mode: 'draft' }, gmail: { mode: 'draft' }, vdp: { mode: 'send', autopilot: false, dailyCap: 40 }, slack_canvas: { mode: 'send' } });
  });

  it('a channel patch merges per channel; turning dry-run off still needs confirm', async () => {
    const s = await ds.getSettings({} as never);
    const r = await call('patchSettings', { params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { channels: { slack: { mode: 'send' } } } } });
    expect(r.entity.sending.channels).toEqual({ slack: { mode: 'send' }, gmail: { mode: 'draft' }, vdp: { mode: 'send', autopilot: false, dailyCap: 40 }, slack_canvas: { mode: 'send' } });
    expect(r.entity.sending.dryRun).toBe(true);
    const e = await appError(ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: r.entity.sending.version, value: { dryRun: false } } }));
    expect(e.code).toBe('validation');
    const bad = await appError(ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: r.entity.sending.version, value: { channels: { slack: { mode: 'post' } } } } }));
    expect(bad.code).toBe('validation');
  });

  it('a preview without an explicit mode starts on the channel mode (the user’s per-message choice wins)', async () => {
    expect((await call('previewDraft', { params: { id: 'dr_dana' }, body: {} })).mode).toBe('draft');
    const s = await ds.getSettings({} as never);
    await ds.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { channels: { slack: { mode: 'send' } } } } });
    expect((await call('previewDraft', { params: { id: 'dr_dana' }, body: {} })).mode).toBe('send');
    expect((await call('previewDraft', { params: { id: 'dr_globex_sow' }, body: {} })).mode).toBe('draft'); // gmail stays draft
    const d = await ds.getDraft({ params: { id: 'dr_dana' } });
    await ds.patchDraft({ params: { id: 'dr_dana' }, body: { ifVersion: d.version, mode: 'draft' } });
    expect((await call('previewDraft', { params: { id: 'dr_dana' }, body: {} })).mode).toBe('draft');
  });
});

describe('dry-run dispatch', () => {
  it('records the exact payload, marks it dry-run delivered and touches nothing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { preview, res } = await confirmAndDispatch('dr_dana', 'send');
    expect(res.dryRun).toBe(true);
    expect(res.attempt.outcome).toBe('rendered');
    expect(res.attempt.detail).toMatch(/^Dry-run delivered: payload recorded \(sha256:[0-9a-f]{12}\), nothing sent$/);
    expect(res.draft.status).toBe('drafting'); // a dry run never looks like a delivery
    expect(JSON.stringify(res.payload)).toBe(JSON.stringify(preview.payload));
    const [rec] = ds.outbox.deliveries('dr_dana');
    expect(rec).toMatchObject({ state: 'dry_run_delivered', dryRun: true, mode: 'send', channel: 'slack', payloadHash: payloadHash(preview.payload) });
    expect(rec!.payload).toEqual(preview.payload);
    expect(rec!.toolCall).toMatchObject({ server: 'slack', tool: 'slack_send_message', args: { channel_id: 'C0ACME' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.calls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('live (dry-run off) with a fake MCP transport', () => {
  it('draft mode: confirm → fake create-draft once → staged; Slack read-back is unconfirmed', async () => {
    await liveMode();
    const { res } = await confirmAndDispatch('dr_dana', 'draft');
    expect(res.dryRun).toBe(false);
    expect(fake.writes().map((c) => c.tool)).toEqual(['slack_send_message_draft']);
    expect(fake.calls[0]!.args).toMatchObject({ channel_id: 'C0ACME' });
    expect(res.attempt.outcome).toBe('staged');
    expect(res.draft.status).toBe('staged');
    expect(res.draft.verification?.state).toBe('pending');
    await eventually(() => expect(ds.outbox.deliveries('dr_dana')[0]?.readback).toBe('unconfirmed'));
    const d = await call('getDraft', { params: { id: 'dr_dana' } });
    expect(d.status).toBe('staged');
    expect(d.verification).toMatchObject({ state: 'unverified' });
    expect(fake.calls.some((c) => c.tool === 'slack_send_message')).toBe(false);
  });

  it('send mode: confirm → fake send → read-back → verified, and the Outbox shows it under Sent', async () => {
    await liveMode();
    const { res } = await confirmAndDispatch('dr_globex_sow', 'send');
    expect(fake.writes().map((c) => c.tool)).toEqual(['send_gmail_message']);
    expect(res.attempt.outcome).toBe('sent');
    expect(res.draft.status).toBe('sent');
    await eventually(() => expect(fake.calls.map((c) => c.tool)).toEqual(['send_gmail_message', 'get_gmail_message_content']));
    await eventually(async () => expect((await ds.getDraft({ params: { id: 'dr_globex_sow' } })).status).toBe('verified'));
    const rec = ds.outbox.deliveries('dr_globex_sow')[0]!;
    expect(rec).toMatchObject({ state: 'delivered', readback: 'confirmed', mode: 'send', dryRun: false });
    expect(rec.result?.externalId).toBeTruthy();
    const outbox = await call('getOutbox', {});
    const sent = outbox.groups.find((g) => g.group === 'sent')!.items.map((i) => i.draft.id);
    expect(sent).toContain('dr_globex_sow');
  });

  it('a delivered draft is never dispatched again (no double send)', async () => {
    await liveMode();
    await confirmAndDispatch('dr_globex_sow', 'send');
    const again = await ds.previewDraft({ params: { id: 'dr_globex_sow' }, body: { mode: 'send' } });
    const e = await appError(ds.dispatchDraft({ params: { id: 'dr_globex_sow' }, body: { ifVersion: again.version, mode: 'send', confirmToken: again.confirmToken } }));
    expect(e.code).toBe('validation');
    expect(fake.writes()).toHaveLength(1);
  });

  it('a failure lands in the Outbox Failed group with the reason; Retry (a fresh confirm) delivers', async () => {
    await liveMode();
    fake.failOnce('slack_send_message', 'channel_not_found');
    const p = await ds.previewDraft({ params: { id: 'dr_chat_initech' }, body: { mode: 'send' } });
    const e = await appError(ds.dispatchDraft({ params: { id: 'dr_chat_initech' }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } }));
    expect(e.code).toBe('upstream_unavailable');
    expect(e.message).toMatch(/channel not found.*\(channel_not_found\)\. Nothing was sent/i);
    expect(e.details).toMatchObject({ draftId: 'dr_chat_initech', code: 'channel_not_found', retry: 'reconfirm' });

    const failed = await call('getDraft', { params: { id: 'dr_chat_initech' } });
    expect(failed.status).toBe('failed');
    expect(failed.attempts.at(-1)).toMatchObject({ outcome: 'failed', dryRun: false });
    const outbox = await call('getOutbox', {});
    const row = outbox.groups.find((g) => g.group === 'failed')!.items.find((i) => i.draft.id === 'dr_chat_initech');
    expect(row).toBeTruthy();
    expect(outbox.counts.failed).toBeGreaterThan(0);

    // the old confirm is stale (the draft moved on): replaying it is refused, nothing more is written
    const stale = await appError(ds.dispatchDraft({ params: { id: 'dr_chat_initech' }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } }));
    expect(stale.code).toBe('conflict');
    expect(fake.writes()).toHaveLength(1);

    // Retry = preview again + confirm again
    const { res } = await confirmAndDispatch('dr_chat_initech', 'send');
    expect(res.attempt.outcome).toBe('sent');
    expect(fake.writes()).toHaveLength(2);
    await eventually(async () => expect((await ds.getDraft({ params: { id: 'dr_chat_initech' } })).status).toBe('verified'));
    expect(ds.outbox.deliveries('dr_chat_initech').map((r) => r.state)).toEqual(['failed', 'delivered']);
  });

  it('no confirm, no delivery: a missing, forged or wrong-mode token is refused before any tool call', async () => {
    await liveMode();
    const p = await ds.previewDraft({ params: { id: 'dr_dana' }, body: { mode: 'draft' } });
    for (const [mode, token] of [
      ['send', 'forged'],
      ['send', p.confirmToken], // the token was for draft mode
      ['draft', `${p.confirmToken}x`],
    ] as const) {
      const e = await appError(ds.dispatchDraft({ params: { id: 'dr_dana' }, body: { ifVersion: p.version, mode, confirmToken: token } }));
      expect(e.code).toBe('validation');
    }
    expect(fake.calls).toHaveLength(0);
    expect((await ds.getDraft({ params: { id: 'dr_dana' } })).status).toBe('drafting');
  });

  it('the default mock transport is the in-memory simulator (never the network)', async () => {
    const plain = new MockDataSource({ seed: structuredClone(seed), delays: fast, autoplay: false, clockMode: 'seed' });
    try {
      const s = await plain.getSettings({} as never);
      await plain.patchSettings({ params: { section: 'sending' }, body: { ifVersion: s.sending.version, value: { dryRun: false }, confirm: true } });
      const p = await plain.previewDraft({ params: { id: 'dr_dana' }, body: { mode: 'send' } });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const r = await plain.dispatchDraft({ params: { id: 'dr_dana' }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } });
      expect(r.attempt.outcome).toBe('sent');
      await eventually(async () => expect((await plain.getDraft({ params: { id: 'dr_dana' } })).status).toBe('verified'));
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      expect(new SimulatedOutboxTransport()).toBeInstanceOf(SimulatedOutboxTransport);
    } finally {
      plain.dispose();
    }
  });
});
