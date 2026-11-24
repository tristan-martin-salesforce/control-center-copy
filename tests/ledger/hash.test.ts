/** ledgerHash lives in src/lib/ledger-hash; src/db/ledger re-exports it, so a contentHash means the same call either way. */
import { describe, expect, it } from 'vitest';

import { ledgerHash as dbHash } from '../../src/db/ledger';
import { ledgerHash as libHash } from '../../src/lib/ledger-hash';

describe('ledgerHash', () => {
  it('db re-exports the lib function', () => {
    expect(dbHash).toBe(libHash);
  });
  it('matches a fixed vector: sha256 of each part plus NUL, first 32 hex chars (null is empty)', () => {
    // printf 'sonnet\0\0a\0001\0true\0' | shasum -a 256
    expect(libHash('sonnet', null, 'a', 1, true)).toBe('5f663d028c22272c99b0256e2f94fef5');
  });
  it('is 32 hex chars and order-sensitive', () => {
    expect(libHash('a', 'b')).toMatch(/^[0-9a-f]{32}$/);
    expect(libHash('a', 'b')).not.toBe(libHash('b', 'a'));
  });
});
