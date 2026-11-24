/**
 * The fake model of the tool-choice goldens: it picks the first tool for an ask by reading the served tool
 * descriptions and nothing else (no model, no network). Ranking is BM25 over the descriptions' words, with a small
 * vocabulary map that stands in for a reader's world knowledge ("email" is Gmail, "deck" is a Drive file). A tool
 * whose description says a kind of it needs another tool first ("call plan first") sends the reader there.
 *
 * So the goldens guard the descriptions: if a description loses the words that tell two tools apart, the pick
 * changes and a case fails. They do not grade a model.
 */
import type { ServedTool } from '@/llm/chat/server';

const STOP = new Set(
  'a an the and or but of to in on at by for with from into about as is are was were be been have has had it its this that these those my me i you your we our us they them their he she his her what which who when where how does did could would should will shall please there here any some all one not no yes than then so if just also only up out over yet'.split(
    ' ',
  ),
);

/** The reader's vocabulary: an ask's word → the words the descriptions use for the same thing. */
const SAME: Readonly<Record<string, string[]>> = {
  email: ['gmail'],
  mail: ['gmail'],
  inbox: ['gmail'],
  deck: ['drive', 'file'],
  doc: ['drive', 'file'],
  document: ['drive', 'file'],
  slide: ['drive', 'file'],
  sheet: ['drive', 'file'],
  opportunity: ['opp', 'opps', 'org62'],
  deal: ['opps', 'deals'],
  meeting: ['meetings', 'calendar'],
  reauth: ['sign'],
  signin: ['sign'],
  rescan: ['rescan', 'connector'],
  reply: ['draft'],
  ranked: ['rank'],
  forget: ['remember'],
  log: ['logging', 'log_batch'],
  spent: ['spend'],
  hold: ['spend_holds'],
};

function stem(w0: string): string {
  let w = w0;
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w.length > 4 && w.endsWith('e') ? w.slice(0, -1) : w;
}

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/sign[- ]in/g, 'signin')
    .replace(/re-?auth\w*/g, 'reauth')
    .replace(/([a-z])-([a-z])/g, '$1$2') // "follow-up" is one word
    .split(/[^a-z0-9_]+/)
    .flatMap((w) => (w.includes('_') ? [w, ...w.split('_')] : [w])) // "vdp_find_assets" names vdp, find and assets too
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

function expand(ask: string[]): string[] {
  return [...new Set(ask.flatMap((w) => [w, ...(SAME[w] ?? []).map(stem)]))];
}

/** BM25's length weight (the usual 0.75). */
const B = 0.75;

/** BM25 scores of every tool for an ask (k1 1.2, b = B), best first; ties keep the catalog order. */
export function rank(ask: string, tools: readonly ServedTool[]): Array<{ name: string; score: number }> {
  // a "…: use X instead" sentence describes another tool, so it is not this one's vocabulary
  const docs = tools.map((t) => words(t.description.replace(/[^.;()]*use [a-z_]+ instead[^.;]*/gi, ' ')));
  const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = docs.length;
  const q = expand(words(ask));
  return tools
    .map((t, i) => {
      const d = docs[i]!;
      let score = 0;
      for (const w of q) {
        const tf = d.filter((x) => x === w).length;
        if (!tf) continue;
        const idf = Math.log((n - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5) + 1);
        score += (idf * tf * 2.2) / (tf + 1.2 * (1 - B + (B * d.length) / avg));
      }
      return { name: t.name, score: Math.round(score * 1000) / 1000, i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ name, score }) => ({ name, score }));
}

/**
 * "research, read_in and vdp_find_assets need a plan the user said Run to (call plan first)": the kinds a tool's
 * description says need another tool first, and that tool.
 */
function firstRule(description: string): { kinds: string[]; tool: string } | null {
  const m = /([a-z_]+(?:, [a-z_]+)*(?:,? and [a-z_]+)?) needs? [^.;]*\(call ([a-z_]+) first\)/i.exec(description);
  if (!m) return null;
  return { kinds: m[1]!.split(/,\s*|\s+and\s+/).map((k) => k.trim()), tool: m[2]! };
}

/** Which `kind {…}` clause of a description the ask reads as (the clause with the most of the ask's words). */
function kindOf(ask: string, description: string): { kind: string; hit: number } | null {
  const q = new Set(expand(words(ask)));
  let best: { kind: string; hit: number } | null = null;
  for (const c of description.split(';')) {
    const clause = c.split(/\.\s/)[0]!; // the kind's own clause, not the sentences after the list
    const k = /([a-z_]+) \{/.exec(clause)?.[1];
    if (!k) continue;
    const hit = words(clause).filter((w) => q.has(w)).length;
    if (!best || hit > best.hit) best = { kind: k, hit };
  }
  return best && best.hit > 0 ? best : null;
}

/**
 * "To find it by words, use search instead.": a description's redirects, each the sentence's words before "use X
 * instead" and the tool X.
 */
export function redirects(description: string): Array<{ when: string[]; tool: string }> {
  return [...description.matchAll(/([^.;()]*?)[:,]?\s*use ([a-z_]+) instead/gi)].map((m) => ({ when: words(m[1]!), tool: m[2]! }));
}

/**
 * The first tool the fake model calls for an ask: the best-ranked description; then, as a reader would, a "call plan
 * first" for the kind the ask reads as, or a "…: use X instead" whose words the ask shares (one hop).
 */
export function pickFirstTool(ask: string, tools: readonly ServedTool[]): { tool: string; via?: string; ranking: Array<{ name: string; score: number }> } {
  const ranking = rank(ask, tools);
  const top = ranking[0]!.name;
  const t = tools.find((x) => x.name === top)!;
  const rule = firstRule(t.description);
  const kind = rule ? kindOf(ask, t.description) : null;
  const first = rule && kind && rule.kinds.includes(kind.kind) && tools.some((x) => x.name === rule.tool) ? { tool: rule.tool, via: `${top} ${kind.kind}`, ranking } : null;
  // an ask that names the kind (two or more of its words) follows its rule before any redirect
  if (first && kind!.hit >= 2) return first;
  const q = new Set(expand(words(ask)));
  const hop = redirects(t.description).find((r) => r.tool !== top && tools.some((x) => x.name === r.tool) && r.when.some((w) => q.has(w)));
  if (hop) return { tool: hop.tool, via: `${top}: use ${hop.tool} instead`, ranking };
  if (first) return first;
  return { tool: top, ranking };
}
