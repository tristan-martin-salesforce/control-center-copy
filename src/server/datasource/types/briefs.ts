/** Briefs and watches. */
import type { In, Out } from './route';

export interface BriefsSource {
  getBriefs(i: In<'getBriefs'>): Out<'getBriefs'>;
  getBrief(i: In<'getBrief'>): Out<'getBrief'>;
  promoteHighlight(i: In<'promoteHighlight'>): Out<'promoteHighlight'>;
  taskFromHighlight(i: In<'taskFromHighlight'>): Out<'taskFromHighlight'>;
  dismissHighlight(i: In<'dismissHighlight'>): Out<'dismissHighlight'>;
  listWatches(i: In<'listWatches'>): Out<'listWatches'>;
  createWatch(i: In<'createWatch'>): Out<'createWatch'>;
  patchWatch(i: In<'patchWatch'>): Out<'patchWatch'>;
}
