/**
 * How two use cases compare: the dedupe key (opp, normalized product, the problem's noun phrase) and a fuzzy title
 * match. The fuzzy part is pg_trgm's own similarity (the same trigram set: each word padded with two spaces before and
 * one after, lower case, non-alphanumerics as separators; |A ∩ B| / |A ∪ B|), so the mock and a SQL `similarity()`
 * agree; tests/use-cases/use-cases-db.test.ts checks it against Postgres. Pure.
 */
import { sameUseCaseTitle } from '@/engines/vdp/gaps';

import { normalizeProduct } from './vocab';

/** pg_trgm's trigrams of a text. */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const p = `  ${w} `;
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3));
  }
  return out;
}

/** pg_trgm `similarity(a, b)`. */
export function trigramSimilarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter += 1;
  return Math.round((inter / (x.size + y.size - inter)) * 1000) / 1000;
}

/** Words that never tell two use cases apart. */
const FILLER = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'by', 'from', 'their', 'our', 'its', 'new', 'use', 'case', 'cases', 'poc', 'pilot', 'phase', 'project',
  'data', 'cloud', '360', 'd360', 'agentforce', 'salesforce', 'ai', 'solution', 'platform', 'using', 'via', 'into', 'better', 'improve', 'improved',
]);

/** A light stem: plurals and -ing / -ed endings ("claims" = "claim", "profiles" = "profile"; "status" stays). */
function stem(w: string): string {
  if (w.length <= 3 || /(ss|us|is)$/.test(w)) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  return w;
}

/** The problem's noun phrase as a key: its telling words, stemmed, sorted ("Claims status lookup" → "claim look status"). */
export function problemKey(title: string): string {
  const ws = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w));
  return [...new Set(ws.map(stem))].sort().join(' ');
}

/** The dedupe key: `<opp or account or none>|<product>|<problem key>`. */
export function dedupeKeyOf(c: { oppId: string | null; accountId: string | null; product: string | null | undefined; title: string }): string {
  const where = c.oppId ? `o:${c.oppId}` : c.accountId ? `a:${c.accountId}` : '-';
  return `${where}|${normalizeProduct(c.product)}|${problemKey(c.title)}`;
}

/** The fuzzy line: titles at least this similar (pg_trgm) name the same use case. */
export const FUZZY_MIN = 0.5;

/**
 * Two titles name the same use case: VDP's rule (`sameUseCaseTitle`: equal, or nearly the same words, numbers kept
 * apart), the same problem key, or trigram similarity at or over FUZZY_MIN with no differing number.
 */
export function sameUseCase(a: string, b: string): { same: boolean; how: 'title' | 'key' | 'fuzzy' | null; score: number } {
  if (sameUseCaseTitle(a, b)) return { same: true, how: 'title', score: 1 };
  const ka = problemKey(a);
  if (ka && ka === problemKey(b)) return { same: true, how: 'key', score: 1 };
  const nums = (s: string) => (s.match(/\d+/g) ?? []).sort().join(',');
  const score = trigramSimilarity(a, b);
  if (score >= FUZZY_MIN && nums(a) === nums(b)) return { same: true, how: 'fuzzy', score };
  return { same: false, how: null, score };
}
