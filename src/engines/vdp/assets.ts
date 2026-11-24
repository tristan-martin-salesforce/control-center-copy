/**
 * VDP asset candidates (pure). What counts as an asset link, one key per asset (so a deck shared three times is one
 * candidate), dedupe against what the VDP already holds, and the deterministic matcher that attaches new Drive files,
 * Slack links, Gmail links and calendar attachments to the VDP of the account they are about, or to the VDP that
 * account does not have yet. No model call: unsure matches wait for the user's confirm (*tenet: Suggest, then learn*).
 *
 * An asset is a link VDP can hold (its assets are URL-only, research 02): Google Slides / Docs / Sheets / Drive files,
 * Slack canvases and files, recordings (Zoom, Gong, Loom, Vidyard, Drive video), Quip / SharePoint / Box documents,
 * PDFs, and demo-org links (those only ever "unsure"). Meeting joins, mail, Slack threads, Org62 records and VDP itself
 * are not assets.
 *
 * Which account an item is about, strongest first:
 *   1. the app already mapped it (a Drive file's account, a Slack channel mapped to the account)  → as mapped
 *   2. the asset's own title (or the event / subject) names the account                           → 0.8
 *   3. the message body mentions it, or the attendees' domains say so                              → at most 0.6
 * At 0.7 and above a candidate is `suggested` (a step); below it is `unsure` (a confirm).
 */
import type { VdpAssetKind, VdpCandidateSource } from '@/contract';

/** At or above: a step to add it. Below: a confirm first. */
export const SUGGEST_AT = 0.7;
/** Demo-org links are often record links of a demo, never sure enough to suggest. */
const DEMO_CAP = 0.55;

const DRIVE_ID_RE = /(?:docs\.google\.com\/(?:document|presentation|spreadsheets|drawings)\/(?:u\/\d+\/)?d\/|drive\.google\.com\/(?:file\/(?:u\/\d+\/)?d\/|open\?id=|uc\?(?:export=\w+&)?id=))([A-Za-z0-9_-]{20,})/;

