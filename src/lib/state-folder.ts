/**
 * Where the state lives: the ONE place `src/` spells the folder (D-101: `command-center`; the 1.x name is only in
 * scripts/ops/lib/migrate-state.mjs, which moves a 1.x folder). The name itself is in `state-folder-name.ts` (no Node
 * imports, so the pure layers can show it); this file adds the paths. The plain .mjs ops scripts keep a twin
 * (scripts/ops/lib/paths.mjs `STATE_FOLDER_NAME`); tests/ops/pg-url.test.ts keeps the two in step. Outside the repo
 * (CLAUDE.md invariant 6).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { STATE_FOLDER_NAME } from './state-folder-name';

export { STATE_FOLDER_DISPLAY, STATE_FOLDER_NAME } from './state-folder-name';

/** `~/Library/Application Support/command-center`, ignoring CC_STATE_DIR (the default location of everything it holds). */
export const homeStateDir = (home: string = homedir()): string => join(home, 'Library', 'Application Support', STATE_FOLDER_NAME);

/** A path under the default state folder: `inStateDir('chat-cwd')`. */
export const inStateDir = (...parts: string[]): string => join(homeStateDir(), ...parts);
