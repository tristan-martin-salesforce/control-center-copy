/**
 * `npm run update` (lane E, E1): the order of the steps and every failure path, over fakes (no git, npm, launchd or
 * database). The rules: build before migrating (a failed build leaves the schema alone), back up before migrating,
 * both LaunchAgents stopped while it installs, builds and migrates, and a major release asks before anything changes.
 */
import { describe, expect, it } from 'vitest';

import { majorOf, runUpdate } from '../../scripts/ops/lib/update.mjs';

const WEB = 'com.commandcenter.web';
const WORKER = 'com.commandcenter.worker';
const CHANGELOG = '# Changelog\n\n## [2.0.0] - 2026-12-01\n### Changed\n- Run the new step.\n\n## [1.2.0] - 2026-11-20\n### Added\n- A feature.\n\n## [1.1.0] - 2026-11-13\n';

interface FakeOpts {
  from?: string;
  to?: string;
  incoming?: number;
  running?: string[];
  confirm?: boolean;
  fail?: Partial<Record<'fetch' | 'merge' | 'install' | 'build' | 'migrate' | 'backup' | 'stop' | 'start', boolean>>;
  hasBuild?: boolean;
  elsewhere?: string[];
  local?: { files: string[]; ahead: number };
  saveFails?: boolean;
}

function fake(o: FakeOpts = {}) {
  const log: string[] = [];
  const lines: string[] = [];
  let merged = false;
  const step = (name: string, ok = true) => {
    log.push(name);
    return ok;
  };
  const deps = {
    say: (m: string) => void lines.push(m),
    version: () => (merged ? (o.to ?? '1.2.0') : (o.from ?? '1.1.0')),
    runningVersion: async () => o.from ?? '1.1.0',
    git: {
      sha: () => (merged ? 'bbbbbbb' : 'aaaaaaa'),
      hasUpstream: () => true,
      fetch: async () => step('fetch', !o.fail?.fetch),
      incoming: () => o.incoming ?? 3,
      upstreamFile: (p: string) => (p === 'package.json' ? JSON.stringify({ version: o.to ?? '1.2.0' }) : p === 'CHANGELOG.md' ? CHANGELOG : null),
      mergeFfOnly: async () => {
        merged = !o.fail?.merge;
        return step('merge', !o.fail?.merge);
      },
      localChanges: () => o.local ?? { files: [], ahead: 0 },
      discardLock: async () => step('discard-lock'),
      saveLocal: async (branch: string) => step(`save:${branch}`, !o.saveFails),
    },
    stamp: () => '20261120-0930',
    changelog: (text: string, from: string, to: string) => (text.includes(`## [${to}]`) ? [`## [${to}] (from ${from})`] : []),
    readLocal: () => CHANGELOG,
    confirm: async (q: string) => {
      log.push(`confirm:${q}`);
      return o.confirm ?? false;
    },
    agents: {
      elsewhere: () => o.elsewhere ?? [],
      running: () => o.running ?? [WEB, WORKER],
      stop: async (l: string) => step(`stop:${l}`, !o.fail?.stop),
      start: async (l: string) => step(`start:${l}`, !o.fail?.start),
    },
    install: async () => step('install', !o.fail?.install),
    build: async () => step('build', !o.fail?.build),
    migrate: async () => step('migrate', !o.fail?.migrate),
    snapshot: async () => (step('snapshot'), o.hasBuild === false ? null : 'snap'),
    restore: async (h: string) => void step(`restore:${h}`),
    drop: async (h: string) => void step(`drop:${h}`),
    backup: async () => {
      step('backup');
      if (o.fail?.backup) throw new Error('pg_dump: connection refused');
      return { name: 'command_center-20261114-020000.dump', bytes: 4096, copied: null };
    },
  };
  return { deps, log, lines };
}

