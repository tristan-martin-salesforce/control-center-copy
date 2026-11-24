/**
 * D-66: the Org62 Description of a logged row, written like a teammate's note instead of a log key.
 *
 *   templateNote      the deterministic note every row gets: what was done and with whom (a team or an org, never a
 *                     person's contact details), the topic, the VDP use case when the row's opp has one, and the next
 *                     step when the meeting notes give one. 1–2 sentences, at most NOTE_MAX characters.
 *   noteSummaryRequest / parseNoteSummary
 *                     the cheap model's note where meeting notes exist (the `activity.notes` job; under the daily caps).
 *                     Anything it returns goes through `cleanNote`; an unusable answer is null and the template stays.
 *   cleanNote         credential-like text redacted, emails, phone numbers and links removed, one line, clipped.
 *   withCcKey         the Description as written to Org62: the note, then the exact `CC#<row id>` token at the END
 *                     (the read-back joins on it; matching is the time-roundtrip lane's, not this file's).
 *
 * Pure: no I/O, no clock.
 */
import { redactText } from '@/lib/redact';

/** The longest note the app writes (the user's own edit may be longer). */
export const NOTE_MAX = 300;
/** Bump when the summary prompt changes: cached summaries of the old prompt are made again. */
export const NOTE_PROMPT_VERSION = 'activity-note@1';
/** How the row's note was made. A note the user edited is locked (`logNote` in userLockedFields): theirs. */
export type NoteBasis = 'template' | 'summary';

export interface NoteFacts {
  /** A meeting, an onsite day, travel, or off-calendar work (Claude sessions, Drive edits, Slack). */
  kind: 'meeting' | 'onsite' | 'travel' | 'work';
  /** The row's subject (the meeting title, the work label). */
  subject: string;
  taskType: string | null;
  /** D-64: internal-only work (no customer). */
  internal?: boolean;
  /** The customer's short name ("ACME" of "ACME - Data 360 Expansion"). */
  customer?: string | null;
  /** External attendee domains of a meeting (customer, partner). */
  externalDomains?: readonly string[];
  /** The VDP use case of the row's opp. */
  useCase?: string | null;
  /** The next step the meeting notes give. */
  nextStep?: string | null;
  /** Off-calendar evidence: Claude session topics, Drive doc titles, Slack channel names, repos. */
  sessions?: readonly string[];
  docs?: readonly string[];
  channels?: readonly string[];
  repos?: readonly string[];
  city?: string | null;
}

// ------------------------------------------------------------------ wording

/** What a meeting of this SE task type was, as a teammate would open the note. */
const MEETING_LEAD: Readonly<Record<string, string>> = {
  'Customer Discovery': 'Discovery session',
  Workshop: 'Workshop',
  POC: 'POC working session',
  'Customer Presentation': 'Presentation',
  'Consumption Estimation': 'Consumption review',
  'Business Value Assessment': 'Business value session',
  'BVS - Business Case': 'Business case session',
  'BVS - Proposal': 'Proposal session',
  'BVS - Value Hypothesis': 'Value hypothesis session',
  'Account Planning': 'Account planning',
  RFx: 'RFx working session',
  'Dry Run': 'Dry run',
  'Solution Creation': 'Solution design session',
  'Partner Support': 'Partner session',
  'Post Sale Consumption Activation': 'Consumption activation session',
  'Post Sale Adoption Support': 'Adoption support session',
  'Post Sale Technical Product Support': 'Technical product support session',
  'Red Account Support': 'Red account support',
  'Marketing Support': 'Marketing event',
  Travel: 'Travel',
  'Personal Development': 'Learning session',
  'Sales Enablement': 'Enablement session',
  'Asset Creation': 'Asset working session',
  Mentorship: 'Mentoring session',
};

/** What off-calendar work of this type was. */
const WORK_LEAD: Readonly<Record<string, string>> = {
  'Solution Creation': 'Solution build',
  'Consumption Estimation': 'Consumption estimate',
  'Account Planning': 'Account planning',
  RFx: 'RFx response',
  'Dry Run': 'Dry-run prep',
  'BVS - Business Case': 'Business case',
  'BVS - Proposal': 'Proposal',
  'BVS - Value Hypothesis': 'Value hypothesis',
  'Business Value Assessment': 'Business value assessment',
  'Customer Presentation': 'Presentation prep',
  'Customer Discovery': 'Discovery prep',
  Workshop: 'Workshop prep',
  POC: 'POC build',
  'Asset Creation': 'Internal asset build',
  'Personal Development': 'Learning',
  'Sales Enablement': 'Enablement prep',
};

