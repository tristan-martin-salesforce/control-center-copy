/**
 * Learned rules: the engine's memory (R2, tenet: Suggest, then learn). `mapping_rules` existed since 0001 with no
 * reader and no writer (lane 06 TA-2); this is both.
 *
 *   read    every rule whose key the signal carries (its series, channel, domains, emails, repo, distinctive words)
 *           adds a `rule` reason (weight ruleOpp / ruleAccount × hits / (hits + misses)), cited in `why[]`.
 *   learn   a correction (accept, edit, pick, reject) of a time row, a canvas row, a DC claim or a suggestion: the
 *           rules it agrees with are strengthened (hits + 1, last used now); the ones it contradicts decay (misses + 1)
 *           and, once misses reach hits, are replaced by the new target (hits 1); a key the signal carries that no rule
 *           covers yet gets one (the strongest generalizable key: series, else channel, else repo; plus its domains,
 *           else its people; plus a distinctive word when the account has several open opps).
 *           A channel or domain rule that sees another opp of the same account is generalized to the account.
 *   never   a rule never overrides a field the user set (the callers skip locked rows), and a disabled rule is never read.
 */
import { dealWords, accountWords, domainOfEmail, normDomain } from './text';
import type { AttributionWeights, LearnedRule, RuleKind, Signal, World } from './types';

/** The `mapping_rules.kind` each rule kind is stored as (migration 0032 adds person_to_account, keyword_to_opportunity). */
export const DB_KIND: Readonly<Record<RuleKind, string>> = {
  domain: 'domain_to_account',
  channel: 'channel_to_account',
  person: 'person_to_account',
  keyword: 'keyword_to_opportunity',
  series: 'meeting_to_opportunity',
  repo: 'repo_path_to_account',
};
/** Read side: the stored kinds the engine reads (a seeded title_token_to_account is a word / phrase rule). */
export const RULE_KIND_OF_DB: Readonly<Record<string, RuleKind>> = { ...Object.fromEntries(Object.entries(DB_KIND).map(([k, v]) => [v, k as RuleKind])), title_token_to_account: 'keyword' };

/** The `target_value` of a rule that says "internal work" (the check constraint wants one target). */
export const INTERNAL_TARGET = 'internal';

export interface RuleKey {
  kind: RuleKind;
  pattern: string;
}

const lc = (s: string) => s.trim().toLowerCase();

/** External = not internal, partner or ignored. */
export function externalDomainsOf(sig: Pick<Signal, 'domains' | 'emails'>, w: Pick<World, 'internalDomains' | 'partnerDomains' | 'ignoreDomains'>): string[] {
  const skip = new Set([...(w.internalDomains ?? []), ...(w.partnerDomains ?? []), ...(w.ignoreDomains ?? [])].map(normDomain));
  const all = [...(sig.domains ?? []), ...(sig.emails ?? []).map((e) => domainOfEmail(e)).filter((d): d is string => !!d)].map(normDomain);
  return [...new Set(all)].filter((d) => d && !skip.has(d)).sort();
}

export function externalEmailsOf(sig: Pick<Signal, 'emails'>, w: Pick<World, 'internalDomains' | 'partnerDomains' | 'ignoreDomains'>): string[] {
  const ext = new Set(externalDomainsOf({ emails: sig.emails ?? [] }, w));
  return [...new Set((sig.emails ?? []).map(lc))].filter((e) => ext.has(domainOfEmail(e) ?? '')).sort();
}

/** Every rule key a signal carries. */
export function ruleKeysOf(sig: Signal, w: Pick<World, 'internalDomains' | 'partnerDomains' | 'ignoreDomains'>): RuleKey[] {
  const keys: RuleKey[] = [];
  if (sig.seriesId) keys.push({ kind: 'series', pattern: sig.seriesId.trim() });
  if (sig.channel?.id) keys.push({ kind: 'channel', pattern: sig.channel.id.trim() });
  if (sig.repo) keys.push({ kind: 'repo', pattern: sig.repo.trim() });
  for (const d of externalDomainsOf(sig, w)) keys.push({ kind: 'domain', pattern: d });
  for (const e of externalEmailsOf(sig, w)) keys.push({ kind: 'person', pattern: e });
  for (const t of dealWords(sig.text)) keys.push({ kind: 'keyword', pattern: t });
  return keys;
}

