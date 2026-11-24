/**
 * The deterministic use-case extractor (lane 06 R6, TA-8): use-case shaped statements in a Gemini note, a meeting's
 * title and description, a Slack burst or a mail thread with a customer counterpart. Rules first; a tool-less Haiku
 * pass (confirm.ts) only reads the statements this file marks `unsure`.
 *
 *   precision   a source with no customer counterpart (no external participant, not a customer channel) yields
 *               nothing: an internal-only meeting is never a use case. "wants to know / discuss / sign …" is a
 *               question or a step, not a use case.
 *   cues        "they want to …", "looking to replace …", "a (working) demo / POC / pilot of …", "the POC scope for
 *               …", "agreed to prove … first", "use case: …" (sure when a product or a capability is named);
 *               "asked for …", "asked whether X can …", "replace / automate …" alone (unsure).
 *   products    Settings ▸ Time `dcProducts` and VDP's vocabulary (vocab.ts): the canonical name and the track.
 *   outcome     a KPI or a number named in the same source ("containment 58%", "handle time").
 *   stage       Live (went live, in production) · Build (implementation) · Discovery (a POC, validation, pilot,
 *               demo, scoping, workshop: pre-sale, Org62's U03 Scoping) · null.
 * Pure: no clock, no network.
 */
import { productsIn, productVocabulary, type ProductTerm } from './vocab';
import type { UcMention, UcSource } from './types';

/** Gemini notes: the sections that describe the meeting (not the next steps, which are tasks). */
const NOTE_SECTIONS = /^#{1,3}\s*(summary|decisions|details|notes)\b/i;
const ANY_HEADING = /^#{1,3}\s/;

/** The text worth reading in a source (a Gemini note: its Summary and Decisions; anything else as it is). */
export function readableText(s: Pick<UcSource, 'kind' | 'text'>): string {
  if (s.kind !== 'gemini_note' || !/^#{1,3}\s/m.test(s.text)) return s.text;
  const out: string[] = [];
  let on = false;
  for (const ln of s.text.split('\n')) {
    if (ANY_HEADING.test(ln)) {
      on = NOTE_SECTIONS.test(ln);
      continue;
    }
    if (on && !/^transcription (ended|started)/i.test(ln.trim())) out.push(ln);
  }
  return out.join('\n');
}

/** Sentences (and bullets) of a text. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?;])\s+(?=[A-Z0-9"“(])/)
    .map((x) => x.replace(/^[\s>*•-]+/, '').replace(/^\[[^\]]{1,60}\]\s*/, '').trim())
    .filter((x) => x.length >= 8 && x.length <= 600);
}

/** Verbs after "want to" that make a question or a step, never a use case. */
const NOT_A_USE_CASE = new Set([
  'know', 'understand', 'see', 'discuss', 'talk', 'meet', 'schedule', 'confirm', 'review', 'check', 'sign', 'hear', 'learn', 'follow', 'share', 'send', 'join', 'chat', 'connect',
  'catch', 'align', 'ask', 'set', 'move', 'keep', 'make', 'finalize', 'close', 'pay', 'get', 'go', 'come', 'be', 'have', 'wait', 'think', 'loop', 'sync', 'clarify', 'revisit', 'visit',
]);

/** Words that say the object is a capability (sure with a strong cue even when no product is named). */
const CAPABILITY = /\b(agents?|assistants?|bots?|status|triage|lookup|profiles?|routing|summar(y|ies|ization)|personali[sz]ation|maintenance|fraud|claims?|orders?|cases?|segmentation|recommendations?|scoring|forecast(ing)?|insights?|deflection|self[- ]service|knowledge|onboarding|activation|identity|360|foundation|intake|dispatch|renewals?|faq|portal)\b/i;

