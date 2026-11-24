/**
 * Resolution rules D1–D6 (docs/reviews/2026-11-20-holistic/03-scanner-quality.md §4.1): what code can decide about
 * "is this item done?" before any model is asked. Pure functions over a small, ordered view of the item's
 * conversation; nothing here reads a store, calls a model or writes. The resolution check (a later chunk) builds the
 * input from its context pack and wires the decision in; the eval harness (tests/evals/scanner) asserts the rules on
 * the golden cases today.
 *
 *   D1  my reply in the ask's DM/thread after the ask carrying the asked file/link (deliveryMatch)   done · Sure
 *   D2  a question-type ask ("Answer…", "Confirm…", "Reply…", or a title ending in "?"), my
 *       substantive reply in the same conversation (not only a promise; ≥ 12 words or a link), and
 *       no later chase by the asker                                                                 done · Sure
 *   D3  a read-back shows the record fixed (Org62 DC, a logged Event, a VDP field)                     done · Sure
 *   D4  a linked Claude session is done with a PR or URL in its last message                          done · Likely
 *   D5  the asker's last line after mine is an acknowledgement, and nothing since                     done · Likely
 *       (Sure when D1 also fired)
 *   D6  nothing new since the last verdict                                                            skip (no call)
 *
 * The model is asked only when no rule decides. A chase by the asker after my last line vetoes D1, D2 and D5: the
 * conversation says it is not finished, whatever I sent before (SCN-4).
 */
import { deliveryMatch } from '../delivery';

export type RuleId = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';

/** One line of the item's own conversation (thread, DM or email thread), as the pack holds it. */
export interface RuleLine {
  /** Pack alias or source item id: what a decision cites. */
  id: string;
  at: string;
  fromMe: boolean;
  /** Written by the person who asked (or whom I promised). */
  byAsker: boolean;
  text: string;
  /** Attachments REC-1 recorded (name, mimetype). */
  files?: { name?: string; mimetype?: string }[];
  /** Found by the `has:file` search: something is attached, its name unknown. */
  hasFile?: boolean;
}

export interface RuleInput {
  item: { kind: string; title: string; purpose?: string | null };
  /** When it was asked (ISO). Lines at or before it are history, not answers. */
  askAt: string;
  /** Every line after the ask in the ask's own conversation, any order (sorted here). */
  after: RuleLine[];
  /** D3: a read-back of the record the item is about shows it fixed. */
  record?: { fixed: boolean; cite?: string } | null;
  /** D4: the Claude session the item launched or is linked to. */
  session?: { status: string; lastMessage?: string | null; cite?: string } | null;
  /** D6: the last verdict on this item, and when the newest input for it arrived. */
  lastVerdictAt?: string | null;
  latestInputAt?: string | null;
}

export interface RuleDecision {
  rule: RuleId;
  /** `done` closes (at `confidence`); `skip` means no check is needed now. */
  decides: 'done' | 'skip';
  confidence: 'sure' | 'likely' | null;
  /** The line (or read-back / session) that proves it. */
  cite?: string;
  why: string;
}

export interface RuleHints {
  /** Minutes from the ask to my first reply after it (null: none). */
  myReplyAfterAskMin: number | null;
  replyHasLinkOrFile: boolean;
  askerAckAfterMine: boolean;
  askerChasedAfterMine: boolean;
  lastWriter: 'me' | 'asker' | 'other' | null;
}

export interface RulesResult {
  /** Every rule that fired, in rule order. */
  fired: RuleDecision[];
  /** The strongest decision (Sure before Likely; D6 only when nothing else fired), or null: ask the model. */
  decision: RuleDecision | null;
  hints: RuleHints;
}

