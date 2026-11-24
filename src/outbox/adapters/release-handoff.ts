/**
 * The release handoff (D-90, H-12): what `npm run release -- <bump> --publish` stages after it built a release, for
 * the maintainer to apply. *Nothing leaves without approval*: this module builds payloads and refuses to be sent.
 *
 *   release.drive_upload   a HANDOFF, never a write: the app's Google access is read-only (devbar's
 *                          google_workspace_readonly, hard invariant 2: the allowlist is never widened), so the app
 *                          cannot put a file in Drive. The item names the three files (the build, the release feed
 *                          `manifest.json`, `install.sh`), the folder's link and "Copy upload instructions" text: the
 *                          maintainer drops the files into the folder, or asks Claude Code to, with their own Drive
 *                          connector in their own session.
 *   release.announce       a Slack message draft to `distribution.announceChannel` (text from the CHANGELOG section),
 *                          in the Slack adapter's payload shape (`slack_send_message`, channel, text), dry run on. It
 *                          is delivered only by the existing Outbox Send, with its confirm token, if the user sends it.
 *
 * `releaseHandoffAdapter.toolCall` always throws: there is no tool call for a handoff, in any mode.
 *
 * W12-7 (as built): both are ordinary Outbox items (`ActionDestination`, actions `release.drive_upload` and
 * `release.announce`), built by `releaseDestinations()` below and staged by `POST /outbox/releases`
 * (src/outbox/release.ts). Pure: no node modules, so the UI and src/lib/actions.ts import it too.
 */
import type { ActionDestination, Destination, DispatchMode } from '@/contract';

export const RELEASE_UPLOAD_KIND = 'release.drive_upload';
export const RELEASE_ANNOUNCE_KIND = 'release.announce';

export interface ReleaseHandoffInput {
  version: string;
  channel: 'stable' | 'beta';
  /** Absolute paths of the three files to upload. */
  artifactPath: string;
  feedPath: string;
  installShPath: string;
  artifactName: string;
  sha256: string;
  bytes: number;
  /** The version's CHANGELOG section (markdown). */
  notes: string;
  /** distribution.driveFolderId ('' when not set: the item says so). */
  folderId: string;
  /** distribution.announceChannel ('' when not set). */
  announceChannel: string;
  announceChannelName?: string;
}

export interface DriveUploadHandoff {
  kind: typeof RELEASE_UPLOAD_KIND;
  mode: 'handoff';
  /** Always true: there is nothing for the app to send. */
  dryRun: true;
  version: string;
  folderId: string | null;
  folderUrl: string | null;
  files: Array<{ name: string; path: string; sha256?: string; bytes?: number }>;
  /** The text "Copy upload instructions" copies. */
  copyText: string;
  invalid?: string;
}

export interface AnnouncementDraft {
  kind: typeof RELEASE_ANNOUNCE_KIND;
  /** The Slack adapter's payload shape (src/outbox/adapters/slack.ts). */
  tool: 'slack_send_message';
  channel: string | null;
  channelName: string | null;
  text: string;
  /** Default on: the global dry run and the confirm token still apply when it is sent through the Outbox. */
  dryRun: boolean;
  invalid?: string;
}

const base = (p: string) => p.split('/').pop() ?? p;
const folderUrlOf = (id: string) => `https://drive.google.com/drive/folders/${id}`;

