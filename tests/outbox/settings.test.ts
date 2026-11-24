/** BE-OUTBOX · Settings → Sending contract (additive) and its helpers. */
import { describe, expect, it } from 'vitest';

import { DEFAULT_SENDING_SETTINGS, SendingSettings, SETTINGS_SECTION_SCHEMAS, Settings, type Destination } from '../../src/contract';
import { defaultModeFor, mergeSendingPatch, sendingOf } from '../../src/outbox';

const legacy = { version: 3, defaultMode: 'send', dryRun: true, verifyReadback: true, undoWindowSec: 10 } as const;

describe('SendingSettings.channels', () => {
  it('is optional on input (older seeds and rows) and defaults both channels to draft', () => {
    const s = SendingSettings.parse(legacy);
    expect(s.channels).toEqual({ slack: { mode: 'draft' }, gmail: { mode: 'draft' }, vdp: { mode: 'send', autopilot: false, dailyCap: 40 }, slack_canvas: { mode: 'send' } });
    expect(SendingSettings.parse({ ...legacy, channels: { slack: { mode: 'send' } } }).channels).toEqual({ slack: { mode: 'send' }, gmail: { mode: 'draft' }, vdp: { mode: 'send', autopilot: false, dailyCap: 40 }, slack_canvas: { mode: 'send' } });
    expect(SendingSettings.safeParse({ ...legacy, channels: { slack: { mode: 'post' } } }).success).toBe(false);
  });

  it('safe defaults: dry-run on, draft everywhere', () => {
    expect(DEFAULT_SENDING_SETTINGS).toMatchObject({ dryRun: true, channels: { slack: { mode: 'draft' }, gmail: { mode: 'draft' } } });
    expect(Settings.shape.sending).toBe(SendingSettings);
  });

  it('the PATCH schema accepts one channel at a time and rejects unknown modes', () => {
    const patch = SETTINGS_SECTION_SCHEMAS.sending;
    expect(patch.parse({ channels: { gmail: { mode: 'send' } } })).toEqual({ channels: { gmail: { mode: 'send' } } });
    expect(patch.parse({ dryRun: false })).toEqual({ dryRun: false });
    expect(patch.safeParse({ channels: { gmail: { mode: 'later' } } }).success).toBe(false);
  });
});

describe('helpers', () => {
  it('sendingOf fills defaults and never reads a missing dry-run flag as off', () => {
    expect(sendingOf(undefined)).toMatchObject({ dryRun: true, channels: { slack: { mode: 'draft' }, gmail: { mode: 'draft' } } });
    expect(sendingOf({ ...legacy, dryRun: undefined as unknown as boolean }).dryRun).toBe(true);
    expect(sendingOf({ ...legacy, dryRun: false }).dryRun).toBe(false);
  });

  it('mergeSendingPatch merges channels per channel and keeps everything else', () => {
    const cur = SendingSettings.parse({ ...legacy, channels: { slack: { mode: 'send' }, gmail: { mode: 'draft' } } });
    const next = mergeSendingPatch(cur, { channels: { gmail: { mode: 'send' } } });
    expect(next.channels).toEqual({ slack: { mode: 'send' }, gmail: { mode: 'send' }, vdp: { mode: 'send', autopilot: false, dailyCap: 40 }, slack_canvas: { mode: 'send' } });
    expect(next).toMatchObject({ version: 3, defaultMode: 'send', dryRun: true, undoWindowSec: 10 });
    expect(mergeSendingPatch(cur, { undoWindowSec: 5 }).channels).toEqual(cur.channels);
  });

  it('defaultModeFor: the user’s per-message choice wins, else the channel mode', () => {
    const sending = SendingSettings.parse({ ...legacy, channels: { slack: { mode: 'send' } } });
    const slack: Destination = { kind: 'slack', target: 'channel', channelId: 'C1', channelName: '#a', threadTs: null };
    const email: Destination = { kind: 'email', target: 'new', to: [{ email: 'a@example.com' }], cc: [], subject: 's', threadId: null, inReplyTo: null };
    expect(defaultModeFor({ destination: slack, mode: 'draft', userLockedFields: [] }, sending)).toBe('send');
    expect(defaultModeFor({ destination: email, mode: 'send', userLockedFields: [] }, sending)).toBe('draft');
    expect(defaultModeFor({ destination: slack, mode: 'draft', userLockedFields: ['mode'] }, sending)).toBe('draft');
  });
});
