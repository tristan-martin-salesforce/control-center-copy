/**
 * Settings → Sending helpers shared by the mock and db DataSources. Stored rows may predate `channels`,
 * so every read goes through `sendingOf()`; it never turns dry-run off (a missing flag reads as ON).
 */
import { AutopilotAssetHost, DEFAULT_AUTOPILOT_ASSET_HOSTS, DEFAULT_SENDING_CHANNELS, DEFAULT_VDP_AUTOPILOT_CAP, type Destination, type DispatchMode, type Draft, type SendingSettings, type SendingSettingsPatch } from '@/contract';

import { actionFamily, type ActionFamily } from '@/lib/actions';

import type { OutboxChannel } from './types';

/** A structured action's channel, by its family (the action's prefix). */
const ACTION_CHANNEL: Record<ActionFamily, OutboxChannel> = { vdp: 'vdp', slack_canvas: 'slack_canvas', feedback: 'feedback', release: 'release' };

/** The delivery channel of a destination. Exhaustive: nothing falls through to Gmail (it used to, for any non-Slack). */
export function channelOf(dest: Destination): OutboxChannel {
  switch (dest.kind) {
    case 'slack':
      return 'slack';
    case 'email':
      return 'gmail';
    case 'action':
      return ACTION_CHANNEL[actionFamily(dest.action)];
  }
}

/** VDP autopilot's daily write cap: a whole number from 1 to 500, else the default (40). */
const capOf = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 500 ? v : DEFAULT_VDP_AUTOPILOT_CAP);

/**
 * VDP autopilot's trusted asset sites (SEC-6): a stored list as is (valid names only, deduped; an empty list trusts
 * nothing), a missing or odd one reads as the default list.
 */
const assetHostsOf = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [...DEFAULT_AUTOPILOT_ASSET_HOSTS];
  const ok = v.map((h) => AutopilotAssetHost.safeParse(h)).flatMap((r) => (r.success ? [r.data] : []));
  return [...new Set(ok)];
};

/** The sending section with defaults filled (channels → draft; dryRun anything but `false` → true). */
export function sendingOf(raw: Partial<SendingSettings> | null | undefined): SendingSettings {
  const s = raw ?? {};
  return {
    version: s.version ?? 1,
    defaultMode: s.defaultMode ?? 'draft',
    dryRun: s.dryRun !== false,
    verifyReadback: s.verifyReadback ?? true,
    undoWindowSec: s.undoWindowSec ?? 10,
    channels: {
      slack: { mode: s.channels?.slack?.mode ?? DEFAULT_SENDING_CHANNELS.slack.mode },
      gmail: { mode: s.channels?.gmail?.mode ?? DEFAULT_SENDING_CHANNELS.gmail.mode },
      // VDP has no drafts: whatever is stored, its mode is send (Apply), gated by dry-run and the confirm. Autopilot
      // (D-60) is on only when stored as exactly `true` (a missing or odd value reads as off).
      vdp: { mode: 'send', autopilot: s.channels?.vdp?.autopilot === true, dailyCap: capOf(s.channels?.vdp?.dailyCap) },
      // A logging canvas is private and has no draft: Apply creates it.
      slack_canvas: { mode: 'send' },
    },
    autopilotAssetHosts: assetHostsOf(s.autopilotAssetHosts),
  };
}

/** PATCH merge: top-level fields replace, `channels` merges per channel (naming one keeps the other). */
export function mergeSendingPatch(cur: Partial<SendingSettings>, patch: SendingSettingsPatch | Record<string, unknown>): SendingSettings {
  const base = sendingOf(cur);
  const p = patch as SendingSettingsPatch;
  const { channels, ...rest } = p;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<SendingSettings>;
  return {
    ...base,
    ...defined,
    channels: {
      slack: channels?.slack ? { ...channels.slack } : base.channels.slack,
      gmail: channels?.gmail ? { ...channels.gmail } : base.channels.gmail,
      // VDP: only autopilot and its cap change (the mode stays send)
      vdp: channels?.vdp ? { mode: 'send', autopilot: channels.vdp.autopilot ?? base.channels.vdp.autopilot, dailyCap: capOf(channels.vdp.dailyCap ?? base.channels.vdp.dailyCap) } : base.channels.vdp,
      slack_canvas: base.channels.slack_canvas,
    },
    autopilotAssetHosts: assetHostsOf(defined.autopilotAssetHosts ?? base.autopilotAssetHosts),
  };
}

/**
 * Which sending changes need `confirm: true` (both DataSources): turning dry-run off, and turning VDP autopilot on
 * (D-60: the app then writes to VDP by itself). Null when the patch needs none.
 */
export function sendingConfirmNeeded(cur: Partial<SendingSettings>, patch: Record<string, unknown>): string | null {
  const base = sendingOf(cur);
  if (patch.dryRun === false && base.dryRun) return 'Turning dry-run off needs confirm: true';
  const vdp = (patch.channels as { vdp?: { autopilot?: unknown } } | undefined)?.vdp;
  if (vdp?.autopilot === true && !base.channels.vdp.autopilot) return 'Turning VDP autopilot on needs confirm: true';
  return null;
}

/**
 * The mode the composer toggle starts on: the user's own per-message choice when they set one
 * (`mode` is user-locked), else the channel's Settings → Sending mode.
 */
export function defaultModeFor(d: Pick<Draft, 'destination' | 'mode' | 'userLockedFields'>, sending: Partial<SendingSettings> | null | undefined): DispatchMode {
  if (d.userLockedFields.includes('mode')) return d.mode;
  const ch = channelOf(d.destination);
  // A feedback report has no Slack draft and no Settings → Sending row: Send posts it (D-56).
  // Nor does a release item (D-90): the announcement posts on Send, the upload hand-off is marked on Apply.
  if (ch === 'feedback' || ch === 'release') return 'send';
  return sendingOf(sending).channels[ch].mode;
}
