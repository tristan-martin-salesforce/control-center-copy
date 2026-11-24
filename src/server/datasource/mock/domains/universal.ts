/**
 * The mock DataSource, universal domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { I, Res } from '../shared';
import type { LiveEvent } from '@/contract';
import { invalid, notFound } from '@/server/errors';
import { planUndo } from '../store';
import { buildSince } from '../views';
import { peopleView, searchView } from '@/server/views/universal';

export class MockUniversal {
  constructor(private readonly ctx: MockCtx) {}

  async undoAudit({ params }: I<'undoAudit'>): Promise<Res<'undoAudit'>> {
    const target = this.ctx.audit.get(params.id);
    if (!target) throw notFound('Audit entry', params.id);
    if (!target.undoable) throw invalid('This change cannot be undone');
    if (target.undoneAt) throw invalid('Already undone');
    const ops = this.ctx.audit.inverseOf(target.id);
    if (!ops) throw invalid('No inverse recorded for this change');
    const at = this.ctx.nowIso();
    const plan = planUndo(this.ctx.store, ops, at);
    const r = this.ctx.tx({ actor: 'user', action: 'undo', summary: `Undo: ${target.summary}`, entity: target.entity, related: target.related, undoOf: target.id }, (tx) => {
      for (const p of plan) {
        if (p.next === null) tx.remove(p.col, p.id);
        else tx.put(p.col, p.next as never);
      }
    });
    this.ctx.audit.markUndone(target.id, at);
    const entry = r.entry ?? this.ctx.audit.record({ at, actor: 'user', action: 'undo', summary: `Undo: ${target.summary}`, entity: target.entity, ops: [], undoable: false, undoOf: target.id });
    return { entity: entry, auditId: entry.id, receipt: this.ctx.receiptFrom(entry, r.ops, 'user', `Undid: ${target.summary}`) };
  }

  async search({ query }: I<'search'>): Promise<Res<'search'>> {
    if (!query.q.trim()) return { q: query.q, hits: [], total: 0 };
    return searchView(this.ctx.store, query);
  }

  async getPeople({ query }: I<'getPeople'>): Promise<Res<'getPeople'>> {
    return peopleView(this.ctx.store, query, query.account ?? null);
  }

  async getSince({ query }: I<'getSince'>): Promise<Res<'getSince'>> {
    return buildSince(this.ctx.store, this.ctx.audit.entries, query.ts ?? this.ctx.store.meta().lastActiveAt, this.ctx.now());
  }

  // ---- Read-ins (BE-READIN; mock/readin.ts: deterministic, never calls out) ----
  async getReadIn({ params }: I<'getReadIn'>): Promise<Res<'getReadIn'>> {
    return this.ctx.ds.readins!.get(params);
  }
  async requestReadIn({ params, body }: I<'requestReadIn'>): Promise<Res<'requestReadIn'>> {
    return this.ctx.ds.readins!.request(params, body.force);
  }

  events({ signal }: { signal: AbortSignal }): AsyncIterable<LiveEvent> {
    return this.ctx.bus.iterate(signal);
  }
}
