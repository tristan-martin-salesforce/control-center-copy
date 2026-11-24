/**
 * The db DataSource, feedback domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, I, Res } from '../shared';
import { renderAll } from '../../mock/render';
import { chatLlmEnabled } from '@/server/chat/backend';
import { insertDraft } from '../store/nba';
import { actionDraftFor } from '@/server/vdp/coverage';
import { diagnoseFeedback, feedbackState, SdkFeedbackAgent, stageFeedback, type FeedbackHost } from '@/server/feedback';
import { feedbackBudget, recordFeedbackSpend } from '@/server/feedback/budget-db';
import { loadScrubTerms } from '@/server/feedback/terms';
import { dbSpendGovernor } from '@/server/datasource/db/spend';

export class DbFeedback {
  constructor(private readonly ctx: DbCtx) {}

  private feedbackAgent: SdkFeedbackAgent | null | undefined;

  private feedbackHost(): FeedbackHost {
    this.feedbackAgent ??= chatLlmEnabled() ? new SdkFeedbackAgent() : null;
    return {
      ds: this.ctx.ds,
      now: () => this.ctx.now(),
      terms: async () => loadScrubTerms(this.ctx.db, await this.ctx.userId()),
      me: async () => (await this.ctx.model(WHOLE)).ctx.me.name,
      insertAction: async (dest, audit) => {
        const draft = actionDraftFor(dest, { id: crypto.randomUUID(), now: this.ctx.now().toISOString(), workItemId: null, rendered: (doc) => renderAll(dest, doc) });
        const r = await this.ctx.mutate({ action: audit.action, summary: audit.summary, entity: { type: 'draft', id: draft.id }, undoable: false }, async (w) => {
          await insertDraft(w, draft);
        });
        this.ctx.bus.publishTables(['drafts'], [draft.id], audit.action);
        return { draft: (await this.ctx.model(WHOLE)).get('drafts', draft.id) ?? draft, auditId: r.auditId };
      },
      budget: async () => feedbackBudget(this.ctx.db, await this.ctx.userId(), (await this.ctx.model(WHOLE)).settings(), this.ctx.now()),
      recordSpend: async (sp) => recordFeedbackSpend(this.ctx.db, await this.ctx.userId(), (await this.ctx.model(WHOLE)).settings().profile.timezone, this.ctx.now(), sp),
      agent: this.feedbackAgent,
      // F-4: the diagnose run holds its estimate on the governor and asks past it
      spend: async () => (this.feedbackAgent ? dbSpendGovernor({ db: this.ctx.db, userId: await this.ctx.userId(), clock: () => this.ctx.now() }) : null),
      // PKG-8: a seeded (demo) database's report carries no machine log tail or doctor run
      live: async () => !((await this.ctx.model(WHOLE)).meta() as { seedHash?: string }).seedHash,
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