/** The CHANGELOG section as a few Slack lines: headings bold, at most `max` bullets. */
export function notesForSlack(notes: string, max = 12): string {
  const out: string[] = [];
  let bullets = 0;
  let dropped = 0;
  for (const raw of notes.split('\n')) {
    const l = raw.trimEnd();
    if (!l.trim() || /^## /.test(l)) continue;
    const h = /^###\s+(.*)$/.exec(l);
    if (h) {
      out.push(`*${h[1]!.trim()}*`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      if (bullets >= max) {
        dropped++;
        continue;
      }
      bullets++;
      out.push(`• ${l.replace(/^\s*[-*]\s+/, '').replace(/\*\*([^*]+)\*\*/g, '*$1*')}`);
    }
  }
  if (dropped) out.push(`…and ${dropped} more (CHANGELOG.md)`);
  return out.join('\n');
}

export function driveUploadHandoff(i: ReleaseHandoffInput): DriveUploadHandoff {
  const folderUrl = i.folderId ? folderUrlOf(i.folderId) : null;
  const files = [
    { name: i.artifactName, path: i.artifactPath, sha256: i.sha256, bytes: i.bytes },
    { name: 'manifest.json', path: i.feedPath },
    { name: 'install.sh', path: i.installShPath },
  ];
  const copyText = [
    `Upload Command Center v${i.version} (${i.channel}) to ${folderUrl ?? 'the Command Center Drive folder (not set: distributionDriveFolderId in config/team.json)'}:`,
    ...files.map((f) => `  - ${f.path}${f.name !== base(f.path) ? ` (as ${f.name})` : ''}`),
    `Replace the folder's manifest.json and install.sh with these; keep the older builds the feed still lists.`,
    `${i.artifactName} must have sha256 ${i.sha256}.`,
    `Claude Code can do it with your Drive connector: "Upload these three files to ${folderUrl ?? '<the folder>'}, replacing manifest.json and install.sh, and tell me the new file ids."`,
  ].join('\n');
  return { kind: RELEASE_UPLOAD_KIND, mode: 'handoff', dryRun: true, version: i.version, folderId: i.folderId || null, folderUrl, files, copyText, ...(i.folderId ? {} : { invalid: 'no Drive folder set (distributionDriveFolderId in config/team.json)' }) };
}

export function announcementDraft(i: ReleaseHandoffInput): AnnouncementDraft {
  const folder = i.folderId ? folderUrlOf(i.folderId) : 'the Command Center Drive folder';
  const notes = notesForSlack(i.notes);
  const text = [
    `*Command Center v${i.version}* is out${i.channel === 'beta' ? ' (beta)' : ''}.`,
    ...(notes ? ['', notes] : []),
    '',
    `*Update:* the app shows an Update banner; or ask Claude Code: "Update Command Center to v${i.version} from ${folder}" (the full prompt is in docs/INSTALL.md).`,
    `*New here?* Ask Claude Code: "Install Command Center from ${folder}" (docs/INSTALL.md).`,
  ].join('\n');
  return { kind: RELEASE_ANNOUNCE_KIND, tool: 'slack_send_message', channel: i.announceChannel || null, channelName: i.announceChannelName || null, text, dryRun: true, ...(i.announceChannel ? {} : { invalid: 'no announcement channel set (distributionAnnounceChannel in config/team.json)' }) };
}

/** Both items, in the order the maintainer applies them (upload first, then announce). */
export function releaseHandoffItems(i: ReleaseHandoffInput): [DriveUploadHandoff, AnnouncementDraft] {
  return [driveUploadHandoff(i), announcementDraft(i)];
}

/** Structurally an Outbox adapter that never sends: a handoff has no tool call in any mode. */
export const releaseHandoffAdapter = {
  kind: RELEASE_UPLOAD_KIND,
  toolCall(_payload: Record<string, unknown>, _mode: DispatchMode): never {
    throw new Error('invalid_request: a release upload is a handoff: the app has read-only Drive access and never uploads (Copy upload instructions)');
  },
  /** The "Copy upload instructions" text of a staged handoff payload. */
  instructions(payload: Record<string, unknown>): string {
    return typeof payload.copyText === 'string' ? payload.copyText : '';
  },
};

// ---------------------------------------------------------------------------
// W12-7: the two items as Outbox drafts (ActionDestination), their payloads and the row's facts
// ---------------------------------------------------------------------------

/** A Slack channel id as config/team.json (or the `settings.distribution` row) holds it (src/ops/distribution.ts). */
export const RELEASE_CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;
/** One Slack message; a release note this long is a paste accident. */
export const RELEASE_ANNOUNCE_MAX_CHARS = 6000;

/**
 * Said once (24-visual-qa surface 8): the row's line says what to set (`releaseRowFacts().missing`), its verb is off,
 * and the dispatch refusal ("Not sent: …") points at that row instead of repeating it. Title, chips and the change
 * lines don't say it again.
 */
const UNSET_FOLDER = 'no Drive folder is set (the upload’s row in the Outbox says what to set)';
const UNSET_CHANNEL = 'no announcement channel is set (the announcement’s row in the Outbox says what to set)';
const MISSING_FOLDER = 'No Drive folder is set: add the folder’s id as distributionDriveFolderId in config/team.json.';
const MISSING_CHANNEL = 'No announcement channel is set: add the channel’s id as distributionAnnounceChannel in config/team.json.';

/** `input` of a `release.drive_upload` item. */
export interface ReleaseUploadInput {
  version: string;
  channel: 'stable' | 'beta';
  folderId: string;
  folderUrl: string | null;
  artifactName: string;
  sha256: string;
  bytes: number;
  files: Array<{ name: string; path: string; sha256?: string; bytes?: number }>;
  /** "Copy upload instructions": the exact prompt for Claude Code. */
  copyText: string;
}

/** `input` of a `release.announce` item. */
export interface ReleaseAnnounceInput {
  version: string;
  channel: 'stable' | 'beta';
  channelId: string;
  channelName: string;
  /** The Slack mrkdwn the post carries (from the CHANGELOG section). */
  text: string;
  sha256: string;
  folderId: string;
}

const relLabel = (v: string, ch: 'stable' | 'beta') => `v${v}${ch === 'beta' ? ' (beta)' : ''}`;
const chanLabel = (name: string, id: string) => (name ? (name.startsWith('#') ? name : `#${name}`) : id);
export const shortSha = (sha: string) => (/^[0-9a-f]{12,}$/.test(sha) ? sha.slice(0, 12) : sha);

/** Both Outbox items of one release, in the order you apply them (upload first, then announce). */
export function releaseDestinations(i: ReleaseHandoffInput): [ActionDestination, ActionDestination] {
  const h = driveUploadHandoff(i);
  const a = announcementDraft(i);
  const upload: ReleaseUploadInput = { version: i.version, channel: i.channel, folderId: h.folderId ?? '', folderUrl: h.folderUrl, artifactName: i.artifactName, sha256: i.sha256, bytes: i.bytes, files: h.files, copyText: h.copyText };
  const announce: ReleaseAnnounceInput = { version: i.version, channel: i.channel, channelId: a.channel ?? '', channelName: a.channelName ?? '', text: a.text, sha256: i.sha256, folderId: i.folderId };
  const where = a.channel ? chanLabel(a.channelName ?? '', a.channel) : null;
  return [
    {
      kind: 'action',
      action: RELEASE_UPLOAD_KIND,
      target: { label: `Upload ${relLabel(i.version, i.channel)} to the releases folder`, url: h.folderUrl },
      input: { ...upload },
      changes: [
        { label: 'Drive folder', before: null, after: h.folderUrl ?? 'not set' },
        { label: 'Build', before: null, after: i.artifactName },
        { label: 'sha256', before: null, after: shortSha(i.sha256) },
      ],
      text: h.copyText,
    },
    {
      kind: 'action',
      action: RELEASE_ANNOUNCE_KIND,
      target: { label: where ? `${where} · Command Center ${relLabel(i.version, i.channel)}` : `Announce Command Center ${relLabel(i.version, i.channel)}`, url: null },
      input: { ...announce },
      changes: [
        { label: 'Post to', before: null, after: where ?? 'not set' },
        { label: 'Release', before: null, after: relLabel(i.version, i.channel) },
      ],
      text: a.text,
    },
  ];
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');

export function releaseUploadInputOf(dest: Pick<ActionDestination, 'input'>): ReleaseUploadInput {
  const i = dest.input as Partial<ReleaseUploadInput>;
  return {
    version: s(i.version),
    channel: i.channel === 'beta' ? 'beta' : 'stable',
    folderId: s(i.folderId),
    folderUrl: s(i.folderUrl) || null,
    artifactName: s(i.artifactName),
    sha256: s(i.sha256),
    bytes: typeof i.bytes === 'number' ? i.bytes : 0,
    files: Array.isArray(i.files) ? i.files.map((f) => ({ name: s(f?.name), path: s(f?.path), ...(f?.sha256 ? { sha256: s(f.sha256) } : {}), ...(typeof f?.bytes === 'number' ? { bytes: f.bytes } : {}) })) : [],
    copyText: s(i.copyText),
  };
}

export function releaseAnnounceInputOf(dest: Pick<ActionDestination, 'input'>): ReleaseAnnounceInput {
  const i = dest.input as Partial<ReleaseAnnounceInput>;
  return { version: s(i.version), channel: i.channel === 'beta' ? 'beta' : 'stable', channelId: s(i.channelId), channelName: s(i.channelName), text: s(i.text), sha256: s(i.sha256), folderId: s(i.folderId) };
}

/**
 * The exact payload of a release item: what the preview, the dry run and Apply use.
 *   release.announce      { tool: 'slack_send_message', channel, channelName, text, version } (the D-56 shape)
 *   release.drive_upload  { mode: 'handoff', version, folderId, folderUrl, files, sha256, copyText }: no `tool`, ever
 * An item that cannot go (no channel / folder, an empty or oversized post) carries `invalid`, which the adapter refuses.
 */
export function releaseActionPayload(dest: ActionDestination): Record<string, unknown> {
  if (dest.action === RELEASE_UPLOAD_KIND) {
    const u = releaseUploadInputOf(dest);
    return { mode: 'handoff', version: u.version, folderId: u.folderId, folderUrl: u.folderUrl, files: u.files, sha256: u.sha256, copyText: u.copyText, ...(u.folderId ? {} : { invalid: UNSET_FOLDER }) };
  }
  const a = releaseAnnounceInputOf(dest);
  const invalid = !RELEASE_CHANNEL_ID.test(a.channelId)
    ? UNSET_CHANNEL
    : !a.text.trim()
      ? 'the announcement is empty'
      : a.text.length > RELEASE_ANNOUNCE_MAX_CHARS
        ? `the announcement is ${a.text.length} characters; one post takes at most ${RELEASE_ANNOUNCE_MAX_CHARS}`
        : null;
  return { tool: 'slack_send_message', channel: a.channelId, channelName: a.channelName, text: a.text, version: a.version, ...(invalid ? { invalid } : {}) };
}

/**
 * Where a release item stands in an Outbox list: a release's two items stay together, at the newer one's place, the
 * upload first (you apply it first, and the announcement links the upload). null for anything else.
 */
export const releaseListRank = (dest: Destination): 0 | 1 | null => (dest?.kind !== 'action' ? null : dest.action === RELEASE_UPLOAD_KIND ? 0 : dest.action === RELEASE_ANNOUNCE_KIND ? 1 : null);

/** Newest first by `updatedAt`, a release's two items together and the upload above its announcement. */
export function sortOutboxNewestFirst<T extends { draft: { destination: Destination; updatedAt: string; id: string } }>(items: T[]): T[] {
  const pairAt = new Map<string, string>();
  for (const it of items) {
    if (releaseListRank(it.draft.destination) === null) continue;
    const v = releaseVersionOf(it.draft.destination);
    if ((pairAt.get(v) ?? '') < it.draft.updatedAt) pairAt.set(v, it.draft.updatedAt);
  }
  const at = (it: T) => (releaseListRank(it.draft.destination) === null ? it.draft.updatedAt : pairAt.get(releaseVersionOf(it.draft.destination))!);
  const pair = (it: T) => (releaseListRank(it.draft.destination) === null ? '' : `release:${releaseVersionOf(it.draft.destination)}`);
  return items.sort((a, b) => at(b).localeCompare(at(a)) || pair(a).localeCompare(pair(b)) || (releaseListRank(a.draft.destination) ?? 0) - (releaseListRank(b.draft.destination) ?? 0));
}

/** A `release.drive_upload` item: Apply marks it handed off (no tool call, no delivery, no job). */
export const isReleaseHandoff = (dest: Destination): dest is ActionDestination & { action: typeof RELEASE_UPLOAD_KIND } => dest?.kind === 'action' && dest.action === RELEASE_UPLOAD_KIND;
/** Either release item. */
export const isReleaseItem = (dest: Destination): dest is ActionDestination => dest?.kind === 'action' && (dest.action === RELEASE_UPLOAD_KIND || dest.action === RELEASE_ANNOUNCE_KIND);
/** The version a release item belongs to ('' for anything else). */
export const releaseVersionOf = (dest: Destination): string => (isReleaseItem(dest) ? s((dest.input as { version?: unknown }).version) : '');

/** What a release row shows besides its title: the version, where it goes, the sha256 short, what is not set. */
export interface ReleaseRowFacts {
  kind: 'upload' | 'announce';
  version: string;
  /** The Drive folder link (upload) or the channel (#name / id) the post goes to (announce); null when not set. */
  where: string | null;
  shaShort: string;
  /** What to set before this item can go, in words (null: nothing missing). */
  missing: string | null;
  /** upload: the exact "Copy upload instructions" text. */
  copyText: string | null;
}

export function releaseRowFacts(dest: ActionDestination): ReleaseRowFacts {
  if (dest.action === RELEASE_UPLOAD_KIND) {
    const u = releaseUploadInputOf(dest);
    return { kind: 'upload', version: u.version, where: u.folderUrl, shaShort: shortSha(u.sha256), missing: u.folderId ? null : MISSING_FOLDER, copyText: u.copyText };
  }
  const a = releaseAnnounceInputOf(dest);
  const ok = RELEASE_CHANNEL_ID.test(a.channelId);
  return { kind: 'announce', version: a.version, where: ok ? chanLabel(a.channelName, a.channelId) : null, shaShort: shortSha(a.sha256), missing: ok ? null : MISSING_CHANNEL, copyText: null };
}

/**
 * D-98-style landing of a handed-off upload (`record_landings` kind `release`, destination `drive`, record = the
 * version): ids, the folder, the build's name and sha256 only. Nothing was sent by the app: the user uploaded the files.
 */
export function releaseLanding(dest: ActionDestination): { recordId: string; destination: 'drive'; externalId: string | null; values: Record<string, string | null> } {
  const u = releaseUploadInputOf(dest);
  return { recordId: u.version, destination: 'drive', externalId: u.folderId || null, values: { version: u.version, channel: u.channel, folder: u.folderId || null, artifact: u.artifactName || null, sha256: u.sha256 || null, by: 'handoff' } };
}
