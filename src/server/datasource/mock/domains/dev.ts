/**
 * The mock DataSource, dev domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { I, Res } from '../shared';
import { invalid } from '@/server/errors';

export class MockDev {
  constructor(private readonly ctx: MockCtx) {}

  devFailRate = 0;

  async getScenario(_i: I<'getScenario'>): Promise<Res<'getScenario'>> {
    return this.ctx.ds.scenario.status();
  }

  async controlScenario({ body }: I<'controlScenario'>): Promise<Res<'controlScenario'>> {
    switch (body.action) {
      case 'play':
        return this.ctx.ds.scenario.play();
      case 'pause':
        return this.ctx.ds.scenario.pause();
      case 'reset':
        return this.ctx.ds.scenario.reset();
      case 'seek':
        if (body.seconds === undefined) throw invalid('seek needs `seconds`');
        return this.ctx.ds.scenario.seek(body.seconds);
    }
  }

  async getDevFail(_i: I<'getDevFail'>): Promise<Res<'getDevFail'>> {
    return { rate: this.devFailRate };
  }

  async setDevFail({ body }: I<'setDevFail'>): Promise<Res<'setDevFail'>> {
    this.devFailRate = body.rate;
    return { rate: this.devFailRate };
  }

  async devEngineChange({ body }: I<'devEngineChange'>): Promise<Res<'devEngineChange'>> {
    if (body.entityType === 'work_item') {
      const r = this.ctx.ds.engine.engineUpdateItem(body.id, body.patch, body.reason);
      return { applied: r.applied, proposalIds: r.proposalIds };
    }
    const d = this.ctx.store.must('drafts', body.id, 'Draft');
    const text = typeof body.patch.text === 'string' ? body.patch.text : null;
    if (!text) throw invalid('Draft engine change needs patch.text (the new body)');
    if (!d.nbaId) throw invalid('Draft has no NBA');
    const before = this.ctx.store.all('proposals').length;
    this.ctx.ds.engine.engineReviseDraft(d.nbaId, text, body.reason, { kind: 'slack', label: 'Dev engine change' });
    const created = this.ctx.store.all('proposals').slice(before).map((p) => p.id);
    return { applied: created.length ? [] : ['doc'], proposalIds: created };
  }
}