/** Promises and offers are never completion (skills/check-completion.md rule 1). */
export const PROMISE_RE = /\b(i'?ll|i will|i can|i could|happy to|will send|will share|will get|let me|on it|by eod|by end of day|tomorrow|get back to you|circle back|looking into it)\b/i;

/** A title that asks for an answer rather than an artifact. */
export const QUESTION_TITLE_RE = /^(answer|confirm|reply|respond|tell|explain|clarify|let \S+ know|check (?:with|whether|if)|find out)\b/i;

/** An acknowledgement that closes a loop ("got it, thanks", "that works", "perfect"). */
export const ACK_RE = /^(?:(?:ok(?:ay)?|great|perfect|awesome|thanks?|thank you|ty|thx|got it|received|that works(?: for (?:us|me))?|works (?:for (?:us|me)|now)|looks good|lgtm|sounds good|all good|that'?s it|exactly what i needed|this is great|much appreciated|appreciate it|cheers|nice|cool)\b[\s,.!:;-]*)+/i;
/** A line that asks for more is never an acknowledgement, whatever it starts with. */
const REQUEST_RE = /\?|\b(can you|could you|would you|please|pls|also need|one more|another|still need|doesn'?t (?:work|open)|didn'?t (?:work|get)|can'?t (?:open|access|find|see)|not working|broken|missing|wrong|any update|any news|following up|ping|bump|chase|reminder)\b/i;
/** The asker writing again with a chase or a problem. */
const CHASE_RE = /\?|\b(any update|any news|following up|follow up|just checking|ping|bump|still (?:need|waiting|looking)|doesn'?t (?:work|open)|didn'?t (?:work|get|receive)|can'?t (?:open|access|find|see)|not working|broken|wrong (?:file|link|version)|missing|re-?send|re-?share|again)\b/i;

const URL_RE = /https?:\/\/[^\s|>)]+/g;
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const words = (t: string) => (t.replace(URL_RE, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length;

export function urlsOf(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => m[0]);
}

/** Is the line only a promise or an offer, with no substance of its own? */
export function isPromiseOnly(text: string): boolean {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length) return false;
  const substance = sentences.filter((s) => !PROMISE_RE.test(s));
  return substance.reduce((n, s) => n + words(s), 0) < 12 && !urlsOf(text).length;
}

/** D2's "substantive": a link or a file, or at least 12 words outside promise sentences. */
export function isSubstantive(line: Pick<RuleLine, 'text' | 'files' | 'hasFile'>): boolean {
  if (urlsOf(line.text).length || line.files?.length || line.hasFile) return true;
  return !isPromiseOnly(line.text) && words(line.text.replace(/<@[^>]+>/g, ' ')) >= 12;
}

/** Curly quotes to straight ones, so "doesn’t" matches like "doesn't". */
const plain = (text: string) => text.replace(/[\u2018\u2019]/g, "'");

export function isAcknowledgement(text: string): boolean {
  const t = plain(text).replace(/<@[^>]+>/g, ' ').replace(/:[a-z0-9_+-]+:/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= 200 && ACK_RE.test(t) && !REQUEST_RE.test(t);
}

export function isChase(text: string): boolean {
  return !isAcknowledgement(text) && CHASE_RE.test(plain(text));
}

export function isQuestionTitle(title: string): boolean {
  const t = title.trim();
  return QUESTION_TITLE_RE.test(t) || /\?\s*$/.test(t);
}

/** Run D1–D6. Pure and deterministic. */
export function evaluateRules(input: RuleInput): RulesResult {
  const askMs = ms(input.askAt);
  const after = input.after.filter((l) => ms(l.at) > askMs).sort((a, b) => ms(a.at) - ms(b.at));
  const mine = after.filter((l) => l.fromMe);
  const lastMine = mine[mine.length - 1];
  const sinceMine = lastMine ? after.filter((l) => ms(l.at) > ms(lastMine.at)) : [];
  const askerSinceMine = sinceMine.filter((l) => l.byAsker);
  const chased = askerSinceMine.some((l) => isChase(l.text));
  const last = after[after.length - 1];
  const lastAsker = askerSinceMine[askerSinceMine.length - 1];
  const ackAfterMine = !!lastAsker && lastAsker === last && isAcknowledgement(lastAsker.text);

  const hints: RuleHints = {
    myReplyAfterAskMin: mine[0] && Number.isFinite(askMs) ? Math.round((ms(mine[0].at) - askMs) / 60_000) : null,
    replyHasLinkOrFile: mine.some((l) => urlsOf(l.text).length > 0 || !!l.files?.length || !!l.hasFile),
    askerAckAfterMine: ackAfterMine,
    askerChasedAfterMine: chased,
    lastWriter: last ? (last.fromMe ? 'me' : last.byAsker ? 'asker' : 'other') : null,
  };

  const fired: RuleDecision[] = [];
  // D1: the newest of my lines that carries the asked thing.
  const delivered = chased ? undefined : [...mine].reverse().find((l) => deliveryMatch(input.item, { files: l.files, hasFile: l.hasFile, urls: urlsOf(l.text) }));
  if (delivered) {
    const what = deliveryMatch(input.item, { files: delivered.files, hasFile: delivered.hasFile, urls: urlsOf(delivered.text) });
    fired.push({ rule: 'D1', decides: 'done', confidence: 'sure', cite: delivered.id, why: `my reply after the ask carries ${what}` });
  }
  // D2: a question answered with substance, and no chase since.
  if (!chased && (input.item.kind === 'ask' || input.item.kind === 'follow_up') && isQuestionTitle(input.item.title)) {
    const answer = [...mine].reverse().find((l) => isSubstantive(l));
    if (answer) fired.push({ rule: 'D2', decides: 'done', confidence: 'sure', cite: answer.id, why: 'my substantive reply answers the question, no chase since' });
  }
  if (input.record?.fixed) fired.push({ rule: 'D3', decides: 'done', confidence: 'sure', ...(input.record.cite ? { cite: input.record.cite } : {}), why: 'the read-back shows the record fixed' });
  if (input.session && /^(done|completed|finished|ended)$/i.test(input.session.status) && /https?:\/\/|\bPR\s*#?\d+|\bpull request\b/i.test(input.session.lastMessage ?? '')) {
    fired.push({ rule: 'D4', decides: 'done', confidence: 'likely', ...(input.session.cite ? { cite: input.session.cite } : {}), why: 'the linked session finished with a PR or link' });
  }
  if (ackAfterMine && lastAsker) {
    const withD1 = fired.some((f) => f.rule === 'D1');
    fired.push({ rule: 'D5', decides: 'done', confidence: withD1 ? 'sure' : 'likely', cite: lastAsker.id, why: withD1 ? 'the asker acknowledged my delivery' : 'the asker acknowledged my last reply, nothing since' });
  }
  const lastVerdict = ms(input.lastVerdictAt);
  const latest = ms(input.latestInputAt);
  if (Number.isFinite(lastVerdict) && (!Number.isFinite(latest) || latest <= lastVerdict)) fired.push({ rule: 'D6', decides: 'skip', confidence: null, why: 'nothing new since the last verdict' });

  const done = fired.filter((f) => f.decides === 'done');
  const decision = done.find((f) => f.confidence === 'sure') ?? done[0] ?? fired.find((f) => f.rule === 'D6') ?? null;
  return { fired, decision, hints };
}
