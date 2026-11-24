'use client';
/**
 * The six onboarding steps (B-079) and the explanation pane beside each. Controlled: the page owns the values and
 * saves them. Rows, inputs and the policy weights and rules are the Settings pieces (src/components/settings/**).
 * The role step (D-55) picks the persona and level; the copy of the later steps follows it.
 */
export { StepHead, type Errors } from './steps.head';
export { PrioritiesAside, PrioritiesStep, RoleAside, RoleStep, WEIGHT_SENTENCE, YouAside, YouStep } from './steps.profile';
export { IdentityRow, SourcesAside, SourcesStep, useOnboardingSources, type ActivationProps, type IdentityProps } from './steps.sources';
export { HistoryAside, HistoryStep, ReviewAside, ReviewStep } from './steps.review';
