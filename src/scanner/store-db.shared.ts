// DbScannerStore's connector metadata, kinds, constants, options and pure helpers (ranges, payload split, findings). Split from store-db.ts (max-lines); store-db.ts re-exports the public names.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql, type SQL } from 'drizzle-orm';

import type { Db } from '@/db/client';
import type { ledgerObjectKind, sourceItemKind, sourceSystem } from '@/db/schema/enums';
import type { Involvement, Resolution } from './runtime/contract-ext';
import { toMs } from './store-memory';
import type {
  Confidence, ConnectorHealthProbe, ConnectorId, CoverageObject, NormalizedSourceItem, ScanTrigger, ScopeKey,
  TimeWindow,
} from './types';

type SourceSystem = (typeof sourceSystem.enumValues)[number];
type DbSourceItemKind = (typeof sourceItemKind.enumValues)[number];
type LedgerObjectKind = (typeof ledgerObjectKind.enumValues)[number];
export type ConnectorStatus = 'healthy' | 'degraded' | 'stale' | 'auth_required' | 'paused' | 'disabled' | 'error';
export const DAY = 86_400_000;
/** R6: stored excerpt length (the body column keeps more); every prompt clips what it shows. */
export const EXCERPT_MAX = 4000;
export const TOL = 1000;
export const REOPEN_WINDOW_MS = 14 * DAY;
// ---------------------------------------------------------------------------------------------
// Static maps
// ---------------------------------------------------------------------------------------------

/** connectors row per ConnectorId: (kind, name = connector id). */
export const CONNECTOR_META: Record<
  ConnectorId,
  { kind: SourceSystem; transport: 'mcp_http' | 'agent_sdk' | 'local_files'; skill?: string; label: string }
> = {
  slack: { kind: 'slack', transport: 'agent_sdk', skill: 'scan-slack', label: 'Slack' },
  org62: { kind: 'org62', transport: 'agent_sdk', skill: 'scan-org62', label: 'Org62' },
  gmail: { kind: 'gmail', transport: 'mcp_http', skill: 'scan-gmail', label: 'Gmail' },
  calendar: { kind: 'calendar', transport: 'mcp_http', skill: 'scan-calendar', label: 'Calendar' },
  drive: { kind: 'drive', transport: 'mcp_http', skill: 'scan-drive', label: 'Drive' },
  gemini_notes: { kind: 'gemini_notes', transport: 'mcp_http', skill: 'scan-gemini-notes', label: 'Gemini notes' },
  claude_sessions: { kind: 'claude', transport: 'local_files', skill: 'scan-claude-sessions', label: 'Claude sessions' },
  trainings: { kind: 'gmail', transport: 'mcp_http', skill: 'scan-trainings', label: 'Trainings' },
  watch: { kind: 'slack', transport: 'agent_sdk', skill: 'scan-watch', label: 'Watch briefs' },
  vdp: { kind: 'vdp', transport: 'mcp_http', label: 'VDP' },
};
/** The scanner connector that owns its kind's app-seeded row: the one named like the kind, or the only one of it. */
export function isPrimaryOfKind(connector: ConnectorId): boolean {
  const kind = CONNECTOR_META[connector]?.kind;
  if (!kind) return false;
  if (connector === kind) return true;
  return !Object.entries(CONNECTOR_META).some(([k, m]) => k !== connector && m.kind === kind);
}
export const TRIGGER_MAP: Record<ScanTrigger, 'schedule' | 'startup_catchup' | 'manual' | 'chat' | 'hook' | 'reconcile'> = {
  schedule: 'schedule',
  catch_up: 'startup_catchup',
  reconcile: 'reconcile',
  manual: 'manual',
  chat: 'chat',
  file_watch: 'hook',
};
/** CoverageObject.kind → scan_ledger_entries.object_kind. Refs keep kinds apart where two share a ledger kind. */
export const LEDGER_KIND: Record<CoverageObject['kind'], LedgerObjectKind> = {
  channel_range: 'channel_history',
  thread: 'thread',
  message: 'dm',
  mailbox_range: 'mailbox_page',
  email: 'mailbox_page',
  calendar_range: 'calendar_range',
  file: 'file',
  query_window: 'search_query',
  session: 'transcript_file',
  record: 'soql_query',
};
export const CONFIDENCE_NUM: Record<Confidence, number> = { sure: 0.95, likely: 0.75, guess: 0.45 };
export const RELEVANCE_NUM = { high: 0.9, medium: 0.6, low: 0.3 } as const;
export const RELEVANCE_LEVEL = { high: 'must_read', medium: 'worth_a_look', low: 'fyi' } as const;
/** Keys whose values are message text: they go to `body` (90-day retention), never to `meta`. */
export const TEXT_KEYS = new Set([
  'bodyFull',
  'bodyNew',
  'body',
  'text',
  'transcript',
  'notes',
  'content',
  'markdown',
  'description',
  'summary',
  'snippet',
  'firstPrompt',
  'decisions',
  'nextSteps',
  'myNextSteps',
  'othersNextSteps',
  'excerpt',
  'quote',
  'message',
]);
/** Strings longer than this inside a payload are treated as text, not metadata. */
const META_MAX_STRING = 240;
export const DRIVE_ID = /^[A-Za-z0-9_-]{15,}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ---------------------------------------------------------------------------------------------
// Helpers (exported where the worker reuses them)
// ---------------------------------------------------------------------------------------------

