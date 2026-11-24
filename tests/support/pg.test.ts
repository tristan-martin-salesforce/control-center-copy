import { describe, expect, it } from 'vitest';

import { freshDb, resolvePgBin } from './pg';

describe('the shared Postgres test helper (ENG-1, R3)', () => {
  it('finds the client tools on PATH, then PG17_BIN, then Homebrew', () => {
    const has = (...dirs: string[]) => (p: string) => dirs.some((d) => p.startsWith(`${d}/`));
    expect(resolvePgBin({ PATH: '/usr/bin:/opt/pg16/bin', PG17_BIN: '/custom/pg17' }, has('/opt/pg16/bin', '/custom/pg17'))).toBe('/opt/pg16/bin');
    expect(resolvePgBin({ PATH: '/usr/bin', PG17_BIN: '/custom/pg17' }, has('/custom/pg17', '/opt/homebrew/opt/postgresql@17/bin'))).toBe('/custom/pg17');
    expect(resolvePgBin({ PATH: '/usr/bin' }, has('/opt/homebrew/opt/postgresql@17/bin'))).toBe('/opt/homebrew/opt/postgresql@17/bin');
    expect(resolvePgBin({ PATH: '/usr/bin' }, has('/usr/local/opt/postgresql@17/bin'))).toBe('/usr/local/opt/postgresql@17/bin');
    expect(resolvePgBin({ PATH: '/usr/bin' }, () => false)).toBeNull();
  });

  it('refuses anything that is not a control_center_<something> test database', async () => {
    await expect(freshDb('command_center')).rejects.toThrow(/refusing/);
    await expect(freshDb('control_center')).rejects.toThrow(/refusing/);
    await expect(freshDb('postgres')).rejects.toThrow(/refusing/);
    await expect(freshDb('control_center_x; drop')).rejects.toThrow(/refusing/);
  });
});
