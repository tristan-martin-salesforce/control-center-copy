/** SEC-11: `local_files` checks a path's real location, so a symlink under a root that points elsewhere is refused. */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { LocalPathRefused, localFilesPort, localFilesRuntime } from '@/connectors/runtime';

describe('local_files realpath gate (SEC-11)', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('refuses a symlinked file or folder that leaves the root; a link that stays inside still reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-lfr-'));
    const outside = await mkdtemp(join(tmpdir(), 'cc-lfr-out-'));
    dirs.push(root, outside);
    await writeFile(join(outside, 'secret.txt'), 'nope');
    await mkdir(join(root, 'p'));
    await writeFile(join(root, 'p', 'a.jsonl'), 'ok');
    await symlink(join(outside, 'secret.txt'), join(root, 'p', 'leak.txt'));
    await symlink(outside, join(root, 'away'));
    await symlink(join(root, 'p', 'a.jsonl'), join(root, 'inside.jsonl'));
    const port = localFilesPort(localFilesRuntime({ connector: 'claude_sessions', roots: [root] }));
    await expect(port.readText(join(root, 'p', 'leak.txt'))).rejects.toBeInstanceOf(LocalPathRefused);
    await expect(port.readdir(join(root, 'away'))).rejects.toBeInstanceOf(LocalPathRefused);
    await expect(port.readText(join(root, 'away', 'secret.txt'))).rejects.toMatchObject({ code: 'EOUTSIDE' });
    expect(await port.readText(join(root, 'inside.jsonl'))).toBe('ok');
    await expect(port.stat(join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a root that is itself a symlink still reads what is under it', async () => {
    const real = await mkdtemp(join(tmpdir(), 'cc-lfr-real-'));
    const parent = await mkdtemp(join(tmpdir(), 'cc-lfr-link-'));
    dirs.push(real, parent);
    await writeFile(join(real, 'a.txt'), 'hi');
    await symlink(real, join(parent, 'root'));
    const port = localFilesPort(localFilesRuntime({ connector: 'claude_sessions', roots: [join(parent, 'root')] }));
    expect(await port.readText(join(parent, 'root', 'a.txt'))).toBe('hi');
  });

  it('a root symlink swapped while the runtime lives is checked against where it points now (P25-9)', async () => {
    const first = await mkdtemp(join(tmpdir(), 'cc-lfr-first-'));
    const second = await mkdtemp(join(tmpdir(), 'cc-lfr-second-'));
    const parent = await mkdtemp(join(tmpdir(), 'cc-lfr-swap-'));
    dirs.push(first, second, parent);
    await writeFile(join(first, 'a.txt'), 'one');
    await writeFile(join(second, 'a.txt'), 'two');
    const root = join(parent, 'root');
    await symlink(first, root);
    const port = localFilesPort(localFilesRuntime({ connector: 'claude_sessions', roots: [root] }));
    expect(await port.readText(join(root, 'a.txt'))).toBe('one');
    // re-point the root: the same runtime reads the new target (a cached real root would refuse it as outside)
    await rm(root);
    await symlink(second, root);
    expect(await port.readText(join(root, 'a.txt'))).toBe('two');
    expect(await port.readdir(root)).toEqual(['a.txt']);
  });
});
