/**
 * The db DataSource, briefs domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import { promotedAs, blankItem, WHOLE, I, Res } from '../shared';
import { BRIEFS } from '../reads/scope';
import type { DbCtx } from '../ctx';
import { eq, sql } from 'drizzle-orm';
import type { Brief, BriefHighlight, WorkItemRecord } from '@/contract';
import type { Tx } from '@/db/client';
import { changeSets } from '@/db/schema';
import { invalid, notFound } from '@/server/errors';
import type { ReadModel } from '../model';
import { markBriefSeen, insertWatch, updateHighlight, updateWatch } from '../store/briefs';
import { insertWorkItem } from '../store/work';
import { briefsView, highlightIn } from '@/server/views/briefs';

export class DbBriefs {
  constructor(private readonly ctx: DbCtx) {}

  async getBriefs(_i: I<'getBriefs'>): Promise<Res<'getBriefs'>> {
    return this.ctx.read(BRIEFS, (m) => briefsView(m));
  }

  /** Reading a brief marks it read (a non-undoable marker). */
  async getBrief({ params }: I<'getBrief'>): Promise<Res<'getBrief'>> {
    const m = await this.ctx.model(WHOLE);
    const b = m.get('briefs', params.id);
    if (!b) throw notFound('Brief', params.id);
    if (b.unread) {
      await this.ctx.mutate({ action: 'brief.read', summary: 'Read', entity: { type: 'brief', id: b.id }, undoable: false }, async (w) => markBriefSeen(w, b.id));
      this.ctx.bus.publishTables(['briefs'], [b.id], 'brief.read');
      return promotedAs(m, { ...b, unread: false });
    }
    return promotedAs(m, b);
  }

  private highlight(m: ReadModel, hid: string): { brief: Brief; h: BriefHighlight } {
    return highlightIn(m, hid);
  }

  private async highlightAction(hid: string, ifVersion: number | undefined, kind: 'promote' | 'task' | 'dismiss') {
    const r = await this.ctx.mutate({ action: `highlight.${kind}`, summary: kind, entity: { type: 'brief_highlight', id: hid }, current: async () => this.highlight(await this.ctx.model(WHOLE), hid).h }, async (w, model) => {
      const { brief, h } = this.highlight(model, hid);
      this.ctx.checkVersion(h, ifVersion, 'Highlight', h);
      if (h.status === 'promoted' || h.status === 'dismissed') throw invalid(`Highlight already ${h.status}`);
      await w.tx.update(changeSets).set({ summary: `${kind === 'dismiss' ? 'Not relevant' : kind === 'task' ? 'Made task' : 'Promoted'}: ${h.title}` }).where(eq(changeSets.id, w.cs.id));
      let workItemId: string | null = null;
      if (kind !== 'dismiss') {
        const now = w.now.toISOString();
        const item: WorkItemRecord = {
          ...blankItem(now, model.ctx.me),
          id: crypto.randomUUID(),
          state: kind === 'task' ? 'open' : 'suggested',
          title: h.title,
          purpose: `From brief: ${brief.title}`,
          accountId: brief.accountId,
          oppId: brief.oppId,
          confidence: h.relevance === 'high' ? 'likely' : 'guess',
          why: h.reasons[0]!,
          whyDetail: h.reasons.join(' · '),
          sources: h.sources,
          signals: { customerFacing: !!brief.accountId || !!brief.oppId, fromManager: false, boost: 0 },
        };
        workItemId = item.id;
        await insertWorkItem(w, item, this.ctx.links(model), { locks: [] });
      }
      await updateHighlight(w, h, { ...h, status: kind === 'dismiss' ? 'dismissed' : 'promoted', promotedWorkItemId: workItemId }, ifVersion);
    });
    const m = await this.ctx.model(WHOLE);
    return { entity: promotedAs(m, { highlights: [this.highlight(m, hid).h] }).highlights[0]!, auditId: r.auditId };
  }

  async promoteHighlight({ params, body }: I<'promoteHighlight'>): Promise<Res<'promoteHighlight'>> {
    return this.highlightAction(params.id, body.ifVersion, 'promote');
  }
  async taskFromHighlight({ params, body }: I<'taskFromHighlight'>): Promise<Res<'taskFromHighlight'>> {
    return this.highlightAction(params.id, body.ifVersion, 'task');
  }
  async dismissHighlight({ params, body }: I<'dismissHighlight'>): Promise<Res<'dismissHighlight'>> {
    return this.highlightAction(params.id, body.ifVersion, 'dismiss');
  }

  async listWatches(_i: I<'listWatches'>): Promise<Res<'listWatches'>> {
    return { watches: (await this.ctx.model(WHOLE)).all('watches') };
  }

  private existsFn(tx: Tx) {
    return async (kind: 'opportunity' | 'account' | 'person', rid: string) => {
      const t = kind === 'opportunity' ? 'opportunities' : kind === 'account' ? 'accounts' : 'people';
      const r = await tx.execute(sql`select 1 from ${sql.identifier(t)} where id = ${rid}::uuid`);
      return r.rows.length > 0;
    };
  }

  async createWatch({ body }: I<'createWatch'>): Promise<Res<'createWatch'>> {
    const wid = crypto.randomUUID();
    const r = await this.ctx.mutate({ action: 'watch.create', summary: `Watching ${body.label}`, entity: { type: 'watch', id: wid } }, async (w) => {
      await insertWatch(w, { id: wid, version: 1, ...body, enabled: true, createdAt: w.now.toISOString(), updatedAt: w.now.toISOString() }, this.existsFn(w.tx));
    });
    return { entity: (await this.ctx.model(WHOLE)).get('watches', wid)!, auditId: r.auditId };
  }

  async patchWatch({ params, body }: I<'patchWatch'>): Promise<Res<'patchWatch'>> {
    const r = await this.ctx.mutate({ action: 'watch.edit', summary: 'Edited watch', entity: { type: 'watch', id: params.id }, current: async () => (await this.ctx.model(WHOLE)).get('watches', params.id) ?? null }, async (w, model) => {
      const cur = model.get('watches', params.id);
      if (!cur) throw notFound('Watch', params.id);
      this.ctx.checkVersion(cur, body.ifVersion, 'Watch', cur);
      await w.tx.update(changeSets).set({ summary: `Edited watch ${cur.label}` }).where(eq(changeSets.id, w.cs.id));
      await updateWatch(w, cur, { ...cur, ...body.patch }, body.ifVersion, this.existsFn(w.tx));
    });
    return { entity: (await this.ctx.model(WHOLE)).get('watches', params.id)!, auditId: r.auditId };
  }
}
