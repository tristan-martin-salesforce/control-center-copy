/**
 * VDP autopilot's door through the Outbox (D-60, amends D-49 / D-59). Pure.
 *
 * The Outbox mints a write proof from a human approval (the confirm token, or the recorded click), and, since D-60,
 * from one autonomy policy: VDP autopilot, which the user turns on in Settings ▸ Sending (`channels.vdp.autopilot`).
 * The proof is minted only when, at the moment of the write:
 *   - the setting is on (re-read from the stored settings, not from the caller);
 *   - the item is a `vdp.*` action whose op autopilot may make: create the company or the VDP, a header fill (opps to
 *     add, the account id, the fiscal period), an asset, owners, Generate; never a use-case edit (judgment), never a
 *     delete, never a generation other than a use case's own;
 *   - every field it sets was empty in VDP (`before` empty): autopilot fills, it never changes or clears what a person
 *     entered;
 *   - an asset link is https on a trusted site (SEC-6, `sending.autopilotAssetHosts`; src/engines/vdp/asset-hosts.ts).
 *     The coverage already holds such a link for your Apply; this is the second line, right before the write.
 * Dry run, the read-back and the History entry are the Outbox's own, unchanged. Agents never reach this: the proof is
 * minted only inside the Outbox, from the stored approval (`approval_method = autonomy_policy`).
 */
import { DEFAULT_AUTOPILOT_ASSET_HOSTS, type Destination, type SendingSettings } from '@/contract';
import { trustedAssetHost } from '@/engines/vdp/asset-hosts';

/** The `vdp.*` ops autopilot may make (D-60). Use-case edits are judgment: suggested, never auto-applied. */
export const AUTOPILOT_VDP_OPS = Object.freeze(['create_company', 'create_vdp', 'update_vdp_header', 'add_vdp_asset', 'set_vdp_owners', 'generate_use_case'] as const);
export type AutopilotVdpOp = (typeof AUTOPILOT_VDP_OPS)[number];

/** The autonomy policy's name in History and on the draft ("Applied automatically"). */
export const VDP_AUTOPILOT_POLICY = 'vdp.autopilot';

/** Fields only a person sets (D-63), whatever the policy says. */
const JUDGMENT_FIELDS = new Set(['remove_opportunity_ids', 'entitlement_leveraged', 'sales_segment_id']);

const empty = (v: unknown): boolean => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** May autopilot apply this destination? A reason when not (shown on the item that returns to you). */
export function autopilotRefusal(dest: Destination, sending: (Pick<SendingSettings, 'channels'> & Partial<Pick<SendingSettings, 'autopilotAssetHosts'>>) | null | undefined): string | null {
  if (sending?.channels?.vdp?.autopilot !== true) return 'VDP autopilot is off (Settings ▸ Sending)';
  if (dest.kind !== 'action' || !dest.action.startsWith('vdp.')) return 'Autopilot only applies VDP items';
  const op = dest.action.slice(4);
  if (!(AUTOPILOT_VDP_OPS as readonly string[]).includes(op)) return `Autopilot never makes ${op}: a person approves it`;
  const input = (dest.input ?? {}) as { changes?: Array<{ before?: unknown; field?: unknown; value?: unknown }>; before?: unknown; field?: unknown; value?: unknown; pending?: unknown };
  const changes = input.changes?.length ? input.changes : [{ before: input.before, field: input.field }];
  if (changes.some((c) => !empty(c.before))) return 'Autopilot never changes a value already in VDP';
  // D-63: taking an opp off a VDP, the entitlement and a sales segment are a person's call; and autopilot applies each
  // item on its own, never one that still waits for a parent's new id
  if (changes.some((c) => typeof c.field === 'string' && JUDGMENT_FIELDS.has(c.field))) return 'A person approves this one';
  if (input.pending) return 'It waits for an earlier item: only your push chains them';
  if (op === 'add_vdp_asset') {
    // SEC-6: the link came from a search over untrusted text; autopilot adds it only from a trusted site
    const url = [...changes, { field: input.field, value: input.value }].find((c) => c.field === 'url')?.value;
    if (typeof url !== 'string') return 'Held for you: the asset has no link';
    const site = trustedAssetHost(url, sending.autopilotAssetHosts ?? DEFAULT_AUTOPILOT_ASSET_HOSTS);
    if (!site.trusted) return site.why;
  }
  return null;
}

export const autopilotAllows = (dest: Destination, sending: Parameters<typeof autopilotRefusal>[1]): boolean => autopilotRefusal(dest, sending) === null;
