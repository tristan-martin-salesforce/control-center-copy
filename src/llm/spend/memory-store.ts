/**
 * The governor's in-memory store: tests, the mock DataSource, and a chat turn whose host has no persistent store.
 * Same semantics as the Postgres store (src/server/datasource/db/spend.ts): a daily hold holds its amount against the
 * day until it leaves the live states; events dedupe by fingerprint.
 */
import { randomUUID } from 'node:crypto';

import { LIVE_HOLD_STATES, type DayStatus, type Hold, type SpendEvent, type SpendScope, type SpendStore } from './types';

export interface MemorySpendStoreOptions {
  now?: () => Date;
  /** Booked spend today and the lines (settings.budgets); default $0 of $5 soft / $15 hard. */
  day?: () => { spentUsd: number; softUsd: number; hardUsd: number };
  /** Measured samples per `scope|skill` (newest first). */
  samples?: Record<string, number[]>;
  today?: () => string;
}

export class MemorySpendStore implements SpendStore {
  readonly holds = new Map<string, Hold>();
  readonly events = new Map<string, SpendEvent & { resolved: boolean; count: number }>();
  readonly raises: Array<{ addUsd: number; reason: string }> = [];
  samples: Record<string, number[]>;
  private extraHardUsd = 0;
  constructor(private readonly o: MemorySpendStoreOptions = {}) {
    this.samples = o.samples ?? {};
  }

  now(): Date {
    return this.o.now?.() ?? new Date();
  }

  async today(): Promise<string> {
    return this.o.today?.() ?? this.now().toISOString().slice(0, 10);
  }

  async costSamples(q: { scope: SpendScope; skill?: string }): Promise<number[]> {
    return [...(this.samples[`${q.scope}|${q.skill ?? ''}`] ?? this.samples[q.scope] ?? [])];
  }

  async insertHold(h: Parameters<SpendStore['insertHold']>[0]): Promise<Hold> {
    const hold: Hold = { ...h, id: randomUUID(), createdAt: this.now().toISOString(), settledAt: null, askedAt: null, answeredAt: null, answerUsd: null, callIds: [...(h.callIds ?? [])], estimate: { ...h.estimate } };
    this.holds.set(hold.id, hold);
    return { ...hold, callIds: [...hold.callIds] };
  }

  async getHold(id: string): Promise<Hold | null> {
    const h = this.holds.get(id);
    return h ? { ...h, callIds: [...h.callIds] } : null;
  }

  async updateHold(id: string, patch: Parameters<SpendStore['updateHold']>[1]): Promise<Hold | null> {
    const h = this.holds.get(id);
    if (!h) return null;
    const { addHeldUsd, ...rest } = patch;
    Object.assign(h, rest);
    if (addHeldUsd) h.heldUsd = Math.round((h.heldUsd + addHeldUsd) * 1e6) / 1e6;
    return this.getHold(id);
  }

  async listHolds(q: Parameters<SpendStore['listHolds']>[0]): Promise<Hold[]> {
    return [...this.holds.values()]
      .filter((h) => (!q.since || h.createdAt >= q.since) && (!q.states || q.states.includes(h.state)) && (!q.scope || h.scope === q.scope) && (!q.jobKey || h.jobKey === q.jobKey) && (!q.jobKeyPrefix || h.jobKey.startsWith(q.jobKeyPrefix)))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, q.limit ?? Number.POSITIVE_INFINITY)
      .map((h) => ({ ...h, callIds: [...h.callIds] }));
  }

  async dayStatus(): Promise<DayStatus> {
    const d = this.o.day?.() ?? { spentUsd: 0, softUsd: 5, hardUsd: 15 };
    const day = await this.today();
    const heldUsd = [...this.holds.values()].filter((h) => h.budget === 'daily' && h.budgetDay === day && LIVE_HOLD_STATES.has(h.state)).reduce((a, h) => a + h.heldUsd, 0);
    return { day, spentUsd: d.spentUsd, heldUsd: Math.round(heldUsd * 1e6) / 1e6, softUsd: d.softUsd, hardUsd: d.hardUsd + this.extraHardUsd };
  }

  async recordEvent(e: SpendEvent): Promise<void> {
    const cur = this.events.get(e.fingerprint);
    if (cur && !cur.resolved) cur.count += 1;
    else this.events.set(e.fingerprint, { ...e, resolved: false, count: 1 });
  }

  async resolveEvent(fingerprint: string): Promise<void> {
    const cur = this.events.get(fingerprint);
    if (cur) cur.resolved = true;
  }

  async raiseToday(addUsd: number, reason: string): Promise<void> {
    this.extraHardUsd += addUsd;
    this.raises.push({ addUsd, reason });
  }
}
