/**
 * Drive forward-sampling fetcher (R-UI-15, brief 09 §6.2). Scope `tracked`.
 *
 *   1. Change feed (free):  search_drive_files("modifiedTime > '<cursor - 2 m>'") each run.
 *   2. Tracked set: files linked to open items (`linked()` provider, fed from ScanContext by the runtime)
 *      plus files Tristan edited in the last 30 days (learned from the feed, kept in the cursor).
 *   3. Sample a tracked file only when its modifiedTime moved (or a settle sample is due), throttled to >= 10 min per file.
 *      The first sample is a silent baseline.
 *   4. Digest -> diff against the last *committed* sample (the cursor holds its hash), so a killed run re-diffs identically.
 *   5. Emit `file_revision` only when the digest changed.
 *   6. The first run (no feed cursor) also emits one record-only `file_revision` per Google editor file I last edited
 *      in the lookback, tagged `history` (DRV-1): baselines have nothing to diff, so a 30-day first scan used to give
 *      the Time page and the assets no Drive history at all.
 *   7. A backfill window that ended a day or more behind the feed's frontier (FS-DRIVE-1: the first scan runs oldest
 *      first, so after the first window nearly every later one did) lists exactly its own window, records my editor
 *      files in it as the same history items, and hands the cursor back unchanged; any other window that starts behind
 *      the frontier reads the feed from its own start. Before, both read the feed from the frontier (now - 2 m), so the
 *      window clamp left them no coverage at their start and every such run failed with a hole.
 *
 * No LLM. Fetching content only when modifiedTime moved keeps it cheap.
 */
import type { ConnectorHealthProbe, CoverageObject, Cursor, DeterministicFetcher, FetchResult, NormalizedSourceItem, TimeWindow } from '@/scanner/types';
import { GoogleCallError, type GoogleTools } from '@/connectors/google/client';
import type { Me } from '@/connectors/google/gmail';
import { parseDriveSearch, parseSpreadsheetSheets, type DriveFileRow } from '@/connectors/google/parse';
import { redact } from '@/connectors/redact';
import { decodeCursor, encodeCursor, h16, systemClock, throwIfAborted, type Clock } from '@/connectors/util';
import { digestDoc, digestOpaque, digestPresentation, digestSheet, kindFromMime } from './digest';
import { diffSamples } from './diff';
import type { DigestStore, DriveDigest, DriveFileKind, DriveSample, DriveUser } from './types';

export type TrackedRef = string | { id: string; kind?: DriveFileKind };

interface FileState {
  /** modifiedTime of the committed sample */
  m: string;
  /** digest hash of the committed sample */
  h: string;
  /** when it was sampled */
  s: string;
  k: DriveFileKind;
  /** A settle sample is due 15 min after `m`. */
  settle?: boolean;
  /** A newer modifiedTime was seen but the sample was throttled or capped. */
  pend?: string;
}

interface DriveCursor {
  feedAt: string | null;
  /** Files I edited in the last 30 d: id -> { m: modifiedTime, k: kind } */
  mine: Record<string, { m: string; k: DriveFileKind }>;
  files: Record<string, FileState>;
}

export interface DriveFetcherOptions {
  google: GoogleTools;
  me: Me;
  store: DigestStore;
  /** Files linked to open work items (from ScanContext.openItems[].fileRefs). */
  linked?: () => Promise<TrackedRef[]>;
  clock?: Clock;
  editedLookbackDays?: number;
  throttleMin?: number;
  settleMin?: number;
  maxSamplesPerRun?: number;
  maxFeedPages?: number;
  /** Pages of the first feed (no cursor yet): it reads the whole edited-lookback, not just the last minutes. */
  maxFirstFeedPages?: number;
  feedPageSize?: number;
  maxSheetTabs?: number;
}

const FEED_OVERLAP_MS = 120_000;
/** FS-DRIVE-1: a window that ended this far behind the feed's frontier is history (a first-scan backfill window), not a late poll. */
const HISTORY_BEHIND_MS = 24 * 3600_000;
/** Folders and shortcuts never carry content: in a real 30-day feed they were a third of the rows (DRV-1). */
const FEED_QUERY_EXCLUDES = "mimeType != 'application/vnd.google-apps.folder' and mimeType != 'application/vnd.google-apps.shortcut'";
const EDITOR_KINDS = new Set<DriveFileKind>(['slides', 'doc', 'sheet']);

