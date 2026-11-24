/**
 * Outbox delivery path (BE-OUTBOX): adapters, the guarded gateway, the delivery engine, the confirm proof,
 * the `outbox.dispatch` job handler and the Settings → Sending helpers.
 *
 * Deliberately NOT re-exported: `./mcp-config` (the write allowlist and server declarations). Only files in
 * `src/outbox/**` may import it; tests/beoutbox/guard.test.ts enforces that.
 */
export * from './types';
export { payloadHash, canonicalJson, shortHash } from './hash';
export { channelOf, defaultModeFor, mergeSendingPatch, sendingConfirmNeeded, sendingOf } from './settings';
export { assertSpentOn, confirmDelivery, confirmFromApproval, isConfirmation, isConsumed, NotConfirmedError, type DeliveryConfirmation } from './confirm';
export { OutboxGateway, type OutboxTransport, type TransportCallOptions, type WriteRequest } from './gateway';
export { OutboxDelivery, outcomeUnknown, type DeliverOptions, type DeliveryDeps, type PrepareInput } from './delivery';
export { classifyDeliveryError, ToolCallError } from './errors';
export { feedbackRelay, releaseRelay, liveOutboxTransport, OutboxLiveDisabledError, SimulatedOutboxTransport, type FeedbackRelayOptions } from './transport';
export { attemptDetail, attemptOf, attemptOutcome, draftStatusOf, isOutcomeUnknown, resultUrlOf, verificationOf } from './view';
export { OUTBOX_QUEUE, outboxDispatchHandler, outboxJobDef, parseJobPayload, runOutboxJob, type OutboxJobPayload, type OutboxJobPort, type OutboxJobState } from './job';
export { adapterFor, mrkdwnToMarkdown, type OutboxAdapter } from './adapters';
export { AUTOPILOT_VDP_OPS, autopilotAllows, autopilotRefusal, VDP_AUTOPILOT_POLICY, type AutopilotVdpOp } from './autopilot';
export { existingReleaseItem, handedOff, releaseInputFor, stageRelease, type ReleaseDistribution, type ReleaseStageHost } from './release';
export { isReleaseHandoff, isReleaseItem, releaseLanding, releaseRowFacts, releaseVersionOf } from './adapters/release-handoff';
