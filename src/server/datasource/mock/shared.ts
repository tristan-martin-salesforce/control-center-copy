/**
 * Helpers the mock DataSource's facade, context and domains share (R7).
 */
import { nanoid } from 'nanoid';
import type { RouteInput, RouteKey, RouteOutput, WorkItemRecord, WorkItemLockableField, Resolution } from '@/contract';

export interface MockDelays {
  /** Capture → enrichment chips. */
  enrichMs: number;
  /** Tool run / agent simulation steps. */
  stepMs: number;
  /** Chat text-delta cadence. */
  chatTokenMs: number;
  /** Simulated send → read-back verification. */
  verifyMs: number;
  /** Re-evaluation shimmer duration. */
  reevalMs: number;
}

export const id = (prefix: string) => `${prefix}_${nanoid(10)}`;

export const uniq = <T>(xs: T[]) => [...new Set(xs)];

export function labelOf(v: unknown): string {
  const o = v as Record<string, unknown> | null;
  if (!o) return '';
  return String(o.title ?? o.name ?? o.label ?? (o.thread as { title?: string } | undefined)?.title ?? (o.manifest as { name?: string } | undefined)?.name ?? o.id ?? '');
}

export type I<K extends RouteKey> = RouteInput<K>;

export type Res<K extends RouteKey> = RouteOutput<K>;

export function blankItem(now: string, user: { id: string; name: string }): WorkItemRecord {
  return {
    id: '',
    version: 1,
    kind: 'task',
    state: 'open',
    title: '',
    purpose: null,
    initiativeId: null,
    accountId: null,
    oppId: null,
    servesEventId: null,
    confidence: 'likely',
    why: '',
    whyDetail: null,
    sources: [],
    effort: { youMin: 15, agentMin: 0 },
    startBy: null,
    due: null,
    createdAt: now,
    updatedAt: now,
    ageDays: 0,
    isBackground: false,
    rank: null,
    rankReasons: [],
    score: null,
    priority: 'medium',
    signals: { customerFacing: false, fromManager: false, boost: 0 },
    stale: null,
    userLockedFields: [],
    newEvidenceCount: 0,
    reevaluating: false,
    seenAt: null,
    nbaId: null,
    owner: { id: user.id, name: user.name },
    people: [],
    waiting: null,
    snoozedUntil: null,
    snoozedFrom: null,
    doneAt: null,
    doneBy: null,
    closedReason: null,
    resolution: null,
    resolutionDetail: null,
    involvement: 'owner',
    loopedBackIn: null,
    likelyDone: null,
    reopened: null,
    dismissed: null,
    notes: '',
    enrichment: null,
    deliverable: null,
    training: null,
    runIds: [],
    assetIds: [],
    counterparty: null,
  };
}

export const ITEM_PATCH_LOCK: Record<string, WorkItemLockableField> = {
  title: 'title',
  purpose: 'purpose',
  due: 'due',
  startBy: 'startBy',
  effort: 'effort',
  notes: 'notes',
  initiativeId: 'initiativeId',
  accountId: 'accountId',
  oppId: 'oppId',
  kind: 'kind',
};

export function resolutionLabel(r: Resolution, personName?: string): string {
  switch (r) {
    case 'done_by_me':
      return 'Done by you';
    case 'handed_off':
      return personName ? `Handed off → ${personName}` : 'Handed off';
    case 'done_by_other':
      return personName ? `Done by ${personName}` : 'Done by someone else';
    case 'not_needed':
      return 'Not needed';
    case 'duplicate':
      return 'Duplicate';
    case 'declined':
      return 'Declined';
    case 'superseded':
      return 'Superseded';
  }
}