export class DriveFetcher implements DeterministicFetcher {
  readonly connector = 'drive' as const;
  private readonly g: GoogleTools;
  private readonly o: Required<Omit<DriveFetcherOptions, 'google' | 'me' | 'store' | 'linked' | 'clock'>>;
  private readonly me: Me;
  private readonly store: DigestStore;
  private readonly linked: () => Promise<TrackedRef[]>;
  private readonly clock: Clock;

  constructor(opts: DriveFetcherOptions) {
    this.g = opts.google;
    this.me = opts.me;
    this.store = opts.store;
    this.linked = opts.linked ?? (async () => []);
    this.clock = opts.clock ?? systemClock;
    this.o = {
      editedLookbackDays: opts.editedLookbackDays ?? 30,
      throttleMin: opts.throttleMin ?? 10,
      settleMin: opts.settleMin ?? 15,
      maxSamplesPerRun: opts.maxSamplesPerRun ?? 15,
      maxFeedPages: opts.maxFeedPages ?? 4,
      maxFirstFeedPages: opts.maxFirstFeedPages ?? 20,
      feedPageSize: opts.feedPageSize ?? 50,
      // tabs read per sample, one Sheets read call each (A1:Z300): bounded by the Sheets API's per-user read quota
      // (60 a minute) across a run's samples; a sheet with more tabs records how many were not read (sheetsNotRead)
      maxSheetTabs: opts.maxSheetTabs ?? 8,
    };
  }

  async scopes(): Promise<string[]> {
    return ['tracked'];
  }

  health(): Promise<ConnectorHealthProbe> {
    return this.g.health();
  }

  private isMine(r: DriveFileRow): boolean {
    return !!r.lastEditedByEmail && r.lastEditedByEmail === this.me.email.toLowerCase();
  }