export function modelTierOf(model: string | undefined): 'none' | 'haiku' | 'sonnet' | 'opus' {
  const m = (model ?? '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus')) return 'opus';
  return 'none';
}
/** Local calendar day (YYYY-MM-DD) in an IANA zone. */
export function localDay(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
const skillVersionCache = new Map<string, string>();
/** `version:` from a skill's frontmatter (`skills/<name>.md`), or 'none'. */
export function readSkillVersion(skill: string | undefined, skillsDir = join(process.cwd(), 'skills')): string {
  if (!skill) return 'none';
  const key = `${skillsDir}|${skill}`;
  const hit = skillVersionCache.get(key);
  if (hit) return hit;
  let v = 'none';
  try {
    const head = readFileSync(join(skillsDir, `${skill}.md`), 'utf8').slice(0, 2000);
    const m = /^---[\s\S]*?^version:\s*["']?([^\s"'#]+)/m.exec(head);
    if (m?.[1]) v = m[1];
  } catch {
    /* skill not written yet */
  }
  skillVersionCache.set(key, v);
  return v;
}
export const hashKey = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 24);
export const isoMs = (ms: number) => new Date(ms).toISOString();
export const iso = (v: unknown): string | undefined =>
  v === null || v === undefined ? undefined : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
export interface Range {
  from: number;
  to: number;
}
export function firstHole(merged: Range[], from: number, to: number, tol: number): Range | undefined {
  if (to <= from + tol) return undefined;
  let at = from;
  for (const r of merged) {
    if (r.to <= at) continue;
    if (r.from > at + tol) return { from: at, to: Math.min(r.from, to) };
    at = Math.max(at, r.to);
    if (at >= to - tol) return undefined;
  }
  return at >= to - tol ? undefined : { from: at, to };
}
export function cmpPos(a: string, b: string): number {
  const ta = toMs(a);
  const tb = toMs(b);
  if (ta != null && tb != null) return ta - tb;
  return a.localeCompare(b);
}
export function rangeOf(o: CoverageObject): Range | undefined {
  const from = toMs(o.from);
  const to = toMs(o.to);
  return from != null && to != null && to >= from ? { from, to } : undefined;
}
export function coverageToLedger(objects: CoverageObject[], outcome: 'complete' | 'error') {
  return objects.map((o) => {
    const r = rangeOf(o);
    const meta = o.meta ?? {};
    const num = (k: string) => (typeof meta[k] === 'number' ? Math.max(0, Math.trunc(meta[k] as number)) : undefined);
    return {
      objectKind: LEDGER_KIND[o.kind] ?? 'search_query',
      ref: o.ref,
      // Only a valid range is stored as covered_from/to (ranges_chk); raw positions always go to the tokens.
      coveredFrom: r ? isoMs(r.from) : null,
      coveredTo: r ? isoMs(r.to) : null,
      // Raw source positions (ts, ISO, offsets), compared exactly like the memory store compares `to`.
      startToken: o.from ?? null,
      endToken: o.to ?? null,
      itemCount: num('count') ?? num('listed') ?? num('hits') ?? num('events') ?? 0,
      outcome,
    };
  });
}
function flattenText(v: unknown, out: string[]): void {
  if (v === null || v === undefined) return;
  if (typeof v === 'string') {
    if (v.trim()) out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) flattenText(x, out);
  } else if (typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) flattenText(x, out);
  }
}
/**
 * Splits a fetcher payload into structural metadata (kept forever, never message text) and text parts
 * (go to `body`, purged after 90 days). Known text keys and any long string are text.
 */
