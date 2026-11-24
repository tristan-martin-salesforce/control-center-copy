/**
 * D-90: the release handoff (the Drive upload is a handoff that never sends; the announcement is a Slack draft with
 * dry run on) and the feedback Diagnostics block's release line (version, channel, arch from the manifest).
 */
import { describe, expect, it } from 'vitest';

import { announcementDraft, driveUploadHandoff, notesForSlack, releaseHandoffAdapter, releaseHandoffItems, type ReleaseHandoffInput } from '../../src/outbox/adapters/release-handoff';
import { diagnosticsBlock, type DiagnosticsInput } from '../../src/server/feedback/diagnostics';
import { Scrubber } from '../../src/server/feedback/scrub';

const input = (o: Partial<ReleaseHandoffInput> = {}): ReleaseHandoffInput => ({
  version: '2.1.0',
  channel: 'stable',
  artifactPath: '/repo/dist/releases/command-center-2.1.0-arm64.tgz',
  feedPath: '/repo/dist/releases/manifest.json',
  installShPath: '/repo/dist/releases/install.sh',
  artifactName: 'command-center-2.1.0-arm64.tgz',
  sha256: 'c'.repeat(64),
  bytes: 150_000_000,
  notes: '### Added\n- **time**: a thing\n- another\n\n### Fixed\n- a bug',
  folderId: '1AbCdEfGhIjKlMnOpQ',
  announceChannel: 'C0123456789',
  announceChannelName: '#command-center',
  ...o,
});

describe('release handoff', () => {
  it('the Drive upload is a handoff: three files, the folder link, copyable instructions, never a tool call', () => {
    const h = driveUploadHandoff(input());
    expect(h).toMatchObject({ kind: 'release.drive_upload', mode: 'handoff', dryRun: true, folderUrl: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQ' });
    expect(h.files.map((f) => f.name)).toEqual(['command-center-2.1.0-arm64.tgz', 'manifest.json', 'install.sh']);
    expect(h.copyText).toContain('/repo/dist/releases/command-center-2.1.0-arm64.tgz');
    expect(h.copyText).toContain(`sha256 ${'c'.repeat(64)}`);
    expect(h.invalid).toBeUndefined();
    for (const mode of ['send', 'draft'] as const) expect(() => releaseHandoffAdapter.toolCall(h as never, mode)).toThrow(/never uploads/);
    expect(releaseHandoffAdapter.instructions(h as never)).toBe(h.copyText);
    expect(driveUploadHandoff(input({ folderId: '' }))).toMatchObject({ folderUrl: null, invalid: expect.stringContaining('no Drive folder set') });
  });

  it('the announcement is a Slack draft in the Slack adapter shape, dry run on, text from the CHANGELOG', () => {
    const a = announcementDraft(input());
    expect(a).toMatchObject({ kind: 'release.announce', tool: 'slack_send_message', channel: 'C0123456789', dryRun: true });
    expect(a.text).toContain('*Command Center v2.1.0* is out.');
    expect(a.text).toContain('*Added*\n• *time*: a thing\n• another\n*Fixed*\n• a bug');
    expect(a.text).toContain('ask Claude Code: "Update Command Center to v2.1.0 from https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQ"');
    expect(announcementDraft(input({ announceChannel: '', channel: 'beta' }))).toMatchObject({ channel: null, invalid: expect.stringContaining('no announcement channel'), text: expect.stringContaining('(beta)') });
    expect(releaseHandoffItems(input()).map((i) => i.kind)).toEqual(['release.drive_upload', 'release.announce']);
    expect(notesForSlack(Array.from({ length: 20 }, (_, i) => `- line ${i}`).join('\n'), 3)).toBe('• line 0\n• line 1\n• line 2\n…and 17 more (CHANGELOG.md)');
  });
});

describe('Diagnostics: the release line', () => {
  const base: DiagnosticsInput = { version: '2.0.0', sha: 'abc1234', dirty: 0, channel: 'stable', os: 'darwin', node: 'v22', claudeCli: null, workerVersion: null, mismatch: false, migration: null, migrationPending: false, connectors: [], events: [], doctor: null, logs: { worker: [], web: [] } };
  const sc = new Scrubber({ accounts: [], people: [], opps: [] });

  it('carries the installed release (version, channel, arch); a source checkout has no line', () => {
    expect(diagnosticsBlock({ ...base, release: { version: '2.0.0', channel: 'stable', arch: 'arm64' } }, sc)).toContain('release 2.0.0 · channel stable · arch arm64');
    expect(diagnosticsBlock(base, sc)).not.toContain('release ');
  });
});
