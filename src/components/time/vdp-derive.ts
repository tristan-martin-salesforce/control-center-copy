/**
 * Time ▸ VDP (D-52, D-59): pure parts. The server computes one status per VDP and its open items
 * (src/engines/vdp/status.ts, steps.ts); these helpers only shape them for the screen:
 *
 *   - the head sentence ("3 VDPs need you · 2 waiting · 9 done"), from the same summary Home and the badge read
 *   - the status chip (color marks state only: act, ready, waiting), who does an item, the next read
 *   - an Apply's form values (the suggestions pre-filled) and whether it can be staged
 *   - the admin queue waiting for Apply (VDP changes and logging canvases)
 *
 * My VDPs' grouping (current, then past) is `mineRows` in ./vdp-changes-derive.ts; a staged change is the server's
 * `VdpStep.state === 'staged'` with its `draftId`.
 */
import type { Draft, OutboxItem, VdpApply, VdpCoveragePayload, VdpCoverageRow, VdpStatus, VdpStep } from '@/contract';
import type { BadgeTone } from '@/components/domain';
import { clock } from '@/components/domain/lib/time';
import { vdpStatusSentence } from '@/engines/vdp/status';
import { entryOf } from '@/errors/catalog';

/** The staged drafts by id, so an item's "Review & apply" opens the very draft it staged. */
export const draftsById = (items: readonly Pick<OutboxItem, 'draft'>[]): Map<string, Draft> => new Map(items.map((i) => [i.draft.id, i.draft]));

/** "FY27 Q4" (or nothing when VDP has no period yet). */
export const fiscalLabel = (v: Pick<VdpCoverageRow, 'fiscalYear' | 'fiscalQuarter'>): string | null =>
  v.fiscalYear !== null && v.fiscalYear !== undefined ? `FY${String(v.fiscalYear).padStart(2, '0').slice(-2)}${v.fiscalQuarter ? ` Q${v.fiscalQuarter}` : ''}` : null;

/** The head's one sentence: VDPs by status, then what is not in VDP yet. */
export function vdpSentence(c: Pick<VdpCoveragePayload, 'summary' | 'lastReadAt'> | undefined): string {
  if (!c) return 'Loading your VDPs…';
  if (!c.lastReadAt) return 'VDP has not been read yet: connect it, and your VDPs and what is open on each show here';
  return vdpStatusSentence(c.summary);
}

/** The status chip: color marks state only (act = open, ready = done, neutral = waiting or past). */
export const STATUS_CHIP: Record<VdpStatus['state'], { tone: BadgeTone; icon: string; dashed?: boolean }> = {
  open: { tone: 'now', icon: 'record_update' },
  waiting: { tone: 'neutral', icon: 'clock' },
  // D-69 (VD-11): a current VDP whose account has no 100% DC of mine yet: neutral, not checked until it lands
  waiting_dc: { tone: 'neutral', icon: 'away' },
  done: { tone: 'success', icon: 'check' },
  past: { tone: 'neutral', icon: 'archive', dashed: true },
};

/** "next read 14:30", or "next read due now" once it is late. */
export function nextReadText(nextReadAt: string | null, nowMs: number, tz?: string): string | null {
  if (!nextReadAt) return null;
  return Date.parse(nextReadAt) <= nowMs ? 'next read due now' : `next read ${clock(nextReadAt, tz)}`;
}

/** "3 open · 2 the app can fix · 1 waiting" (the panel's line under the title). */
export function statusLine(s: VdpStatus, nowMs: number, tz?: string): string {
  if (s.state === 'past') return 'Not checked: no open opportunity where your DC is 100%, or an old fiscal period';
  if (s.state === 'waiting_dc') return 'Waiting for your DC: the account has an open opportunity, none where your DC is 100% yet. It is checked once the DC lands';
  if (s.state === 'done') return 'Done: VDP has everything the app checks';
  const next = nextReadText(s.nextReadAt, nowMs, tz);
  if (s.state === 'waiting') return `Waiting for VDP to refresh${next ? ` · ${next}` : ''}`;
  // D-63: the rest wait for a value you type, or for VDP's MCP to take them (no handoffs)
  return [s.label, s.appCanFix ? `${s.appCanFix} the app can push` : null, s.open - s.appCanFix ? `${s.open - s.appCanFix} need a value or wait for VDP` : null, s.waiting ? `${s.waiting} waiting` : null].filter(Boolean).join(' · ');
}

