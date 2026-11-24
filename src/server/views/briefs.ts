/**
 * Briefs and watches, read side (R7 step 3): the briefs list, a highlight by id, a promoted highlight's state.
 */
import type { Brief, BriefHighlight, RouteOutput } from '@/contract';
import { withPromotedAs } from '@/contract';
import { notFound } from '@/server/errors';

import type { ReadSource } from './source';

/** GET /briefs: watched and opportunity briefs, newest first, with what is worth a look. */
export function briefsView(src: ReadSource): RouteOutput<'getBriefs'> {
  const summary = (b: Brief) => ({ id: b.id, kind: b.kind, title: b.title, unread: b.unread, worthALook: b.highlights.filter((h) => h.status === 'new' || h.status === 'seen').length, through: b.through, status: b.status });
  const briefs = src.all('briefs').sort((a, b) => b.through.localeCompare(a.through));
  const watched = briefs.filter((b) => b.kind !== 'opp').map(summary);
  const opportunities = briefs.filter((b) => b.kind === 'opp').map(summary);
  return { watched, opportunities, watches: src.all('watches'), counts: { unread: briefs.filter((b) => b.unread).length, worthALook: [...watched, ...opportunities].reduce((s, b) => s + b.worthALook, 0) } };
}

/** A promoted highlight's one state (in Triage, or a task), from its item. Read-time only. */
export function promotedAs<B extends Pick<Brief, 'highlights'>>(src: ReadSource, b: B): B {
  return withPromotedAs(b, (wid) => src.get('workItems', wid)?.state);
}

/** The highlight with this id and its brief (404 when no brief has it). */
export function highlightIn(src: ReadSource, hid: string): { brief: Brief; h: BriefHighlight } {
  for (const brief of src.all('briefs')) {
    const h = brief.highlights.find((x) => x.id === hid);
    if (h) return { brief, h };
  }
  throw notFound('Highlight', hid);
}
