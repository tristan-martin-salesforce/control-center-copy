/** NBA and proposals. */
import type { In, Out } from './route';

export interface NbaSource {
  getItemNba(i: In<'getItemNba'>): Out<'getItemNba'>;
  regenerateNba(i: In<'regenerateNba'>): Out<'regenerateNba'>;
  applyProposal(i: In<'applyProposal'>): Out<'applyProposal'>;
  rejectProposal(i: In<'rejectProposal'>): Out<'rejectProposal'>;
}
