/** Use cases to add (src/engines/use-cases; db/use-cases.ts, mock/use-cases.ts). */
import type { In, Out } from './route';

export interface UseCasesSource {
  getUseCaseCandidates(i: In<'getUseCaseCandidates'>): Out<'getUseCaseCandidates'>;
  /** Accept drafts the VDP create_use_case item and the Org62 canvas row (both applied by the user); Edit; Reject with why. */
  decideUseCaseCandidate(i: In<'decideUseCaseCandidate'>): Out<'decideUseCaseCandidate'>;
  addUseCaseCandidate(i: In<'addUseCaseCandidate'>): Out<'addUseCaseCandidate'>;
  refreshUseCaseCandidates(i: In<'refreshUseCaseCandidates'>): Out<'refreshUseCaseCandidates'>;
}
