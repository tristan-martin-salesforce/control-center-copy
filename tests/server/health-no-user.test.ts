/** ON-24: GET /health answers before any user exists (a fresh install), as GET /version does (ON-17). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HealthPayload } from '@/contract';
import { isNoUserError, noUserHealth, noUserMessage } from '@/server/health-no-user';

describe('ON-24: /health with no user', () => {
  it('the no-user payload is in the declared shape, says no_user and carries the worker beat', () => {
    const now = Date.parse('2026-11-21T12:00:00Z');
    const h = noUserHealth(new Date(now - 5000), now);
    expect(HealthPayload.parse(h)).toMatchObject({ reason: 'no_user', connectors: [], worker: { alive: true, queueDepth: 0 } });
    expect(noUserHealth(null, now).worker).toMatchObject({ alive: false, lastHeartbeatAt: null });
    expect(noUserHealth(new Date(now - 300_000), now).worker.alive).toBe(false);
  });

  it('the message points at /onboarding on the web port, not db:bootstrap', () => {
    expect(noUserMessage('4439')).toContain('http://localhost:4439/onboarding');
    expect(noUserMessage(undefined)).toContain('http://localhost:4327/onboarding');
    expect(noUserMessage('4439')).not.toContain('db:bootstrap');
    expect(isNoUserError(new Error(noUserMessage('4439')))).toBe(true);
    expect(isNoUserError(new Error('CC_DATA=db: several users; set CC_USER_ID'))).toBe(false);
    expect(isNoUserError('no user')).toBe(false);
  });

  it('DbHealth.getHealth checks for a user before loading the model; ctx.ts throws noUserMessage', () => {
    const root = join(__dirname, '..', '..');
    const health = readFileSync(join(root, 'src/server/datasource/db/domains/health.ts'), 'utf8');
    const body = health.slice(health.indexOf('async getHealth('), health.indexOf('private async healthPage('));
    expect(body.indexOf('isNoUserError')).toBeGreaterThan(-1);
    expect(body.indexOf('noUserHealth')).toBeLessThan(body.indexOf('this.ctx.read(HEALTH'));
    expect(readFileSync(join(root, 'src/server/datasource/db/ctx.ts'), 'utf8')).toContain('noUserMessage()');
  });
});
