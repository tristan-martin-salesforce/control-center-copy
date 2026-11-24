/** The Needs-you queue (01 R1, D-86): providers per kind, compose, the one count and the decide plan. Pure. */
export * from './types';
export { composeNeeds, dedupeNeeds, orderNeeds, emptyByKind, type ComposeOptions } from './compose';
export { NEED_PROVIDERS } from './registry';
export { needsCount, needsCountOf, needsPhrase } from './count';
export { planNeedDecision, type NeedPlan, type NeedPlanResult } from './decide';
export { KIND_URGENCY, groupKeyOf, nextWorkingMorning, workItemUrgency } from './urgency';
export { needsFix } from './providers/time';
