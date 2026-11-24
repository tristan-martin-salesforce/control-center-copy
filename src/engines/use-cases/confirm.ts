/**
 * The model's part (lane 06 §4e; skills/extract-use-cases.md): ONE tool-less Haiku call per source, only for the
 * statements the deterministic extractor marked `unsure`. It says which are use cases and normalizes their wording
 * (a short title, the problem, the product, the outcome); it never picks an opp (attribute() does), never invents a
 * statement, and never sees anything but the statements and the product list. Strict JSON out; anything else is "no".
 *
 * Pure: the request and the parser. The caller (the job, src/jobs/handlers/use-cases-extract.ts) sends it through
 * the `ModelProvider.complete()` seam, under the spend governor's hold, books it in llm_calls and keys it like the
 * completion pass (`ledgerHash(model, skill, system, user)`), so a cassette replays it offline.
 */
import type { UcMention } from './types';

export const EXTRACT_USE_CASES_SKILL = 'extract-use-cases';
export const EXTRACT_USE_CASES_VERSION = 'extract-use-cases@1.0.0';
/** One call's own ceiling (Haiku, a few hundred tokens each way). */
export const CONFIRM_CALL_USD = 0.005;

const SYSTEM = [
  'You read sentences from a seller’s conversation with a customer (meeting notes, a Slack thread, an email).',
  'For each numbered sentence decide: does it state a USE CASE, a business problem the customer wants to solve with software (an agent, a data or analytics capability)?',
  'A question, a task, a scheduling note, a pricing or legal topic, or a demo detail is NOT a use case.',
  'When it is one, normalize it: title (2 to 6 words, Title case, no customer name), problem (one sentence), product (one of the listed products, or null), outcome (a KPI named, or "").',
  'Answer with JSON only, no prose: {"items":[{"i":1,"useCase":true,"title":"…","problem":"…","product":"…","outcome":""}]}. Never add sentences that were not given.',
].join('\n');

export interface ConfirmRequest {
  system: string;
  user: string;
}

/** The request for one source's unsure statements (redacted by the caller before it is built). */
export function confirmRequest(mentions: readonly Pick<UcMention, 'statement'>[], products: readonly string[]): ConfirmRequest {
  const lines = mentions.map((m, i) => `${i + 1}. ${m.statement.replace(/\s+/g, ' ').slice(0, 300)}`);
  return { system: SYSTEM, user: `Products: ${[...new Set(products)].join(', ') || 'any'}\n\nSentences:\n${lines.join('\n')}` };
}

export interface ConfirmedItem {
  i: number;
  useCase: boolean;
  title: string;
  problem: string;
  product: string | null;
  outcome: string;
}

/** The model's answer, strictly: only numbered items that exist; anything malformed is "not a use case". */
export function parseConfirm(text: string, n: number): ConfirmedItem[] {
  const m = /\{[\s\S]*\}/.exec(text ?? '');
  if (!m) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: ConfirmedItem[] = [];
  for (const x of items) {
    const o = x as Record<string, unknown>;
    const i = Number(o.i);
    if (!Number.isInteger(i) || i < 1 || i > n || out.some((y) => y.i === i)) continue;
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 120) : '';
    out.push({ i, useCase: o.useCase === true && title.length >= 3, title, problem: typeof o.problem === 'string' ? o.problem.trim().slice(0, 300) : '', product: typeof o.product === 'string' && o.product.trim() ? o.product.trim().slice(0, 60) : null, outcome: typeof o.outcome === 'string' ? o.outcome.trim().slice(0, 200) : '' });
  }
  return out;
}

/** The unsure mentions the model confirmed, with its wording (sure ones pass through unchanged). */
export function applyConfirm(mentions: readonly UcMention[], confirmed: readonly ConfirmedItem[]): UcMention[] {
  const out: UcMention[] = [];
  mentions.forEach((m, k) => {
    const c = confirmed.find((x) => x.i === k + 1);
    if (!c?.useCase) return;
    out.push({ ...m, title: c.title, problem: c.problem || m.problem, products: c.product ? [...new Set([c.product, ...m.products])] : m.products, outcome: c.outcome || m.outcome, certainty: 'sure' });
  });
  return out;
}
