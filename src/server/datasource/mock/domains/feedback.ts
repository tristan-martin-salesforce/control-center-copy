/**
 * The mock DataSource, feedback domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { id, I, Res } from '../shared';
import { renderAll } from '../render';
import { actionDraftFor } from '@/server/vdp/coverage';
import { diagnoseFeedback, feedbackState, stageFeedback, type FeedbackHost } from '@/server/feedback';
import { scrubTermsFrom } from '@/server/feedback/scrub';

export class MockFeedback {
  constructor(private readonly ctx: MockCtx) {}

  private feedbackHost(): FeedbackHost {
    return {
      ds: this.ctx.ds,
      now: () => this.ctx.now(),
      terms: async () => {
        // The user is a person row on Postgres; here only meta knows them (same term list, same numbering).
        const me = this.ctx.store.meta().user;
        const people = this.ctx.store.all('people');
        const all = people.some((p) => p.id === me.id || p.name === me.name) ? people : [...people, { id: me.id, name: me.name, email: me.email }];
        return scrubTermsFrom({ accounts: this.ctx.store.all('accounts'), people: all, opps: this.ctx.store.all('opps') });
      },
      me: async () => this.ctx.store.meta().user.name,
      insertAction: async (dest, audit) => {
        const draft = actionDraftFor(dest, { id: id('d'), now: this.ctx.nowIso(), workItemId: null, rendered: (doc) => renderAll(dest, doc) });
        const { entry } = this.ctx.tx({ actor: 'user', action: audit.action, summary: audit.summary, entity: { type: 'draft', id: draft.id, label: dest.target.label }, undoable: false }, (tx) => tx.put('drafts', draft));
        return { draft, auditId: entry?.id ?? null };
      },
      budget: async () => ({ capUsd: 0, note: null }),
      recordSpend: async () => undefined,
      agent: null,
    };
  }

  async getFeedback(_i: I<'getFeedback'>): Promise<Res<'getFeedback'>> {
    return feedbackState(this.feedbackHost());
  }

  async diagnoseFeedback({ body }: I<'diagnoseFeedback'>): Promise<Res<'diagnoseFeedback'>> {
    return diagnoseFeedback(this.feedbackHost(), body);
  }

  async stageFeedback({ body }: I<'stageFeedback'>): Promise<Res<'stageFeedback'>> {
    return stageFeedback(this.feedbackHost(), body);
  }
}
