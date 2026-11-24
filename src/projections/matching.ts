/**
 * Entity resolution for projected rows: text (meeting title, repo / cwd, file title) + attendee domains → an
 * account in my book and, where one stands out, its opportunity. Deterministic and pure.
 *
 * Signals, strongest first (ARCHITECTURE §5 "Entity resolver"):
 *  1. the account's name (legal suffixes dropped) or a name / title-token alias, as whole words in the text;
 *  2. attendee domains: account_aliases of kind domain, plus domains learned in this pass from meetings whose
 *     title already named the account (a domain only one account claims);
 * then the opportunity: a distinctive word of exactly one open opp in the text (generic words never count; an opp
 * I'm not on needs two), else my only open team / DC opp on the account. Ambiguity resolves to the account alone,
 * never to a guess (`oppFor`).
 *
 * `mappings()` hands the same knowledge to the activity engine (`ActivityMappings.accounts`, keyed by account id).
 */
import type { AccountMapping, ActivityMappings } from '@/engines/activity';
import { chainOf, type AccountHierarchy } from '@/lib/accounts/hierarchy';

import type { DomainRules } from './types';
import { domainClass, escapeRe, id15 } from './util';

export interface MatchAccount {
  id: string;
  name: string;
  org62AccountId: string | null;
  /** account_aliases values: kind name / short_name / title_token / domain / repo_path. */
  aliases: { kind: string; value: string }[];
  /**
   * DC-23 seam: the Org62 parent account (Account.ParentId), once the hierarchy read fills it. Accounts with one parent
   * are siblings whatever their names; without it, siblings are found by a shared name head (`siblingFamilies`).
   */
  parentOrg62AccountId?: string | null;
}

/**
 * D-69 (the DC-23 seam): each account's Org62 parent from the account hierarchy (src/lib/accounts/hierarchy.ts, kv
 * `cc.org62.account_hierarchy`), once it is read; without it the accounts are as they were (siblings by name head).
 */
export function withOrg62Parents<A extends Pick<MatchAccount, 'org62AccountId' | 'parentOrg62AccountId'>>(accounts: A[], h: AccountHierarchy | null): A[] {
  if (!h) return accounts;
  return accounts.map((a) => {
    const parent = chainOf(h, a.org62AccountId)[1]?.id ?? null;
    return parent ? { ...a, parentOrg62AccountId: parent } : a;
  });
}

export interface MatchOpp {
  id: string;
  accountId: string | null;
  org62OpportunityId: string;
  name: string;
  isClosed: boolean;
  onMyTeam: boolean;
  myDc: boolean;
}

export interface Match {
  accountId: string;
  oppId: string | null;
  via: 'title' | 'alias' | 'domain';
  confidence: number;
}

const SUFFIX = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'llc', 'llp', 'lp', 'ltd', 'limited', 'plc', 'sa', 'ag', 'gmbh', 'nv', 'bv', 'group', 'holdings', 'holding', 'the', 'and', 'of', 'pte', 'pty', 'srl', 'spa', 'ab', 'oy', 'kk', 'parent', 'hq']);
/** Single words too common to name a company on their own (they need the full name or a domain). */
const GENERIC = new Set([
  'target', 'united', 'general', 'national', 'american', 'global', 'first', 'health', 'bank', 'data', 'cloud', 'energy', 'capital', 'international',
  'services', 'solutions', 'systems', 'technologies', 'technology', 'partners', 'digital', 'financial', 'insurance', 'mutual', 'trust', 'state', 'city',
  'new', 'one', 'care', 'life', 'home', 'power', 'west', 'east', 'north', 'south', 'central', 'pacific', 'atlantic', 'summit', 'apex', 'pioneer',
]);
/** Opportunity-name words that say nothing about which deal it is. */
const DEAL_WORDS = new Set([
  'data', 'cloud', '360', 'd360', 'agentforce', 'expansion', 'renewal', 'upsell', 'new', 'business', 'platform', 'salesforce', 'services', 'service',
  'sales', 'marketing', 'commerce', 'tableau', 'mulesoft', 'slack', 'addon', 'license', 'licenses', 'phase', 'edition', 'credits', 'flex', 'premier',
  'success', 'plan', 'with', 'from', 'deal', 'opportunity', 'contract', 'term', 'year', 'years', 'annual', 'multi', 'enterprise', 'unlimited',
]);

