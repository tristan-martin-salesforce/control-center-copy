/** Small hand-made payloads for the Needs-you providers (fakes: only the fields the providers read). */
import type { NeedsContext } from '@/engines/needs/types';
import type { PersonaFeature } from '@/contract';

export const NOW = Date.parse('2026-11-18T17:00:00.000Z'); // a Wednesday, 09:00 in Los Angeles
export const ALL_FEATURES: PersonaFeature[] = ['vdp', 'activityLogging', 'dealContributions', 'missedOpps', 'specialistForecast', 'solutionsJudgement'];

export function ctxOf(over: Partial<NeedsContext> = {}): NeedsContext {
  return { nowMs: NOW, timeZone: 'America/Los_Angeles', utcOffsetMinutes: -480, features: new Set(ALL_FEATURES), ...over };
}

export function workItem(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    version: 3,
    kind: 'ask',
    state: 'open',
    title: `Item ${id}`,
    why: 'Dana asked',
    confidence: 'likely',
    sources: [{ kind: 'slack', label: '#acme-ext', url: 'https://slack.example/x' }],
    effort: { youMin: 15, agentMin: 0 },
    startBy: null,
    due: null,
    createdAt: '2026-11-17T10:00:00.000Z',
    seenAt: null,
    waiting: null,
    reopened: null,
    counterparty: { id: 'p1', name: 'Dana' },
    refs: { initiative: null, account: { type: 'account', id: 'a1', label: 'ACME' }, opp: null, meeting: null },
    ...over,
  };
}

export function triageItem(id: string, group: string, over: Record<string, unknown> = {}) {
  return { id, group, kind: 'work_item', title: `Guess ${id}`, why: 'Possible promise', confidence: 'guess', sources: [], createdAt: '2026-11-16T10:00:00.000Z', workItem: workItem(id), missedOpp: null, mapping: null, ...over };
}

export function triage(items: ReturnType<typeof triageItem>[]): NeedsContext['triage'] {
  const groups = [...new Set(items.map((i) => i.group))].map((g) => ({ group: g, label: g, items: items.filter((i) => i.group === g) }));
  return { groups, count: items.length } as unknown as NeedsContext['triage'];
}

export function draft(id: string, group: 'pending_approval' | 'failed' | 'sent' | 'scheduled', over: Record<string, unknown> = {}) {
  return {
    group,
    draft: { id, version: 2, workItemId: null, destination: { kind: 'slack', target: 'thread', channelId: 'C1', channelName: '#acme-ext' }, createdAt: '2026-11-18T08:00:00.000Z', ...over },
    workItem: null,
    previewText: 'Hi Dana,\nthe deck',
    history: [],
    source: null,
  };
}

export function outbox(items: ReturnType<typeof draft>[], admin: unknown[] = []): NeedsContext['outbox'] {
  const groups = ['pending_approval', 'scheduled', 'sent', 'failed'].map((g) => ({ group: g, label: g, items: items.filter((i) => i.group === g) }));
  return { groups, counts: {}, dryRun: true, admin: { items: admin, pending: admin.length, failed: 0, applied: [] } } as unknown as NeedsContext['outbox'];
}

export function entry(id: string, over: Record<string, unknown> = {}) {
  return { id, status: 'approved', oppId: 'o1', taskType: 'Demo', internal: false, durationH: 1, date: '2026-11-17', end: '2026-11-17T18:00:00.000Z', canvasDraftId: undefined, ...over };
}