describe('npm run update (E1)', () => {
  it('a minor update: fetch, merge, stop both agents, install, build, back up, migrate, start them again', async () => {
    const f = fake();
    const r = await runUpdate(f.deps, {});
    expect(r).toMatchObject({ status: 'updated', fromV: '1.1.0', toV: '1.2.0' });
    expect(f.log).toEqual(['fetch', 'merge', `stop:${WEB}`, `stop:${WORKER}`, 'install', 'snapshot', 'build', 'backup', 'migrate', 'drop:snap', `start:${WEB}`, `start:${WORKER}`]);
    expect(f.lines.join('\n')).toMatch(/v1\.1\.0 · aaaaaaa → v1\.2\.0 · bbbbbbb/);
  });

  it('builds before it migrates, and backs up in between', () => {
    const f = fake();
    return runUpdate(f.deps, {}).then(() => {
      expect(f.log.indexOf('build')).toBeLessThan(f.log.indexOf('backup'));
      expect(f.log.indexOf('backup')).toBeLessThan(f.log.indexOf('migrate'));
      // nothing serves or claims jobs while it installs, builds and migrates
      expect(f.log.indexOf(`stop:${WORKER}`)).toBeLessThan(f.log.indexOf('install'));
      expect(f.log.indexOf(`start:${WORKER}`)).toBeGreaterThan(f.log.indexOf('migrate'));
    });
  });

  it('a failed build never migrates: the previous build goes back and the agents start again', async () => {
    const f = fake({ fail: { build: true } });
    const r = await runUpdate(f.deps, {});
    expect(r).toMatchObject({ status: 'failed', failedAt: 'build' });
    expect(f.log).not.toContain('migrate');
    expect(f.log).not.toContain('backup');
    expect(f.log.slice(-3)).toEqual(['restore:snap', `start:${WEB}`, `start:${WORKER}`]);
    expect(f.lines.join('\n')).toMatch(/build failed\. The database was not migrated, and the previous build is back in place\..*git reset --keep aaaaaaa/s);
  });

  it('a failed backup never migrates', async () => {
    const f = fake({ fail: { backup: true } });
    const r = await runUpdate(f.deps, {});
    expect(r).toMatchObject({ status: 'failed', failedAt: 'backup' });
    expect(f.log).not.toContain('migrate');
    expect(f.log).toContain('restore:snap');
    expect(f.lines.join('\n')).toMatch(/backup failed: pg_dump: connection refused/);
  });

  it('a failed migration puts the build back and starts the app again (the migration rolled back)', async () => {
    const f = fake({ fail: { migrate: true } });
    const r = await runUpdate(f.deps, {});
    expect(r).toMatchObject({ status: 'failed', failedAt: 'migrate' });
    expect(f.log.slice(-3)).toEqual(['restore:snap', `start:${WEB}`, `start:${WORKER}`]);
    expect(f.lines.join('\n')).toMatch(/one transaction, so the database is as it was/);
  });

  it('a failed install starts the agents again without touching the build', async () => {
    const f = fake({ fail: { install: true } });
    const r = await runUpdate(f.deps, {});
    expect(r).toMatchObject({ status: 'failed', failedAt: 'install' });
    expect(f.log).not.toContain('build');
    expect(f.log).not.toContain('snapshot');
    expect(f.log.slice(-2)).toEqual([`start:${WEB}`, `start:${WORKER}`]);
  });

  it('a failed fetch or merge changes nothing and stops no agent', async () => {
    for (const step of ['fetch', 'merge'] as const) {
      const f = fake({ fail: { [step]: true } });
      const r = await runUpdate(f.deps, {});
      expect(r).toMatchObject({ status: 'failed', failedAt: step });
      expect(f.log.some((l) => l.startsWith('stop:'))).toBe(false);
      expect(f.lines.join('\n')).toMatch(/Nothing changed/);
    }
  });

  it('only restarts the agents that were running', async () => {
    const f = fake({ running: [WORKER] });
    await runUpdate(f.deps, {});
    expect(f.log.filter((l) => l.startsWith('stop:') || l.startsWith('start:'))).toEqual([`stop:${WORKER}`, `start:${WORKER}`]);
  });

  it('a major update prints its changelog and asks before anything changes; no means nothing changed', async () => {
    const f = fake({ to: '2.0.0', confirm: false });
    const r = await runUpdate(f.deps, {});
    expect(r.status).toBe('declined');
    expect(f.log).toEqual(['fetch', 'confirm:Update to v2.0.0 and migrate the database now?']);
    expect(f.lines.join('\n')).toMatch(/MAJOR update[\s\S]*## \[2\.0\.0\]/);
    expect(f.lines.join('\n')).toMatch(/Nothing changed/);
  });

  it('a major update goes ahead on yes, or with --yes without asking', async () => {
    const yes = fake({ to: '2.0.0', confirm: true });
    expect((await runUpdate(yes.deps, {})).status).toBe('updated');
    expect(yes.log.indexOf('confirm:Update to v2.0.0 and migrate the database now?')).toBeLessThan(yes.log.indexOf('merge'));
    expect(yes.log).toContain('migrate');
    const flagged = fake({ to: '2.0.0' });
    expect((await runUpdate(flagged.deps, { yes: true })).status).toBe('updated');
    expect(flagged.log.some((l) => l.startsWith('confirm:'))).toBe(false);
  });

  it('UPG-4: a major update keeps its backup out of retention as pre-<major>.0 and says where; a minor one does not', async () => {
    const major = fake({ to: '3.0.0' });
    const kept: Array<[string, number]> = [];
    const deps = { ...major.deps, keepForMajor: async (b: { name: string }, m: number) => (kept.push([b.name, m]), `/state/backups/pre-${m}.0/${b.name}`) };
    expect((await runUpdate(deps, { yes: true })).status).toBe('updated');
    expect(kept).toEqual([['command_center-20261114-020000.dump', 3]]);
    expect(major.lines.join('\n')).toContain('the backup from before v3.0.0 is kept out of retention: /state/backups/pre-3.0/command_center-20261114-020000.dump');
    const minor = fake();
    const none: unknown[] = [];
    await runUpdate({ ...minor.deps, keepForMajor: async (...a: unknown[]) => (none.push(a), 'x') }, {});
    expect(none).toEqual([]);
    expect(minor.lines.join('\n')).not.toMatch(/kept out of retention/);
  });

  it('--no-restart leaves the agents alone; --no-backup skips the backup; --dry changes nothing', async () => {
    const nr = fake();
    await runUpdate(nr.deps, { restart: false });
    expect(nr.log.some((l) => l.startsWith('stop:') || l.startsWith('start:'))).toBe(false);
    const nb = fake();
    await runUpdate(nb.deps, { backup: false });
    expect(nb.log).not.toContain('backup');
    expect(nb.log).toContain('migrate');
    const dry = fake();
    const r = await runUpdate(dry.deps, { dry: true });
    expect(r.status).toBe('up_to_date');
    expect(dry.log).toEqual([]);
  });

  it('with nothing new it still installs, builds and migrates (a --no-pull after a manual merge) and says so', async () => {
    const f = fake({ incoming: 0, to: '1.1.0' });
    const r = await runUpdate(f.deps, {});
    expect(r.status).toBe('up_to_date');
    expect(f.log).not.toContain('merge');
    expect(f.log).toContain('migrate');
    expect(f.lines.join('\n')).toMatch(/already up to date/);
  });

  it('refuses when the installed agents run another checkout: nothing changes, no agent stops', async () => {
    const f = fake({ elsewhere: ['/Users/me/Projects/command-center'] });
    const r = await runUpdate(f.deps, {});
    expect(r).toMatchObject({ status: 'failed', failedAt: 'elsewhere' });
    expect(f.log).toEqual([]); // before anything: no fetch, no stop, no migrate
    expect(f.lines.join('\n')).toMatch(/LaunchAgents run \/Users\/me\/Projects\/command-center, not this checkout: run npm run update there/);
  });

  it('PKG-3: installs with npm ci, and a lockfile npm rewrote here is put back before the fast-forward', async () => {
    const f = fake({ local: { files: ['package-lock.json'], ahead: 0 } });
    const r = await runUpdate(f.deps, {});
    expect(r.status).toBe('updated');
    expect(f.log.slice(0, 3)).toEqual(['fetch', 'discard-lock', 'merge']);
    expect(f.lines.join('\n')).toMatch(/install: npm ci/);
    expect(f.log.some((l) => l.startsWith('confirm:'))).toBe(false);
  });

  it('PKG-3: other local changes stop it with the count and two options; no (or no terminal) changes nothing', async () => {
    const f = fake({ local: { files: ['package-lock.json', 'src/a.ts', 'notes.txt'], ahead: 1 } });
    const r = await runUpdate(f.deps, {});
    expect(r.status).toBe('declined');
    expect(f.log).toEqual(['fetch', 'confirm:Save your changes to cc-local-20261120-0930 and update?']);
    const text = f.lines.join('\n');
    expect(text).toMatch(/You changed the app's code here \(2 files changed and 1 local commit\)/);
    expect(text).toMatch(/1\. Save your changes to the branch cc-local-20261120-0930 and update/);
    expect(text).toMatch(/2\. Cancel: nothing changes/);
    expect(text).toMatch(/Not updated\. Nothing changed/);
  });

  it('PKG-3: yes (or --save-local) saves them to the branch, then updates; a failed save changes nothing', async () => {
    const yes = fake({ local: { files: ['src/a.ts'], ahead: 0 }, confirm: true });
    expect((await runUpdate(yes.deps, {})).status).toBe('updated');
    expect(yes.log.slice(0, 4)).toEqual(['fetch', 'confirm:Save your changes to cc-local-20261120-0930 and update?', 'save:cc-local-20261120-0930', 'merge']);
    const flagged = fake({ local: { files: [], ahead: 2 } });
    expect((await runUpdate(flagged.deps, { saveLocal: true })).status).toBe('updated');
    expect(flagged.log.slice(0, 3)).toEqual(['fetch', 'save:cc-local-20261120-0930', 'merge']);
    const broken = fake({ local: { files: ['src/a.ts'], ahead: 0 }, saveFails: true });
    expect(await runUpdate(broken.deps, { saveLocal: true })).toMatchObject({ status: 'failed', failedAt: 'save' });
    expect(broken.log).not.toContain('merge');
    expect(broken.log.some((l) => l.startsWith('stop:'))).toBe(false);
  });

  it('PKG-3: --dry names the local changes and stops; nothing incoming leaves them alone', async () => {
    const dry = fake({ local: { files: ['src/a.ts'], ahead: 0 } });
    expect((await runUpdate(dry.deps, { dry: true })).status).toBe('declined');
    expect(dry.log).toEqual([]);
    expect(dry.lines.join('\n')).toMatch(/1 file changed.*\n.*cc-local-20261120-0930[\s\S]*--dry: stopping here/);
    const lockDry = fake({ local: { files: ['package-lock.json'], ahead: 0 } });
    await runUpdate(lockDry.deps, { dry: true });
    expect(lockDry.lines.join('\n')).toMatch(/would put the committed package-lock.json back/);
    expect(lockDry.log).toEqual([]);
    const none = fake({ incoming: 0, to: '1.1.0', local: { files: ['src/a.ts'], ahead: 0 } });
    expect((await runUpdate(none.deps, {})).status).toBe('up_to_date');
    expect(none.log.some((l) => l.startsWith('save:') || l.startsWith('confirm:'))).toBe(false);
  });

  it('D-98: a 1.x Homebrew database moves after the backup, before db:migrate; a failed move undoes like a failed migration', async () => {
    const ok = fake();
    const moves: string[] = [];
    const withDb = (f: ReturnType<typeof fake>, good: boolean) => ({ ...f.deps, database: { plan: () => ({ move: true }), move: async () => (f.log.push('move'), moves.push('x'), { ok: good }) } });
    const r = await runUpdate(withDb(ok, true), {});
    expect(r.status).toBe('updated');
    expect(ok.log).toEqual(['fetch', 'merge', `stop:${WEB}`, `stop:${WORKER}`, 'install', 'snapshot', 'build', 'backup', 'move', 'migrate', 'drop:snap', `start:${WEB}`, `start:${WORKER}`]);
    const bad = fake();
    const b = await runUpdate(withDb(bad, false), {});
    expect(b).toMatchObject({ status: 'failed', failedAt: 'move' });
    expect(bad.log.slice(-4)).toEqual(['move', 'restore:snap', `start:${WEB}`, `start:${WORKER}`]);
    expect(bad.log).not.toContain('migrate');
    expect(bad.lines.join('\n')).toMatch(/your data stays in Homebrew Postgres, untouched/);
    const dry = fake();
    await runUpdate(withDb(dry, true), { dry: true });
    expect(dry.lines.join('\n')).toMatch(/would: move the data from Homebrew Postgres/);
    expect(dry.log).not.toContain('move');
    const none = fake();
    await runUpdate({ ...none.deps, database: { plan: () => ({ move: false, message: '--keep-homebrew: the database stays in Homebrew Postgres' }), move: async () => ({ ok: true }) } }, {});
    expect(none.log).not.toContain('move');
    expect(none.lines).toContain('--keep-homebrew: the database stays in Homebrew Postgres');
  });

  it('majorOf reads the major number', () => {
    expect(majorOf('2.0.1')).toBe(2);
    expect(majorOf('v1.9.0')).toBe(1);
    expect(majorOf(undefined)).toBe(0);
  });
});
