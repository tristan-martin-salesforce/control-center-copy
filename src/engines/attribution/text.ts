/**
 * The one tokenizer the attribution engine uses (lane 06 TA-1 found three, with three stopword lists). Generic meeting
 * and deal words come from the projection matcher's list (`isGenericMatchWord`), so "call", "team", "renewal" or
 * "FY27" never make an opp hit here either.
 */
import { isGenericMatchWord, nameCore, shortNames } from '@/projections/matching';

/** Words that say nothing about which deal it is (opp names are full of them). */
const DEAL_WORDS = new Set([
  'data', 'cloud', '360', 'd360', 'agentforce', 'expansion', 'renewal', 'upsell', 'new', 'business', 'platform', 'salesforce', 'services', 'service',
  'sales', 'marketing', 'commerce', 'tableau', 'mulesoft', 'slack', 'addon', 'license', 'licenses', 'phase', 'edition', 'credits', 'flex', 'premier',
  'success', 'plan', 'with', 'from', 'deal', 'opportunity', 'contract', 'term', 'year', 'years', 'annual', 'multi', 'enterprise', 'unlimited', 'poc',
]);
const LEGAL = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'ltd', 'limited', 'plc', 'group', 'holdings', 'the', 'and', 'of']);

export const words = (s: string | null | undefined): string[] => (s ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Words of a text that can name a deal: 4+ letters, not a number, not generic, not a deal word. */
export function dealWords(s: string | null | undefined, skip: ReadonlySet<string> = new Set()): string[] {
  return [...new Set(words(s).filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !isGenericMatchWord(w) && !DEAL_WORDS.has(w) && !LEGAL.has(w) && !skip.has(w)))];
}

/** The account name's own words (they never tell its opps apart). */
export const accountWords = (name: string | null | undefined): Set<string> => new Set(words(name));

/** "saltmere-health.example" → "saltmere-health.example"; "WWW.X.Example" → "x.example". */
export const normDomain = (d: string): string => d.trim().toLowerCase().replace(/^www\./, '');

export const domainOfEmail = (e: string | null | undefined): string | null => {
  const at = (e ?? '').lastIndexOf('@');
  return at > 0 ? normDomain((e ?? '').slice(at + 1)) : null;
};

/**
 * The default `World.matchText`: an account's name (its head, legal suffixes dropped) as whole words, then the short
 * names people use for it (the projection matcher's `shortNames`: "Harrowgate" for "Harrowgate Manufacturing"). A short
 * name several accounts share (siblings of one family) names none of them: never a coin flip. Longest match first.
 */
export function nameMatcher(accounts: ReadonlyArray<{ id: string; name: string }>): (text: string) => Array<{ accountId: string; via: 'name' | 'alias' }> {
  const re = (ws: string[]) => new RegExp(`(?<![a-z0-9])${ws.join('[\\s\\-_.&/]*')}(?![a-z0-9])`);
  const pats: Array<{ accountId: string; re: RegExp; len: number; via: 'name' | 'alias'; key: string }> = [];
  for (const a of accounts) {
    const core = nameCore(a.name);
    if (core.length) pats.push({ accountId: a.id, re: re(core), len: core.join(' ').length, via: 'name', key: core.join(' ') });
    for (const sn of shortNames(a.name)) pats.push({ accountId: a.id, re: re(sn), len: sn.join(' ').length, via: 'alias', key: sn.join(' ') });
  }
  const claims = new Map<string, Set<string>>();
  for (const p of pats) claims.set(p.key, new Set([...(claims.get(p.key) ?? []), p.accountId]));
  const usable = pats.filter((p) => (claims.get(p.key)?.size ?? 0) === 1).sort((x, y) => y.len - x.len || x.accountId.localeCompare(y.accountId));
  return (text) => {
    const t = text.toLowerCase();
    const out: Array<{ accountId: string; via: 'name' | 'alias' }> = [];
    for (const p of usable) if (p.re.test(t) && !out.some((x) => x.accountId === p.accountId)) out.push({ accountId: p.accountId, via: p.via });
    return out;
  };
}
