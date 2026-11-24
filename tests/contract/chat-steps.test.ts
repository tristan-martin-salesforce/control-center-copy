/**
 * Caps audit F-1 (26-caps-audit.md): Steps per message is a runaway guard the user sets, with no fixed ceiling. Any
 * positive whole number is valid (values stored under the old `.max(400)` stay valid), the default stays 200.
 */
import { describe, expect, it } from 'vitest';
import { ChatSettings, DEFAULT_CHAT_SETTINGS } from '@/contract';

const base = DEFAULT_CHAT_SETTINGS;

describe('ChatSettings.maxSteps', () => {
  it('defaults to 200', () => {
    expect(ChatSettings.parse({ ...base, maxSteps: undefined }).maxSteps).toBe(200);
    expect(DEFAULT_CHAT_SETTINGS.maxSteps).toBe(200);
  });

  it('takes any positive whole number, including past the old 400 ceiling', () => {
    for (const n of [1, 30, 200, 400, 401, 5_000]) expect(ChatSettings.parse({ ...base, maxSteps: n }).maxSteps).toBe(n);
  });

  it('rejects zero, negatives and fractions', () => {
    for (const n of [0, -1, 2.5]) expect(ChatSettings.safeParse({ ...base, maxSteps: n }).success).toBe(false);
  });
});
