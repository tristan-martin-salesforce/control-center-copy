// DbScannerStore's ledger rows, failure codes and completion/spend row mapping. Split from store-db.ts (max-lines); store-db.ts re-exports the public names.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import type { PassSpend } from '@/scanner/trace/queries';
import type { CallMeasurement } from '@/db/ledger';
import type { CompletionEvidence } from './completion/types';
import type { ConnectorHealthProbe, ConnectorId, PersonRef, ScannerStore, SpendBooked } from './types';
import { coverageToLedger, CONNECTOR_META, iso } from './store-db.shared';

export async function insertLedger(tx: Tx, connectorId: string, scope: string, runId: string, ledger: ReturnType<typeof coverageToLedger>): Promise<void> {
  for (const e of ledger) {
    await tx.execute(sql`
      insert into scan_ledger_entries (scan_run_id, connector_id, scope, object_kind, object_external_id, covered_from, covered_to,
                                       start_token, end_token, item_count, outcome)
      values (${runId}, ${connectorId}, ${scope}, ${e.objectKind}, ${e.ref}, ${e.coveredFrom}::timestamptz, ${e.coveredTo}::timestamptz,
              ${e.startToken}, ${e.endToken}, ${e.itemCount}, ${e.outcome})`);
  }
}
/** Scanner error class → the contract's connector error class (auth | transient | rate_limited | bug | offline). */
/** The cause of a failed run from its message: prefix_tripwire, cost_cap, timeout, max_turns, no_finish, coverage, auth … */
export function failureCode(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('prefix tripwire')) return 'prefix_tripwire';
  if (m.includes('cost cap')) return 'cost_cap';
  if (m.includes('prompt cap')) return 'prompt_cap';
  if (m.includes('watchdog') || m.includes('timed out') || m.includes('timeout')) return 'timeout';
  if (m.includes('max_turns')) return 'max_turns';
  if (m.includes('without cc_finish') || m.includes('without a cursor')) return 'no_finish';
  if (m.includes('coverage does not span') || m.includes('outside the run window')) return 'coverage';
  if (m.includes('disallowed tool')) return 'disallowed_tool';
  if (/auth|401|403|unauthori[sz]ed|login/.test(m)) return 'auth';
  if (/rate.?limit|429/.test(m)) return 'rate_limited';
  if (m.includes('cancel') || m.includes('abort')) return 'cancelled';
  return 'error';
}
export function contractErrorClass(c: ConnectorHealthProbe['errorClass'] | undefined): 'auth' | 'transient' | 'rate_limited' | 'bug' | 'offline' {
  if (c === 'auth' || c === 'transient' || c === 'rate_limited') return c;
  if (c === 'config') return 'bug';
  return 'transient';
}
// ---------------------------------------------------------------------------------------------
// Completion pass rows (CMP-1)
// ---------------------------------------------------------------------------------------------

/** Source-item columns both completion reads select (alias `si`). */
export const COMPLETION_COLUMNS = sql.raw(`si.id, si.source::text as source, si.kind::text as kind, si.external_id, si.external_parent_id, si.occurred_at,
  si.from_me, si.meta->'author' as author, si.meta->'participants' as participants, si.meta->'accountHints' as account_hints,
  si.meta->>'connector' as connector, si.meta->'fileRefs' as meta_file_refs,
  coalesce((select array_agg(r.value) from source_item_refs r where r.source_item_id = si.id), '{}') as refs`);