/**
 * Words that say nothing about WHICH opportunity a meeting, session or file is about ("FY27 ACME Account Team Call",
 * "weekly sync", "Q4 review"). They never make an opp hit on their own, in the text or in an opp's name: a recurring
 * team call once logged to "… Renewal 1745 Platform, 232 Call Center …" through the shared word "call".
 * Shared by the opp matcher (`oppFor`) and anything else that decides "this text names that opp".
 */
export const GENERIC_MATCH_WORDS: ReadonlySet<string> = new Set([
  'call', 'calls', 'team', 'teams', 'account', 'accounts', 'sync', 'syncs', 'meeting', 'meetings', 'weekly', 'monthly',
  'review', 'reviews', 'update', 'updates', 'check', 'checks', 'platform', 'platforms', 'renewal', 'renewals', 'center',
  'centers', 'centre', 'data', 'the', 'and', 'for', 'with',
]);
/** Fiscal years and quarters ("fy27", "fy2027", "q4") are generic too. */
const GENERIC_MATCH_PATTERNS: readonly RegExp[] = [/^fy\d{2}(?:\d{2})?$/, /^q[1-4]$/];

/** A word that never names an opportunity on its own (GENERIC_MATCH_WORDS, fiscal years and quarters). */
export function isGenericMatchWord(w: string): boolean {
  const s = w.toLowerCase();
  return GENERIC_MATCH_WORDS.has(s) || GENERIC_MATCH_PATTERNS.some((p) => p.test(s));
}

const words = (s: string) => (s.toLowerCase().match(/[a-z0-9&]+/g) ?? []).filter((w) => w !== '&');

