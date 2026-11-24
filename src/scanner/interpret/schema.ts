/**
 * The classifier's strict output (skills/classify-items.md), validated with zod before anything is applied.
 *
 * The brief's four verdicts (`ask | commitment | fyi | noise`) plus the three a link needs so proposals and evidence
 * stay what the agentic path writes today: `completion`, `progress` and `change` (a requirements change on a
 * candidate, applied as `contradiction` with `requirements_change:`). Confidence is a number; code maps it to the
 * confidence words (R8 moved to code, review 04 §4.4).
 */
import { z } from 'zod';

import type { Confidence } from '../types';

export const VERDICTS = ['ask', 'commitment', 'completion', 'progress', 'change', 'fyi', 'noise'] as const;
export type VerdictKind = (typeof VERDICTS)[number];

export const PROPOSAL_KINDS = ['ask', 'commitment', 'deliverable', 'follow_up', 'task'] as const;

const shortText = (n: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, n))
    .nullish();

/** One verdict as the model writes it. Unknown fields are dropped; a bad field fails only its verdict. */
export const Verdict = z.object({
  ref: z.string().min(1).max(200),
  v: z.enum(VERDICTS),
  kind: z.enum(PROPOSAL_KINDS).nullish(),
  title: shortText(160),
  who: shortText(80),
  deliverable: shortText(40),
  due: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/)
    .nullish()
    .catch(null),
  conf: z.coerce.number().min(0).max(1).catch(0),
  cite: shortText(200),
  /** A candidate alias (`w1`) or an earlier ref of the same batch. */
  link: z.string().max(200).nullish(),
  why: shortText(120),
});
export type Verdict = z.infer<typeof Verdict>;

export const ClassifierOutput = z.object({ verdicts: z.array(z.unknown()) });

export interface ParsedOutput {
  verdicts: Verdict[];
  /** Entries that failed validation (index and the first issue; never the text). */
  invalid: Array<{ index: number; issue: string }>;
  /** The reply was not one JSON object with `verdicts`. */
  malformed: boolean;
}

/** The first JSON object in a reply (the model sometimes wraps it in a code fence). */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fenced ? fenced[1]!.trim() : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Parse and validate a reply. Each verdict is validated on its own, so one bad entry costs only that entry. */
export function parseClassifierOutput(text: string): ParsedOutput {
  const top = ClassifierOutput.safeParse(extractJson(text));
  if (!top.success) return { verdicts: [], invalid: [], malformed: true };
  const verdicts: Verdict[] = [];
  const invalid: ParsedOutput['invalid'] = [];
  top.data.verdicts.forEach((raw, index) => {
    const r = Verdict.safeParse(raw);
    if (r.success) verdicts.push(r.data);
    else invalid.push({ index, issue: `${r.error.issues[0]?.path.join('.') || '(root)'}: ${r.error.issues[0]?.message ?? 'invalid'}` });
  });
  return { verdicts, invalid, malformed: false };
}

/** The confidence floor: a verdict below it gets a second pass with more context before it can reach Triage. */
export const CONFIDENCE_FLOOR = 0.6;

/** R8 in code: 0.85+ sure, 0.6+ likely, else guess. */
export function confidenceWord(conf: number): Confidence {
  if (conf >= 0.85) return 'sure';
  if (conf >= CONFIDENCE_FLOOR) return 'likely';
  return 'guess';
}

/** Verdicts that propose or link (the others record only). */
export const ACTS: ReadonlySet<VerdictKind> = new Set(['ask', 'commitment', 'completion', 'progress', 'change']);