export type CompletionRow = {
  id: string;
  source: string;
  kind: string;
  external_id: string;
  external_parent_id: string | null;
  occurred_at: string;
  from_me: boolean;
  author: unknown;
  participants: unknown;
  account_hints: unknown;
  connector: string | null;
  meta_file_refs: unknown;
  refs: string[] | null;
  text: string | null;
};
const SOURCE_CONNECTOR: Record<string, ConnectorId> = { slack: 'slack', gmail: 'gmail', calendar: 'calendar', drive: 'drive', gemini_notes: 'gemini_notes', org62: 'org62', vdp: 'vdp', claude: 'claude_sessions' };
const KIND_BACK: Record<string, string> = { slack_message: 'message', email_message: 'email', drive_file_revision: 'file_revision', gemini_note: 'meeting_notes', org62_record_snapshot: 'record_snapshot', vdp_record_snapshot: 'record_snapshot' };
export function personOf(v: unknown): PersonRef | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string) : undefined);
  const p: PersonRef = {
    ...(str('name') ? { name: str('name') } : {}),
    ...(str('email') ? { email: str('email') } : {}),
    ...(str('externalId') ? { externalId: str('externalId') } : {}),
    ...(o.isMe === true ? { isMe: true } : {}),
    ...(o.isExternal === true ? { isExternal: true } : {}),
  };
  return Object.keys(p).length ? p : undefined;
}
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
export function completionFieldsOf(r: CompletionRow): Omit<CompletionEvidence, 'sourceItemId' | 'role'> {
  const author = personOf(r.author);
  const participants = Array.isArray(r.participants) ? r.participants.map(personOf).filter((p): p is PersonRef => !!p) : [];
  const connector = (r.connector && r.connector in CONNECTOR_META ? r.connector : (SOURCE_CONNECTOR[r.source] ?? r.source)) as ConnectorId;
  return {
    connector,
    kind: KIND_BACK[r.kind] ?? r.kind,
    externalId: r.external_id,
    ...(r.external_parent_id ? { threadRef: r.external_parent_id } : {}),
    occurredAt: iso(r.occurred_at)!,
    fromMe: r.from_me === true,
    ...(author ? { author } : {}),
    ...(participants.length ? { participants } : {}),
    fileRefs: [...new Set([...(r.refs ?? []), ...strings(r.meta_file_refs)])],
    accountHints: strings(r.account_hints),
    ...(r.text ? { text: r.text } : {}),
  };
}
/** What `recordSpend` books (ScannerStore.recordSpend's input, D0 audit fields included). */
export type RecordSpendInput = Parameters<ScannerStore['recordSpend']>[0];
export interface SpendRow {
  model: string;
  skill: string | null;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  status: string;
  errorCode: string | null;
  hash: string;
  contentHash: string | null;
  modelReason: string;
  outcome: string | null;
  /** 0027: what the call measured (a pass row's `m`, or the caller's on a single rest row). */
  measure?: CallMeasurement;
  /** A triage escalation pass (escalated_from_call_id points at the run's cheaper triage call). */
  escalation?: boolean;
}
const tok = (n: number | undefined) => Math.max(0, Math.round(Number.isFinite(n as number) ? (n as number) : 0));
/**
 * D0: the rest of a spend no pass row covered, with its tokens. The caller's per-model usage (the SDK's modelUsage)
 * less what the pass rows booked is what the rest was spent on; the rest is spread over those models by their
 * remaining cost. Without usage, the rest is one row on the caller's model with the caller's tokens.
 */
export function restRows(restUsd: number, parts: PassSpend[], input: SpendBooked, skill: string | null, runId: string | null): SpendRow[] {
  const base = { skill, status: 'ok', errorCode: null, contentHash: input.contentHash ?? null, modelReason: input.modelReason ?? 'default', outcome: input.outcome ?? null };
  const left = new Map<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }>();
  for (const u of input.usage ?? []) left.set(u.model, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, costUsd: u.costUsd });
  for (const p of parts) {
    const l = p.model ? left.get(p.model) : undefined;
    if (!l) continue;
    l.inputTokens -= p.inputTokens;
    l.outputTokens -= p.outputTokens;
    l.cacheReadTokens -= p.cacheReadTokens;
    l.cacheWriteTokens -= p.cacheWriteTokens;
    l.costUsd -= p.costUsd;
  }
  const res = [...left].filter(([, l]) => l.costUsd > 1e-7);
  const hash = () => `spend:${runId ?? 'none'}:${randomUUID()}`;
  if (!res.length) {
    // 0027: the caller's measurement belongs to this row only when no pass row booked part of the spend.
    return [{ ...base, model: input.model, usd: restUsd, inputTokens: tok(input.inputTokens), outputTokens: tok(input.outputTokens), cacheReadTokens: tok(input.cacheReadTokens), cacheWriteTokens: tok(input.cacheWriteTokens), hash: hash(), ...(!parts.length && input.measure ? { measure: input.measure } : {}) }];
  }
  const total = res.reduce((a, [, l]) => a + l.costUsd, 0);
  let booked = 0;
  return res.map(([model, l], i) => {
    const usd = i === res.length - 1 ? restUsd - booked : (restUsd * l.costUsd) / total;
    booked += usd;
    return { ...base, model, usd, inputTokens: tok(l.inputTokens), outputTokens: tok(l.outputTokens), cacheReadTokens: tok(l.cacheReadTokens), cacheWriteTokens: tok(l.cacheWriteTokens), hash: hash() };
  });
}
