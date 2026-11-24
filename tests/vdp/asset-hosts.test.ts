/**
 * SEC-6 (D-60 amended 2026-11-21): VDP autopilot's trusted asset sites. The host matcher decides whether autopilot may
 * add a link by itself; anything it refuses waits for the user's Apply. Placeholders only.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_AUTOPILOT_ASSET_HOSTS, SendingSettings, SendingSettingsPatch } from '../../src/contract';
import { normaliseAssetHost, trustedAssetHost } from '../../src/engines/vdp/asset-hosts';
import { mergeSendingPatch, sendingOf } from '../../src/outbox';

const H = DEFAULT_AUTOPILOT_ASSET_HOSTS;
const ok = (url: string, hosts: readonly string[] = H) => trustedAssetHost(url, hosts).trusted;

describe('trustedAssetHost', () => {
  it('exact host or a subdomain of an entry', () => {
    expect(ok('https://docs.google.com/presentation/d/abc/edit')).toBe(true);
    expect(ok('https://drive.google.com/file/d/abc/view')).toBe(true);
    expect(ok('https://salesforce.com/a.pdf')).toBe(true);
    expect(ok('https://www.salesforce.com/content/dam/a.pdf')).toBe(true);
    expect(ok('https://acme.my.salesforce.com/sfc/p/a')).toBe(true);
    expect(ok('https://trailhead.salesforce.com/content/learn')).toBe(true);
    expect(ok('https://a.sfdcstatic.com/x.pdf')).toBe(true);
    expect(ok('https://DOCS.Google.COM/document/d/abc')).toBe(true);
    expect(ok('https://docs.google.com./document/d/abc')).toBe(true); // a trailing dot is the same host
  });

  it('a look-alike or a suffix trick is not a subdomain', () => {
    expect(trustedAssetHost('https://evilsalesforce.com/a.pdf', H)).toEqual({ trusted: false, host: 'evilsalesforce.com', why: 'Held for you: link is on evilsalesforce.com, not a trusted site' });
    expect(ok('https://salesforce.com.evil.example/a.pdf')).toBe(false);
    expect(ok('https://google.com/a.pdf')).toBe(false); // docs.google.com does not trust its parent
    expect(ok('https://sites.google.com/a.pdf')).toBe(false);
    expect(ok('https://anything.example/deck.pdf')).toBe(false);
  });

  it('IDN: compared as punycode, so a homograph never matches; an IDN entry matches its own host', () => {
    const cyr = trustedAssetHost('https://drive.gооgle.com/file/d/abc', H); // Cyrillic о
    expect(cyr.trusted).toBe(false);
    expect(cyr.host).toMatch(/^drive\.xn--/);
    expect(ok('https://bücher.example/deck.pdf', ['bücher.example'])).toBe(true);
    expect(ok('https://xn--bcher-kva.example/deck.pdf', ['bücher.example'])).toBe(true);
  });

  it('https only, no user name, no port, no IP address', () => {
    expect(trustedAssetHost('http://docs.google.com/document/d/abc', H)).toMatchObject({ trusted: false, why: /not https/ });
    expect(trustedAssetHost('ftp://docs.google.com/a', H).trusted).toBe(false);
    expect(trustedAssetHost('https://docs.google.com@evil.example/a.pdf', H)).toMatchObject({ trusted: false, host: 'evil.example', why: /user name/ });
    expect(trustedAssetHost('https://user:pw@docs.google.com/a', H)).toMatchObject({ trusted: false, why: /user name/ });
    expect(trustedAssetHost('https://docs.google.com:8443/a', H)).toMatchObject({ trusted: false, why: /port 8443/ });
    expect(ok('https://docs.google.com:443/document/d/abc')).toBe(true); // the default port is no port
    for (const ip of ['https://1.2.3.4/a.pdf', 'https://[::1]/a.pdf', 'https://0x7f.1/a.pdf', 'https://2130706433/a.pdf']) expect(trustedAssetHost(ip, [...H, '1.2.3.4']), ip).toMatchObject({ trusted: false, why: /IP address/ });
    expect(trustedAssetHost('not a link', H)).toMatchObject({ trusted: false, host: null });
  });

  it('an empty list trusts nothing; odd stored entries are ignored', () => {
    expect(ok('https://docs.google.com/document/d/abc', [])).toBe(false);
    expect(ok('https://docs.google.com/document/d/abc', ['', '1.2.3.4', 'https://docs.google.com/x'])).toBe(true);
  });
});

describe('normaliseAssetHost (what the user types → the stored entry)', () => {
  it('takes a host, a link or a wildcard and keeps the lower-case host name', () => {
    expect(normaliseAssetHost('Loom.com')).toBe('loom.com');
    expect(normaliseAssetHost('  https://www.Loom.com/share/abc  ')).toBe('www.loom.com');
    expect(normaliseAssetHost('*.gong.io')).toBe('gong.io');
    expect(normaliseAssetHost('bücher.example')).toBe('xn--bcher-kva.example');
  });

  it('refuses what is not a site name', () => {
    for (const bad of ['', '   ', '1.2.3.4', '[::1]', 'docs.google.com:8443', 'user@docs.google.com', 'localhost', 'a b.com', 'http://']) expect(normaliseAssetHost(bad), bad).toBeNull();
  });
});

describe('the setting: settings.sending.autopilotAssetHosts', () => {
  it('defaults to the Salesforce and Google sites, for a new user and for a stored row that predates it', () => {
    expect(SendingSettings.parse({ version: 1, defaultMode: 'draft', dryRun: true, verifyReadback: true, undoWindowSec: 10 }).autopilotAssetHosts).toEqual([...H]);
    expect(sendingOf({}).autopilotAssetHosts).toEqual([...H]);
    expect(H).toEqual(expect.arrayContaining(['salesforce.com', 'force.com', 'my.salesforce.com', 'salesforce-sites.com', 'trailhead.com', 'sfdcstatic.com', 'drive.google.com', 'docs.google.com']));
  });

  it('keeps a stored list as is (an empty one trusts nothing), drops invalid names, dedupes', () => {
    expect(sendingOf({ autopilotAssetHosts: [] }).autopilotAssetHosts).toEqual([]);
    expect(sendingOf({ autopilotAssetHosts: ['loom.com', 'LOOM.com', '1.2.3.4', 'bad host'] as never }).autopilotAssetHosts).toEqual(['loom.com']);
  });

  it('a patch replaces the list; a patch without it keeps it; the schema refuses a non-host', () => {
    const cur = sendingOf({ autopilotAssetHosts: ['loom.com'] });
    expect(mergeSendingPatch(cur, SendingSettingsPatch.parse({ autopilotAssetHosts: ['loom.com', 'Gong.io'] })).autopilotAssetHosts).toEqual(['loom.com', 'gong.io']);
    expect(mergeSendingPatch(cur, SendingSettingsPatch.parse({ undoWindowSec: 5 })).autopilotAssetHosts).toEqual(['loom.com']);
    expect(SendingSettingsPatch.safeParse({ autopilotAssetHosts: ['https://evil.example/x'] }).success).toBe(false);
    expect(SendingSettingsPatch.safeParse({ autopilotAssetHosts: ['1.2.3.4'] }).success).toBe(false);
  });
});
