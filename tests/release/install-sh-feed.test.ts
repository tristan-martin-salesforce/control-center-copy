/**
 * ON-20: install.sh and parseFeed agree on what a release feed is, and the refusal says which file was read and what
 * was wrong. install.sh's feed check is run as it ships (its inline program, cut out of the script) against the same
 * folders parseFeed / feedShaFor read. Temp folders only.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as _rm from '../../scripts/ops/lib/release-manifest.mjs';

const { emptyFeed, feedRefusal, feedShaFor, parseFeed } = _rm as any;

const SH = readFileSync(resolve(__dirname, '../../scripts/ops/install.sh'), 'utf8');
const PROGRAM = /VERDICT="\$\("\$NODE" -e '([\s\S]*?)' "\$DIR" "\$NAME" "\$GOT"\)"/.exec(SH)?.[1];
const NAME = 'command-center-2.0.1-arm64.tgz';
const SHA = 'b'.repeat(64);

let tmp: string;
let n = 0;
beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), 'cc-feed-sh-'))));
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const row = (o: Record<string, unknown> = {}) => ({ version: '2.0.1', channel: 'stable', arch: 'arm64', artifact: NAME, sha256: SHA, bytes: 1, notes: '', published_at: '2026-11-21T00:00:00Z', ...o });
const good = (rows = [row()]) => JSON.stringify({ ...emptyFeed(new Date('2026-11-21T00:00:00Z')), releases: rows });
/** A download folder with these feed files and the build. */
function folder(files: Record<string, string>): string {
  const d = join(tmp, `dl-${(n += 1)}`);
  mkdirSync(d);
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  writeFileSync(join(d, NAME), 'x');
  return d;
}
const shVerdict = (dir: string) => execFileSync(process.execPath, ['-e', PROGRAM!, dir, NAME, SHA], { encoding: 'utf8' });
const parseWhy = (text: string) => {
  try {
    parseFeed(text);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("install.sh's feed check is parseFeed's", () => {
  it('the program is in install.sh', () => expect(PROGRAM).toBeTruthy());

  it('a valid feed listing the build: ok, with the file it read', () => {
    expect(shVerdict(folder({ 'manifest.json': good() }))).toBe('ok manifest.json');
  });

  const broken: Record<string, string> = {
    'no schema or name (the walk hand-made one)': JSON.stringify({ releases: [row()] }),
    'another app': JSON.stringify({ schema: 1, name: 'other', releases: [row()] }),
    'truncated': good().slice(0, 40),
    'no JSON at all': 'Not Found',
    'no releases list': JSON.stringify({ schema: 1, name: 'command-center' }),
  };
  for (const [what, body] of Object.entries(broken)) {
    it(`${what}: refused by both, with the same reason and the file named`, () => {
      const why = parseWhy(body);
      expect(why).toBeTruthy();
      const dir = folder({ 'manifest.json': body });
      expect(shVerdict(dir)).toBe(`invalid manifest.json|${why}`);
      const f = feedShaFor(join(dir, NAME));
      expect(f).toMatchObject({ found: null, feeds: 1, invalid: [{ file: join(dir, 'manifest.json'), why }] });
      expect(feedRefusal(f, join(dir, NAME))).toBe(`manifest.json (next to ${NAME}) can't be used: ${why}. Download manifest.json again from the same Drive folder into ${dir}, then run this again. Nothing changed.`);
    });
  }

  it('a row parseFeed drops (sha not hex, unknown channel) is not listed for install.sh either', () => {
    for (const bad of [row({ sha256: 'zz' }), row({ channel: 'nightly' }), row({ version: 'two' })]) {
      const dir = folder({ 'manifest.json': good([bad]) });
      expect(parseFeed(good([bad])).releases).toEqual([]);
      expect(shVerdict(dir)).toBe('unlisted');
      expect(feedRefusal(feedShaFor(join(dir, NAME)), join(dir, NAME))).toMatch(/does not list it/);
    }
  });

  it('a broken copy beside a good one does not block it; another sha is a mismatch; no feed is nofeed', () => {
    expect(shVerdict(folder({ 'manifest.json': 'Not Found', 'manifest (1).json': good() }))).toBe('ok manifest (1).json');
    expect(shVerdict(folder({ 'manifest.json': good([row({ sha256: 'c'.repeat(64) })]) }))).toBe('mismatch');
    const none = folder({});
    expect(shVerdict(none)).toBe('nofeed');
    expect(feedRefusal(feedShaFor(join(none, NAME)), join(none, NAME))).toMatch(/^no manifest\.json next to /);
  });
});