const sentenceCase = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const lowerFirst = (s: string) => (s && !/^[A-Z]{2}/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);
/** An SE task type not in the lists ("Technical Deep Dive") reads as itself, in sentence case. */
const typePhrase = (t: string) => sentenceCase(t.toLowerCase().replace(/\b(poc|rfx|bvs|cio|cdp|ai|sow)\b/g, (w) => w.toUpperCase()));
const meetingLead = (t: string | null) => (t ? (MEETING_LEAD[t] ?? typePhrase(t)) : 'Meeting');
const workLead = (t: string | null) => (t ? (WORK_LEAD[t] ?? typePhrase(t)) : 'Prep work');

const quote = (s: string) => `'${s.replace(/'/g, '’')}'`;
const listOf = (xs: readonly string[], n: number): string => {
  const head = xs.slice(0, n);
  const more = xs.length - head.length;
  const body = head.length <= 1 ? (head[0] ?? '') : `${head.slice(0, -1).join(', ')} and ${head.at(-1)}`;
  return more > 0 ? `${head.join(', ')} and ${more} more` : body;
};

/** Words that say nothing about the topic of a meeting. */
const FILLER = new Set(
  'a an and the with for of on to in at by x vs call calls meeting meetings sync session sessions chat catch up catch-up touchpoint touch base connect intro introduction weekly biweekly bi-weekly daily monthly meet discussion follow-up followup salesforce sfdc slack'.split(' '),
);
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];

/**
 * The topic of a meeting from its title: the customer's and our names, separators ("|", "<>", " x ", "//") and dates
 * removed. Empty when what is left says no more than the lead ("ACME | Discovery" → "" next to "Discovery session").
 */
export function topicOf(title: string, names: readonly (string | null | undefined)[] = [], lead = ''): string {
  let t = ` ${title} `;
  for (const n of names) {
    if (!n || n.length < 2) continue;
    t = t.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:'s|’s)?(?=$|[^\\p{L}\\p{N}])`, 'giu'), '$1 ');
  }
  t = t
    .replace(/\b(salesforce|sfdc)\b/gi, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(st|nd|rd|th)?\b/gi, ' ')
    .replace(/<>|<->|\/\/|\s[x×]\s|\s-\s|[|•·:–—]/g, ' ; ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ');
  const leadWords = words(lead);
  // "exec briefing" says no more than "Executive briefing": a word is known when a lead word starts with it (or it with one)
  const known = (w: string) => FILLER.has(w) || leadWords.some((l) => l === w || (w.length >= 3 && l.length >= 3 && (l.startsWith(w) || w.startsWith(l))));
  // each part ("ACME", "Discovery", "Phase 2 scoping") stays only when it says more than the lead
  const parts = t
    .split(';')
    .map((p) => p.trim().replace(/^[-/,&+\s]+|[-/,&+\s]+$/g, '').trim())
    .filter((p) => words(p).some((w) => !known(w)));
  const topic = parts.join(' – ').replace(/\s+/g, ' ').trim();
  if (!topic) return '';
  return topic.length > 90 ? `${topic.slice(0, 88).replace(/\s+\S*$/, '')}…` : topic;
}

/** "Phase 2 scoping" or "" → " on Phase 2 scoping". */
const onTopic = (topic: string) => (topic ? ` on ${topic}` : '');
/** D-64: said once, unless the lead already says it ("Internal asset build"). */
const internalTag = (lead: string) => (/\binternal\b/i.test(lead) ? '' : ' (internal, no customer)');
const ucPart = (uc: string | null | undefined) => (uc?.trim() ? ` (use case: ${uc.trim().replace(/[()]/g, '')})` : '');

function meetingSentence(f: NoteFacts): string {
  const lead = meetingLead(f.taskType);
  const domains = [...new Set((f.externalDomains ?? []).filter(Boolean))];
  const names = [f.customer, ...domains.map((d) => d.split('.')[0])];
  const topic = topicOf(f.subject, names, lead);
  const uc = ucPart(f.useCase);
  if (f.internal) return `${lead}${topic ? `: ${topic}` : ''}${internalTag(lead)}.`;
  if (domains.length) {
    const who = f.customer ? `the ${f.customer} team` : `attendees from ${listOf(domains, 3)}`;
    return `${lead} with ${who}${onTopic(topic)}${uc}.`;
  }
  if (f.customer) return `${/^internal\b/i.test(lead) ? lead : `Internal ${lowerFirst(lead)}`} for ${f.customer}${onTopic(topic)}${uc}.`;
  return `${lead}${topic ? `: ${topic}` : ''}${uc}.`;
}

