/**
 * Static safety: the Assistant can never reach a send, an Apply, credentials, the dry-run switch or a launch
 * (2026-11-20 review, 10 R10c; D-58, *tenet: Nothing leaves without approval*). A table over every route in
 * `src/contract/routes.ts`: a route whose key or path names one of those verbs is classified `assistant: 'deny'`,
 * unless it is in STAGE_ONLY below, each with why it only prepares something for the user's own Apply.
 * The behavioural side (a denied route is refused, hidden ones are absent) lives in tests/chat/app-routes.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { ROUTE_KEYS, routes, type RouteDef, type RouteKey } from '../../src/contract/routes';

/** Key or path says: send, dispatch, apply, credentials / cookies / reauth, dry run, launch, push to an external system. */
export const DANGEROUS = /send|dispatch|apply|credential|cookie|reauth|dry-?run|launch|push/i;

/** Routes that match DANGEROUS but only prepare work for the user's own Apply: allowed to be `stage`, each with why. */
const STAGE_ONLY: Partial<Record<RouteKey, string>> = {};
// (stageLogBatch and stageForecast prepare Outbox items for the user's own Apply; they are `stage` and do not match the pattern)

/** The routes that must be denied, named outright (the table above is a pattern; this is the floor). */
const MUST_DENY: RouteKey[] = ['dispatchDraft', 'previewDraft', 'applyProposal', 'applyPolicy', 'pushVdpChanges', 'reauthConnector', 'scanConnector', 'launchAgent', 'startToolRun', 'syncCanvas', 'raiseBudgetToday', 'diagnoseFeedback', 'stageFeedback', 'chat', 'events', 'controlScenario', 'setDevFail', 'devEngineChange'];

const def = (k: RouteKey) => routes[k] as RouteDef;
const matching = ROUTE_KEYS.filter((k) => DANGEROUS.test(k) || DANGEROUS.test(def(k).path));

describe('the Assistant is denied every send, Apply, credential, dry-run and launch route', () => {
  it('the pattern finds the routes it should (the table is not silently empty)', () => {
    expect(matching.length).toBeGreaterThanOrEqual(6);
    for (const k of ['dispatchDraft', 'applyProposal', 'applyPolicy', 'launchAgent', 'pushVdpChanges', 'reauthConnector'] as RouteKey[]) expect(matching, k).toContain(k);
  });

  it.each(matching.map((k) => [k, def(k).method, def(k).path] as const))('%s (%s %s) is deny, or a documented stage-only route', (k) => {
    if (k in STAGE_ONLY) expect(def(k).assistant, `${k}: ${STAGE_ONLY[k]}`).toBe('stage');
    else expect(def(k).assistant, `classify ${k} as assistant: 'deny' in src/contract/routes.ts (or add it to STAGE_ONLY with why)`).toBe('deny');
  });

  it('STAGE_ONLY has no stale entries', () => {
    for (const k of Object.keys(STAGE_ONLY) as RouteKey[]) expect(matching, `${k} no longer matches the pattern`).toContain(k);
  });

  it.each(MUST_DENY)('%s is deny', (k) => {
    expect(routes[k] ? def(k).assistant : 'deny').toBe('deny');
  });

  it('every route that sends, creates a canvas or writes to an external system by dispatch is deny (all POSTs that name a dispatch)', () => {
    const dispatchLike = ROUTE_KEYS.filter((k) => /dispatch|\/send\b|\/apply\b|\/push\b|\/launch\b/.test(def(k).path));
    expect(dispatchLike.length).toBeGreaterThan(0);
    expect(dispatchLike.filter((k) => def(k).assistant !== 'deny')).toEqual([]);
  });
});
