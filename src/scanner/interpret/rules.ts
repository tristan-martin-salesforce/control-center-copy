/**
 * Deterministic pre-filters (review 04 §4.1 #2): items no model needs to read. Pure.
 *
 *   bot        an app or bot message (a `B…` author id, an app-style name)
 *   join       "has joined the channel" and similar system lines
 *   trivial    greetings, thanks, emoji only (the triage pass's isTrivial)
 *   own_no_cue my own message with no commitment or completion words, no file or link, and no candidate home: my ask
 *              of someone else, chat. A promise ("I'll …", "let me …") or a delivery ("here's", a link) still goes on.
 *   bulk_mail  newsletters and notifications (the Gmail fetcher's `bulk`), unless it is a Docs action item for me
 *   calendar_notice  invitation and RSVP mail
 *   seen_decided     recorded before, unchanged, and already given a verdict by an earlier run
 *
 * The cue lists follow `_scanner-common` R7. They decide only what is NOT worth a call; a match never proposes.
 */
import { isTrivial } from '../triage/slack-triage';
import type { NormalizedSourceItem } from '../types';
import type { RuleReason } from './types';

/** R7 commitment words (strong, medium and weak), as a pre-filter: any of them sends my message to the model. */
export const COMMITMENT_CUE = /\b(i'?ll|i will|i'?m going to|going to|gonna|let me|on it|consider it done|i can (?:have|get|send|do|share|put|take)|happy to|will (?:send|share|do|build|get|follow|look|check|update|prepare|put|confirm|review|write|ping|loop)|i'?ll try|we can|we'?ll|i should|i need to|i'?m working on|working on it|by (?:eod|tomorrow|monday|tuesday|wednesday|thursday|friday|end of))\b/i;

/** R7 completion words: "done", "sent", "here's", a link or file. */
export const COMPLETION_CUE = /\b(done|sent|shared|here'?s|here is|here it is|attached|pushed|updated|uploaded|added (?:you|it|the)|signed off|reviewed|confirmed|fixed|completed|finished|see (?:the )?(?:deck|doc|sheet|link|file|slides?)|proposal:|answer(?:ed)?|rough (?:volumes|numbers))\b|✅|https?:\/\//i;

const BOT_NAME = /\b(bot|app|workflow|integration|notifications?|no-?reply|jira|github|pagerduty|google (?:calendar|drive))\b/i;
const JOIN = /^(?:<@[A-Z0-9]+(?:\|[^>]*)?>\s*)?(?:has joined the channel|has left the channel|joined #|was added to|set the channel (?:topic|purpose|description)|renamed the channel)/i;

export function isBot(it: NormalizedSourceItem): boolean {
  const id = it.author?.externalId ?? '';
  if (/^B[A-Z0-9]{6,}$/.test(id)) return true;
  return !it.author?.isMe && !!it.author?.name && BOT_NAME.test(it.author.name) && !it.author.email;
}

export const isJoin = (text: string | undefined) => JOIN.test((text ?? '').trim());

/** My message worth a model look: a promise, a delivery, a file or link. */
export function ownHasCue(it: NormalizedSourceItem): boolean {
  const t = `${it.title ?? ''}\n${it.excerpt ?? ''}`;
  const p = (it.payload ?? {}) as { hasFile?: boolean; files?: unknown[]; attachments?: unknown[]; bodyNew?: string };
  return COMMITMENT_CUE.test(t) || COMPLETION_CUE.test(t) || COMMITMENT_CUE.test(p.bodyNew ?? '') || COMPLETION_CUE.test(p.bodyNew ?? '') || !!p.hasFile || !!p.files?.length || !!p.attachments?.length || !!it.fileRefs?.length;
}

/** The first rule that settles a message without a model, or null (it goes on). `hasCandidate`: a home exists. */
export function messageRule(it: NormalizedSourceItem, o: { hasCandidate: boolean }): RuleReason | null {
  if (isBot(it)) return 'bot';
  if (isJoin(it.excerpt)) return 'join';
  if (isTrivial(it.excerpt) && !it.fileRefs?.length) return 'trivial';
  if (it.author?.isMe && !o.hasCandidate && !ownHasCue(it)) return 'own_no_cue';
  return null;
}

/** Gmail: the fetcher's own classification of bulk and calendar mail. */
export function mailRule(it: NormalizedSourceItem, o: { hasCandidate: boolean }): RuleReason | null {
  const p = (it.payload ?? {}) as { bulk?: boolean; docsAsk?: unknown; calendarNotice?: unknown; direction?: string };
  if (p.docsAsk) return null;
  if (p.bulk) return 'bulk_mail';
  if (p.calendarNotice) return 'calendar_notice';
  if (p.direction === 'sent' && !o.hasCandidate && !ownHasCue(it)) return 'own_no_cue';
  return null;
}

/** Gemini notes: my next steps that are still open (each its own unit). */
export function myOpenSteps(it: NormalizedSourceItem): Array<{ index: number; title: string; description?: string }> {
  const steps = ((it.payload ?? {}) as { myNextSteps?: Array<{ title?: string; description?: string; done?: boolean }> }).myNextSteps ?? [];
  return steps.flatMap((s, i) => (s && typeof s.title === 'string' && s.title.trim() && !s.done ? [{ index: i + 1, title: s.title.trim(), ...(s.description ? { description: String(s.description) } : {}) }] : []));
}
