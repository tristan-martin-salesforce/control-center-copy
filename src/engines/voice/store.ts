import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homeStateDir } from '@/lib/state-folder';
import { voiceProfileSchema, type VoiceProfile } from './types';

/**
 * The real profile is private: it lives only in the app's state dir, never in the repo
 * (CLAUDE.md invariant 6). Directory 0700, file 0600, atomic write.
 */

export function stateDir(): string {
  return process.env.CC_STATE_DIR ?? homeStateDir();
}

export function voiceProfilePath(): string {
  return join(stateDir(), 'voice', 'profile.json');
}

function assertOutsideRepo(path: string): void {
  // Walk up from the target; refuse if any ancestor is a git checkout (keeps private data out of repos).
  let dir = resolve(dirname(path));
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git'))) throw new Error(`refusing to write the voice profile inside a git checkout (${dir})`);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

export function saveVoiceProfile(profile: VoiceProfile, path = voiceProfilePath()): string {
  const valid = voiceProfileSchema.parse(profile);
  assertOutsideRepo(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(valid, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return path;
}

export function loadVoiceProfile(path = voiceProfilePath()): VoiceProfile | null {
  if (!existsSync(path)) return null;
  return voiceProfileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}