/** Leading words of an object that are not part of its name. */
const LEAD = /^(?:(?:a|an|the|their|our|its|his|her|some|working|live|full|quick|first|new|real|proper)\s+)+/i;
const DEMO_OF = /^(?:demo|demonstration|proof of concept|poc|pilot|prototype|walkthrough|version)\s+(?:of|for)\s+(?:the\s+)?/i;
/** Verbs that open an object but do not name it ("prove claim status first" → "claim status"). */
const SOFT_VERB = /^(?:prove|build|show|see|demo|try|start with|stand up|roll out|launch|use|deliver|deploy|pilot|implement|create|have|get|do)\s+/i;
/** Where the object ends. */
const OBJECT_END = /\s+(?:before|after|by|so that|so|because|which|that|while|when|until|if|but|then|next|this|by end|within|in the demo|in production|first)\b|[,;:().]|\s+and\s+(?:a|an|the|then|also)\b/i;

interface Cue {
  re: RegExp;
  name: string;
  strong: boolean;
  /** The object group index in `re`. */
  obj: number;
  /** The verb group (want-to cues): a NOT_A_USE_CASE verb drops it. */
  verb?: number;
}

const CUES: readonly Cue[] = [
  { name: 'looking to replace', re: /\b(?:looking|want(?:s|ed)?|plan(?:s|ning)?|need(?:s|ed)?)\s+to\s+(replace|retire|consolidate|unify|automate|modernize|migrate)\s+(.+)/i, strong: true, obj: 2, verb: 1 },
  { name: 'wants a demo of', re: /\b(?:want(?:s|ed)?|asked for|asks for|requested|need(?:s|ed)?|would like)\s+(?:an?\s+|the\s+)?(?:working\s+|live\s+|quick\s+)?(?:demo|demonstration|proof of concept|poc|pilot|prototype)\s+(?:of|for|on)\s+(.+)/i, strong: true, obj: 1 },
  { name: 'demo of', re: /\b(?:demo|demonstration|proof of concept|poc|pilot)\s+(?:scope\s+)?(?:of|for)\s+(?:the\s+)?(.+)/i, strong: true, obj: 1 },
  { name: 'agreed to prove', re: /\bagreed to\s+(?:prove|build|pilot|start with|focus on|prioriti[sz]e)\s+(.+)/i, strong: true, obj: 1 },
  { name: 'use case', re: /\buse case(?:s)?\s*(?::|is|would be|-)\s*(.+)/i, strong: true, obj: 1 },
  { name: 'want to', re: /\b(?:they|customer|client|team|we)?\s*(?:want(?:s|ed)?|would like|(?:are|is)\s+looking|plan(?:s|ning)?|aim(?:s)?|hope(?:s)?)\s+to\s+([a-z]+)\s+(.+)/i, strong: true, obj: 2, verb: 1 },
  { name: 'asked whether', re: /\basked (?:whether|if)\s+(.+?)\s+can\s+(.+)/i, strong: false, obj: 1 },
  { name: 'asked for', re: /\basked for\s+(.+)/i, strong: false, obj: 1 },
  { name: 'replace', re: /\b(replace|automate|consolidate|unify)\s+(?:their|the|our)\s+(.+)/i, strong: false, obj: 2 },
];

