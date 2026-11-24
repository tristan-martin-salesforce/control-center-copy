/** The providers, one per kind (`tests/needs/registry.test.ts` pins that every NeedKind has exactly one). */
import { dcSuggestionProvider } from './providers/dc';
import { outboxDraftProvider } from './providers/outbox';
import { reopenReviewProvider } from './providers/reopen';
import { setupStepProvider } from './providers/setup';
import { spendAskProvider } from './providers/spend';
import { timeReadyProvider } from './providers/time';
import { mappingQuestionProvider, resolutionConfirmProvider, triageGuessProvider } from './providers/triage';
import { useCaseCandidateProvider } from './providers/use-cases';
import { vdpChangeProvider } from './providers/vdp';
import type { NeedProvider } from './types';

export const NEED_PROVIDERS: readonly NeedProvider[] = [
  spendAskProvider,
  setupStepProvider,
  outboxDraftProvider,
  reopenReviewProvider,
  triageGuessProvider,
  mappingQuestionProvider,
  resolutionConfirmProvider,
  timeReadyProvider,
  dcSuggestionProvider,
  vdpChangeProvider,
  useCaseCandidateProvider,
];
