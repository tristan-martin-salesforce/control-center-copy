// InMemoryScannerStore's errors, options, row shapes and range helpers. Split from store-memory.ts (max-lines); store-memory.ts re-exports the public names.
import type { ResolvedPersona } from '../personas/types';
import type {
  ConnectorHealthProbe, Confidence, CoverageObject, Cursor, EvidenceRole, NormalizedSourceItem, ProposeItemInput,
  ScanContext, ScanningPrefs, ScanRunStats, ScanTrigger, ScopeKey, TimeWindow,
} from './types';
import type { Involvement, Resolution } from './runtime/contract-ext';
import type { CompletionEvidence } from './completion/types';

/** Completion pass: live statuses it checks (mirrors completion/types LIVE_STATUSES; a type-only import keeps this file free of a cycle). */
export const COMPLETION_LIVE = ['open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done', 'suggested'] as const;
 // CMP-SUG: as store-db

export class RunStateError extends Error {
  override name = 'RunStateError';
}
export class CoverageError extends Error {
  override name = 'CoverageError';
}
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}
export interface StoreClock {
  now(): Date;
}
export interface StoreProfile {
  me: ScanContext['me'];
  watchList?: ScanContext['watchList'];
  aliases?: ScanContext['aliases'];
  /** Settings ▸ Scanning (absent: the defaults). */
  scanning?: ScanningPrefs;
  /** D-55: the resolved persona (absent: none in the context, which reads as the SE persona). */
  persona?: ResolvedPersona;
}
export interface InMemoryStoreOptions {
  clock?: StoreClock;
  profile?: StoreProfile;
  softCapUsd?: number;
  hardCapUsd?: number;
  /** Max hole (ms) still treated as contiguous. Default 1000. */
  toleranceMs?: number;
  /** Local-day key for spend totals. Default: UTC date. */
  dayKey?: (d: Date) => string;
  /** Done items stay link candidates this long (requirement changes → contradiction). Default 14 d. */
  reopenWindowMs?: number;
  /** The user's timezone: a bare due date is 17:00 there (DUE-1). Default UTC. */
  timeZone?: string;
  /** Settings ▸ Closing as the db store reads it (R2 reopenOnFollowUp, R15 oldAskDays). Absent: the defaults. */
  closing?: { reopenOnFollowUp?: boolean; oldAskDays?: number };
}
export type WorkState = 'open' | 'suggested' | 'in_progress' | 'waiting_on_me' | 'done' | 'dismissed' | 'merged' | string;
export interface SourceItemRow extends NormalizedSourceItem {
  id: string;
  revision: number;
  firstRunId: string;
  lastRunId: string;
}
export interface WorkItemRow {
  id: string;
  kind: string;
  title: string;
  purpose?: string;
  state: WorkState;
  landedAs: 'open' | 'suggested';
  newBadge: boolean;
  confidence: Confidence;
  due?: string;
  effort?: ProposeItemInput['effort'];
  initiativeId?: string;
  accountId?: string;
  oppId?: string;
  expected?: ProposeItemInput['expected'];
  /** Why it landed where it did (DEEP-1 / PAST-1 "Still needed?"). */
  statusReason?: string;
  people: Set<string>;
  accounts: Set<string>;
  keywords: Set<string>;
  threadRefs: Set<string>;
  fileRefs: Set<string>;
  lastEvidenceAt?: string;
  doneAt?: string;
  /** Who closed it (R2: only a close for you reopens on a follow-up). */
  doneBy?: 'engine' | 'user';
  /** R1: the user's correction (reopened after a close, kept on Still needed?): never closed for them again. */
  correction?: 'reopened' | 'kept';
  resolution?: Resolution;
  involvement?: Involvement;
  handedOffTo?: string;
  originKey: string;
  createdRunId?: string;
}
export interface EvidenceRow {
  id: string;
  workItemId: string;
  sourceItemId: string;
  role: EvidenceRole;
  confidence: Confidence;
  reason: string;
  runId: string;
  skillVersion?: string;
}
export interface InitiativeRow {
  id: string;
  key: string;
  title: string;
  purpose: string;
  accountId?: string;
  oppId?: string;
  workItemIds: string[];
  accounts: string[];
  keywords: string[];
}
export interface RunRow {
  id: string;
  scope: ScopeKey;
  scopeId: string;
  trigger: ScanTrigger;
  window: TimeWindow;
  model?: string;
  skillVersion?: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  cursorBefore: Cursor | null;
  cursorAfter?: Cursor;
  stats?: ScanRunStats | Partial<ScanRunStats>;
  summary?: string;
  error?: string;
  errorClass?: ConnectorHealthProbe['errorClass'];
  staged: CoverageObject[];
  flagged: Set<string>;
  seen: Map<string, 'new' | 'changed' | 'unchanged'>;
}
export interface LedgerRow {
  runId: string;
  scopeId: string;
  object: CoverageObject;
  fromMs?: number;
  toMs?: number;
  outcome: 'complete' | 'error';
}
export interface UnlinkedRow {
  sourceItemId: string;
  attempts: number;
  reason: string;
  hints: string[];
  deferred: boolean;
  lastFlaggedAt: string;
  /** MAP-1: no mapping question (not an ask or commitment of mine): never listed again. */
  ignored?: string;
}
export const DAY = 86_400_000;
const STOP = new Set(
  'the and for with that this from have will your you are was were but not all any can our out about into over then them they their there what when where which while would could should just also than been being does done its it’s i’ll ill lets let send sent please thanks thank hey team need needs more some'.split(
    ' ',
  ),
);
export function tokenize(text: string | undefined): string[] {
  if (!text) return [];
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOP.has(t)),
    ),
  ];
}
export const normPerson = (s: string) => s.trim().toLowerCase();
/** Parse an ISO string, a Slack ts ("1730812345.000100") or epoch seconds/millis into ms. */
/**
 * R13: one form for a Drive file ref. `drive:<ID>` (Slack, agents) and Docs/Drive URLs become the bare file id, so the
 * "same file" joins (`source_item_refs.kind = 'drive_file'`, findCandidates, the completion pass) all see one value.
 * Anything else is returned as is.
 */
