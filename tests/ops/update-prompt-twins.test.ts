/**
 * The two copies of the Claude Code update prompt stay one text: the server's (src/ops/release.ts `updatePrompt`, GET
 * /version `update.prompt`, copied by the Health banner on an installed copy) and the ops script's
 * (scripts/ops/lib/update-from.mjs `claudeUpdatePrompt`, printed by `npm run update -- --from <folder id>`, the text
 * the install walks validated). The app can't import the .mjs without bundling, so this test is the guard.
 */
import { homedir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { updatePrompt } from '@/ops/release';

const FOLDER = '1AbCdEfGhIjKlMnOpQrStUv';
const HOME = homedir();

describe('update prompt twins', async () => {
  const { claudeUpdatePrompt } = (await import('../../scripts/ops/lib/update-from.mjs')) as {
    claudeUpdatePrompt: (folderId: string, version?: string | null, env?: Record<string, string | undefined>) => string;
  };

  const envs: Array<[string, Record<string, string | undefined>]> = [
    ['the default state folder', { HOME }],
    ['CC_STATE_DIR', { HOME, CC_STATE_DIR: '/tmp/lane/state' }],
    ['CC_STATE_DIR under HOME', { HOME, CC_STATE_DIR: `${HOME}/lane-state` }],
    ['CC_RELEASES_DIR over CC_STATE_DIR', { HOME, CC_STATE_DIR: '/tmp/lane/state', CC_RELEASES_DIR: '/tmp/lane/releases' }],
  ];

  it.each(envs)('renders the same text (%s)', (_name, env) => {
    expect(updatePrompt({ version: '2.1.0' }, FOLDER, env)).toBe(claudeUpdatePrompt(FOLDER, '2.1.0', env));
  });

  it('names the releases folder the env picks, never the default when overridden', () => {
    expect(updatePrompt({ version: '2.1.0' }, FOLDER, { HOME })).toContain('npm --prefix "$HOME/Library/Application Support/command-center/releases/current" run update -- --from');
    expect(updatePrompt({ version: '2.1.0' }, FOLDER, { HOME, CC_STATE_DIR: '/tmp/lane/state' })).toContain('npm --prefix "/tmp/lane/state/releases/current" run update');
    expect(updatePrompt({ version: '2.1.0' }, FOLDER, { HOME, CC_RELEASES_DIR: '/tmp/lane/releases' })).toContain('npm --prefix "/tmp/lane/releases/current" run update');
  });

  it('without a folder id it still names the Drive folder in words (the server only; the script always has an id)', () => {
    const p = updatePrompt({ version: '2.1.0' }, null, { HOME });
    expect(p).toContain('from the Command Center Google Drive folder download manifest.json');
    expect(p).not.toContain('folders/null');
  });
});