const sameKey = (r: Pick<LearnedRule, 'kind' | 'pattern'>, k: RuleKey) => r.kind === k.kind && (k.kind === 'channel' || k.kind === 'series' || k.kind === 'repo' ? r.pattern === k.pattern : lc(r.pattern) === lc(k.pattern));

/** A rule is read while it is on and has more agreement than disagreement. */
export const ruleActive = (r: LearnedRule): boolean => r.enabled && r.hits > r.misses;

/** The rules a signal triggers (active ones only). */
export function matchingRules(sig: Signal, w: World): LearnedRule[] {
  const keys = ruleKeysOf(sig, w);
  const text = ` ${(sig.text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  // a word or series rule whose pattern is a phrase ("Saltmere weekly sync", a seeded title token) matches the text
  const phrase = (r: LearnedRule) => (r.kind === 'keyword' || r.kind === 'series') && /\s/.test(r.pattern.trim()) && text.includes(` ${r.pattern.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `);
  return (w.rules ?? []).filter((r) => ruleActive(r) && (keys.some((k) => sameKey(r, k)) || phrase(r)));
}

/** A rule's weight: its kind's base × its agreement share. */
export function ruleWeight(r: LearnedRule, w: AttributionWeights): number {
  const base = r.oppId || r.internal ? w.ruleOpp : w.ruleAccount;
  const n = r.hits + r.misses;
  return Math.round(base * (n ? r.hits / n : 1) * 1000) / 1000;
}

const KIND_WORD: Record<RuleKind, string> = { domain: 'domain', channel: 'channel', person: 'contact', keyword: 'word', series: 'meeting series', repo: 'repo' };

/** "Learned 11/12 from your pick: channel #acme-ext → ACME" (the reason a rule shows, tenet: Legible). */
export function ruleText(r: LearnedRule, target: string, keyLabel?: string | null): string {
  const when = r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' }) : null;
  const src = r.source === 'seed' ? 'Set up for you' : `Learned${when ? ` ${when}` : ''} from your ${r.hits > 1 ? `${r.hits} picks` : 'pick'}`;
  return `${src}: ${KIND_WORD[r.kind]} ${keyLabel ?? r.pattern} → ${target}`;
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

/** What the user settled: an opp (with its account), an account alone, or internal work. */
export interface Chosen {
  oppId: string | null;
  accountId: string | null;
  internal?: boolean;
}

export interface LearnInput {
  signal: Signal;
  chosen: Chosen;
  /** accept: took the top as shown; edit: picked something else; reject: said no to what was shown. */
  outcome: 'accept' | 'edit' | 'reject';
  /** What was shown (a reject decays the rules that pointed at it). */
  shown?: Chosen | null;
  world: World;
}

export interface RuleChange {
  before: LearnedRule | null;
  after: LearnedRule;
  effect: 'new' | 'strengthened' | 'decayed' | 'replaced' | 'generalized';
}

const agrees = (r: Pick<LearnedRule, 'oppId' | 'accountId' | 'internal'>, c: Chosen): boolean =>
  c.internal ? !!r.internal : !r.internal && (r.oppId ? r.oppId === c.oppId : !!r.accountId && r.accountId === c.accountId);

/** Kinds that describe an account (an opp on them is a narrowing that a second opp of the same account undoes). */
const ACCOUNT_KINDS = new Set<RuleKind>(['channel', 'domain', 'person', 'repo']);

/**
 * The rule changes one correction makes (pure; the db and the mock apply them in the correction's own change set, so
 * Undo reverts the learning with the edit). `newId` names a new rule.
 */
export function planLearning(i: LearnInput, existing: readonly LearnedRule[], now: string, newId: (k: RuleKey) => string): RuleChange[] {
  const keys = ruleKeysOf(i.signal, i.world);
  const out: RuleChange[] = [];
  const touched = new Set<string>();
  const c = i.chosen;
  const target = i.outcome === 'reject' ? null : c;
  if (target && !target.internal && !target.oppId && !target.accountId) return [];
  const acctOfOpp = (id: string | null) => (id ? (i.world.opps.find((o) => o.id === id)?.accountId ?? null) : null);

  for (const r of existing) {
    if (!r.enabled || !keys.some((k) => sameKey(r, k))) continue;
    touched.add(`${r.kind}|${lc(r.pattern)}`);
    if (target && agrees(r, target)) {
      out.push({ before: r, after: { ...r, hits: r.hits + 1, lastUsedAt: now }, effect: 'strengthened' });
      continue;
    }
    // the same account, another opp: an account-kind rule generalizes to the account (it never names one opp again)
    if (target && !target.internal && r.oppId && ACCOUNT_KINDS.has(r.kind) && r.accountId && r.accountId === (target.accountId ?? acctOfOpp(target.oppId))) {
      out.push({ before: r, after: { ...r, oppId: null, hits: r.hits + 1, lastUsedAt: now }, effect: 'generalized' });
      continue;
    }
    // a rule that pointed somewhere else (or at what was rejected) decays; once disagreement catches up it is replaced
    const pointedAtShown = !target && i.shown ? agrees(r, i.shown) : true;
    if (!pointedAtShown) continue;
    const misses = r.misses + 1;
    if (target && misses >= r.hits) {
      const keepsOpp = r.kind === 'channel' || r.kind === 'series' || r.kind === 'keyword';
      out.push({ before: r, after: { ...r, accountId: target.internal ? null : (target.accountId ?? acctOfOpp(target.oppId)), oppId: target.internal || !keepsOpp ? null : target.oppId, internal: !!target.internal, hits: 1, misses: 0, lastUsedAt: now, source: 'user_correction' }, effect: 'replaced' });
    } else out.push({ before: r, after: { ...r, misses, lastUsedAt: now }, effect: 'decayed' });
  }
  if (!target) return out;

  // new rules for the generalizable keys nothing covers yet
  const fresh = (k: RuleKey) => !touched.has(`${k.kind}|${lc(k.pattern)}`);
  const accountId = target.internal ? null : (target.accountId ?? acctOfOpp(target.oppId));
  const add = (k: RuleKey, opp: string | null) => {
    if (!fresh(k)) return;
    touched.add(`${k.kind}|${lc(k.pattern)}`);
    out.push({ before: null, after: { id: newId(k), kind: k.kind, pattern: k.pattern, accountId, oppId: target.internal ? null : opp, internal: !!target.internal, hits: 1, misses: 0, lastUsedAt: now, enabled: true, source: 'user_correction' }, effect: 'new' });
  };
  const primary = keys.find((k) => k.kind === 'series') ?? keys.find((k) => k.kind === 'channel') ?? keys.find((k) => k.kind === 'repo');
  if (primary) add(primary, primary.kind === 'repo' ? null : target.oppId);
  if (target.internal) return out;
  const domains = keys.filter((k) => k.kind === 'domain').slice(0, 2);
  for (const k of domains) add(k, null);
  if (!domains.length) for (const k of keys.filter((x) => x.kind === 'person').slice(0, 2)) add(k, null);
  // a distinctive word the text and the opp's name share, when the account has several open opps (it tells them apart)
  if (target.oppId && accountId) {
    const opp = i.world.opps.find((o) => o.id === target.oppId);
    const siblings = i.world.opps.filter((o) => o.accountId === accountId && o.isOpen && o.id !== target.oppId);
    if (opp && siblings.length) {
      const skip = accountWords(i.world.accounts.find((a) => a.id === accountId)?.name);
      const inName = new Set(dealWords(opp.name, skip));
      const word = dealWords(i.signal.text, skip).find((t) => inName.has(t) && !siblings.some((s) => dealWords(s.name).includes(t)));
      if (word) add({ kind: 'keyword', pattern: word }, target.oppId);
    }
  }
  // nothing else to learn from (no series, channel, repo, domain or contact): the text's most telling word, so the
  // correction is never lost ("Hooli onsite" → the opp you picked); the account's own name word only as a last resort
  if (!out.some((c) => c.effect === 'new' || c.effect === 'strengthened' || c.effect === 'generalized' || c.effect === 'replaced')) {
    const own = accountWords(i.world.accounts.find((a) => a.id === accountId)?.name);
    const ws = dealWords(i.signal.text);
    const word = ws.find((w) => !own.has(w) && w.length >= 5) ?? ws.find((w) => !own.has(w)) ?? ws[0];
    if (word) add({ kind: 'keyword', pattern: word }, target.oppId);
  }
  return out;
}

/** Apply planned changes to a rule list (the mock store and tests; the db writes the same `after` rows). */
export function applyRuleChanges(rules: readonly LearnedRule[], changes: readonly RuleChange[]): LearnedRule[] {
  const byId = new Map(rules.map((r) => [r.id, r] as const));
  for (const c of changes) byId.set(c.after.id, c.after);
  return [...byId.values()];
}
