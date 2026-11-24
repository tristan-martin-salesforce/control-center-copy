/**
 * `npm run setup` (B-079): infra only, then the browser onboarding; `--headless` keeps the profile and bootstrap for
 * scripted installs, now with the persona. Pure helpers only: nothing here runs setup, opens a browser or a server.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { appUp, onboardingUrl, validateProfile } from '../../scripts/ops/setup.mjs';
import { profileFromSetupFile } from '../../src/server/datasource/db/bootstrap';

describe('setup', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  it('opens /onboarding on the env file’s port (it wins over the shell’s, as the services run: P34-1), else the shell’s, else 4327', () => {
    const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
    expect(onboardingUrl({}, env({}))).toBe('http://localhost:4327/onboarding');
    expect(onboardingUrl({ PORT: '4347' }, env({}))).toBe('http://localhost:4347/onboarding');
    expect(onboardingUrl({ PORT: '4347' }, env({ PORT: '4350' }))).toBe('http://localhost:4347/onboarding');
    expect(onboardingUrl({}, env({ PORT: '4350' }))).toBe('http://localhost:4350/onboarding');
  });

  it('knows whether the app answers (its onboarding route), and never throws', async () => {
    server = createServer((req, res) => {
      res.statusCode = req.url === '/api/v1/onboarding' ? 200 : 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    expect(await appUp(`http://127.0.0.1:${port}/onboarding`)).toBe(true);
    expect(await appUp('http://127.0.0.1:1/onboarding', 500)).toBe(false);
  });

  it('--headless: the persona is checked and reaches the bootstrap through profile.json', () => {
    const ok = { name: 'Ada', role_pack: 'se_ic', working_hours: { start: '09:00', end: '18:00' } };
    expect(validateProfile({ ...ok, persona: 'ae' })).toEqual([]);
    expect(validateProfile({ ...ok, persona: 'ceo' })).toEqual(['persona must be one of se, ae']);
    expect(validateProfile({ ...ok, persona: 'ae', role_pack: 'se_manager' })).toHaveLength(1);
    expect(profileFromSetupFile({ ...ok, email: 'ada@example.com', persona: 'ae' })).toMatchObject({ persona: 'ae', role: 'se_ic' });
  });
});