/** Ordinary words that open real company names ("Horizon …", "Blue Shield …"): never a short name on their own. */
const COMMON = new Set([
  'blue', 'red', 'green', 'white', 'black', 'gold', 'silver', 'delta', 'horizon', 'endeavor', 'premier', 'liberty', 'eagle', 'frontier', 'alliance',
  'unity', 'harmony', 'beacon', 'anchor', 'bristol', 'cross', 'shield', 'star', 'sun', 'sky', 'ocean', 'river', 'mountain', 'valley', 'harbor',
  'phoenix', 'keystone', 'heritage', 'legacy', 'vision', 'advance', 'progressive', 'standard', 'select', 'prime', 'core', 'bright', 'true',
]);
/** A word too ordinary to stand for a company on its own (GENERIC or COMMON). The private scan skips these too. */
export const isOrdinaryNameWord = (w: string): boolean => GENERIC.has(w.toLowerCase()) || COMMON.has(w.toLowerCase());
/** Words an acronym skips ("Blue Shield of Placeholdia" → BSP; "Health Care Example Corporation" → HCEC). */
const ACRONYM_SKIP = new Set(['of', 'the', 'and', 'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'plc', 'co']);

/**
 * ACC-1: the short names people use for an Org62 account, derived from its legal name. Org62 names an account
 * "Globex Health - Commercial 2.0" or "Initech42Health" while Slack and email say "Globex" or "Initech42", and the
 * live database had no aliases at all: 36 of 50 work items matched no account.
 *  - a distinctive first word of a multi-word name ("Globex", "Initech", "Umbrella"; never a generic or common word);
 *  - a word that runs letters into digits into a word: "Initech42Health" → "initech42";
 *  - the acronym of a name of three or more words, 3-5 letters: "Blue Shield of Placeholdia" → "bsp".
 * Ambiguity (several accounts claim the same name) is settled in byText, never by guessing.
 */
export function shortNames(name: string): string[][] {
  const out = new Map<string, string[]>();
  const core = nameCore(name);
  const first = core[0];
  if (core.length >= 2 && first && first.length >= 4 && !GENERIC.has(first) && !COMMON.has(first) && !/\d/.test(first)) out.set(first, [first]);
  for (const w of core) {
    const m = /^([a-z]{3,}\d+)[a-z]{3,}$/.exec(w);
    if (m) out.set(m[1]!, [m[1]!]);
  }
  const all = words(name.replace(/\([^)]*\)/g, ' ')).filter((w) => !ACRONYM_SKIP.has(w) && !/^\d+$/.test(w));
  if (all.length >= 3) {
    const ac = all.map((w) => w[0]).join('');
    if (ac.length >= 3 && ac.length <= 5) out.set(ac, [ac]);
  }
  for (const k of out.keys()) if (core.length === 1 && core[0] === k) out.delete(k); // already the name pattern
  return [...out.values()];
}

/**
 * DC-23: the whole name as words, the part after " - " and a parenthetical kept ("Umbrella Health - Medicaid" →
 * ["umbrella", "health", "medicaid"]; "Umbrella Health (Org2)" → […, "org2"]), legal suffixes dropped. What tells
 * sibling child accounts apart, where `nameCore` (the head) is the same for all of them.
 */
export function fullNameCore(name: string): string[] {
  return words(name.replace(/[()]/g, ' ')).filter((w) => !SUFFIX.has(w));
}

/**
 * DC-23: child accounts of one company ("Umbrella Health - Commercial", "Umbrella Health - Medicaid") by account id →
 * their family key. A family is accounts with one Org62 parent (the seam: `parentOrg62AccountId`, once the hierarchy is
 * read), else accounts whose name head (`nameCore`) is the same and whose full names differ. An account whose full
 * name IS the head (the parent itself, "Umbrella Health") is not in it: the head is its own name.
 */
export function siblingFamilies(accounts: ReadonlyArray<Pick<MatchAccount, 'id' | 'name' | 'parentOrg62AccountId'>>): Map<string, string> {
  const groups = new Map<string, Array<{ id: string; full: string; own: boolean }>>();
  for (const a of accounts) {
    const head = nameCore(a.name).join(' ');
    const full = fullNameCore(a.name).join(' ');
    const key = a.parentOrg62AccountId ? `p:${id15(a.parentOrg62AccountId)}` : head ? `n:${head}` : null;
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), { id: a.id, full, own: !a.parentOrg62AccountId && full === head }]);
  }
  const out = new Map<string, string>();
  for (const [key, list] of groups) {
    if (new Set(list.map((x) => x.full)).size < 2) continue;
    for (const x of list) if (!x.own) out.set(x.id, key);
  }
  return out;
}

/** "ACME Corporation (Parent)" → ["acme"]; "The Home Depot, Inc." → ["home", "depot"]. */
export function nameCore(name: string): string[] {
  const head = name.replace(/\([^)]*\)/g, ' ').split(/\s+[-–|:]\s+/)[0] ?? name;
  const core = words(head).filter((w) => !SUFFIX.has(w));
  if (!core.length) return [];
  if (core.length === 1 && (GENERIC.has(core[0]!) || core[0]!.length < 3)) return [];
  return core;
}

const phrasePattern = (tokens: string[]) => `(?<![a-z0-9])${tokens.map(escapeRe).join('[\\s\\-_.&/]*')}(?![a-z0-9])`;

