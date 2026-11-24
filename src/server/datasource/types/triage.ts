/** Triage. */
import type { In, Out } from './route';

export interface TriageSource {
  getTriage(i: In<'getTriage'>): Out<'getTriage'>;
  acceptTriage(i: In<'acceptTriage'>): Out<'acceptTriage'>;
  dismissTriage(i: In<'dismissTriage'>): Out<'dismissTriage'>;
  mergeTriage(i: In<'mergeTriage'>): Out<'mergeTriage'>;
}
