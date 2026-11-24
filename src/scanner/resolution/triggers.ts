/**
 * When the resolution check runs (lane 03 R3): code decides, per new source item, which items to check. Otherwise an
 * item is skipped (no pack, no call). Pure, shared by the DB trigger hook (triggers-db.ts) and the in-memory pipeline.
 *
 *   conversation_line  a new line in the item's conversation (Slack thread or DM, mail thread), or my line to the
 *                      asker anywhere
 *   drive_revision     a revision of the item's file;  drive_share: a share of it
 *   notes              Gemini notes naming it (two deliverable words, or one with the asker in the meeting)
 *   session            a Claude session touching it (linked, or naming two deliverable words)
 *   quiet              the asker gone quiet past the item's expected window (isQuiet, the nightly sweep)
 *   sweep              no check in SWEEP_DAYS (the nightly sweep)
 *
 * Closed items (wave-0 review W0-2): an engine-closed item in the reopen window is checked again only when the new line
 * is from the asker AND addressed to me, or names the deliverable; at most once a day. Chatter in a busy DM never
 * re-judges (or reopens) it; the scanner's DUP-1 `follow_up:` contradiction stays the other way back.
 *
 * Dedupe: one `resolution.check` per item per 10 minutes (per day for a closed item).
 */
import { deliverableWords } from '@/engines/resolution/pack';
import type { ResolutionTrigger } from '@/engines/resolution/types';

export const TRIGGER_DEDUPE_MS = 10 * 60_000;
export const CLOSED_DEDUPE_MS = 24 * 3600_000;
export const SWEEP_DAYS = 7;
export const REOPEN_WINDOW_DAYS = 14;
const DAY = 86_400_000;

export interface TriggerSource {
  id: string;
  connector: string;
  /** file_revision, file_share, meeting_notes, session, message, email … */
  kind: string;
  occurredAt: string;
  fromMe: boolean;
  /** Lower-cased author keys (Slack id, email, name). */
  authorKeys: string[];
  addressedToMe: boolean;
  /** My line: whom it went to (lower-cased keys). "A new message from me to the asker anywhere" is a trigger (§4.1). */
  recipientKeys?: string[];
  /** `dm:<channel>`, `slack:<channel>:<threadTs>`, `gmail-thread:<id>` … (the scanner stores' conversation keys). */
  conversationKey?: string | null;
  fileRefs: string[];
  text: string;
  sessionId?: string | null;
}

export interface TriggerItem {
  id: string;
  status: string;
  title: string;
  doneAt?: string | null;
  doneBy?: string | null;
  askAt: string;
  conversationKeys: string[];
  fileRefs: string[];
  askerKeys: string[];
  sessionIds: string[];
}

export interface TriggerHit {
  itemId: string;
  trigger: ResolutionTrigger;
  sourceItemId: string;
  dedupeKey: string;
}

const LIVE = new Set(['open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done']);
const wordsOf = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []);
export const namesCount = (title: string, text: string) => {
  const ws = wordsOf(text);
  return deliverableWords(title).filter((w) => ws.has(w)).length;
};

/** The idempotency key that dedupes a trigger: per item per 10 minutes (per day for a closed item). */
export function triggerDedupeKey(itemId: string, now: Date, closed = false): string {
  const bucket = Math.floor(now.getTime() / (closed ? CLOSED_DEDUPE_MS : TRIGGER_DEDUPE_MS));
  return `resolution.check:${itemId}:${closed ? 'd' : 'm'}${bucket}`;
}

/** W0-2: is this new line in a closed item's conversation worth a re-check? */
export function closedItemLineCounts(item: TriggerItem, s: TriggerSource): boolean {
  if (s.fromMe) return false;
  const byAsker = s.authorKeys.some((k) => item.askerKeys.includes(k));
  return (byAsker && s.addressedToMe) || namesCount(item.title, s.text) >= 1;
}

/** Which items each new source triggers (at most one hit per item: the first trigger wins). */
export function triggersFor(items: TriggerItem[], sources: TriggerSource[], now: Date, o: { reopenOnFollowUp?: boolean; reopenWindowDays?: number } = {}): TriggerHit[] {
  const out = new Map<string, TriggerHit>();
  const windowMs = (o.reopenWindowDays ?? REOPEN_WINDOW_DAYS) * DAY;
  for (const it of items) {
    const closed = it.status === 'done';
    if (closed) {
      if (o.reopenOnFollowUp === false || it.doneBy !== 'engine' || !it.doneAt || now.getTime() - Date.parse(it.doneAt) > windowMs) continue;
    } else if (!LIVE.has(it.status)) continue;
    const askMs = Date.parse(it.askAt);
    for (const s of sources) {
      if (Date.parse(s.occurredAt) <= askMs) continue;
      if (closed && Date.parse(s.occurredAt) <= Date.parse(it.doneAt!)) continue;
      let trigger: ResolutionTrigger | null = null;
      if (s.conversationKey && it.conversationKeys.includes(s.conversationKey)) trigger = closed ? (closedItemLineCounts(it, s) ? 'conversation_line' : null) : 'conversation_line';
      else if (closed) trigger = null;
      else if (s.fromMe && (s.recipientKeys ?? []).some((k) => it.askerKeys.includes(k))) trigger = 'conversation_line';
      else if (s.connector === 'drive' && s.fileRefs.some((f) => it.fileRefs.includes(f))) trigger = s.kind === 'file_share' ? 'drive_share' : 'drive_revision';
      else if (s.connector === 'gemini_notes') {
        const n = namesCount(it.title, s.text);
        if (n >= 2 || (n >= 1 && s.authorKeys.some((k) => it.askerKeys.includes(k)))) trigger = 'notes';
      } else if (s.connector === 'claude_sessions' && ((s.sessionId && it.sessionIds.includes(s.sessionId)) || namesCount(it.title, s.text) >= 2)) trigger = 'session';
      if (trigger && !out.has(it.id)) out.set(it.id, { itemId: it.id, trigger, sourceItemId: s.id, dedupeKey: triggerDedupeKey(it.id, now, closed) });
    }
  }
  return [...out.values()];
}

/** How long an item may sit without a word from the asker before the check asks whether it went quiet. */
export function expectedWindowDays(kind: string): number {
  return kind === 'ask' ? 5 : kind === 'commitment' ? 7 : kind === 'follow_up' ? 7 : 10;
}

/**
 * The per-item "quiet" detector: past its due date, or past the kind's window since the ask, with no line from anyone
 * in its conversation since the window started (so a live back-and-forth never counts as quiet).
 */
export function isQuiet(x: { kind: string; askAt: string; dueAt?: string | null; lastLineAt?: string | null }, now: Date): boolean {
  const start = x.dueAt ? Date.parse(x.dueAt) : Date.parse(x.askAt) + expectedWindowDays(x.kind) * DAY;
  if (!Number.isFinite(start) || now.getTime() <= start) return false;
  const last = Date.parse(x.lastLineAt ?? '');
  return !Number.isFinite(last) || last <= start;
}

/** The nightly sweep: an item with no check in SWEEP_DAYS (or never checked). */
export function sweepDue(lastCheckAt: string | null | undefined, now: Date, days = SWEEP_DAYS): boolean {
  const t = Date.parse(lastCheckAt ?? '');
  return !Number.isFinite(t) || now.getTime() - t >= days * DAY;
}
