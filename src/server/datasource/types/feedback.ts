/** Feedback (D-56, lane D): Report a bug / idea; Send is dispatchDraft (dry run applies). */
import type { In, Out } from './route';

export interface FeedbackSource {
  getFeedback(i: In<'getFeedback'>): Out<'getFeedback'>;
  diagnoseFeedback(i: In<'diagnoseFeedback'>): Out<'diagnoseFeedback'>;
  stageFeedback(i: In<'stageFeedback'>): Out<'stageFeedback'>;
}
