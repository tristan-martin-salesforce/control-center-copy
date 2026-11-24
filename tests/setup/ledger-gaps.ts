/**
 * D0 guard (audit 2026-11-13, lane D): no test may book a model call with a missing audit field (trigger, model
 * reason, outcome, content hash) or with dollars and no tokens. 0027 (holistic review 04 §4.5): nor a call that booked
 * model requests (`turns > 0`) without the size of its first one (`first_prompt_tokens`). Both ledger writers (src/db/ledger.ts insertLlmCall and
 * the scanner store's recordSpend, DB and memory) note such a row; this hook fails the test that booked it.
 * Wired into every vitest config as a setup file.
 */
import { afterEach, expect } from 'vitest';

import { takeLedgerGaps } from '../../src/db/ledger';

afterEach(() => {
  expect(takeLedgerGaps(), 'every booked model call carries trigger, model_reason, outcome, content_hash, tokens when it costs, and first_prompt_tokens when it booked turns').toEqual([]);
});