export function splitPayload(payload: Record<string, unknown> | undefined): { meta: Record<string, unknown>; text: string[] } {
  const text: string[] = [];
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      if (v.length > META_MAX_STRING) {
        text.push(v);
        return undefined;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1)).filter((x) => x !== undefined);
    if (v && typeof v === 'object') {
      if (depth > 6) return undefined;
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (TEXT_KEYS.has(k)) {
          flattenText(x, text);
          continue;
        }
        const w = walk(x, depth + 1);
        if (w !== undefined) o[k] = w;
      }
      return o;
    }
    return v;
  };
  const meta = (walk(payload ?? {}, 0) as Record<string, unknown>) ?? {};
  return { meta, text };
}
export function dbKindOf(item: NormalizedSourceItem): { source: SourceSystem; kind: DbSourceItemKind } {
  const c = item.connector;
  switch (item.kind) {
    case 'email':
      return { source: 'gmail', kind: 'email_message' };
    case 'calendar_event':
      return { source: 'calendar', kind: 'calendar_event' };
    case 'file_revision':
      return { source: 'drive', kind: 'drive_file_revision' };
    case 'meeting_notes':
      return { source: 'gemini_notes', kind: 'gemini_note' };
    case 'claude_session':
      return { source: 'claude', kind: 'claude_session' };
    case 'training_notice':
      return item.dedupeKey.startsWith('training:cal') ? { source: 'calendar', kind: 'calendar_event' } : { source: 'gmail', kind: 'email_message' };
    case 'message':
    case 'thread':
      return c === 'slack' || c === 'watch' ? { source: 'slack', kind: 'slack_message' } : { source: 'app', kind: 'tool_output' };
    case 'record_snapshot':
      return c === 'vdp' ? { source: 'vdp', kind: 'vdp_record_snapshot' } : { source: 'org62', kind: 'org62_record_snapshot' };
    default:
      // Scanner "notes" (watch plans) are tool output; real manual notes are user-created, never scanned.
      return { source: 'app', kind: 'tool_output' };
  }
}
export const textArr = (vals: string[]): SQL =>
  vals.length
    ? sql`array[${sql.join(
        vals.map((v) => sql`${v}::text`),
        sql`, `,
      )}]`
    : sql`'{}'::text[]`;
export const uuidArr = (vals: string[]): SQL =>
  vals.length
    ? sql`array[${sql.join(
        vals.map((v) => sql`${v}::uuid`),
        sql`, `,
      )}]`
    : sql`'{}'::uuid[]`;
export const normPerson = (s: string) => s.trim().toLowerCase();
/** reconcile_findings.detail for unlinked items: JSON, so reason, hints and "counts as an attempt" survive. */
export interface FindingDetail {
  reason: string;
  hints: string[];
  counts: boolean;
}
export function parseFinding(detail: string | null): FindingDetail {
  try {
    const d = JSON.parse(detail ?? '') as Partial<FindingDetail>;
    return { reason: String(d.reason ?? ''), hints: Array.isArray(d.hints) ? d.hints.map(String) : [], counts: d.counts !== false };
  } catch {
    const reason = (detail ?? '').split('\n')[0] ?? '';
    return { reason, hints: [], counts: !reason.startsWith('deferred:') };
  }
}
// ---------------------------------------------------------------------------------------------
// Run state (process-wide, so several store instances share in-flight runs)
// ---------------------------------------------------------------------------------------------

export interface RunState {
  runId: string;
  scope: ScopeKey;
  connectorId: string;
  trigger: ScanTrigger;
  window: TimeWindow;
  skillVersion?: string;
  model?: string;
  staged: CoverageObject[];
}
export const RUNS = new Map<string, RunState>();
// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

export interface HealthChange {
  connector: ConnectorId;
  from: ConnectorStatus | null;
  to: ConnectorStatus;
  probe: ConnectorHealthProbe;
}
export interface BudgetStatus {
  todayUsd: number;
  softCapUsd: number;
  hardCapUsd: number;
  state: 'ok' | 'soft_alert' | 'capped';
}
export interface DbScannerStoreOptions {
  userId: string;
  db?: Db;
  clock?: () => Date;
  skillsDir?: string;
  /** Caps when neither the budgets setting (`settings.budgets`) nor llm_budgets has one (SCANNER.md §7: hard $15/day). */
  defaultBudget?: { softUsd: number; hardUsd: number; alertPct?: number };
  onHealthChange?: (e: HealthChange) => void | Promise<void>;
}
export type DigestRow = {
  id: string;
  initiative_id: string | null;
  kind: string;
  title: string;
  purpose: string | null;
  status: string;
  resolution: Resolution | null;
  involvement: Involvement;
  handed_off_to: string | null;
  account_id: string | null;
  people: string[] | null;
  accounts: string[] | null;
  thread_refs: string[] | null;
  file_refs: string[] | null;
  last_evidence_at: string | null;
  expected_file: string | null;
  expected_changes: string[] | null;
  has_deliverable: boolean;
};
