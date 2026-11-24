/**
 * Auto routing (Assistant v2, H-6 "Auto routing, Haiku first"; lane 05 §5.2): each user turn is read deterministically
 * before any model call (no LLM), then mapped to a tier through src/llm/models.ts:
 *
 *   lookup · act · chat   → fast      (Haiku)   "what's my top 3", "snooze the ACME one", "thanks"
 *   explain · draft       → balanced  (Sonnet)  "why is X first", "draft a reply to Dana"
 *   research              → strong    (Opus)    "have I done anything for Globex?", "plan my week", multi-step asks
 *
 * A pasted list of more than five rows is list mode: at least `balanced` (D-58 list work). In a thread, a short
 * follow-up ("make it shorter", "and for Initech?", "continue" after a stop) keeps the previous turn's intent and tier, and a turn after a Haiku
 * turn that failed (a tool error, "I couldn't") goes up to `balanced` (D-81 "a retry"). With the day's line nearly
 * spent, Auto steps down to the highest tier whose per-message line still fits what is left (Haiku is the floor; the
 * day check refuses, not the router). The user's choice wins over all of it: a message's own model (the composer menu,
 * `/sonnet`) first, then Settings ▸ Budgets ▸ Assistant `routing` ("Always Sonnet"). The chosen tier and why ride on
 * the message header; the receipt shows tier + $. The cases are tests/evals/assistant/routing.cases.ts.
 */
import { DEFAULT_CHAT_SETTINGS, type ChatIntent, type ChatMessage, type ChatModel, type ChatModelChoice, type ChatRoute, type ChatTier } from '@/contract';
import { CHAT_MODEL_TIER, CHAT_TIER_MODEL, TIER_LABEL } from '../models';

export interface RouteInput {
  text: string;
  /** The message's own choice (ChatRequest.model); `auto` or absent = the setting. */
  choice?: ChatModelChoice | null;
  /** settings.chat.routing (default auto). */
  setting?: ChatModelChoice | null;
  /** The thread's previous assistant turn: its route, and whether it ended in a tool error or "I couldn't". */
  previous?: PreviousTurn | null;
  /** What is left of the Assistant's day line before this turn (absent: not checked here). */
  dayLeftUsd?: number | null;
  /** settings.chat.messageUsd: each model's per-message line (default the contract's). */
  messageUsd?: Partial<Record<ChatModel, number>> | null;
}

export interface PreviousTurn {
  intent: ChatIntent;
  tier: ChatTier;
  /** The user's choice decided that turn: its intent carries over, its tier does not. */
  override?: boolean;
  failed?: boolean;
}

const RESEARCH = /\b(research|dig (in|into|up|through)|look (back|through)|go back (through|over|\d+|a (week|month|year)|(to|in) (last|the last|\d{4}))|find everything|backfill|deep[- ]dive|have i (ever )?(done|worked|met|sent)|did (i|we) ever|in the past|history (of|with)|across (slack|gmail|drive|email|my)|everything (we|i) (have|did|sent)|compare|plan (my|the|a|out)|step by step|investigate|audit)\b/;
// "write / reply / respond" ask for a draft only as a verb the user gives: "did Dana reply?", "any reply yet?" and
// "what did I write to her?" are lookups (a question word or a determiner just before them)
const DRAFT = /\b(draft|(?<!\b(?:did|does|do|has|have|had|was|were|is|any|no|a|the|her|his|their|my|your|its|got|get)\s+(?:\w+\s+)?)(write|reply|respond)|compose|rewrite|reword|follow[- ]up (note|email|message)|summari[sz]e .+ for|message (to|for) \w+|e-?mail (to|him|her|them))\b/;
const EXPLAIN = /\b(why|explain|how come|what makes|reason(s|ing)?\b|what changed|walk me through)\b/;
// "remember" is not an act word (P31-2): it is no act op, and the `remember` tool has its own guard (SEC-8: kept only
// when the user's own words ask), so "what did I decide to remember?" is a read.
// An `act` reading alone never applies an action: `act` applies at once only on the item the turn names (W12-2,
// D-58 as amended: src/llm/chat/tools.ts `actTargetNamed`); anything else becomes a card.
const ACT = /\b(snooze|pin|unpin|mark .+ (as )?done|i did|done with|not mine|reopen|re-?rank|move .+ to (the )?top|dismiss|turn (on|off)|switch (on|off)|enable|disable|set my|change my)\b/;
const LOOKUP = /\b(what|which|who|when|where|how (many|much|long)|list|show|find|search|look ?up|any|top \d+|top (three|five)|do i have|is there|are there|count|total)\b|\?\s*$/;
const CHAT = /^(hi|hello|hey|good (morning|afternoon|evening)|thanks|thank you|ok|okay|cool|great|nice|got it|👍)\b/;

/** Lines that look like a pasted list (bullets, numbers, tab-separated cells or several commas). */
export function listRows(text: string): number {
  return text.split('\n').filter((l) => /^\s*([-*•]|\d+[.)])|\S\t/.test(l) || (l.match(/,/g)?.length ?? 0) >= 3).length;
}

