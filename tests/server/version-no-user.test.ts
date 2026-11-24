/** ON-17: GET /version answers the build's version before any user exists (a fresh install, before Getting started). */
import { describe, expect, it } from 'vitest';

import { VersionPayload } from '@/contract';
import { personaOf } from '@/personas';
import { buildInfo, versionPayload, versionSettings } from '@/server/version';

function fake(user: string | null) {
  const calls: string[] = [];
  return {
    calls,
    userId: async () => {
      calls.push('userId');
      if (!user) throw new Error('CC_DATA=db: no user in this database');
      return user;
    },
    settings: async () => (calls.push('model'), { persona: { id: 'ae' as const } }),
  };
}

describe('ON-17: GET /version without a user', () => {
  it('no user: the default persona, the user model never loaded, and the payload in the declared shape', async () => {
    const f = fake(null);
    const settings = await versionSettings(f);
    expect(settings).toEqual({});
    expect(f.calls).toEqual(['userId']);
    const v = versionPayload({ build: buildInfo(), migration: null, persona: personaOf(settings), workerVersion: null, dataSource: 'db', update: null, release: null });
    expect(VersionPayload.parse(v)).toEqual(v);
    expect(v).toMatchObject({ version: buildInfo().version, persona: { id: 'se' } });
  });

  it("with a user it reads the user's persona", async () => {
    const f = fake('u1');
    const settings = await versionSettings(f);
    expect(f.calls).toEqual(['userId', 'model']);
    expect(personaOf(settings).id).toBe('ae');
  });

  it('DbHealth.getVersion asks versionSettings, not the user model, first', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/server/datasource/db/domains/health.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('async getVersion('), src.indexOf('async reauthConnector('));
    expect(body).toContain('versionSettings({');
    expect(body).not.toMatch(/const m = await this\.ctx\.model\(WHOLE\);/);
  });
});
