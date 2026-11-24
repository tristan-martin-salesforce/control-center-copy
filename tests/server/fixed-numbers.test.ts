/**
 * P25-11 (no arbitrary caps): the trusted-sites list has no count limit (it is the user's list; each name is checked on
 * its own), and the Work list's `limit` is a page size, not a cap: paging goes on past it.
 */
import { describe, expect, it } from 'vitest';

import { ItemsQuery, SendingSettings } from '@/contract';
import { sendingOf } from '@/outbox/settings';

const hosts = Array.from({ length: 120 }, (_, i) => `site${i}.example.com`);

describe('fixed numbers (P25-11)', () => {
  it('the trusted sites keep every valid name, past 50', () => {
    expect(sendingOf({ autopilotAssetHosts: hosts } as never).autopilotAssetHosts).toEqual(hosts);
    expect(SendingSettings.shape.autopilotAssetHosts.safeParse(hosts).success).toBe(true);
  });

  it('the Work page size is bounded per response (500), with a cursor to go on', () => {
    expect(ItemsQuery.safeParse({ tab: 'done', limit: 500, cursor: 'k:abc' }).success).toBe(true);
    expect(ItemsQuery.safeParse({ tab: 'done', limit: 501 }).success).toBe(false);
  });
});