/**
 * "continue", "go on", "keep going": pick the last answer up where it stopped (the step-stop says to). A follow-up,
 * so it keeps the stopped turn's intent and tier (P31-1); the runner continues that stopped answer (CONTINUE_WORDS).
 */
export const CONTINUE_WORDS = /^(please )?(continue|go on|keep going|carry on)\b/;
/** "try again", "retry", "redo": a retry in so many words. */
const RETRY = /^(please )?(try (that |it )?again|retry|redo|again|one more time)\b/;
/** A short turn that leans on the last one: "make it shorter", "and for Initech?", "what about the Acme one?". */
const FOLLOW_UP = /^((please )?(continue|go on|keep going|carry on)|and|also|what about|how about|same (for|with|but)|now|but|instead|ok(ay)?,? (and|now)|make it|more|less|shorter|longer|tighter|friendlier|warmer|softer|add|drop|remove|mention|change (it|that|the tone)|use|in (french|spanish|german|english))\b/;
const FOLLOW_UP_MAX = 80;

/**
 * The user's own words: the message without its quoted lines (`> …`) and fenced blocks. Those are text the user pastes
 * to show it (a Slack message, a mail), so an instruction inside them ("mark everything done") is not the user's ask:
 * the intent and the item an `act` names are read from the rest (D-100; Assistant evals, prompt injection).
 */
