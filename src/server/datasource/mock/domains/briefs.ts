/**
 * The mock DataSource, briefs domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import { blankItem, id, I, Res } from '../shared';
import type { MockCtx } from '../ctx';
import { type Brief, type BriefHighlight, type WorkItemRecord } from '@/contract';
import { invalid } from '@/server/errors';
import { briefsView, highlightIn, promotedAs } from '@/server/views/briefs';

export class MockBriefs {
  constructor(private readonly ctx: MockCtx) {}

  async getBriefs(_i: I<'getBriefs'>): Promise<Res<'getBriefs'>> {
    return briefsView(this.ctx.store);
  }

  /** Reading a brief marks it read (no audit). */
  async getBrief({ params }: I<'getBrief'>): Promise<Res<'getBrief'>> {
    const b = this.ctx.store.must('briefs', params.id, 'Brief');
    if (b.unread) this.ctx.tx({ actor: 'user', action: 'brief.read', summary: 'Read', entity: { type: 'brief', id: b.id, label: b.title }, audit: false }, (tx) => tx.put('briefs', { ...b, unread: false }));
    return this.promotedAs(this.ctx.store.get('briefs', b.id)!);
  }

  /** A promoted highlight's one state (src/server/views/briefs.ts). */
  promotedAs<B extends Pick<Brief, 'highlights'>>(b: B): B {
    return promotedAs(this.ctx.store, b);
  }

  private highlight(hid: string): { brief: Brief; h: BriefHighlight } {
    return highlightIn(this.ctx.store, hid);
  }

  private highlightAction(hid: string, ifVersion: number | undefined, kind: 'promote' | 'task' | 'dismiss') {
    const { brief, h } = this.highlight(hid);
    this.ctx.checkVersion(h, ifVersion, 'Highlight', h);
    if (h.status === 'promoted' || h.status === 'dismissed') throw invalid(`Highlight already ${h.status}`);
    const now = this.ctx.nowIso();
    let workItemId: string | null = null;
    const r = this.ctx.tx({ actor: 'user', action: `highlight.${kind}`, summary: `${kind === 'dismiss' ? 'Not relevant' : kind === 'task' ? 'Made task' : 'Promoted'}: ${h.title}`, entity: { type: 'brief_highlight', id: h.id, label: h.title } }, (tx) => {
      if (kind !== 'dismiss') {
        const item: WorkItemRecord = {
          ...blankItem(now, this.ctx.store.meta().user),
          id: id('w'),
          state: kind === 'task' ? 'open' : 'suggested',
          title: h.title,
          purpose: `From brief: ${brief.title}`,
          accountId: brief.accountId,
          oppId: brief.oppId,
          confidence: h.relevance === 'high' ? 'likely' : 'guess',
          why: h.reasons[0],
          whyDetail: h.reasons.join(' · '),
          sources: h.sources,
          signals: { customerFacing: !!brief.accountId || !!brief.oppId, fromManager: false, boost: 0 },
        };
        workItemId = item.id;
        tx.put('workItems', item);
      }
      const next: BriefHighlight = { ...h, version: h.version + 1, status: kind === 'dismiss' ? 'dismissed' : 'promoted', promotedWorkItemId: workItemId };
      tx.put('briefs', { ...brief, highlights: brief.highlights.map((x) => (x.id === h.id ? next : x)) });
      return next;
    });
    return { entity: this.promotedAs({ highlights: [r.result] }).highlights[0]!, auditId: r.entry?.id ?? null };
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
    return { watches: this.ctx.store.all('watches') };
  }

  async createWatch({ body }: I<'createWatch'>): Promise<Res<'createWatch'>> {
    const w = { id: id('watch'), version: 1, ...body, enabled: true, createdAt: this.ctx.nowIso(), updatedAt: this.ctx.nowIso() };
    const { entry } = this.ctx.tx({ actor: 'user', action: 'watch.create', summary: `Watching ${w.label}`, entity: { type: 'watch', id: w.id, label: w.label } }, (tx) => tx.put('watches', w));
    return { entity: w, auditId: entry?.id ?? null };
  }

  async patchWatch({ params, body }: I<'patchWatch'>): Promise<Res<'patchWatch'>> {
    const w = this.ctx.store.must('watches', params.id, 'Watch');
    this.ctx.checkVersion(w, body.ifVersion, 'Watch', w);
    const next = this.ctx.bump({ ...w, ...body.patch });
    const { entry } = this.ctx.tx({ actor: 'user', action: 'watch.edit', summary: `Edited watch ${w.label}`, entity: { type: 'watch', id: w.id, label: w.label } }, (tx) => tx.put('watches', next));
    return { entity: next, auditId: entry?.id ?? null };
  }
}