/** Text → the form the patterns run on (lower case; path separators and punctuation as spaces). */
export const normText = (s: string) => s.toLowerCase().replace(/[_/\\.:|()[\]{}"',]+/g, ' ');

interface Pat {
  accountId: string;
  re: RegExp;
  len: number;
  via: 'title' | 'alias';
  /** DC-23: a name head siblings share (their family key): it never picks one of them on its own. */
  shared?: string;
}

export class Matcher {
  private readonly pats: Pat[] = [];
  private readonly domains = new Map<string, string>();
  private readonly learned = new Map<string, Set<string>>();
  private readonly openByAccount = new Map<string, MatchOpp[]>();
  private readonly oppTokens = new Map<string, string[]>();
  readonly accounts: Map<string, MatchAccount>;
  readonly opps: Map<string, MatchOpp>;

  constructor(accounts: MatchAccount[], opps: MatchOpp[], private readonly rules: DomainRules) {
    this.accounts = new Map(accounts.map((a) => [a.id, a]));
    this.opps = new Map(opps.map((o) => [o.id, o]));
    const families = siblingFamilies(accounts);
    for (const a of accounts) {
      const core = nameCore(a.name);
      const family = families.get(a.id);
      // DC-23: a child account is named by its full name; the head it shares with its siblings is only a shared hint
      const full = family ? fullNameCore(a.name) : [];
      if (family && full.length > core.length) this.pats.push({ accountId: a.id, re: new RegExp(phrasePattern(full)), len: full.join(' ').length, via: 'title' });
      if (core.length) this.pats.push({ accountId: a.id, re: new RegExp(phrasePattern(core)), len: core.join(' ').length, via: 'title', ...(family ? { shared: family } : {}) });
      for (const sn of shortNames(a.name)) this.pats.push({ accountId: a.id, re: new RegExp(phrasePattern(sn)), len: sn.join(' ').length, via: 'alias', ...(family ? { shared: family } : {}) });
      for (const al of a.aliases) {
        if (al.kind === 'domain') {
          const d = al.value.toLowerCase().replace(/^www\./, '');
          if (!this.domains.has(d)) this.domains.set(d, a.id);
          continue;
        }
        const t = words(al.value);
        if (t.length && (t.length > 1 || (t[0]!.length >= 3 && !GENERIC.has(t[0]!)))) this.pats.push({ accountId: a.id, re: new RegExp(phrasePattern(t)), len: t.join(' ').length, via: 'alias' });
      }
    }
    this.pats.sort((x, y) => y.len - x.len || x.accountId.localeCompare(y.accountId));
    for (const o of opps) {
      if (!o.accountId || o.isClosed) continue;
      this.openByAccount.set(o.accountId, [...(this.openByAccount.get(o.accountId) ?? []), o]);
      const acct = this.accounts.get(o.accountId);
      // the account's own name never tells its opps apart, nor do deal words and generic meeting words
      const skip = new Set([...(acct ? words(acct.name) : []), ...SUFFIX, ...DEAL_WORDS]);
      this.oppTokens.set(o.id, [...new Set(words(o.name).filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !/^(fy|q)\d+$/.test(w) && !skip.has(w) && !isGenericMatchWord(w)))]);
    }
    // per account: how many of its open opps carry each token (a token only one opp has is distinctive)
    for (const [acc, list] of this.openByAccount) {
      const n = new Map<string, number>();
      for (const o of list) for (const w of this.oppTokens.get(o.id) ?? []) n.set(w, (n.get(w) ?? 0) + 1);
      this.tokenOpps.set(acc, n);
    }
    for (const list of this.openByAccount.values()) list.sort((a, b) => Number(b.onMyTeam || b.myDc) - Number(a.onMyTeam || a.myDc) || a.org62OpportunityId.localeCompare(b.org62OpportunityId));
    for (const [acc, list] of this.openByAccount) this.weight.set(acc, list.filter((o) => o.onMyTeam || o.myDc).length * 100 + list.length);
  }

  /** Open opps per account (mine count most): settles accounts that claim the same name. */
  private readonly weight = new Map<string, number>();
  /** Account → opp-name token → how many of its open opps carry it. */
  private readonly tokenOpps = new Map<string, Map<string, number>>();

  private external(domains: readonly string[]): string[] {
    return [...new Set(domains.map((d) => d.toLowerCase()))].filter((d) => domainClass(d, this.rules) === 'external');
  }

  /**
   * The longest name or alias in the text. When several accounts claim it (two "Umbrella, Inc." rows, a short name that
   * three entities of one company share), the one with my open opps wins; a tie that remains matches nothing. Before, the
   * first account id won, whatever it was (ACC-1).
   */
  private byText(text: string): Pat | null {
    const t = normText(text);
    const found: Pat[] = [];
    for (const p of this.pats) {
      if (found.length && p.len < found[0]!.len) break;
      if (p.re.test(t)) found.push(p);
    }
    // DC-23: a head siblings share loses to the account whose own name it is (the parent)
    const own = found.filter((h) => !h.shared);
    const hits = own.length ? own : found;
    const accounts = [...new Set(hits.map((h) => h.accountId))];
    if (accounts.length <= 1) return hits[0] ?? null;
    if (hits.every((h) => h.shared && h.shared === hits[0]!.shared)) {
      // siblings named only by their shared head: an opp-name word that points at exactly one of them, else none
      // (never "the one with more of my opps": that put hours and evidence on the wrong child)
      const tw = new Set(words(text));
      const named = accounts.filter((a) => (this.openByAccount.get(a) ?? []).some((o) => (this.oppTokens.get(o.id) ?? []).some((w) => tw.has(w))));
      return named.length === 1 ? hits.find((h) => h.accountId === named[0])! : null;
    }
    const ranked = accounts.map((a) => ({ a, w: this.weight.get(a) ?? 0 })).sort((x, y) => y.w - x.w);
    let pick = ranked[0]!.w !== ranked[1]!.w ? ranked[0]!.a : null;
    if (!pick) {
      // Still tied: an opp-name word in the text that points at exactly one of them.
      const tw = new Set(words(text));
      const top = ranked.filter((r) => r.w === ranked[0]!.w).map((r) => r.a);
      const named = top.filter((a) => (this.openByAccount.get(a) ?? []).some((o) => (this.oppTokens.get(o.id) ?? []).some((w) => tw.has(w))));
      if (named.length === 1) pick = named[0]!;
    }
    return pick ? hits.find((h) => h.accountId === pick)! : null;
  }

  /** Domains of meetings whose title names an account map to that account (when no other account claims them). */
  learnDomains(events: { title: string; domains: readonly string[] }[]): void {
    for (const e of events) {
      const p = this.byText(e.title);
      if (!p) continue;
      for (const d of this.external(e.domains)) this.learned.set(d, new Set([...(this.learned.get(d) ?? []), p.accountId]));
    }
  }

  private accountForDomain(d: string): string | null {
    const known = this.domains.get(d);
    if (known) return known;
    const l = this.learned.get(d);
    return l && l.size === 1 ? [...l][0]! : null;
  }

  /** Domains the engine may use for an account: aliases plus this pass's learned ones. */
  domainsOf(accountId: string): string[] {
    const out = new Set<string>();
    for (const [d, a] of this.domains) if (a === accountId) out.add(d);
    for (const [d, s] of this.learned) if (s.size === 1 && s.has(accountId) && !this.domains.has(d)) out.add(d);
    return [...out].sort();
  }

  /**
   * The opp a text points at, else my only open team / DC opp on the account, else null (the account fallback: the
   * row logs to the account and asks for an opp). Generic words ("call", "team", "renewal", "FY27": GENERIC_MATCH_WORDS)
   * and the account's own name never count.
   *  - A hit needs a distinctive word (one only that opp's name has among the account's open opps) or two shared words.
   *  - The one hit wins when it is mine (team or DC). An opp I'm not on wins only when the text names it strongly (two
   *    distinctive words): a weak hit on someone else's deal is a guess, and a guess logs hours to the wrong opp.
   *  - Several hits: the one with the most distinctive words wins when it alone has the most; else they are
   *    ambiguous: my single team / DC opp, else the account.
   */
  oppFor(accountId: string, text: string): string | null {
    const open = this.openByAccount.get(accountId) ?? [];
    if (!open.length) return null;
    const isMine = (o: MatchOpp) => o.onMyTeam || o.myDc;
    const t = new Set(words(text).filter((w) => !isGenericMatchWord(w)));
    const owners = this.tokenOpps.get(accountId);
    const hits = open
      .map((o) => {
        const shared = (this.oppTokens.get(o.id) ?? []).filter((w) => t.has(w));
        return { o, shared: shared.length, distinct: shared.filter((w) => owners?.get(w) === 1).length };
      })
      .filter((h) => h.distinct >= 1 || h.shared >= 2);
    // several hits: the one with the most distinctive words, when it alone has the most (and has one)
    const best = Math.max(0, ...hits.map((h) => h.distinct));
    const top = hits.length > 1 && best > 0 ? hits.filter((h) => h.distinct === best) : hits;
    // an opp I'm not on: only as the one distinctive hit, named by two distinctive words
    const onlyDistinct = hits.filter((h) => h.distinct > 0).length === 1;
    if (top.length === 1 && (isMine(top[0]!.o) || (top[0]!.distinct >= 2 && onlyDistinct))) return top[0]!.o.id;
    const mine = open.filter(isMine);
    return mine.length === 1 ? mine[0]!.id : null;
  }

  resolve(text: string, domains: readonly string[] = []): Match | null {
    const p = this.byText(text);
    if (p) return { accountId: p.accountId, oppId: this.oppFor(p.accountId, text), via: p.via, confidence: p.via === 'title' ? 0.8 : 0.75 };
    const votes = new Map<string, number>();
    for (const d of this.external(domains)) {
      const a = this.accountForDomain(d);
      if (a) votes.set(a, (votes.get(a) ?? 0) + 1);
    }
    const ranked = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!ranked.length || (ranked.length > 1 && ranked[0]![1] === ranked[1]![1])) return null;
    const accountId = ranked[0]![0];
    return { accountId, oppId: this.oppFor(accountId, text), via: 'domain', confidence: 0.65 };
  }

  /** The activity engine's account table (key = account id, whatId = Org62 opp, else the account fallback). */
  mappings(base: Pick<ActivityMappings, 'internalDomains' | 'partnerDomains' | 'ignoreDomains'>, extra: { repos?: Record<string, string>; channels?: Record<string, string> } = {}): ActivityMappings {
    const accounts: AccountMapping[] = [];
    const patByAccount = new Map<string, Pat>();
    for (const p of this.pats) if (!patByAccount.has(p.accountId)) patByAccount.set(p.accountId, p);
    const ordered = [...this.accounts.values()].sort((a, b) => (patByAccount.get(b.id)?.len ?? 0) - (patByAccount.get(a.id)?.len ?? 0) || a.id.localeCompare(b.id));
    for (const a of ordered) {
      // DC-23: a head siblings share never maps a row to one of them (the engine takes the first match)
      const pats = this.pats.filter((p) => p.accountId === a.id && !p.shared);
      const oppId = this.oppFor(a.id, '');
      const opp = oppId ? this.opps.get(oppId) : undefined;
      accounts.push({
        key: a.id,
        // the engine lower-cases the text and runs these case-insensitively; separators are normalized the same way
        match: pats.length ? pats.map((p) => `(?:${p.re.source})`).join('|') : '(?!)',
        domains: this.domainsOf(a.id),
        whatId: opp?.org62OpportunityId ?? a.org62AccountId ?? '',
        whatType: opp ? 'Opportunity' : 'Account',
        whatName: opp?.name ?? a.name,
        team: opp ? opp.onMyTeam || opp.myDc : undefined,
        // D-103 (c): zero open opps makes the Account WhatId a settled target (classify.ts drops the flag)
        openOpps: (this.openByAccount.get(a.id) ?? []).length,
      });
    }
    return { accounts, repos: extra.repos ?? {}, channels: extra.channels ?? {}, neitherRepos: {}, internalDomains: base.internalDomains, partnerDomains: base.partnerDomains, ignoreDomains: base.ignoreDomains, overrides: [] };
  }

  oppByOrg62(org62Id: string | null | undefined): MatchOpp | null {
    if (!org62Id) return null;
    for (const o of this.opps.values()) if (id15(o.org62OpportunityId) === id15(org62Id)) return o;
    return null;
  }

  accountByOrg62(org62Id: string | null | undefined): MatchAccount | null {
    if (!org62Id) return null;
    for (const a of this.accounts.values()) if (a.org62AccountId && id15(a.org62AccountId) === id15(org62Id)) return a;
    return null;
  }
}
