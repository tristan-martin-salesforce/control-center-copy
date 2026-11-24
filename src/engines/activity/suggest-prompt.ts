/**
 * The cheap model's question for a Time row the rules can't place (src/lib/time-suggest.ts): is this internal work,
 * or which of these opportunities is it for? One tool-less Haiku call per row (`activity.suggest`,
 * src/jobs/handlers/activity-suggest.ts). Pure: the request text and the parse of the answer.
 *
 * The prompt names the row (what it says, when, how long, its sources by kind and label, its account when known),
 * the plain-English issues, and a numbered list of candidate opportunities (the row's own ranking, open ones first).
 * The answer is one line of JSON: `{"choice": "internal" | <number>, "confidence": 0..1, "reason": "…"}`; anything
 * else is no answer (stored as none, so the same row never costs twice). Credential-like text is redacted; email
 * addresses and phone numbers are dropped.
 */
import type { ActivityEntry, OppOption } from '@/contract';
import { redactText } from '@/lib/redact';
import { plainIssues } from '@/lib/time-issues';
import { INTERNAL_TASK_TYPES } from './internal';

/** At most this many candidate opportunities in a prompt. */
export const SUGGEST_MAX_CANDIDATES = 15;

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const clean = (s: string, n: number) => redactText(s).replace(EMAIL, '').replace(PHONE, '').replace(/\s+/g, ' ').trim().slice(0, n);

const SYSTEM = [
  'You help a Salesforce Solutions Engineer log their time. Each row of work must be logged either to one customer opportunity, or as internal work (no customer: building demos, assets or tools, training, enablement, travel).',
  'Decide for the row you are given. Pick a candidate opportunity only when the row clearly belongs to that customer (its account, a channel or domain naming them, the topic). Pick "internal" only when nothing names a customer and the work is clearly internal. When unsure, give your best pick with a low confidence.',
  'Answer with ONE line of JSON and nothing else: {"choice": "internal" or the candidate number, "confidence": a number from 0 to 1, "reason": "at most 15 words, plain English, no ids"}.',
].join('\n');

export interface SuggestFacts {
  entry: Pick<ActivityEntry, 'description' | 'date' | 'durationH' | 'sources' | 'issues' | 'accountName' | 'taskType'>;
  /** Candidate opportunities, best first (the row's own ranking). */
  candidates: Array<Pick<OppOption, 'id' | 'name' | 'accountName' | 'stage' | 'closeDate' | 'isOpen' | 'lastUsed'>>;
  /** The persona logs internal-only work (else "internal" is not offered). */
  internalActivity: boolean;
}

/** The candidates a prompt lists: open first, then the closed ones the row is tied to, at most SUGGEST_MAX_CANDIDATES. */
export function suggestCandidates(opps: readonly OppOption[]): OppOption[] {
  const open = opps.filter((o) => o.isOpen);
  const tied = opps.filter((o) => !o.isOpen && o.why.length);
  return [...open, ...tied].slice(0, SUGGEST_MAX_CANDIDATES);
}

export function suggestRequest(f: SuggestFacts): { system: string; user: string } {
  const e = f.entry;
  const lines = [
    `Row: ${clean(e.description || '(no title)', 200)}`,
    `When: ${e.date}, ${e.durationH} h`,
    e.accountName ? `Account on the row: ${clean(e.accountName, 80)}` : 'Account on the row: none',
    e.taskType ? `Task type: ${e.taskType}` : null,
    e.sources.length ? `Sources: ${e.sources.slice(0, 6).map((s) => `${s.kind}: ${clean(s.label, 100)}`).join(' | ')}` : null,
    ...plainIssues(e).slice(0, 3).map((i) => `Note: ${clean(i, 160)}`),
    '',
    'Candidates:',
    ...f.candidates.map((o, i) => `${i + 1}. ${clean(o.name, 120)}${o.accountName ? ` (account: ${clean(o.accountName, 80)})` : ''}${o.stage ? `, ${o.stage}` : ''}${o.closeDate ? `, closes ${o.closeDate}` : ''}${o.isOpen ? '' : ', closed'}${o.lastUsed ? `, last logged to ${o.lastUsed}` : ''}`),
    ...(f.candidates.length ? [] : ['(none)']),
    f.internalActivity ? `internal. Internal work, no customer (${INTERNAL_TASK_TYPES.join(', ')})` : 'Internal work is not an option for this role: pick a candidate.',
  ].filter((x): x is string => x !== null);
  return { system: SYSTEM, user: lines.join('\n') };
}

export interface SuggestAnswer {
  kind: 'opp' | 'internal';
  /** The candidate picked (kind opp). */
  oppId: string | null;
  confidence: number;
  reason: string;
}

/** The model's answer, or null (not JSON, an unknown choice, a refusal). Confidence is clamped to 0–1. */
export function parseSuggestAnswer(text: string | null | undefined, f: Pick<SuggestFacts, 'candidates' | 'internalActivity'>): SuggestAnswer | null {
  const raw = (text ?? '').replace(/^```[a-z]*\s*|\s*```$/g, '').trim();
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  let j: { choice?: unknown; confidence?: unknown; reason?: unknown };
  try {
    j = JSON.parse(m[0]) as typeof j;
  } catch {
    return null;
  }
  const conf = typeof j.confidence === 'number' && Number.isFinite(j.confidence) ? Math.max(0, Math.min(1, j.confidence)) : null;
  if (conf === null) return null;
  const reason = typeof j.reason === 'string' ? clean(j.reason, 140).replace(/\b(00[0-9][A-Za-z0-9]{12,15})\b/g, '').trim() : '';
  if (typeof j.choice === 'string' && /^internal$/i.test(j.choice.trim())) return f.internalActivity ? { kind: 'internal', oppId: null, confidence: conf, reason: reason || 'Nothing names a customer' } : null;
  const n = typeof j.choice === 'number' ? j.choice : typeof j.choice === 'string' && /^\d+$/.test(j.choice.trim()) ? Number(j.choice) : NaN;
  const pick = Number.isInteger(n) ? f.candidates[n - 1] : undefined;
  if (!pick) return null;
  return { kind: 'opp', oppId: pick.id, confidence: conf, reason: reason || 'The closest match' };
}
