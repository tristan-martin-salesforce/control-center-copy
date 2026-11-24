/** Universal: undo, search, since-you-left, people, read-ins (BE-READIN), live events. */
import type { In, Out, Stream, WithSignal } from './route';

export interface UniversalSource {
  undoAudit(i: In<'undoAudit'>): Out<'undoAudit'>;
  search(i: In<'search'>): Out<'search'>;
  getSince(i: In<'getSince'>): Out<'getSince'>;
  /** People search for @-mentions and recipient pickers (q over name, email, Slack id, role, title, account). */
  getPeople(i: In<'getPeople'>): Out<'getPeople'>;
  getReadIn(i: In<'getReadIn'>): Out<'getReadIn'>;
  requestReadIn(i: In<'requestReadIn'>): Out<'requestReadIn'>;
  events(i: WithSignal<In<'events'>>): Stream<'events'>;
}
