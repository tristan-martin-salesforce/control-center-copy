// BE-CHAT (db): the kit the db DataSource lends, plan keys and small helpers. Split from chat-be6.ts (max-lines); chat-be6.ts re-exports the public names.
import type { Logger } from 'pino';

import { logger } from '@/lib/log';
import type { ChatChange, PriorityPolicy, Receipt, Resolution, ResolutionDetail, WorkItemRecord } from '@/contract';
import type { Db } from '@/db/client';
import type { ConnectorId } from '@/scanner/types';
import { activityError, changeError } from '@/server/chat/changes';
import { CHAT_PLAN_PREFIX } from '@/server/chat/outputs';
import type { ReadModel } from './model';
import type { WriteCtx } from './store/common';
import { loadChatSkill } from '@/llm/chat/prompt';
import { runOneReadLookup } from '@/server/onboarding/identity';
import type { WorkLinkTargets } from './store/work';

/** W0-14: the API log (pino JSON), created on first use: the error's class and code, never its message. */
let ledgerLogger: Logger | null = null;
export const ledgerLog = (): Logger => (ledgerLogger ??= logger('api'));
export const planKey = (id: string) => `${CHAT_PLAN_PREFIX}${id}`;
/** Connector source → the scanner connector and the scope a chat rescan runs. */
export const SCAN_SCOPE: Record<string, { connector: ConnectorId; scope: string }> = {
  slack: { connector: 'slack', scope: 'inbox' },
  gmail: { connector: 'gmail', scope: 'inbox' },
  calendar: { connector: 'calendar', scope: 'primary' },
  drive: { connector: 'drive', scope: 'tracked' },
  gemini: { connector: 'gemini_notes', scope: 'poll' },
  claude: { connector: 'claude_sessions', scope: 'all' },
  org62: { connector: 'org62', scope: 'opps' },
  vdp: { connector: 'vdp', scope: 'plans' },
};
export const RECEIPT_FIELDS = new Set(['state', 'snoozedUntil', 'rank', 'resolution', 'title', 'purpose', 'due', 'startBy', 'effort', 'notes', 'kind', 'accountId', 'initiativeId', 'oppId', 'signals']);
interface MutMetaLite {
  action: string;
  summary: string;
  entity?: { type: string; id: string };
  actor?: 'chat';
  undoable?: boolean;
}
/** What the db DataSource lends BE-CHAT (bound private helpers). */
export interface DbChatKit {
  db: Db;
  now(): Date;
  userId(): Promise<string>;
  model(): Promise<ReadModel>;
  mutate<T>(m: MutMetaLite, fn: (w: WriteCtx, model: ReadModel) => Promise<T>): Promise<{ result: T; auditId: string; undoable: boolean }>;
  writeItem(w: WriteCtx, model: ReadModel, cur: WorkItemRecord, next: WorkItemRecord, o: { bump: boolean }): Promise<unknown>;
  rankedIds(): Promise<string[]>;
  rerankIn(w: WriteCtx, model: ReadModel, policy: PriorityPolicy, rankedIds: string[], now: Date, policyRowId?: string): Promise<unknown>;
  resolvedRecord(model: ReadModel, cur: WorkItemRecord, o: { reason: string; resolution: Resolution; detail: Partial<Omit<ResolutionDetail, 'inferred'>>; doneBy: 'user' | 'chat'; at: string }): WorkItemRecord;
  blankItem(now: string, me: { id: string; name: string }): WorkItemRecord;
  links(model: ReadModel): WorkLinkTargets;
  /** The ranker's #1 under `policy` (ids + scores, read from the in-memory model). */
  rankTop(model: ReadModel, policy: PriorityPolicy, now: Date): { id: string; score: number } | undefined;
  scoreOf(model: ReadModel, w: WorkItemRecord, policy: PriorityPolicy, now: Date): number;
  receipt(auditId: string, summary: string, filter: (table: string, field: string) => boolean): Promise<Receipt>;
  publish(tables: string[], ids: string[], reason: string): void;
  /** The one read-only Org62 / Slack call (default runOneReadLookup; tests inject a fake). */
  readLookup?: typeof runOneReadLookup;
  /** Live Org62 lookups outside a chat turn (the Time picker): the Assistant's gate, or a test's fake reader. */
  org62Live?: boolean;
}
/** Why a staged edit can't land now (closed since, a row logged since): null when it still fits. */
export function editConflict(c: ChatChange, model: ReadModel, now: Date): string | null {
  const cur = 'itemId' in c ? (model.get('workItems', c.itemId) ?? null) : null;
  const err = changeError(c, cur, now);
  if (err) return err;
  if (c.op === 'edit_activities')
    for (const id of c.entryIds) {
      const e = activityError(id, model.get('activity', id), c.patch.oppId ? !!model.get('opps', c.patch.oppId) : null, c.patch, [...model.extra.vocab.taskTypeByName.keys()]);
      if (e) return e;
    }
  return null;
}
/** A failed edit's line on the receipt: the item or rows it was for. */
export function changeLabel(c: ChatChange, model: ReadModel): string {
  if ('itemId' in c) return `${c.op} · ${model.get('workItems', c.itemId)?.title ?? c.itemId}`;
  if (c.op === 'edit_activities') return `Time rows · ${c.entryIds.length} row${c.entryIds.length === 1 ? '' : 's'}`;
  return c.op.replace(/_/g, ' ');
}
/** YYYY-MM-DD of `d` in `tz` (the budget day). */
export function localDay(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
/** The chat skill's `<skill>@<version>` (llm_calls.prompt_version for a turn recorded without one). */
export function chatSkillTag(): string {
  try {
    return loadChatSkill().versionTag;
  } catch {
    return 'chat-assistant';
  }
}
