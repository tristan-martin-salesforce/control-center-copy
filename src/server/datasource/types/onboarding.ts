/** Onboarding (B-079): first-launch setup. Mock: reachable, never required. Db: required with no user or an unfinished one; completing runs bootstrapUser(). The Sources step only reads status, never starts auth. */
import type { In, Out } from './route';

export interface OnboardingSource {
  getOnboarding(i: In<'getOnboarding'>): Out<'getOnboarding'>;
  saveOnboardingStep(i: In<'saveOnboardingStep'>): Out<'saveOnboardingStep'>;
  getOnboardingSources(i: In<'getOnboardingSources'>): Out<'getOnboardingSources'>;
  completeOnboarding(i: In<'completeOnboarding'>): Out<'completeOnboarding'>;
}
