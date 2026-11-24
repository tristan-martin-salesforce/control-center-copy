/** Fonts and icons synced into public/ (DEP.ASSETS.MISSING): pages work without them, but plainer. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { bad, isCompiledRelease, ok, type Check } from './types';

export const checkAssets: Check = async (c) => {
  const count = (d: string) => {
    try {
      return readdirSync(join(c.repoRoot, 'public', d)).filter((f) => !f.startsWith('.')).length;
    } catch {
      return 0;
    }
  };
  const fonts = count('fonts');
  const icons = count('icons');
  // a compiled release never ships the licensed fonts (scripts/release/build.mjs): the Mac's own font is the design
  // there, not a fault, and the source checkout's sync script is not in it (ON-11)
  if (isCompiledRelease(c) && fonts === 0 && icons > 0) return ok('assets', 'Fonts and icons', `${icons} icons; the Mac's own font (the brand fonts are not shipped in a build)`);
  return fonts > 0 && icons > 0
    ? ok('assets', 'Fonts and icons', `${fonts} font files, ${icons} icons`)
    : bad('warn', 'assets', 'Fonts and icons', `fonts=${fonts}, icons=${icons}`, 'node scripts/sync-brand-assets.mjs  (or: npm run setup)', undefined, { code: 'DEP.ASSETS.MISSING' });
};
