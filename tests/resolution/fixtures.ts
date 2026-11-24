/** Hand-built resolution-check inputs (placeholder people and text only). */
import { DEFAULT_CLOSING_SETTINGS, type ClosingSettings } from '@/contract';
import type { RawSource } from '@/engines/settle/context';
import type { PolicyItem } from '@/engines/settle/policy';
import type { ResolutionItem, ResolutionRaw } from '@/engines/resolution/types';
import type { CompletionModel, CompletionModelRequest } from '@/scanner/completion/types';
import { loadResolutionSkill } from '@/scanner/resolution/skill';

/** The repo's resolution skill, as the job handler loads it (runLadder's `skill`). */
export const SKILL = loadResolutionSkill();

export const ASK_AT = '2026-11-02T16:00:00.000Z';
export const at = (min: number) => new Date(Date.parse(ASK_AT) + min * 60_000).toISOString();
export const NOW = new Date(at(24 * 60));

let n = 0;
export function line(min: number, text: string, o: Partial<RawSource> & { files?: Array<{ name?: string }> } = {}): RawSource & { files?: Array<{ name?: string }> } {
  n += 1;
  return { id: o.id ?? `si-${n}`, source: 'slack', kind: 'message', externalId: `x${n}`, parent: null, url: null, at: at(min), fromMe: false, addressedToMe: true, title: null, text, author: 'PERSON_A', channelId: 'D0DM00001', channelType: 'im', channelName: null, threadTs: null, ts: `${n}.0`, ...o };
}
export const mine = (min: number, text: string, o: Partial<RawSource> & { files?: Array<{ name?: string }> } = {}) => line(min, text, { fromMe: true, author: 'me', ...o });

export function raw(o: { title?: string; kind?: string; status?: string; id?: string; ask?: string; after?: RawSource[]; elsewhere?: RawSource[]; extra?: Partial<ResolutionRaw> } = {}): ResolutionRaw {
  const ask = line(0, o.ask ?? 'Can you send me the ACME pricing deck?', { id: `${o.id ?? 'w1'}-ask`, role: 'origin' });
  return {
    item: { id: o.id ?? 'w1', kind: o.kind ?? 'ask', status: o.status ?? 'open', title: o.title ?? 'Send PERSON_A the ACME pricing deck', purpose: null, description: null, dueAt: null, createdAt: ASK_AT, counterparty: 'PERSON_A', account: null },
    evidence: [ask],
    conversation: o.after ?? [],
    elsewhere: o.elsewhere ?? [],
    events: [],
    siblings: [],
    keywords: ['acme', 'pricing', 'deck'],
    ...o.extra,
  };
}

export function item(o: Partial<ResolutionItem> & { id?: string; status?: string; worth?: ResolutionItem['worth']; mayAutoClose?: boolean; doneAt?: string; reopenedCount?: number; lastReopenAt?: string | null } = {}): ResolutionItem {
  const id = o.id ?? 'w1';
  const status = o.status ?? 'open';
  const policy: PolicyItem = { id, kind: 'ask', status, userTouched: false, userReopened: false, userKept: false, doneByEngine: status === 'done', externalCommitment: false, people: [], channels: [], originSource: 'slack' };
  return {
    id,
    kind: 'ask',
    status,
    title: 'Send PERSON_A the ACME pricing deck',
    closure: { id, version: 1, kind: 'ask', status: status as ResolutionItem['closure']['status'], title: 'Send PERSON_A the ACME pricing deck', resolution: null, involvement: 'owner', ...(o.doneAt ? { doneAt: o.doneAt, doneBy: 'engine' as const } : {}), ...(o.mayAutoClose === false ? { mayAutoClose: false, autoCloseBlock: 'user_reopened' } : {}), reopenedCount: o.reopenedCount ?? 0, lastReopenedAt: o.lastReopenAt ?? null },
    policy,
    reopenedCount: o.reopenedCount ?? 0,
    lastReopenAt: o.lastReopenAt ?? null,
    ...(o.worth ? { worth: o.worth } : {}),
  };
}

export const settings = (o: Partial<ClosingSettings> = {}): ClosingSettings => ({ ...DEFAULT_CLOSING_SETTINGS, ...o });

/** A scripted model: answers by item alias from `verdicts(req, aliasIndex)`; records every request. */
export function scripted(answer: (req: CompletionModelRequest, i: number) => Record<string, unknown>, cost = 0.0004): { model: CompletionModel; calls: CompletionModelRequest[] } {
  const calls: CompletionModelRequest[] = [];
  const model: CompletionModel = async (req) => {
    calls.push(req);
    const items = (JSON.parse(req.user) as { items: Array<{ id: string }> }).items;
    return { ok: true, text: JSON.stringify({ verdicts: items.map((it, i) => ({ item: it.id, ...answer(req, i) })) }), costUsd: cost, inputTokens: 900, outputTokens: 40 };
  };
  return { model, calls };
}
