/**
 * The attribution engine's records as the contract shows them (src/contract/attribution.ts): a learned rule for
 * Settings ▸ Time ▸ Learned rules, the DC suggestions payload, and the comment an accepted suggestion's DC request
 * carries. Pure; the db and the mock DataSources share it.
 */
import type { DcSuggestion, DcSuggestionsPayload, MappingRuleView } from '@/contract';
import { ruleActive } from './rules';
import type { LearnedRule } from './types';

const KEY_WORD: Record<LearnedRule['kind'], (p: string) => string> = {
  domain: (p) => p,
  channel: (p) => (p.startsWith('name:') ? `#${p.slice(5)}` : p),
  person: (p) => p,
  keyword: (p) => `the word “${p}”`,
  series: () => 'a recurring meeting',
  repo: (p) => `repo ${p}`,
};

/** One rule as Settings lists it. `names` looks up its target's name. */
export function ruleView(r: LearnedRule, names: { opp(id: string): { id: string; name: string } | undefined; account(id: string): { id: string; name: string } | undefined }): MappingRuleView {
  const opp = r.oppId ? names.opp(r.oppId) : undefined;
  const acct = r.accountId ? names.account(r.accountId) : undefined;
  const target: MappingRuleView['target'] = r.internal ? { kind: 'internal', id: null, name: 'Internal work' } : opp ? { kind: 'opp', id: opp.id, name: opp.name } : { kind: 'account', id: acct?.id ?? r.accountId, name: acct?.name ?? 'an account' };
  return { id: r.id, kind: r.kind, pattern: r.pattern, label: KEY_WORD[r.kind](r.pattern), target, hits: r.hits, misses: r.misses, lastUsedAt: r.lastUsedAt, enabled: r.enabled, active: ruleActive(r), source: r.source ?? 'user_correction' };
}

/** The waiting suggestions (groups together, pre-ticked first) and the decided ones (newest first). */
export function dcPayload(all: DcSuggestion[], quarter: string, extra: { generatedAt: string | null; dcProducts: string[]; enabled: boolean }): DcSuggestionsPayload {
  const waiting = all.filter((x) => x.state === 'new').sort((a, b) => a.groupKey.localeCompare(b.groupKey) || Number(b.preTicked) - Number(a.preTicked) || b.sharePercent - a.sharePercent || a.oppName.localeCompare(b.oppName));
  const decided = all.filter((x) => x.state === 'accepted' || x.state === 'edited' || x.state === 'rejected').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
  return { quarter, suggestions: waiting, decided, generatedAt: extra.generatedAt, dcProducts: extra.dcProducts, enabled: extra.enabled };
}

/** Comments__c for an accepted suggestion: what I did, from its reasons and evidence. */
export function dcComment(s: Pick<DcSuggestion, 'oppName' | 'reasons' | 'evidence'>): string {
  const why = s.reasons.filter((r) => r.code !== 'split_question').map((r) => r.text);
  const ev = s.evidence.map((e) => e.label).slice(0, 3);
  const text = [...why, ...(ev.length ? [`Evidence: ${ev.join('; ')}`] : [])].join('. ');
  return (text || `Engaged on ${s.oppName}`).slice(0, 1000);
}