  private async feed(from: Date, signal: AbortSignal, maxPages = this.o.maxFeedPages, to?: Date): Promise<{ rows: DriveFileRow[]; truncated: boolean }> {
    const upTo = to ? ` and modifiedTime <= '${to.toISOString()}'` : '';
    const rows: DriveFileRow[] = [];
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      throwIfAborted(signal);
      const text = await this.g.call(
        'search_drive_files',
        { query: `modifiedTime > '${from.toISOString()}'${upTo} and trashed = false and ${FEED_QUERY_EXCLUDES}`, detailed: true, page_size: this.o.feedPageSize, include_items_from_all_drives: true, ...(token ? { page_token: token } : {}) },
        { signal },
      );
      const p = parseDriveSearch(text);
      rows.push(...p.files);
      token = p.nextPageToken;
      if (!token) return { rows, truncated: false };
    }
    return { rows, truncated: true };
  }

  async listForReconcile(_scope: string, window: TimeWindow, opts: { signal: AbortSignal }): Promise<CoverageObject[]> {
    const { rows } = await this.feed(new Date(Date.parse(window.from)), opts.signal);
    const linked = new Set((await this.linked()).map((r) => (typeof r === 'string' ? r : r.id)));
    return rows
      .filter((r) => kindFromMime(r.mimeType) !== 'other' || linked.has(r.id))
      .filter((r) => Date.parse(r.modified) < Date.parse(window.to) && (this.isMine(r) || linked.has(r.id)))
      .map((r) => ({ kind: 'file' as const, ref: r.id, from: r.modified, to: r.modified, meta: { name: redact(r.name).text } }));
  }

  /** Reads the file and builds a digest. `kindHint` skips probing; unknown kinds are probed slides -> doc -> sheet. */
  private async digestFile(id: string, kindHint: DriveFileKind | undefined, row: DriveFileRow | undefined, signal: AbortSignal): Promise<DriveDigest> {
    const kind = kindHint ?? (row ? kindFromMime(row.mimeType) : undefined);
    const tryKind = async (k: DriveFileKind): Promise<DriveDigest> => {
      if (k === 'slides') return digestPresentation(id, await this.g.call('get_presentation', { presentation_id: id }, { signal }));
      if (k === 'doc') return digestDoc(id, row?.name ?? '', await this.g.call('get_doc_as_markdown', { document_id: id, include_comments: false }, { signal }));
      if (k === 'sheet') {
        const info = await this.g.call('get_spreadsheet_info', { spreadsheet_id: id }, { signal });
        const title = info.match(/^Spreadsheet:\s*"([^"]*)"/m)?.[1] ?? row?.name ?? '';
        const all = parseSpreadsheetSheets(info);
        const tabs = all.slice(0, this.o.maxSheetTabs);
        const out: Array<{ name: string; size?: string; values: string }> = [];
        for (const t of tabs) {
          throwIfAborted(signal);
          const values = await this.g.call('read_sheet_values', { spreadsheet_id: id, range_name: `'${t.name.replace(/'/g, "''")}'!A1:Z300` }, { signal });
          out.push({ name: t.name, size: t.size, values });
        }
        return digestSheet(id, title, out, all.length - tabs.length);
      }
      return digestOpaque(id, row?.name ?? '', row?.size, row?.mimeType);
    };
    if (kind) return tryKind(kind);
    let lastErr: unknown;
    for (const k of ['slides', 'doc', 'sheet'] as const) {
      try {
        return await tryKind(k);
      } catch (e) {
        if (e instanceof GoogleCallError && (e.info.objectScoped || e.info.errorClass === 'config' || e.info.errorClass === 'unknown')) {
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  async fetch(_scope: string, cursor: Cursor | null, window: TimeWindow, opts: { signal: AbortSignal; limit?: number }): Promise<FetchResult> {
    const now = this.clock();
    const prev = decodeCursor<DriveCursor>(cursor, { feedAt: null, mine: {}, files: {} });
    // FS-DRIVE-1: the feed reads forward from its frontier, so a window that ended a day or more behind it lists itself
    // (fetchHistory), and any other window that starts behind it reads the feed from the window's start: coverage
    // always reaches back to window.from.
    const frontier = prev.feedAt ? Date.parse(prev.feedAt) - FEED_OVERLAP_MS : null;
    if (cursor && frontier !== null && Date.parse(window.to) <= frontier - HISTORY_BEHIND_MS) return this.fetchHistory(cursor, window, opts.signal);
    const cur: DriveCursor = { feedAt: prev.feedAt, mine: { ...prev.mine }, files: { ...prev.files } };
    const lookbackMs = this.o.editedLookbackDays * 86400_000;
    const feedFrom = new Date(frontier !== null ? Math.min(frontier, Date.parse(window.from)) : Math.min(Date.parse(window.from), now.getTime() - lookbackMs));

    const first = !prev.feedAt;
    const { rows, truncated } = await this.feed(feedFrom, opts.signal, first ? this.o.maxFirstFeedPages : this.o.maxFeedPages);
    const rowById = new Map(rows.map((r) => [r.id, r]));

    // Learn "files I edited recently".
    for (const r of rows) {
      const k = kindFromMime(r.mimeType);
      if (this.isMine(r) && r.mimeType !== 'application/vnd.google-apps.folder') cur.mine[r.id] = { m: r.modified, k };
    }
    for (const [id, v] of Object.entries(cur.mine)) if (Date.parse(v.m) < now.getTime() - lookbackMs) delete cur.mine[id];

    const linkedRefs = (await this.linked()).map((r) => (typeof r === 'string' ? { id: r } : r));
    const kindHints = new Map<string, DriveFileKind | undefined>(linkedRefs.map((r) => [r.id, r.kind]));
    const tracked = new Set<string>([...linkedRefs.map((r) => r.id), ...Object.keys(cur.mine)]);
    for (const id of Object.keys(cur.files)) if (!tracked.has(id)) delete cur.files[id]; // no longer tracked

    const limit = Math.min(opts.limit ?? this.o.maxSamplesPerRun, this.o.maxSamplesPerRun);
    const items: NormalizedSourceItem[] = [];
    const coverage: CoverageObject[] = [
      { kind: 'query_window', ref: 'drive:feed', from: feedFrom.toISOString(), to: now.toISOString(), meta: { rows: rows.length, truncated, tracked: tracked.size } },
    ];
    let sampled = 0;
    let _deferred = 0;
    let capped = 0;

    for (const id of tracked) {
      throwIfAborted(opts.signal);
      const st = cur.files[id];
      const row = rowById.get(id);
      const rowM = row?.modified;
      const nowMs = now.getTime();

      let reason: 'baseline' | 'modified' | 'pending' | 'settle' | null = null;
      if (!st) reason = 'baseline';
      else if (rowM && rowM !== st.m) reason = 'modified';
      else if (st.pend) reason = 'pending';
      else if (st.settle && nowMs >= Date.parse(st.m) + this.o.settleMin * 60_000) reason = 'settle';
      if (!reason) {
        coverage.push({ kind: 'file', ref: id, from: st?.m, to: st?.m, meta: { sampled: false, unchanged: true } });
        continue;
      }
      // Throttle (never for baselines).
      if (st && reason !== 'settle' && nowMs - Date.parse(st.s) < this.o.throttleMin * 60_000) {
        cur.files[id] = { ...st, pend: rowM ?? st.pend ?? st.m };
        coverage.push({ kind: 'file', ref: id, from: st.m, to: rowM ?? st.m, meta: { sampled: false, throttled: true } });
        _deferred++;
        continue;
      }
      if (sampled >= limit) {
        if (st) cur.files[id] = { ...st, pend: rowM ?? st.pend ?? st.m };
        capped++;
        continue;
      }

      let digest: DriveDigest;
      try {
        digest = await this.digestFile(id, kindHints.get(id) ?? st?.k ?? cur.mine[id]?.k, row, opts.signal);
      } catch (e) {
        if (e instanceof GoogleCallError && e.info.objectScoped) {
          coverage.push({ kind: 'file', ref: id, meta: { sampled: false, error: e.info.signature } });
          continue;
        }
        throw e;
      }
      sampled++;
      const modifiedTime = rowM ?? st?.m ?? now.toISOString();
      const user: DriveUser | undefined = row ? { name: row.lastEditedByName, email: row.lastEditedByEmail } : undefined;
      const sample: DriveSample = { fileId: id, sampledAt: now.toISOString(), modifiedTime, lastModifyingUser: user, digest };
      await this.store.put(sample);

      const settle = nowMs - Date.parse(modifiedTime) < this.o.settleMin * 60_000;
      const next: FileState = { m: modifiedTime, h: digest.digestHash, s: now.toISOString(), k: digest.kind, settle: settle || undefined };
      const meta: Record<string, unknown> = { sampled: true, reason, kind: digest.kind };

      if (!st) {
        meta.baseline = true; // pre-baseline edits are unknown
      } else if (st.h === digest.digestHash) {
        meta.modifiedOnly = rowM !== st.m; // touched but nothing the digest can see (e.g. image-only edit)
      } else {
        const prevSample = await this.store.getByHash(id, st.h);
        if (!prevSample) {
          meta.baselineLost = true;
        } else {
          const change = diffSamples(prevSample, sample);
          if (change) items.push(this.toItem(sample, change, row));
        }
      }
      cur.files[id] = next;
      coverage.push({ kind: 'file', ref: id, from: modifiedTime, to: modifiedTime, meta });
    }

    // DRV-1: on the first run every tracked file is a baseline (no diff items can exist), so the history items are the
    // run's only items and the run is record-only: the scan-drive skill interprets diffs, and there are none.
    if (first) {
      for (const r of rows) {
        const k = kindFromMime(r.mimeType);
        if (this.isMine(r) && EDITOR_KINDS.has(k) && Date.parse(r.modified) >= now.getTime() - lookbackMs) items.push(this.historyItem(r, k));
      }
    }
    const complete = capped === 0 && !truncated;
    // Feed progress: only move when the whole feed was read; deferred files carry `pend` state so nothing is lost.
    if (!truncated || !prev.feedAt) cur.feedAt = now.toISOString();
    return { items, coverage, nextCursor: encodeCursor(cur, now.toISOString()), complete, ...(first ? { recordOnly: true } : {}) };
  }

  /**
   * FS-DRIVE-1: a window that ended a day or more behind the feed's frontier (an oldest-first backfill window after
   * the first feed). The
   * feed only moves forward, so it cannot speak for this window; list the window itself (bounded both ends) instead.
   * Record-only history of my editor files in it (the same items as the first run's, so a repeat is unchanged), no
   * sampling, and the cursor value handed back unchanged, so the feed state (frontier, tracked files, baselines) never
   * moves backwards. Like the first feed, a listing cut at the page limit still claims the window (rows have no order to
   * claim a part by) and reports itself incomplete.
   */
  private async fetchHistory(cursor: Cursor, window: TimeWindow, signal: AbortSignal): Promise<FetchResult> {
    const from = new Date(Date.parse(window.from));
    const to = new Date(Date.parse(window.to));
    const { rows, truncated } = await this.feed(from, signal, this.o.maxFirstFeedPages, to);
    const items: NormalizedSourceItem[] = [];
    for (const r of rows) {
      const k = kindFromMime(r.mimeType);
      if (this.isMine(r) && EDITOR_KINDS.has(k)) items.push(this.historyItem(r, k));
    }
    const coverage: CoverageObject[] = [
      { kind: 'query_window', ref: 'drive:feed', from: from.toISOString(), to: to.toISOString(), meta: { rows: rows.length, truncated, history: true } },
    ];
    return { items, coverage, nextCursor: { value: cursor.value, at: to.toISOString() }, complete: !truncated, recordOnly: true };
  }

  /** A file I last edited before the first scan: its last edit only (the feed has no revision history), no change digest. */
  private historyItem(r: DriveFileRow, kind: DriveFileKind): NormalizedSourceItem {
    const kindWord = kind === 'slides' ? 'deck' : kind === 'doc' ? 'doc' : 'sheet';
    const user: DriveUser = { name: r.lastEditedByName, email: r.lastEditedByEmail };
    return {
      connector: 'drive',
      kind: 'file_revision',
      externalId: `${r.id}@${r.modified}`,
      dedupeKey: `drive:${r.id}@${r.modified}`,
      contentHash: h16('history', r.id, r.modified),
      occurredAt: r.modified,
      author: { name: user.name, email: user.email, isMe: true },
      permalink: editorUrl(r.id, kind) ?? r.link,
      title: redact(r.name).text,
      excerpt: `${kindWord} last edited by me (before the first scan; no change digest)`,
      redacted: false,
      fileRefs: [r.id],
      payload: { fileId: r.id, fileKind: kind, modifiedTime: r.modified, lastModifyingUser: user, editedByMe: true, history: true },
    };
  }

  private toItem(s: DriveSample, change: NonNullable<ReturnType<typeof diffSamples>>, row?: DriveFileRow): NormalizedSourceItem {
    const user = s.lastModifyingUser;
    const isMe = !!user?.email && user.email === this.me.email.toLowerCase();
    const title = redact(row?.name ?? s.digest.title).text;
    const kindWord = s.digest.kind === 'slides' ? 'deck' : s.digest.kind === 'doc' ? 'doc' : s.digest.kind === 'sheet' ? 'sheet' : 'file';
    const permalink = editorUrl(s.fileId, s.digest.kind) ?? row?.link;
    return {
      connector: 'drive',
      kind: 'file_revision',
      externalId: `${s.fileId}@${s.modifiedTime}`,
      dedupeKey: `drive:${s.fileId}@${s.modifiedTime}`,
      contentHash: s.digest.digestHash,
      occurredAt: s.modifiedTime,
      author: user ? { name: user.name, email: user.email, isMe } : undefined,
      permalink,
      title,
      excerpt: redact(`${kindWord} edited${isMe ? ' by me' : user?.name ? ' by ' + user.name : ''}: ${change.summary}`).text.slice(0, 1000),
      redacted: false,
      fileRefs: [s.fileId],
      payload: {
        fileId: s.fileId,
        fileKind: s.digest.kind,
        modifiedTime: s.modifiedTime,
        lastModifyingUser: user,
        editedByMe: isMe,
        sampledAt: s.sampledAt,
        change,
        contentKey: h16(s.digest.digestHash),
      },
    };
  }
}

function editorUrl(fileId: string, kind: DriveFileKind): string | undefined {
  if (kind === 'slides') return `https://docs.google.com/presentation/d/${fileId}/edit`;
  if (kind === 'doc') return `https://docs.google.com/document/d/${fileId}/edit`;
  if (kind === 'sheet') return `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
  return undefined;
}