/** The Google file id inside a Docs / Slides / Sheets / Drive link, else null. */
export function driveIdOf(url: string): string | null {
  return DRIVE_ID_RE.exec(url)?.[1] ?? null;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

/**
 * One key per asset: `drive:<fileId>` for Google files (whatever the link form: /edit, /view, ?usp=…), else the link
 * without scheme, `www.`, query, fragment and trailing slash, lower-cased host.
 */
export function assetKeyOf(url: string): string {
  const d = driveIdOf(url);
  if (d) return `drive:${d}`;
  try {
    const u = new URL(url.trim());
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path}`;
  } catch {
    return url.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
}

const RECORDING_HOSTS = /(^|\.)(gong\.io|loom\.com|vidyard\.com|chorus\.ai|wistia\.com|vimeo\.com)$/;
const DOC_HOSTS = /(^|\.)(quip\.com|sharepoint\.com|box\.com|dropbox\.com|notion\.so|lucid\.app|lucidchart\.com|miro\.com|figma\.com)$/;
const DEMO_HOSTS = /\.(my\.salesforce\.com|lightning\.force\.com|my\.site\.com|force\.com|salesforce-setup\.com)$/;
/** Internal systems whose links are records, not assets (Org62, GUS, the VDP app itself). */
const NOT_ASSET_HOSTS = /(^|\.)(org62\.|gus\.|vdp-app|herokuapp-internal\.com$)/;

function kindFromHint(mime: string | null | undefined, title: string | null | undefined): VdpAssetKind | null {
  const m = (mime ?? '').toLowerCase();
  const t = (title ?? '').toLowerCase();
  if (m.includes('presentation') || /\.(pptx?|key)$/.test(t)) return 'deck';
  if (m.includes('spreadsheet') || /\.(xlsx?|csv)$/.test(t)) return 'sheet';
  if (m.includes('pdf') || t.endsWith('.pdf')) return 'pdf';
  if (m.startsWith('video/') || m.startsWith('audio/') || /\.(mp4|mov|m4a|webm)$/.test(t)) return 'recording';
  if (m.includes('document') || m.includes('word') || /\.(docx?|txt|md)$/.test(t)) return 'doc';
  if (m.includes('folder')) return null;
  return null;
}

/** The asset kind of a link, or null when it is not an asset (a meeting join, a mail, a Slack thread, a record). */
export function assetKindOf(url: string, hint: { mime?: string | null; title?: string | null } = {}): VdpAssetKind | null {
  const host = hostOf(url);
  if (!host || !/^https?:/i.test(url.trim())) return null;
  if (NOT_ASSET_HOSTS.test(host)) return null;
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (host === 'docs.google.com') {
    if (path.startsWith('/presentation/')) return 'deck';
    if (path.startsWith('/document/')) return 'doc';
    if (path.startsWith('/spreadsheets/')) return 'sheet';
    if (path.startsWith('/drawings/')) return 'doc';
    return null; // forms, the docs home
  }
  if (host === 'drive.google.com') {
    if (path.includes('/folders/') || path === '/drive' || path.startsWith('/drive/my-drive')) return null;
    if (!driveIdOf(url)) return null;
    return kindFromHint(hint.mime, hint.title) ?? 'doc';
  }
  if (host === 'slides.google.com') return 'deck';
  if (host.endsWith('slack.com')) {
    if (/^\/(docs|canvas)\//.test(path)) return 'canvas';
    if (/^\/files\//.test(path) || host.startsWith('files.')) return kindFromHint(hint.mime, hint.title) ?? 'doc';
    return null; // archives (threads), app links
  }
  if (host.endsWith('zoom.us')) return /\/rec\//.test(path) ? 'recording' : null;
  if (RECORDING_HOSTS.test(host)) return 'recording';
  if (DOC_HOSTS.test(host)) return kindFromHint(hint.mime, hint.title) ?? 'doc';
  if (path.endsWith('.pdf')) return 'pdf';
  if (DEMO_HOSTS.test(host)) return 'demo';
  return null;
}

const KIND_NAME: Record<VdpAssetKind, string> = {
  deck: 'Google Slides deck',
  doc: 'Document',
  sheet: 'Spreadsheet',
  pdf: 'PDF',
  recording: 'Recording',
  demo: 'Demo org',
  canvas: 'Slack canvas',
  link: 'Link',
};

/** A title for a link that came without one: the file name in the path, else what it is ("Recording · gong.io"). */
export function titleForLink(url: string, kind: VdpAssetKind): string {
  const host = hostOf(url) ?? '';
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '');
    if (/[a-z]{3,}.*\.[a-z0-9]{2,5}$/i.test(last) && last.length <= 120) return last.replace(/[_+]/g, ' ');
  } catch {
    /* fall through */
  }
  return `${KIND_NAME[kind]} · ${host}`;
}

/**
 * VDP's asset type for an asset (the labels `list_asset_types` serves; add_vdp_asset matches them case-insensitively);
 * empty = leave it untyped. The title says the specific types VDPs actually carry: on 200 recent VDPs (all owners,
 * 2026-11-14) a quarter of the assets were estimate calculators, then architecture diagrams, consumption cards, BVDs,
 * planning sheets, RFPs, repos and demo videos, beside decks, docs and canvases.
 */
export function vdpAssetType(kind: VdpAssetKind, title?: string | null, url?: string | null): string {
  const t = (title ?? '').toLowerCase();
  const host = url ? (hostOf(url) ?? '') : '';
  if (kind === 'demo') return 'Demo Org';
  if (kind === 'recording') return DEMO_WORDS.test(t) ? 'Demo Video' : '';
  if (host === 'github.com') return 'Github Repo';
  if (/consumption card/.test(t)) return 'Consumption Card';
  if (/\b(estimate|estimator|calculator|pricing|sizing|credit(s)? (model|estimate)|consumption (model|estimate))\b/.test(t)) return 'Estimate Calculator';
  if (/\bbvd\b|business value/.test(t)) return 'BVD';
  if (/\brfp\b|\brfi\b/.test(t)) return 'RFP';
  if (/\barchitecture\b|\bdiagram\b|\bblueprint\b/.test(t) || /(^|\.)(lucid\.app|lucidchart\.com|miro\.com)$/.test(host)) return 'Architecture Diagram';
  if (kind === 'sheet' && /\b(plan|planning|inventory|tracker|roadmap)\b/.test(t)) return 'Google Sheets - Planning';
  return kind === 'deck' ? 'Deck' : kind === 'canvas' ? 'Canvas' : kind === 'doc' || kind === 'sheet' || kind === 'pdf' ? 'Doc' : '';
}

/**
 * VDP's asset types (the labels its `list_asset_types` served, 2026-11-14; every type `vdpAssetType` suggests is one):
 * the Type choice while the mirror has not stored the server's own list yet. Once it has, the server's list governs.
 */
export const VDP_ASSET_TYPES: readonly string[] = ['Deck', 'Doc', 'Canvas', 'Demo Org', 'Demo Video', 'Estimate Calculator', 'Architecture Diagram', 'BVD', 'Consumption Card', 'RFP', 'Github Repo', 'Google Sheets - Planning', 'Google Site', 'Prototype', 'Opportunity'];

/** The asset types an asset's Type picks from: VDP's own list once read, else VDP_ASSET_TYPES. */
export function assetTypeOptions(server: { assetTypes?: readonly string[] | null } | null | undefined): string[] {
  return server?.assetTypes?.length ? [...server.assetTypes] : [...VDP_ASSET_TYPES];
}

/** A value as one of a lookup's labels (case-insensitive, the way add_vdp_asset matches them), else null. */
export function matchLookup(value: string | null | undefined, options: readonly string[]): string | null {
  const v = (value ?? '').trim().toLowerCase();
  return v ? (options.find((o) => o.trim().toLowerCase() === v) ?? null) : null;
}

// ---------------------------------------------------------------------------
// What is worth a VDP's Assets tab (owner, 2026-11-14: "a repository: if we push too much non-helpful stuff in there
// then the value goes down")
// ---------------------------------------------------------------------------

const DEMO_WORDS = /\bdemo(s|nstration)?\b|walk-?through/i;
/** Google Meet's artifacts: "<event> - 2026/11/02 15:58 EST - Chat | Transcript | Recording | Notes by Gemini". */
const MEET_STAMP = /\d{4}\/\d{2}\/\d{2}\s+\d{1,2}:\d{2}\s+[A-Z]{2,5}\s*-\s*(chat|transcript|recording|notes by gemini|notes)\b/i;
const MEETING_NOTES = /\btranscripts?\b|\bnotes by gemini\b|\bgemini notes\b|\s-\s*chat$|^(watch )?video recap\b|^(meeting |mtg )?notes (from|on|of)\b|\b(meeting|mtg) notes\b/i;
/** Working material between colleagues: prep, syncs, agendas, team calls, 1:1s ("A / B - …", "A // B: …"). */
const INTERNAL = /^\W*(int|internal)\b|\binternal\b|\bprep\b|\bsync\b|\bweekly\b|\bstand-?up\b|\baccount team\b|\bagenda\b|\b1:1\b|\s\/\/\s|^[A-Z][a-z]+ \/ [A-Z][a-z]+\b/i;
const SCREEN_CAPTURE = /^(screen ?share|screen ?recording|screen ?shot|screenshot)\b/i;
const MEDIA_FILE = /\.(mp4|mov|m4a|mp3|webm|wav|mp)$/i;
/** titleForLink's fallback ("Document · drive.google.com") or a bare file id: nothing says what it is. */
const UNTITLED = /^(document|google slides deck|spreadsheet|pdf|recording|demo org|slack canvas|link) · |^[A-Za-z0-9_-]{25,}$/i;

export type AssetScreen = { keep: true; unsure: boolean } | { keep: false; reason: string };

/**
 * Is this worth a VDP's Assets tab? What VDPs hold (200 recent VDPs, all owners: decks, estimate calculators, docs,
 * canvases, demo orgs, architecture diagrams; meeting notes and recordings were about 1%), not everything a meeting
 * attached. Out: untitled links, Gemini notes / chats / transcripts, internal prep and syncs, screen captures, and
 * meeting recordings. A recording or video of a demo stays, but only as a confirm (owner: recordings are rare, and
 * welcome when they are real).
 */
export function screenAsset(a: { title: string | null; kind: VdpAssetKind }): AssetScreen {
  const t = (a.title ?? '').trim();
  if (!t || UNTITLED.test(t)) return { keep: false, reason: 'untitled: nothing says what it is' };
  if (MEETING_NOTES.test(t) || (MEET_STAMP.test(t) && !/-\s*recording\b/i.test(t))) return { keep: false, reason: "a meeting's notes, chat or transcript" };
  if (INTERNAL.test(t)) return { keep: false, reason: 'internal working material (prep, sync, agenda, team call)' };
  // "… - Recording", "… - 2026/10/26 Recording", "Recording 2": a recording, whatever its file kind says
  const media = a.kind === 'recording' || MEDIA_FILE.test(t) || /\brecording\b/i.test(t) || SCREEN_CAPTURE.test(t);
  if (media) return DEMO_WORDS.test(t) ? { keep: true, unsure: true } : { keep: false, reason: 'a meeting recording or screen capture' };
  return { keep: true, unsure: false };
}

/** A candidate as screened: an unsure keep is a confirm, never a suggested step. */
function screened<T extends { title: string; kind: VdpAssetKind; status: string }>(c: T): T | null {
  const v = screenAsset(c);
  if (!v.keep) return null;
  return v.unsure && c.status === 'suggested' ? { ...c, status: 'unsure' } : c;
}

/** Open drafts → the ones worth a VDP (screenAsset), media demoted to a confirm. */
export const screenDrafts = (drafts: readonly CandidateDraft[]): CandidateDraft[] => drafts.map((d) => screened(d)).filter((d): d is CandidateDraft => !!d);

/**
 * Stored candidates as the app shows them: open ones (suggested / unsure) that fail screenAsset are left out, media
 * becomes a confirm, and copies of one file ("Copy of X", "X (1).pptx") collapse to the newest one per target.
 * Added and dismissed ones stay as they are (they are history), and so does any candidate you set yourself
 * (`statusAt`: you confirmed it, or put it back): the screen never overrules your decision. Read-time, so a better rule
 * needs no data patch.
 */
export function screenCandidates<T extends { id: string; targetKey: string; title: string; kind: VdpAssetKind; status: string; firstSeenAt: string; statusAt?: string | null }>(list: readonly T[]): T[] {
  const open = (c: T) => (c.status === 'suggested' || c.status === 'unsure') && !c.statusAt;
  const newest = new Map<string, T>();
  for (const c of list) {
    if (!open(c)) continue;
    const s = screened(c);
    if (!s) continue;
    const nt = normTitle(c.title);
    const k = nt.length >= 8 ? `${c.targetKey}|t:${nt}` : `${c.targetKey}|id:${c.id}`;
    const cur = newest.get(k);
    if (!cur || s.firstSeenAt > cur.firstSeenAt) newest.set(k, s);
  }
  const winners = new Map([...newest.values()].map((c) => [c.id, c]));
  // the list's own order (oldest first), with the screened versions in place
  return list.flatMap((c) => (!open(c) ? [c] : winners.has(c.id) ? [winners.get(c.id)!] : []));
}

/** A title as two sightings of one file compare it: no extension, no "Copy of", no " (1)", no "(updated version)". */
const normTitle = (t: string | null | undefined) =>
  (t ?? '')
    .toLowerCase()
    .replace(/\s*\((?:\d+|updated[^)]*|[^)]*\bcopy|shared [^)]*)\)\s*$/g, '')
    .replace(/\.(pptx?|docx?|xlsx?|pdf|key|csv)$/, '')
    .replace(/\s*\((?:\d+|updated[^)]*|[^)]*\bcopy|shared [^)]*)\)\s*$/g, '')
    .replace(/^copy of\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The same asset: the same key, or (both titled) the same title of at least 8 characters. */
export function sameAsset(a: { url: string; title: string | null }, b: { url: string; title: string | null }): boolean {
  if (assetKeyOf(a.url) === assetKeyOf(b.url)) return true;
  const ta = normTitle(a.title);
  return ta.length >= 8 && ta === normTitle(b.title);
}

/** Is the asset already on the VDP (by link or title)? */
export const inVdp = (asset: { url: string; title: string | null }, vdpAssets: ReadonlyArray<{ url: string; title: string | null }>): boolean => vdpAssets.some((v) => sameAsset(asset, v));

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

/** Where candidates for one account (or one VDP without an account) go. */
export interface AssetTarget {
  /** The account id, else `vdp:<slug>`. */
  key: string;
  accountId: string | null;
  /** The VDP they go on (the account's newest live VDP); null = none yet. */
  vdpSlug: string | null;
  companyName: string;
  /** Assets already on that VDP. */
  inVdp: ReadonlyArray<{ url: string; title: string | null }>;
}

export interface AssetLink {
  url: string;
  title: string | null;
  mime: string | null;
}

export interface AssetItem {
  sourceItemId: string;
  source: VdpCandidateSource['source'];
  /** The subject, event title or file title. */
  title: string | null;
  /** Title + excerpt, for "mentions the account". */
  text: string;
  /** The source's own deep link (provenance). */
  url: string | null;
  at: string;
  /** "#acme-ext", "Gmail · Re: pricing", "Calendar · ACME QBR", "Drive" */
  label: string;
  /** The account the app already mapped the item to (a Drive file's account, the channel's account). */
  mapped: { accountId: string; confidence: number; via: string } | null;
  /** External participant domains (mail, meetings). */
  domains: readonly string[];
  /** The asset links it carries (a Drive file: itself). */
  links: AssetLink[];
}

/** Account resolution by text and domains (src/projections/matching.ts `Matcher.resolve`). */
export type AccountResolver = (text: string, domains: readonly string[]) => { accountId: string; confidence: number; via: string } | null;

export interface CandidateDraft {
  targetKey: string;
  vdpSlug: string | null;
  accountId: string | null;
  companyName: string;
  title: string;
  url: string;
  assetKey: string;
  kind: VdpAssetKind;
  why: string;
  confidence: number;
  status: 'unsure' | 'suggested';
  sources: VdpCandidateSource[];
  sourceItemIds: string[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * New source items → asset candidates for the targets (my VDPs and engaged accounts without one). Items about another
 * account, links that are not assets, and assets the VDP already holds yield nothing. Repeats of one asset in the batch
 * merge (highest confidence, every source).
 */
export function matchAssetItems(items: readonly AssetItem[], targets: readonly AssetTarget[], resolve: AccountResolver): CandidateDraft[] {
  const byAccount = new Map(targets.filter((t) => t.accountId).map((t) => [t.accountId!, t]));
  const out = new Map<string, CandidateDraft>();
  for (const it of items) {
    for (const link of it.links) {
      const kind = assetKindOf(link.url, { mime: link.mime, title: link.title });
      if (!kind) continue;
      const title = (link.title?.trim() || null) ?? (it.source === 'drive' ? it.title : null) ?? titleForLink(link.url, kind);
      // which account, strongest signal first
      let hit: { accountId: string; confidence: number; why: string } | null = null;
      if (it.mapped && byAccount.has(it.mapped.accountId)) hit = { accountId: it.mapped.accountId, confidence: Math.min(0.9, it.mapped.confidence), why: it.mapped.via };
      const byTitle = resolve([link.title, it.source === 'drive' || it.source === 'calendar' || it.source === 'gmail' ? it.title : null].filter(Boolean).join(' · '), []);
      if (byTitle && byAccount.has(byTitle.accountId) && (!hit || hit.confidence < 0.8)) hit = { accountId: byTitle.accountId, confidence: 0.8, why: `its title names ${byAccount.get(byTitle.accountId)!.companyName}` };
      if (!hit) {
        const byText = resolve(it.text, it.domains);
        if (byText && byAccount.has(byText.accountId)) hit = { accountId: byText.accountId, confidence: Math.min(0.6, byText.confidence), why: byText.via === 'domain' ? `shared with ${byAccount.get(byText.accountId)!.companyName} people` : `the message mentions ${byAccount.get(byText.accountId)!.companyName}` };
      }
      if (!hit) continue;
      const target = byAccount.get(hit.accountId)!;
      if (inVdp({ url: link.url, title }, target.inVdp)) continue;
      const confidence = round3(kind === 'demo' ? Math.min(DEMO_CAP, hit.confidence) : hit.confidence);
      const assetKey = assetKeyOf(link.url);
      const source: VdpCandidateSource = { source: it.source, label: it.label, url: it.url, at: it.at };
      const where = it.source === 'drive' ? 'A Drive file' : `Shared in ${it.label}`;
      const draft: CandidateDraft = {
        targetKey: target.key,
        vdpSlug: target.vdpSlug,
        accountId: target.accountId,
        companyName: target.companyName,
        title: title.slice(0, 300),
        url: link.url,
        assetKey,
        kind,
        why: `${where}: ${hit.why}`.slice(0, 300),
        confidence,
        status: confidence >= SUGGEST_AT ? 'suggested' : 'unsure',
        sources: [source],
        sourceItemIds: [it.sourceItemId],
      };
      const k = `${target.key}|${assetKey}`;
      const cur = out.get(k);
      if (!cur) out.set(k, draft);
      else out.set(k, mergeDraft(cur, draft));
    }
  }
  // only what is worth a VDP: a calendar's Gemini chat log, a prep doc or an untitled attachment is not an asset
  return screenDrafts([...out.values()]);
}

/**
 * Two sightings of one asset: the stronger one's title, kind and reason; both sources, every one (tenet *Provenance on
 * everything*; caps audit 2026-11-21: the merge kept 8 sources and 20 source items and dropped the rest).
 */
export function mergeDraft(a: CandidateDraft, b: CandidateDraft): CandidateDraft {
  const [hi, lo] = b.confidence > a.confidence ? [b, a] : [a, b];
  const sources = [...hi.sources, ...lo.sources.filter((s) => !hi.sources.some((x) => x.url === s.url && x.label === s.label))];
  const sourceItemIds = [...new Set([...hi.sourceItemIds, ...lo.sourceItemIds])];
  // a real title wins over the stronger sighting's placeholder ("Document · drive.google.com"), or the screen drops it
  const title = UNTITLED.test(hi.title.trim()) && !UNTITLED.test(lo.title.trim()) ? lo.title : hi.title;
  return { ...hi, title, sources, sourceItemIds };
}

/** Raw link-like strings (Slack `drive:<id>` / `url:<u>` refs, bare Drive ids) → links. */
export function linksFromRefs(refs: readonly string[], titles: ReadonlyMap<string, { title: string | null; mime: string | null; url: string | null }> = new Map()): AssetLink[] {
  const out: AssetLink[] = [];
  for (const r of refs) {
    const v = r.replace(/^(drive|url):/, '');
    if (/^https?:\/\//i.test(v)) {
      const id = driveIdOf(v);
      const known = id ? titles.get(id) : undefined;
      out.push({ url: v, title: known?.title ?? null, mime: known?.mime ?? null });
    } else if (/^[A-Za-z0-9_-]{20,}$/.test(v)) {
      const known = titles.get(v);
      out.push({ url: known?.url ?? `https://drive.google.com/file/d/${v}/view`, title: known?.title ?? null, mime: known?.mime ?? null });
    }
  }
  return out;
}

/** http(s) links in a text (mail bodies, descriptions), without trailing punctuation; every distinct one unless `max`. */
export function linksInText(text: string, max = Number.POSITIVE_INFINITY): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s<>|)"'\]]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))].slice(0, max);
}
