/**
 * The company-identity judgment (D-69): ONE tool-less, one-turn model call per ambiguity unit (an account and its
 * relatives in my book that the rules could not settle), with the `vdp-company-identity` skill (Haiku, a per-call cap
 * from its frontmatter). The reply is parsed and checked here: a `match` must name a company VDP returned for that
 * account; a `create` needs a name. The decision is cached per unit with the hash of its inputs, so it runs again only
 * when they change (src/engines/vdp/identity.ts `resolveCompanyIdentity` applies it). Writes nothing.
 */
import { ledgerHash } from '@/lib/ledger-hash';
import type { VdpIdentityPick } from '@/contract';
import { loadSkill } from '@/engines/nba/prompt/skills';
import type { CompletionModel } from '@/scanner/completion/types';

import type { IdentityJudgment, JudgedAccount, JudgmentRequest } from './identity';

export const IDENTITY_SKILL = 'vdp-company-identity';
export const IDENTITY_MODEL = 'claude-haiku-5-5';

/** The user message: the unit's accounts, what VDP returned up their chains, and why each is ambiguous. */
export function renderIdentityPrompt(u: JudgmentRequest): string {
  return JSON.stringify({ accounts: u.accounts, options: u.options, kinds: u.kinds });
}

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** The reply, checked against the unit: one decision per known account, matches only among its options. */
export function parseIdentityReply(text: string, u: JudgmentRequest): JudgedAccount[] | null {
  const at = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (at < 0 || end <= at) return null;
  let body: { accounts?: unknown };
  try {
    body = JSON.parse(text.slice(at, end + 1)) as { accounts?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(body.accounts)) return null;
  const ids = new Set(u.accounts.map((a) => a.id));
  const out: JudgedAccount[] = [];
  for (const x of body.accounts as Array<Record<string, unknown>>) {
    const accountId = typeof x?.accountId === 'string' ? x.accountId : '';
    if (!ids.has(accountId) || out.some((o) => o.accountId === accountId)) continue;
    const p = (x.pick ?? {}) as Record<string, unknown>;
    let pick: VdpIdentityPick | null = null;
    if (p.kind === 'match' && typeof p.id === 'string') {
      const opt = u.options.find((o) => o.accountId === accountId && o.id === p.id);
      if (opt) pick = { kind: 'match', id: opt.id, name: opt.name };
    } else if (p.kind === 'create') {
      const name = clip(p.name, 200);
      const aliases = Array.isArray(p.aliases) ? p.aliases.map((a) => clip(a, 200)).filter(Boolean).slice(0, 20) : [];
      if (name) pick = { kind: 'create', name, aliases };
    }
    if (!pick) continue;
    const confidence = typeof x.confidence === 'number' && Number.isFinite(x.confidence) ? Math.max(0, Math.min(1, x.confidence)) : 0;
    const level = typeof x.level === 'number' && Number.isFinite(x.level) ? Math.max(0, Math.min(5, Math.round(x.level))) : 0;
    out.push({ accountId, pick, level, confidence, reason: clip(x.reason, 140) || 'The judgment picked this company' });
  }
  return out.length ? out : null;
}

export interface JudgeRunResult {
  judgments: Record<string, IdentityJudgment>;
  judged: number;
  failed: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** D0: hash of the model, skill version and the inputs of every unit asked (each unit's own inputs hash). */
  contentHash: string;
  /** Units left for the next run (the per-run cap or the budget stopped it). */
  left: number;
}

/**
 * Judge the pending units, at most `maxUnits`, each capped at the skill's per-call budget, stopping when `budgetUsd`
 * is spent. A failed or unreadable reply leaves the unit undecided ("Needs you" stays) and is remembered with its
 * inputs' hash, so it is asked again only once they change.
 */
export async function judgeIdentityUnits(units: readonly JudgmentRequest[], call: CompletionModel, o: { now: Date; budgetUsd: number; maxUnits?: number; signal?: AbortSignal; prev?: Readonly<Record<string, IdentityJudgment>> }): Promise<JudgeRunResult> {
  const skill = loadSkill(IDENTITY_SKILL);
  const perCall = Number(skill.meta.budget_usd_per_call ?? 0.02);
  const max = o.maxUnits ?? Number(skill.meta.max_units_per_run ?? 12);
  const model = typeof skill.meta.model === 'string' ? skill.meta.model : IDENTITY_MODEL;
  const judgments: Record<string, IdentityJudgment> = { ...(o.prev ?? {}) };
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const asked: string[] = [];
  let judged = 0;
  let failed = 0;
  let n = 0;
  for (const u of units) {
    if (n >= max || costUsd + perCall > o.budgetUsd || o.signal?.aborted) break;
    n += 1;
    const res = await call({ system: skill.body, user: renderIdentityPrompt(u), model, effort: 'low', maxBudgetUsd: perCall, ...(o.signal ? { signal: o.signal } : {}) });
    costUsd += res.costUsd;
    inputTokens += res.inputTokens;
    outputTokens += res.outputTokens;
    cacheReadTokens += res.cacheReadTokens ?? 0;
    cacheWriteTokens += res.cacheWriteTokens ?? 0;
    asked.push(u.hash);
    const accounts = res.ok ? parseIdentityReply(res.text, u) : null;
    if (!accounts) {
      // remembered as tried (no decision): asked again only once the unit's inputs change, never in a loop
      failed += 1;
      judgments[u.key] = { hash: u.hash, at: o.now.toISOString(), model, accounts: [] };
      continue;
    }
    judgments[u.key] = { hash: u.hash, at: o.now.toISOString(), model, accounts };
    judged += 1;
  }
  return { judgments, judged, failed, costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, contentHash: ledgerHash(model, skill.version ?? null, ...asked), left: units.length - n };
}