/** "a working demo of order status before signing" → "order status". */
export function objectPhrase(raw: string): string {
  let s = raw.trim().replace(/\s+/g, ' ');
  for (let i = 0; i < 3; i++) s = s.replace(LEAD, '').replace(DEMO_OF, '').replace(SOFT_VERB, '');
  const end = OBJECT_END.exec(s);
  if (end) s = s.slice(0, end.index);
  s = s.replace(LEAD, '').replace(/\s+(?:support|capabilit(?:y|ies)|use case)$/i, (m) => (/support/i.test(m) ? m : ''));
  return s.trim().split(' ').slice(0, 10).join(' ').replace(/[\s.,;:'"’”)]+$/, '');
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The title a candidate shows ("order status" → "Order status"; a verb that names it stays: "Replace the IVR"). */
export function titleOf(obj: string, verb?: string): string {
  const v = verb && /^(replace|retire|consolidate|unify|automate|modernize|migrate)$/i.test(verb) ? `${verb.toLowerCase()} ` : '';
  return cap(`${v}${obj}`.trim()).slice(0, 120);
}

const OUTCOME = /\b(containment|handle time|aht|deflection|csat|nps|conversion|churn|first[- ]contact resolution|resolution time|time to resolve|cost per|revenue|savings?|reduc\w+ [^.]{0,40}\d+\s?%|\d+(?:\.\d+)?\s?%)/i;

/** The outcome or KPI a source names (the first sentence with one), clipped. */
export function outcomeOf(sentences: readonly string[], near: string): string {
  if (OUTCOME.test(near)) return near.slice(0, 200);
  const s = sentences.find((x) => OUTCOME.test(x));
  return s ? s.slice(0, 200) : '';
}

/** The VDP execution phase a source sounds like. */
export function stageHintOf(text: string): string | null {
  if (/\b(went live|is live|in production|go-?live (?:was|happened)|rolled out)\b/i.test(text)) return 'Live';
  if (/\b(implementation|implementing|in build|being built|rolling out)\b/i.test(text)) return 'Build';
  if (/\b(proof of concept|poc|pilot|technical validation|validation|prototype|demo|discovery|scoping|scope|workshop|requirements)\b/i.test(text)) return 'Discovery';
  return null;
}

/** A source has a customer on the other side (precision: internal-only sources yield nothing). */
export const hasCustomer = (s: Pick<UcSource, 'externalEmails' | 'externalDomains' | 'customer'>): boolean => !!s.customer || s.externalEmails.length > 0 || s.externalDomains.length > 0;

export interface ExtractOptions {
  vocab?: readonly ProductTerm[];
  /** At most this many mentions per source (default 4). */
  limit?: number;
}

/** The use-case shaped statements of one source. */
export function extractMentions(src: UcSource, o: ExtractOptions = {}): UcMention[] {
  if (!hasCustomer(src)) return [];
  const vocab = o.vocab ?? productVocabulary();
  const text = readableText(src);
  const sentences = sentencesOf(src.kind === 'meeting' ? `${src.title}.\n${text}` : text);
  const stage = stageHintOf(`${src.title} ${text}`);
  const out: UcMention[] = [];
  const seen = new Set<string>();
  for (const s of sentences) {
    for (const c of CUES) {
      const m = c.re.exec(s);
      if (!m) continue;
      const verb = c.verb ? (m[c.verb] ?? '').toLowerCase() : undefined;
      if (verb && NOT_A_USE_CASE.has(verb)) continue;
      const raw = m[c.obj] ?? '';
      const obj = objectPhrase(c.name === 'want to' && verb && !SOFT_VERB.test(`${verb} `) ? `${verb} ${raw}` : raw);
      const words = obj.split(' ').filter(Boolean);
      if (words.length < 1 || words.length > 10 || obj.length < 4) continue;
      const products = productsIn(`${s} ${obj}`, vocab);
      const named = products.length > 0 || CAPABILITY.test(obj);
      const title = titleOf(obj, c.name === 'looking to replace' ? verb : undefined);
      const key = title.toLowerCase();
      if (seen.has(key)) break;
      seen.add(key);
      const track = products[0]?.track ?? (/\b(agents?|assistants?|bots?|faq|self[- ]service|deflection)\b/i.test(obj) ? 'agentforce' : /\b(profiles?|identity|360|foundation|segmentation|data)\b/i.test(obj) ? 'd360' : null);
      out.push({
        sourceKey: src.key,
        statement: s.slice(0, 300),
        title,
        problem: s.slice(0, 300),
        products: products.map((p) => p.name),
        track,
        outcome: outcomeOf(sentences, s),
        stageHint: stage,
        cue: c.name,
        certainty: c.strong && named && words.length >= 1 ? 'sure' : 'unsure',
      });
      break;
    }
    if (out.length >= (o.limit ?? 4)) break;
  }
  return out;
}