function workEvidence(f: NoteFacts): string {
  const bits: string[] = [];
  const sessions = [...new Set(f.sessions ?? [])].filter(Boolean);
  const docs = [...new Set(f.docs ?? [])].filter(Boolean);
  const channels = [...new Set(f.channels ?? [])].filter(Boolean);
  if (sessions.length) bits.push(`Claude Code work on ${listOf(sessions.map(quote), 2)}`);
  if (docs.length) bits.push(`edited ${listOf(docs.map(quote), 2)} in Drive`);
  if (channels.length) bits.push(`worked with the team in ${listOf(channels.map((c) => `#${c.replace(/^#/, '')}`), 2)}`);
  return bits.join('; ');
}

function workSentence(f: NoteFacts): string {
  const lead = workLead(f.taskType);
  const ev = workEvidence(f);
  const repos = [...new Set(f.repos ?? [])].filter(Boolean);
  const where = repos.length ? ` in ${listOf(repos, 2)}` : '';
  if (f.internal) return `${lead}${where}${internalTag(lead)}${ev ? `: ${ev}` : ''}.`;
  const forWho = f.customer ? ` for ${f.customer}` : '';
  return `${lead}${forWho}${ucPart(f.useCase)}${ev ? `: ${ev}` : where}.`;
}

function onsiteSentence(f: NoteFacts): string {
  const at = f.customer ? `at ${f.customer}` : 'at the customer';
  const city = f.city ? ` in ${f.city}` : '';
  return `Onsite day ${at}${city}: ${lowerFirst(meetingLead(f.taskType))} with the ${f.customer ? `${f.customer} ` : ''}team${ucPart(f.useCase)}.`;
}

function travelSentence(f: NoteFacts): string {
  const topic = topicOf(f.subject, [], 'travel');
  const forWho = f.customer ? ` for the ${f.customer} onsite` : '';
  return `Travel${forWho}${topic ? `: ${topic}` : ''}.`;
}

/** The next step as its own sentence: "Next step: Send the POC plan." */
export function nextStepSentence(step: string | null | undefined): string {
  const s = (step ?? '').replace(/\s+/g, ' ').replace(/^(next steps?|action item|todo|to-do)\s*[:-]\s*/i, '').replace(/[.;,\s]+$/, '').trim();
  return s ? `Next step: ${sentenceCase(s)}.` : '';
}

/** The deterministic note (D-66): 1–2 sentences, at most NOTE_MAX characters, credential-redacted. */
export function templateNote(f: NoteFacts): string {
  const first = f.kind === 'work' ? workSentence(f) : f.kind === 'onsite' ? onsiteSentence(f) : f.kind === 'travel' ? travelSentence(f) : meetingSentence(f);
  const next = nextStepSentence(f.nextStep);
  const a = cleanNote(first);
  if (!next) return a;
  const both = `${a} ${cleanNote(next)}`;
  // the next step is the part that fits second: drop it rather than cut the first sentence
  return both.length <= NOTE_MAX ? both : a;
}

// ------------------------------------------------------------------ the use case

export interface UseCaseOption {
  title: string | null;
  /** VDP's priority ('3 - High', '2 - Medium', '1 - Low'). */
  priority?: string | null;
}

const UC_STOP = new Set(['data', 'cloud', 'agentforce', 'salesforce', 'customer', 'phase', 'with', 'from', 'into', 'their', 'this', 'that', 'use', 'case', 'cases', 'agent', 'agents', 'service', 'platform']);
const ucWords = (s: string) => new Set(words(s).filter((w) => w.length >= 4 && !UC_STOP.has(w)));

/**
 * The use case a row names, of its opp's VDP use cases: the only one; else the one whose title shares the most
 * distinctive words with the row (its subject, sessions, docs); else the one High-priority one. Several and nothing to
 * tell them apart: none (a wrong use case in Org62 is worse than none: tenet Trustworthy).
 */
export function pickUseCase(options: readonly UseCaseOption[], hint: string): string | null {
  const titled = options.filter((o): o is UseCaseOption & { title: string } => !!o.title?.trim());
  const uniq = [...new Map(titled.map((o) => [o.title.trim().toLowerCase(), o])).values()];
  if (uniq.length === 0) return null;
  if (uniq.length === 1) return uniq[0]!.title.trim();
  const h = ucWords(hint);
  const scored = uniq.map((o) => ({ o, n: [...ucWords(o.title)].filter((w) => h.has(w)).length })).sort((a, b) => b.n - a.n);
  if (scored[0]!.n > 0 && scored[0]!.n > scored[1]!.n) return scored[0]!.o.title.trim();
  const high = uniq.filter((o) => /^3\b|high/i.test(o.priority ?? ''));
  return high.length === 1 ? high[0]!.title.trim() : null;
}

// ------------------------------------------------------------------ hygiene

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const LINK = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

/** Cut at the last sentence end within `max`, else at a word boundary with "…". */
export function clipNote(s: string, max = NOTE_MAX): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (end >= max * 0.5) return head.slice(0, end + 1);
  return `${head.slice(0, max - 1).replace(/\s+\S*$/, '').replace(/[,;:\s-]+$/, '')}…`;
}

