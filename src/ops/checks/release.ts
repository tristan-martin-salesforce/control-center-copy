/**
 * D-90: the compiled release this Mac runs. `releases/current` is a valid link and the folder it points at matches its
 * manifest (every file's size; the entry points' sha256, or every file's with CC_DOCTOR_DEEP=1). A source checkout
 * (no release installed) skips. DATA.RELEASE.CORRUPT when not.
 */
import { lstatSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

import { currentReleaseLink, releasesDir } from '../paths';
import { readReleaseManifest, RELEASE_SAMPLE_FILES, verifyReleaseTree } from '../release';
import { bad, npmRun, ok, type Check } from './types';

const LABEL = 'Installed release';
const fix = (c: Parameters<Check>[0]) => `${npmRun(c, 'ops:rollback')}  (the previous build), or install the build again from the Drive folder (docs/INSTALL.md)`;

export const checkRelease: Check = async (c) => {
  const link = currentReleaseLink(c.env);
  let target: string;
  try {
    if (!lstatSync(link).isSymbolicLink()) return bad('fail', 'release', LABEL, 'releases/current is not a link', fix(c), undefined, { code: 'DATA.RELEASE.CORRUPT' });
    target = join(releasesDir(c.env), basename(readlinkSync(link)));
  } catch {
    return bad('skip', 'release', LABEL, 'no compiled release installed (a source checkout updates with npm run update)');
  }
  const m = readReleaseManifest(target);
  if (!m) return bad('fail', 'release', LABEL, `releases/current points at ${basename(target)}, which holds no release manifest`, fix(c), undefined, { code: 'DATA.RELEASE.CORRUPT' });
  const deep = c.env.CC_DOCTOR_DEEP === '1';
  const v = await verifyReleaseTree(target, m, { deep, sample: RELEASE_SAMPLE_FILES });
  const data = { version: m.version, channel: m.channel ?? null, arch: m.arch ?? null, builtAt: m.built_at ?? null, files: v.checked, deep };
  if (!v.ok) {
    const first = [...v.missing, ...v.changed].slice(0, 3).join(', ');
    return bad('fail', 'release', LABEL, `v${m.version}: ${v.missing.length} missing, ${v.changed.length} changed (${first})`, fix(c), { ...data, missing: v.missing.length, changed: v.changed.length }, { code: 'DATA.RELEASE.CORRUPT' });
  }
  return ok('release', LABEL, `v${m.version} (${m.channel ?? '?'}, ${m.arch ?? '?'}): ${v.checked} files match the manifest${deep ? ' (every sha256)' : ''}`, data);
};