/** Who does an item, in the words the row shows (D-60: autopilot's items, suggestions you approve; D-63: no handoffs). */
export const whoText = (s: Pick<VdpStep, 'who'> & Partial<Pick<VdpStep, 'policy' | 'check' | 'suggestion' | 'apply' | 'kind'>>): string =>
  s.kind === 'find_assets' ? 'the app looks for them here' : s.kind === 'assets' ? 'in the details: confirm what was found' : s.policy === 'auto' ? 'autopilot can apply it' : s.check === 'wrong' ? 'looks wrong: the app suggests a fix' : s.suggestion ? 'the app suggests, you approve' : 'the app can fix';

const asText = (v: VdpApply['fields'][number]['suggested']): string => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v));

/** The form's starting values: each field's suggestion (lists joined), else empty (D-63: no guessed default, a select says "Pick one"). */
export function applyDefaults(a: Pick<VdpApply, 'fields'>): Record<string, string> {
  return Object.fromEntries(a.fields.map((f) => [f.field, asText(f.suggested)]));
}

/** The editable fields (an id the app knows is shown, not typed). */
export const editableFields = (a: Pick<VdpApply, 'fields'>) => a.fields.filter((f) => !f.fixed);

/** Every required field has a value, and at least one field does: the Apply can stage. */
export function applyReady(a: Pick<VdpApply, 'fields'>, values: Readonly<Record<string, string>>): boolean {
  if (!a.fields.length) return true;
  const val = (f: VdpApply['fields'][number]) => (f.fixed ? asText(f.suggested) : (values[f.field] ?? '')).trim();
  return a.fields.every((f) => !f.required || val(f) !== '') && a.fields.some((f) => val(f) !== '');
}

/** An Apply needs typing first when an editable field has no suggestion (a use case's empty inputs, a title). */
export const applyNeedsInput = (a: Pick<VdpApply, 'fields'>): boolean => editableFields(a).some((f) => asText(f.suggested) === '');

/** A fixed field's value as shown ("006A…, 006B…"). */
export const fixedText = (f: VdpApply['fields'][number]): string => asText(f.suggested);

/** The admin items to act on (pending, then failed), newest first within each. */
export function adminQueue(items: readonly OutboxItem[]): OutboxItem[] {
  const rank = (i: OutboxItem) => (i.group === 'pending_approval' ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || b.draft.updatedAt.localeCompare(a.draft.updatedAt));
}

/** "VDP · Acme FY27 Q4 · Persona" / "Slack · Activity log · 3 rows" */
export function adminTitle(d: Draft): string {
  if (d.destination.kind !== 'action') return d.plainText.split('\n')[0] ?? 'Draft';
  const a = d.destination.action;
  return `${a.startsWith('vdp.') ? 'VDP' : a.startsWith('feedback.') ? 'Feedback' : 'Logging batch'} · ${d.destination.target.label}`;
}

/**
 * "Find assets for all" (Time ▸ VDP): how many runs today's assistant line covers at what a run really costs, what
 * all of them cost, and the shortfall "Allow $N more today" raises (rounded up to the cent, 0 when they all fit).
 */
export function findAllPlan(a: Pick<VdpCoveragePayload['assets'], 'targets' | 'runUsd' | 'dayLeftUsd' | 'running'>): { all: number; fits: number; fitsUsd: number; allUsd: number; shortUsd: number } {
  const all = Math.max(0, a.targets - a.running);
  const run = Math.max(0.01, a.runUsd);
  const fits = Math.min(all, Math.floor((a.dayLeftUsd + 1e-9) / run));
  const cents = (n: number) => Math.round(n * 100) / 100;
  const allUsd = cents(all * run);
  return { all, fits, fitsUsd: cents(fits * run), allUsd, shortUsd: Math.max(0, Math.ceil((allUsd - a.dayLeftUsd) * 100 - 1e-6) / 100) };
}

/**
 * The VDP re-auth button's words, from the error catalog (src/errors/catalog.ts, AUTH.VDP.COOKIE_EXPIRED's action), so
 * Activity ▸ VDP says what Health and the toasts say ("Re-auth VDP"), never a local string.
 */
export function vdpReauthLabel(code = 'AUTH.VDP.COOKIE_EXPIRED'): string {
  return entryOf(code).action?.label ?? 'Re-auth VDP';
}