export function normDriveRef(ref: string): string {
  const r = ref.trim();
  const tagged = /^drive:([A-Za-z0-9_-]{15,})$/.exec(r);
  if (tagged) return tagged[1]!;
  const url = /docs\.google\.com\/(?:[a-z]+\/)*d\/([A-Za-z0-9_-]{15,})|drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]{15,})/.exec(r);
  return url ? (url[1] ?? url[2])! : r;
}
export function toMs(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  if (/^\d{9,11}(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  if (/^\d{12,14}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}
export const iso = (ms: number) => new Date(ms).toISOString();
export interface Range {
  from: number;
  to: number;
}
/** Time-range coverage kinds (queries over a window), as opposed to objects (threads, files, records). */
const TIME_RANGE_KINDS = new Set<CoverageObject['kind']>(['query_window', 'channel_range', 'mailbox_range', 'calendar_range']);
/**
 * S8c: an INCOMPLETE run (cursor.at before window.to) covered its window only up to its cursor. Time ranges that
 * claim more are clamped to the cursor before commit, so one query's full window cannot mask another query's
 * paged-out end (stress finding C-1: the rest of the window would otherwise vanish from coverageGaps when the
 * continuation is lost). Objects keep their own ranges.
 */
export function clampToCursor(objects: CoverageObject[], cursorAtMs: number): CoverageObject[] {
  return objects.map((o) => {
    if (!TIME_RANGE_KINDS.has(o.kind)) return o;
    const from = toMs(o.from);
    const to = toMs(o.to);
    if (from == null || to == null || to <= cursorAtMs) return o;
    return { ...o, to: new Date(Math.max(from, cursorAtMs)).toISOString(), meta: { ...(o.meta ?? {}), clampedFrom: o.to } };
  });
}
export function mergeRanges(ranges: Range[], tol: number): Range[] {
  const sorted = ranges.filter((r) => r.to > r.from).sort((a, b) => a.from - b.from);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + tol) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}
/** The source-item fields the completion pass reads (shared by its evidence and candidate rows). */
export function completionFields(s: NormalizedSourceItem): Omit<CompletionEvidence, 'sourceItemId' | 'role'> {
  return {
    connector: s.connector,
    kind: s.kind,
    externalId: s.externalId,
    ...(s.threadRef ? { threadRef: s.threadRef } : {}),
    occurredAt: s.occurredAt,
    fromMe: s.author?.isMe === true,
    ...(s.author ? { author: s.author } : {}),
    ...(s.participants?.length ? { participants: s.participants } : {}),
    fileRefs: s.fileRefs ?? [],
    accountHints: s.accountHints ?? [],
    ...(s.excerpt || s.title ? { text: [s.title, s.excerpt].filter(Boolean).join('\n').slice(0, 1200) } : {}),
  };
}
export function personKeys(p: { name?: string; email?: string; externalId?: string; isMe?: boolean }): string[] {
  if (p.isMe) return [];
  return [p.externalId, p.email, p.name].filter((x): x is string => !!x).map(normPerson);
}
export function rangeOf(o: CoverageObject): Range | undefined {
  const from = toMs(o.from);
  const to = toMs(o.to);
  return from != null && to != null && to >= from ? { from, to } : undefined;
}
export const isRange = (r: Range | undefined): r is Range => !!r;
export function rangeFields(o: CoverageObject): { fromMs?: number; toMs?: number } {
  const r = rangeOf(o);
  return r ? { fromMs: r.from, toMs: r.to } : {};
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
/** Two ledger positions: as instants when both read as times, else as text (also lane E's ledger compaction). */
export function cmpPos(a: string, b: string): number {
  const ta = toMs(a);
  const tb = toMs(b);
  if (ta != null && tb != null) return ta - tb;
  return a.localeCompare(b);
}