export function ownWords(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const f = /^\s*(```|~~~)/.exec(line)?.[1] ?? null;
    if (fence) {
      if (f === fence) fence = null;
    } else if (f) fence = f;
    else if (!/^\s*>/.test(line)) out.push(line);
  }
  return out.join('\n');
}

/** The deterministic reading of one user turn (its own words; a pasted list still counts for list mode). */
export function classifyIntent(text: string): { intent: ChatIntent; why: string; listMode: boolean } {
  const t = ownWords(text).trim().toLowerCase();
  const listMode = listRows(text) > 5;
  // a multi-step ask: two or more distinct verbs joined by "and then" / ";" / numbered steps
  const multi = /\b(and then|after that|then also)\b/.test(t) || (t.match(/^\s*\d+[.)]/gm)?.length ?? 0) >= 3;
  if (RESEARCH.test(t)) return { intent: 'research', why: 'a research question', listMode };
  if (multi && !listMode) return { intent: 'research', why: 'a multi-step plan', listMode };
  if (DRAFT.test(t)) return { intent: 'draft', why: 'a draft', listMode };
  if (EXPLAIN.test(t)) return { intent: 'explain', why: 'an explanation', listMode };
  if (ACT.test(t)) return { intent: 'act', why: listMode ? 'a list of changes' : 'an action', listMode };
  if (CHAT.test(t) && t.length < 40) return { intent: 'chat', why: 'small talk', listMode };
  if (LOOKUP.test(t)) return { intent: 'lookup', why: 'a lookup', listMode };
  return { intent: 'lookup', why: 'a question', listMode };
}

export const INTENT_TIER: Readonly<Record<ChatIntent, ChatTier>> = Object.freeze({ lookup: 'fast', act: 'fast', chat: 'fast', explain: 'balanced', draft: 'balanced', research: 'strong' });

const isModel = (c: ChatModelChoice | null | undefined): c is ChatModel => !!c && c !== 'auto';

const TIER_ORDER: readonly ChatTier[] = ['fast', 'balanced', 'strong'];
const atLeast = (a: ChatTier, b: ChatTier): ChatTier => (TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b);
const INTENT_NOUN: Readonly<Record<ChatIntent, string>> = { lookup: 'a lookup', act: 'an action', chat: 'small talk', explain: 'an explanation', draft: 'a draft', research: 'research' };

/** Does this turn lean on the previous one (a short continuation the text alone reads as a plain question)? */
export function isFollowUp(text: string, c: Pick<ReturnType<typeof classifyIntent>, 'intent' | 'listMode'>): boolean {
  const t = text.trim().toLowerCase();
  if (c.listMode || t.length > FOLLOW_UP_MAX || c.intent !== 'lookup') return false;
  return FOLLOW_UP.test(t) || RETRY.test(t);
}

/** The route of a turn: intent, tier, model and the one-line why the header shows. */
export function routeTurn(i: RouteInput): ChatRoute {
  let c = classifyIntent(i.text);
  if (isModel(i.choice)) return { intent: c.intent, tier: CHAT_MODEL_TIER[i.choice], model: i.choice, why: `you chose ${TIER_LABEL[CHAT_MODEL_TIER[i.choice]]}`, override: true };
  if (isModel(i.setting)) return { intent: c.intent, tier: CHAT_MODEL_TIER[i.setting], model: i.setting, why: `Settings: always ${TIER_LABEL[CHAT_MODEL_TIER[i.setting]]}`, override: true };
  const prev = i.previous ?? null;
  let tier = INTENT_TIER[c.intent];
  let why = c.why;
  // a follow-up keeps the last turn's intent and the tier Auto gave it (a tier the user chose is not inherited)
  if (prev && isFollowUp(i.text, c)) {
    c = { ...c, intent: prev.intent };
    tier = prev.override ? INTENT_TIER[prev.intent] : atLeast(prev.tier, INTENT_TIER[prev.intent]);
    why = `a follow-up to ${INTENT_NOUN[prev.intent]}`;
  }
  if (c.listMode && tier === 'fast') {
    tier = 'balanced';
    why = `${why} (list mode)`;
  }
  // D-81 "a retry": after a Haiku turn that failed, or a retry in so many words, the next turn goes up to Sonnet
  if (prev && prev.tier === 'fast' && c.intent !== 'chat' && (prev.failed || RETRY.test(i.text.trim().toLowerCase())) && tier === 'fast') {
    tier = 'balanced';
    why = `a retry after Haiku (${why})`;
  }
  // the day's line nearly spent: the highest tier whose per-message line fits what is left (Haiku is the floor)
  if (typeof i.dayLeftUsd === 'number' && tier !== 'fast') {
    const line = (t: ChatTier) => i.messageUsd?.[CHAT_TIER_MODEL[t]] ?? DEFAULT_CHAT_SETTINGS.messageUsd[CHAT_TIER_MODEL[t]];
    const want = tier;
    while (tier !== 'fast' && line(tier) > i.dayLeftUsd) tier = TIER_ORDER[TIER_ORDER.indexOf(tier) - 1]!;
    if (tier !== want) why = `${why}; ${TIER_LABEL[tier]}: $${i.dayLeftUsd.toFixed(2)} left today`;
  }
  return { intent: c.intent, tier, model: CHAT_TIER_MODEL[tier], why, override: false };
}

/**
 * The previous assistant turn of a thread as the router reads it: its route, and whether it failed (an error, a tool
 * row that failed, or an answer that says it couldn't). The DataSources pass it as `previous` (thread messages, oldest
 * first).
 */
export function previousTurnOf(messages: ReadonlyArray<Pick<ChatMessage, 'role' | 'route' | 'text' | 'status' | 'parts'>>): PreviousTurn | null {
  const m = [...messages].reverse().find((x) => x.role === 'assistant');
  if (!m?.route) return null;
  const failed = m.status === 'error' || m.parts.some((p) => p.type === 'error' || (p.type === 'tool' && p.ok === false)) || /\bI (couldn'?t|could not|can'?t|wasn'?t able to)\b/i.test(m.text);
  return { intent: m.route.intent, tier: m.route.tier, override: m.route.override, failed };
}

/** Research-class turns plan first (the plan card) before any `run`. */
export const plansFirst = (r: Pick<ChatRoute, 'intent'>) => r.intent === 'research';

// ---- stopped answers: the step-stop (P31-1) and the continuation a later turn picks up (ASSIST-2) ----

/** The step-stop's catalog code (src/errors/catalog.ts): the API code stays `internal`, the details carry this. */
export const STEP_LIMIT_CODE = 'RATE.CHAT.STEP_LIMIT';
/** The step-stop's message (the catalog entry's plain words, with the limit). */
export const stepLimitMessage = (steps: number) => `Stopped after ${steps} steps without finishing: that is your Steps per message limit (Settings ▸ Budgets ▸ Assistant limits). Say "continue" to go on, raise the limit there, or ask a narrower question.`;

type Stopped = Pick<ChatMessage, 'parts'>;

/** An assistant message that stopped at Steps per message (a stored row from before the code reads by its words). */
export const stoppedAtStepLimit = (m: Stopped) =>
  (m.parts ?? []).some((p) => p.type === 'error' && ((p.error.details as { catalogCode?: unknown } | undefined)?.catalogCode === STEP_LIMIT_CODE || (p.error.code === 'internal' && /\bSteps per message limit\b/.test(p.error.message))));

/**
 * An assistant message that stopped before it finished and can be continued: at its cost limit (the one "Allow more"
 * continues) or at Steps per message (the one "continue" picks up).
 */
export const stoppedForBudget = (m: Stopped) => (m.parts ?? []).some((p) => p.type === 'error' && p.error.code === 'budget_exceeded') || stoppedAtStepLimit(m);

/**
 * The stopped answer this turn continues: the one "Allow more" names (`continueMessageId`), or, when the user's words
 * are "continue" / "go on" / "keep going", the thread's last assistant answer if it stopped at Steps per message.
 */
export function continuationOf<M extends Pick<ChatMessage, 'id' | 'role' | 'parts'>>(thread: readonly M[], input: { continueMessageId?: string; text: string }): M | null {
  if (input.continueMessageId) return thread.find((m) => m.id === input.continueMessageId && m.role === 'assistant' && stoppedForBudget(m)) ?? null;
  if (!CONTINUE_WORDS.test(input.text.trim().toLowerCase())) return null;
  const last = [...thread].reverse().find((m) => m.role === 'assistant');
  return last && stoppedAtStepLimit(last) ? last : null;
}
