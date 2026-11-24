/** ON-28: the release build checks that the client chunks carry the build's sha (BuildWatch's source). Fake trees only. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as _build from '../../scripts/release/build.mjs';

const { clientShaMatches } = _build as any;

let tmp: string;
beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), 'cc-build-sha-'))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function chunk(rel: string, body: string) {
  const p = join(tmp, 'chunks', rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

describe('ON-28: clientShaMatches', () => {
  it('finds the sha inlined in a nested chunk', () => {
    chunk('app/x.js', 'a');
    chunk('7401-abc.js', 'const s={sha:"a4ed1e2"};');
    expect(clientShaMatches(tmp, 'a4ed1e2')).toBe(true);
  });
  it('a chunk from an older sha fails', () => {
    chunk('7401-abc.js', 'const s={sha:"c1b99e8"};');
    expect(clientShaMatches(tmp, 'a4ed1e2')).toBe(false);
  });
  it('no chunks folder fails; no sha passes', () => {
    expect(clientShaMatches(tmp, 'a4ed1e2')).toBe(false);
    expect(clientShaMatches(tmp, '')).toBe(true);
  });
  it('ignores non-js files', () => {
    chunk('x.js.map', '"a4ed1e2"');
    expect(clientShaMatches(tmp, 'a4ed1e2')).toBe(false);
  });
});
