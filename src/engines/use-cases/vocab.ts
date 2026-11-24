/**
 * The product vocabulary the use-case extractor reads (config over code): the user's DC products (Settings ▸ Time
 * `dcProducts`, default DEFAULT_DC_PRODUCTS) plus VDP's own vocabulary: its two tracks (D360 and Agentforce, the
 * `track` VDP's MCP returns, src/connectors/vdp/parse.ts) and the agent types VDP and Org62 share
 * (`UC_AGENT_TYPES`, the Use_Case_Agent_Type__c picklist). A product mention resolves to a canonical name and a track.
 * Pure.
 */
import { DEFAULT_DC_PRODUCTS } from '@/contract/settings';
import { UC_AGENT_TYPES, type UcTrack } from '@/engines/activity/use-cases';

export interface ProductTerm {
  /** The canonical product name a candidate shows ("Data 360", "Agentforce"). */
  name: string;
  track: UcTrack;
  /** Lower-case phrases that name it, longest first. */
  phrases: string[];
}

/** VDP's tracks and the phrases people use for them. */
const TRACK_TERMS: readonly ProductTerm[] = [
  { name: 'Data 360', track: 'd360', phrases: ['data 360', 'data cloud', 'd360', 'cdp', 'customer data platform', 'unified profile', 'unified member profile', 'identity resolution', 'data graph', 'data foundation'] },
  { name: 'Agentforce', track: 'agentforce', phrases: ['agentforce', 'virtual agent', 'service agent', 'ai agent', 'agent', 'assistant', 'copilot', 'chatbot', 'bot'] },
  { name: 'Tableau Next', track: 'd360', phrases: ['tableau next', 'tableau'] },
];

const lc = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The track a product name points at (D360 unless it says agent). */
export const trackOfProductName = (p: string): UcTrack => (/agent|assistant|bot|voice|slack/i.test(p) && !/data|d360|cdp/i.test(p) ? 'agentforce' : 'd360');

/**
 * The vocabulary for a user: their DC products (each its own term), VDP's tracks, and VDP's agent types (each one's
 * distinctive tail: "Agentforce for Service" → "service agent" stays Agentforce). Longest phrase first, so
 * "data cloud" wins over "cloud" and "service agent" over "agent".
 */
export function productVocabulary(dcProducts: readonly string[] = DEFAULT_DC_PRODUCTS): ProductTerm[] {
  const out: ProductTerm[] = [];
  for (const p of dcProducts) {
    const k = lc(p);
    if (k.length < 2) continue;
    const t = trackOfProductName(p);
    out.push({ name: t === 'd360' && /^(data 360|data cloud|d360)$/.test(k) ? 'Data 360' : p.trim(), track: t, phrases: [k] });
  }
  out.push(...TRACK_TERMS);
  for (const [track, types] of Object.entries(UC_AGENT_TYPES) as Array<[UcTrack, readonly string[]]>) {
    for (const t of types) {
      const k = lc(t.replace(/\(.*?\)/g, ''));
      if (!/^(d360|agentforce) /.test(k)) continue;
      out.push({ name: track === 'agentforce' ? 'Agentforce' : 'Data 360', track, phrases: [k] });
    }
  }
  return out;
}

export interface ProductHit {
  name: string;
  track: UcTrack;
  phrase: string;
}

/** The products a text names (canonical names, once each, in the order they first appear). */
export function productsIn(text: string, vocab: readonly ProductTerm[]): ProductHit[] {
  const t = ` ${lc(text).replace(/[^a-z0-9 ]+/g, ' ')} `;
  const all = vocab.flatMap((v) => v.phrases.map((phrase) => ({ v, phrase }))).sort((a, b) => b.phrase.length - a.phrase.length);
  const taken: Array<[number, number]> = [];
  const hits: Array<ProductHit & { at: number }> = [];
  for (const { v, phrase } of all) {
    const needle = ` ${phrase.replace(/[^a-z0-9 ]+/g, ' ')} `;
    let from = 0;
    for (;;) {
      const at = t.indexOf(needle, from);
      if (at < 0) break;
      from = at + 1;
      const end = at + needle.length;
      if (taken.some(([a, b]) => at < b && end > a)) continue;
      taken.push([at, end]);
      hits.push({ name: v.name, track: v.track, phrase, at });
    }
  }
  const seen = new Set<string>();
  return hits
    .sort((a, b) => a.at - b.at)
    .filter((h) => (seen.has(h.name) ? false : (seen.add(h.name), true)))
    .map(({ at: _at, ...h }) => h);
}

/** A product name as the dedupe key reads it ("Data Cloud" and "D360" are "data 360"). */
export function normalizeProduct(p: string | null | undefined): string {
  const k = lc(p ?? '');
  if (!k) return '';
  if (/^(data 360|data cloud|d360|cdp)$/.test(k)) return 'data 360';
  if (/agentforce|agent/.test(k)) return 'agentforce';
  return k;
}
