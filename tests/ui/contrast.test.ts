/**
 * The contrast gate as a test: every token pair in src/styles/brand.css meets its WCAG/APCA minimum in both themes.
 * Runs scripts/contrast.mjs (`npm run contrast`, also usable on its own); a failing pair is printed in the assertion.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

it('every token pair in brand.css passes the contrast check, light and dark', () => {
  const r = spawnSync(process.execPath, ['scripts/contrast.mjs'], { cwd: ROOT, encoding: 'utf8' });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
});
