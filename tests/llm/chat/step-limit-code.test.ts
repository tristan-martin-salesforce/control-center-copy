/**
 * P34-5: the step-stop's catalog code is spelled twice, in the client (which must not import src/llm) and in the chat
 * router. This test is the one place that imports both, so a rename on one side fails here, not in a user's thread
 * (the client would stop offering "continue" on a step-stop).
 */
import { describe, expect, it } from 'vitest';

import { STEP_LIMIT_CODE as CLIENT_STEP_LIMIT_CODE } from '@/client/chat/turn';
import { CATALOG } from '@/errors/catalog';
import { STEP_LIMIT_CODE as ROUTER_STEP_LIMIT_CODE } from '@/llm/chat/router';

describe('the step-limit code (P34-5)', () => {
  it('is the same in the client and the router, and is a catalog entry', () => {
    expect(CLIENT_STEP_LIMIT_CODE).toBe(ROUTER_STEP_LIMIT_CODE);
    expect(CATALOG[ROUTER_STEP_LIMIT_CODE]?.code).toBe(ROUTER_STEP_LIMIT_CODE);
  });
});
