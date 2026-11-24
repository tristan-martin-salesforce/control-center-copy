/** `nextLocalTime` (src/lib/local-time): the worker's slot math, now in the shared layer for the brief engine. */
import { describe, expect, it } from 'vitest';

import { nextLocalTime } from '../../src/lib/local-time';

describe('nextLocalTime', () => {
  it('handles the user time zone and DST', () => {
    expect(nextLocalTime(new Date('2026-10-31T12:00:00Z'), '03:15', 'America/Denver').toISOString()).toBe('2026-11-01T10:15:00.000Z');
    expect(nextLocalTime(new Date('2026-11-01T12:00:00Z'), '03:15', 'America/Denver').toISOString()).toBe('2026-11-02T10:15:00.000Z');
  });
  it('is strictly after the given instant', () => {
    expect(nextLocalTime(new Date('2026-11-02T10:15:00Z'), '03:15', 'America/Denver').toISOString()).toBe('2026-11-03T10:15:00.000Z');
  });
});