/**
 * A note fit for an Org62 Description: credential-like text redacted (tenet: Local data, privacy-safe logs), no
 * email address, phone number or link (roles and teams, never contact details), one line without table pipes,
 * at most `max` characters.
 */
export function cleanNote(text: string, max = NOTE_MAX): string {
  const s = redactText(text ?? '')
    .replace(EMAIL, '')
    .replace(PHONE, '')
    .replace(LINK, '')
    .replace(/\[REDACTED[^\]]*\]/g, '[redacted]')
    .replace(/\|/g, '/')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\(\s*[,;]?\s*\)/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return clipNote(s, max);
}

/** The key that ties an Org62 Event back to its row (the read-back), at the end of the Description. */
export const ccKey = (id: string) => `CC#${id}`;

/** The Description as written to Org62: the note, then the CC# key. */
export function withCcKey(note: string | null | undefined, id: string): string {
  const n = (note ?? '').trim().replace(/\s*·?\s*CC#[A-Za-z0-9_-]+\s*$/, '');
  return n ? `${n} · ${ccKey(id)}` : ccKey(id);
}

// ------------------------------------------------------------------ the cheap model's note (meeting notes only)

export interface NoteSummaryInput {
  facts: NoteFacts;
  /** The meeting's notes (Gemini summary, decisions, next steps), already redacted at ingest. */
  notes: string;
}

/** Most of the notes the model reads (the summary and next steps come first in the stored body). */
export const NOTE_SUMMARY_INPUT_MAX = 6000;

const SUMMARY_SYSTEM = [
  'You write the Description of one Salesforce Solutions Event that a Solutions Engineer logs for a customer meeting.',
  'Write it like a teammate’s note in the CRM: 1 or 2 plain sentences, at most 280 characters in total.',
  'Say what was done in the meeting and with whom, by role or team ("the ACME data team", "their CIO", "the AE"): never a person’s name, email address or phone number.',
  'Name the use case when one is given. When the notes state an agreed next step, end with "Next step: …".',
  'Use only facts the notes state. No greeting, no markdown, no list, no quotes around the answer, no link.',
  'If the notes say nothing you can use, reply with the single word SKIP.',
].join('\n');

/** The one-turn request for the cheap model (`activity.notes`). */
export function noteSummaryRequest(i: NoteSummaryInput): { system: string; user: string } {
  const f = i.facts;
  const lines = [
    `Meeting title: ${f.subject}`,
    f.customer ? `Customer: ${f.customer}` : null,
    f.externalDomains?.length ? `Attendee domains: ${f.externalDomains.join(', ')}` : null,
    f.taskType ? `SE task type: ${f.taskType}` : null,
    f.useCase ? `Use case: ${f.useCase}` : null,
    '',
    'Meeting notes:',
    redactText(i.notes).replace(EMAIL, '').replace(PHONE, '').slice(0, NOTE_SUMMARY_INPUT_MAX),
  ].filter((x): x is string => x !== null);
  return { system: SUMMARY_SYSTEM, user: lines.join('\n') };
}

/** The model's answer as a note, or null (SKIP, empty, too short, a refusal): the template stays. */
export function parseNoteSummary(text: string | null | undefined): string | null {
  const raw = (text ?? '')
    .replace(/^```[a-z]*\s*|\s*```$/g, '')
    .replace(/^\s*(description|note)\s*:\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\*\*|__|^#+\s*/gm, '')
    .trim();
  if (!raw || /^skip\b/i.test(raw) || raw.length < 20) return null;
  if (/\b(I (can(no|')t|am unable|don'?t have)|as an ai)\b/i.test(raw)) return null;
  const note = cleanNote(raw);
  return note.length >= 20 ? note : null;
}

/**
 * The cache key of one summary: the prompt version, the notes and the facts the prompt names. The same notes and
 * facts never cost a second call; changed notes (or a new use case) make a new one.
 */
export function noteSummaryKey(i: NoteSummaryInput): string {
  const f = i.facts;
  return `${NOTE_PROMPT_VERSION}:${fnv1a([i.notes, f.subject, f.customer ?? '', f.taskType ?? '', f.useCase ?? '', (f.externalDomains ?? []).join(',')].join('\u0001'))}`;
}

/** 32-bit FNV-1a, hex (a cache key, not a security hash). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
