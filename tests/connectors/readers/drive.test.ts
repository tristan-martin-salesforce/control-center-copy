import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDriveSearch, parsePresentation, parseDocSections, parseSpreadsheetSheets } from '@/connectors/google/parse';
import { DriveFetcher, digestDoc, digestPresentation, digestSheet, diffDigests, diffSamples, FileDigestStore, MemoryDigestStore, type DriveSample } from '@/scanner/drive-digest';
import { classifyGoogleError, GoogleCallError } from '@/connectors/google/client';
import { FakeGoogle, fx, ME, signal, WINDOW } from './helpers';

const DECK = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const pres = (v: string) => fx('drive', `presentation_${v}.txt`);
const d = (v: string) => digestPresentation(DECK, pres(v));

describe('drive parsers', () => {
  it('parses search rows with last editor', () => {
    const p = parseDriveSearch(fx('drive', 'feed_deck_modified.txt'));
    expect(p.files).toHaveLength(2);
    expect(p.files[0]).toMatchObject({ id: DECK, mimeType: 'application/vnd.google-apps.presentation', modified: '2026-03-10T17:20:00.000Z', lastEditedByEmail: 'me@example.com' });
  });
  it('parses slides with object ids, element counts and text', () => {
    const p = parsePresentation(pres('v1'));
    expect(p.slides.map((s) => [s.n, s.objectId, s.elementCount])).toEqual([[1, 'p_title', 2], [2, 'p_agenda', 6], [3, 'p_arch', 9], [4, 'p_logo', 3]]);
    expect(p.slides[2]!.lines[1]).toBe('Snowflake to Data 360 via batch ingest');
  });
  it('splits docs by heading and cuts at the transcript', () => {
    const s = parseDocSections(fx('drive', 'doc_v1.md'));
    expect(s.map((x) => x.heading)).toEqual(['ACME_CORP requirements', 'Data sources', 'Security']);
  });
  it('lists sheet tabs', () => {
    expect(parseSpreadsheetSheets(fx('drive', 'sheet_info.txt'))).toEqual([{ name: 'Inputs', size: '100x10' }, { name: 'Outputs', size: '50x6' }]);
  });
});

describe('drive digest + diff', () => {
  it('no change means no diff (identical digest)', () => {
    expect(diffDigests(d('v1'), d('v1'))).toBeNull();
    // A touch that changes nothing the digest can see (e.g. an image-only edit) is also "no change".
    expect(diffDigests(d('v1'), digestPresentation(DECK, pres('v1_touched')))).toBeNull();
  });

  it('edit a slide: reports the changed slide with before/after text and the changed lines', () => {
    const diff = diffDigests(d('v1'), digestPresentation(DECK, pres('v2').replace(/  Slide 5[\s\S]*$/, '').replace('Total Slides: 5', 'Total Slides: 4')))!;
    expect(diff.slides!.changed).toHaveLength(1);
    const c = diff.slides!.changed[0]!;
    expect(c).toMatchObject({ objectId: 'p_arch', n: 3, kinds: ['text'] });
    expect(c.before).toContain('batch ingest');
    expect(c.after).toContain('zero-copy');
    expect(c.linesAdded).toEqual(['Snowflake zero-copy to Data 360']);
    expect(c.linesRemoved).toEqual(['Snowflake to Data 360 via batch ingest']);
    expect(diff.counts).toEqual({ added: 0, removed: 0, changed: 1, moved: 0 });
  });

  it('add a slide', () => {
    const diff = diffDigests(d('v1'), d('v2'))!;
    expect(diff.slides!.added).toEqual([expect.objectContaining({ objectId: 'p_privconn', n: 5, title: 'Private Connect for GCP' })]);
    expect(diff.slides!.countBefore).toBe(4);
    expect(diff.slides!.countAfter).toBe(5);
    expect(diff.summary).toMatch(/1 slide added/);
  });

  it('remove a slide', () => {
    const diff = diffDigests(d('v2'), d('v3'))!;
    expect(diff.slides!.removed).toEqual([expect.objectContaining({ objectId: 'p_logo', title: 'Thank you' })]);
    expect(diff.slides!.added).toHaveLength(0);
    expect(diff.counts.removed).toBe(1);
  });

  it('moving a slide is one move, not a pile of changes', () => {
    const diff = diffDigests(d('v3'), d('v4'))!;
    expect(diff.slides!.moved).toHaveLength(1);
    expect(diff.slides!.moved[0]!.objectId).toMatch(/p_arch|p_privconn/);
    expect(diff.slides!.changed).toHaveLength(0);
  });

  it('element-count changes are reported (the only signal for image swaps) and the limits are stated', () => {
    const edited = pres('v1').replace('Slide 4: ID p_logo, 3 element(s)', 'Slide 4: ID p_logo, 4 element(s)');
    const diff = diffDigests(d('v1'), digestPresentation(DECK, edited))!;
    expect(diff.slides!.changed[0]).toMatchObject({ objectId: 'p_logo', kinds: ['elements'], elementCountBefore: 3, elementCountAfter: 4 });
    expect(diff.limits.join(' ')).toMatch(/Image, logo/);
  });

  it('docs: per-heading section hashes, added and changed sections', () => {
    const a = digestDoc('doc1', 'Reqs', fx('drive', 'doc_v1.md'));
    const b = digestDoc('doc1', 'Reqs', fx('drive', 'doc_v2.md'));
    expect(a.sections!.map((s) => s.key)).toEqual(['ACME_CORP requirements#1', 'Data sources#1', 'Security#1']);
    const diff = diffDigests(a, b)!;
    expect(diff.sections!.changed.map((c) => c.heading)).toEqual(['Data sources', 'Security']);
    expect(diff.sections!.changed[1]!.linesAdded).toEqual(['Private Connect for GCP is in scope.']);
    expect(diffDigests(a, digestDoc('doc1', 'Reqs', fx('drive', 'doc_v1.md')))).toBeNull();
    const withNew = digestDoc('doc1', 'Reqs', fx('drive', 'doc_v1.md') + '\n## Pricing\n\nTBD\n');
    // the new section goes before the cut transcript marker in v1, so insert before it:
    const md = fx('drive', 'doc_v1.md').replace('# Transcript', '## Pricing\n\nTBD\n\n# Transcript');
    expect(diffDigests(a, digestDoc('doc1', 'Reqs', md))!.sections!.added.map((s) => s.heading)).toEqual(['Pricing']);
    void withNew;
  });

  it('docs: the transcript is not part of the digest', () => {
    const a = digestDoc('doc1', 'Reqs', fx('drive', 'doc_v1.md'));
    const b = digestDoc('doc1', 'Reqs', fx('drive', 'doc_v1.md').replace('this part is ignored', 'changed transcript text'));
    expect(a.digestHash).toBe(b.digestHash);
  });

  it('sheets: per-tab hashes', () => {
    const tabs1 = [{ name: 'Inputs', size: '100x10', values: fx('drive', 'sheet_inputs_v1.txt') }, { name: 'Outputs', size: '50x6', values: fx('drive', 'sheet_outputs_v1.txt') }];
    const tabs2 = [{ ...tabs1[0]!, values: fx('drive', 'sheet_inputs_v2.txt') }, tabs1[1]!];
    const diff = diffDigests(digestSheet('s', 'Sizing', tabs1), digestSheet('s', 'Sizing', tabs2))!;
    expect(diff.sheets!.changed.map((c) => c.name)).toEqual(['Inputs']);
    expect(diff.sheets!.changed[0]!.linesAdded).toEqual(['Sources | 5']);
  });

  it('caps audit: a cut line list carries its total; a sheet with unread tabs says how many', async () => {
    const { textDelta } = await import('@/scanner/drive-digest/diff');
    const before = 'a';
    const after = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    const d = textDelta(before, after);
    expect(d.linesAdded).toHaveLength(8);
    expect(d.linesAddedTotal).toBe(12);
    expect(d.linesRemovedTotal).toBeUndefined(); // one line removed: the list is whole
    const tabs = [{ name: 'Inputs', size: '1x1', values: 'x' }];
    const diff = diffDigests(digestSheet('s', 'Sizing', tabs, 3), digestSheet('s', 'Sizing', [{ ...tabs[0]!, values: 'y' }], 3))!;
    expect(diff.summary).toContain('3 more tabs not read');
  });

  it('redacts stored text but hashes the raw text (a rotated secret still counts as a change)', () => {
    const a = digestDoc('d', 't', '# H\n\npassword: hunter2hunter2\n');
    const b = digestDoc('d', 't', '# H\n\npassword: hunter3hunter3\n');
    expect(JSON.stringify(a)).not.toContain('hunter2');
    expect(a.digestHash).not.toBe(b.digestHash);
  });

  it('diffSamples carries both samples metadata', () => {
    const s = (v: string, mt: string, user: string): DriveSample => ({ fileId: DECK, sampledAt: mt, modifiedTime: mt, lastModifyingUser: { email: user }, digest: d(v) });
    const c = diffSamples(s('v1', '2026-03-10T10:00:00.000Z', 'a@x.com'), s('v2', '2026-03-10T11:00:00.000Z', 'me@example.com'))!;
    expect(c.from.user?.email).toBe('a@x.com');
    expect(c.to.user?.email).toBe('me@example.com');
    expect(diffSamples(s('v1', 't1', 'a'), s('v1', 't2', 'b'))).toBeNull();
  });
});

describe('DriveFetcher', () => {
  const T0 = new Date('2026-03-10T17:30:00.000Z');
  let now = T0;
  let version = 'v1';
  let modified = '2026-03-10T17:20:00.000Z';
  let _kind = 'presentation';

  const setup = (store = new MemoryDigestStore(), linked: () => Promise<string[]> = async () => []) => {
    now = T0;
    version = 'v1';
    modified = '2026-03-10T17:20:00.000Z';
    _kind = 'presentation';
    const g = new FakeGoogle({
      search_drive_files: () => fx('drive', 'feed_deck_modified.txt').replace('2026-03-10T17:20:00.000Z', modified),
      get_presentation: () => pres(version),
      get_doc_as_markdown: () => fx('drive', 'doc_v1.md'),
      get_spreadsheet_info: () => fx('drive', 'sheet_info.txt'),
      read_sheet_values: (a) => (String(a.range_name).includes('Inputs') ? fx('drive', 'sheet_inputs_v1.txt') : fx('drive', 'sheet_outputs_v1.txt')),
    });
    const f = new DriveFetcher({ google: g, me: ME, store, linked, clock: () => now });
    return { g, f, store };
  };

  it('first sample is a silent baseline (no diff item), but coverage and cursor record it', async () => {
    const { f } = setup();
    const r = await f.fetch('tracked', null, WINDOW, { signal });
    // DRV-1: the first run's only items are record-only history (asserted below), never a diff.
    expect(r.items.filter((i) => !(i.payload as { history?: boolean }).history)).toHaveLength(0);
    expect(r.coverage.find((c) => c.ref === DECK)?.meta).toMatchObject({ sampled: true, baseline: true, kind: 'slides' });
    const cur = JSON.parse(r.nextCursor.value);
    expect(cur.files[DECK]).toMatchObject({ m: modified, k: 'slides' });
    expect(Object.keys(cur.mine)).toEqual([DECK]); // only files I last edited are tracked; the other person's deck is not
  });

  it('DRV-1: the first run records my last edit of each editor file as record-only history; later runs do not repeat it', async () => {
    const { f, g } = setup();
    const r = await f.fetch('tracked', null, WINDOW, { signal });
    expect(r.recordOnly).toBe(true);
    expect(r.items).toHaveLength(1); // my deck only: the other person's deck is not mine
    expect(r.items[0]).toMatchObject({
      kind: 'file_revision',
      dedupeKey: `drive:${DECK}@${modified}`,
      occurredAt: modified,
      author: { email: 'me@example.com', isMe: true },
      permalink: `https://docs.google.com/presentation/d/${DECK}/edit`,
      payload: { fileId: DECK, fileKind: 'slides', editedByMe: true, history: true },
    });
    // Folders and shortcuts are left out of the feed query; the first feed may read up to 20 pages.
    expect(String(g.calls.find((c) => c.tool === 'search_drive_files')!.args.query)).toMatch(/mimeType != 'application\/vnd\.google-apps\.folder' and mimeType != 'application\/vnd\.google-apps\.shortcut'/);
    now = new Date(T0.getTime() + 60_000);
    const r2 = await f.fetch('tracked', r.nextCursor, WINDOW, { signal });
    expect(r2.items).toHaveLength(0);
    expect(r2.recordOnly).toBeUndefined();
  });

  it('DRV-1: the first feed pages past the regular 4-page limit; later feeds keep it', async () => {
    const store = new MemoryDigestStore();
    let pages = 0;
    const g = new FakeGoogle({
      search_drive_files: () => {
        pages += 1;
        return fx('drive', 'feed_deck_modified.txt') + '\nnextPageToken: tok' + pages;
      },
      get_presentation: () => pres('v1'),
    });
    const f = new DriveFetcher({ google: g, me: ME, store, clock: () => T0 });
    const r = await f.fetch('tracked', null, WINDOW, { signal });
    expect(pages).toBe(20);
    expect(r.complete).toBe(false);
    pages = 0;
    await f.fetch('tracked', r.nextCursor, WINDOW, { signal });
    expect(pages).toBe(4);
  });

  it('a change emits one file_revision with the structured diff; no change emits nothing', async () => {
    const { f, g } = setup();
    modified = '2026-03-10T16:00:00.000Z'; // long settled: no settle sample is due
    const r1 = await f.fetch('tracked', null, WINDOW, { signal });
    // nothing modified: no content fetch at all
    now = new Date(T0.getTime() + 3600_000);
    const callsBefore = g.count('get_presentation');
    const r2 = await f.fetch('tracked', r1.nextCursor, WINDOW, { signal });
    expect(r2.items).toHaveLength(0);
    expect(g.count('get_presentation')).toBe(callsBefore);
    // an edit
    version = 'v2';
    modified = '2026-03-10T18:25:00.000Z';
    now = new Date(T0.getTime() + 2 * 3600_000);
    const r3 = await f.fetch('tracked', r2.nextCursor, WINDOW, { signal });
    expect(r3.items).toHaveLength(1);
    const it = r3.items[0]!;
    expect(it).toMatchObject({ connector: 'drive', kind: 'file_revision', externalId: `${DECK}@${modified}`, dedupeKey: `drive:${DECK}@${modified}`, fileRefs: [DECK] });
    expect(it.author).toMatchObject({ email: 'me@example.com', isMe: true });
    const change = it.payload!.change as { slides: { added: unknown[]; changed: Array<{ objectId: string }> }; summary: string };
    expect(change.slides.added).toHaveLength(1);
    expect(change.slides.changed.map((c) => c.objectId)).toEqual(['p_arch']);
    expect(it.payload).toMatchObject({ editedByMe: true, fileKind: 'slides' });
  });

  it('modifiedTime moved but the digest did not (image-only edit): no item, marked modifiedOnly', async () => {
    const { f } = setup();
    const r1 = await f.fetch('tracked', null, WINDOW, { signal });
    modified = '2026-03-10T18:25:00.000Z';
    now = new Date(T0.getTime() + 2 * 3600_000);
    const r2 = await f.fetch('tracked', r1.nextCursor, WINDOW, { signal });
    expect(r2.items).toHaveLength(0);
    expect(r2.coverage.find((c) => c.ref === DECK)?.meta).toMatchObject({ sampled: true, modifiedOnly: true });
  });

  it('is idempotent after a killed run: re-running from the SAME cursor re-emits the same keys', async () => {
    const { f } = setup();
    const r1 = await f.fetch('tracked', null, WINDOW, { signal });
    version = 'v2';
    modified = '2026-03-10T18:25:00.000Z';
    now = new Date(T0.getTime() + 2 * 3600_000);
    const a = await f.fetch('tracked', r1.nextCursor, WINDOW, { signal }); // run killed: cursor never committed
    const b = await f.fetch('tracked', r1.nextCursor, WINDOW, { signal }); // re-run
    expect(a.items).toHaveLength(1);
    expect(b.items.map((i) => `${i.dedupeKey}|${i.contentHash}`)).toEqual(a.items.map((i) => `${i.dedupeKey}|${i.contentHash}`));
    // once the cursor is committed, a further run emits nothing
    const c = await f.fetch('tracked', a.nextCursor, WINDOW, { signal });
    expect(c.items).toHaveLength(0);
  });

  it('throttles samples to once per 10 minutes and picks the change up afterwards', async () => {
    const { f } = setup();
    const r1 = await f.fetch('tracked', null, WINDOW, { signal });
    version = 'v2';
    modified = '2026-03-10T17:33:00.000Z';
    now = new Date(T0.getTime() + 3 * 60_000);
    const r2 = await f.fetch('tracked', r1.nextCursor, WINDOW, { signal });
    expect(r2.items).toHaveLength(0);
    expect(r2.coverage.find((c) => c.ref === DECK)?.meta).toMatchObject({ throttled: true });
    now = new Date(T0.getTime() + 20 * 60_000);
    const r3 = await f.fetch('tracked', r2.nextCursor, WINDOW, { signal });
    expect(r3.items).toHaveLength(1);
  });

  it('settle sample: an edit still in progress is re-sampled 15 minutes after the last change', async () => {
    const { f } = setup();
    modified = '2026-03-10T17:29:00.000Z'; // edited a minute ago
    const r1 = await f.fetch('tracked', null, WINDOW, { signal });
    expect(JSON.parse(r1.nextCursor.value).files[DECK].settle).toBe(true);
    version = 'v2'; // more edits landed without modifiedTime moving in the feed we saw
    now = new Date(T0.getTime() + 16 * 60_000);
    const r2 = await f.fetch('tracked', r1.nextCursor, WINDOW, { signal });
    expect(r2.items).toHaveLength(1);
    expect(JSON.parse(r2.nextCursor.value).files[DECK].settle).toBeUndefined();
  });

  it('tracks files linked to open items even if I did not edit them, and detects their changes', async () => {
    const other = '1OtherFileId00000000000000000';
    const { f, g } = setup(new MemoryDigestStore(), async () => [other]);
    const r1 = await f.fetch('tracked', null, WINDOW, { signal });
    expect(r1.coverage.find((c) => c.ref === other)?.meta).toMatchObject({ baseline: true });
    expect(g.calls.some((c) => c.tool === 'get_presentation' && c.args.presentation_id === other)).toBe(true);
    version = 'v2';
    modified = '2026-03-10T18:40:00.000Z';
    now = new Date(T0.getTime() + 2 * 3600_000);
    g.routes.search_drive_files = () => fx('drive', 'feed_deck_modified.txt').replace('2026-03-10T17:10:00.000Z', '2026-03-10T18:30:00.000Z');
    const r2 = await f.fetch('tracked', r1.nextCursor, WINDOW, { signal });
    const otherItem = r2.items.find((i) => i.fileRefs?.[0] === other);
    expect(otherItem?.author).toMatchObject({ email: 'other@example.com', isMe: false });
  });

  it('caps samples per run and reports incomplete without losing the pending files', async () => {
    const { f } = setup(new MemoryDigestStore(), async () => ['1AAAAAAAAAAAAAAAAAAAAAAAAAAAA', '1BBBBBBBBBBBBBBBBBBBBBBBBBBBB']);
    const small = new DriveFetcher({ google: (f as unknown as { g: FakeGoogle }).g, me: ME, store: new MemoryDigestStore(), linked: async () => ['1AAAAAAAAAAAAAAAAAAAAAAAAAAAA', '1BBBBBBBBBBBBBBBBBBBBBBBBBBBB'], clock: () => now, maxSamplesPerRun: 1 });
    const r = await small.fetch('tracked', null, WINDOW, { signal });
    expect(r.complete).toBe(false);
    expect(r.coverage.filter((c) => c.kind === 'file' && (c.meta as { sampled?: boolean })?.sampled).length).toBe(1);
  });

  it('digests docs and sheets and probes unknown kinds', async () => {
    const docId = '1DocDocDocDocDocDocDocDocDocDoc';
    const sheetId = '1SheetId000000000000000000000';
    const { f, g } = setup(new MemoryDigestStore(), async () => []);
    const f2 = new DriveFetcher({
      google: g, me: ME, store: new MemoryDigestStore(), clock: () => now,
      linked: async () => [{ id: docId, kind: 'doc' as const }, { id: sheetId, kind: 'sheet' as const }, { id: '1Unknown0000000000000000000000' }],
    });
    g.routes.get_presentation = (a) => {
      if (a.presentation_id === '1Unknown0000000000000000000000') throw Object.assign(new Error('x'), {});
      return pres('v1');
    };
    // unknown kind: slides probe throws a non-GoogleCallError, so the run fails loudly rather than guessing.
    await expect(f2.fetch('tracked', null, WINDOW, { signal })).rejects.toThrow();
    g.routes.get_presentation = () => pres('v1');
    const r = await f2.fetch('tracked', null, WINDOW, { signal });
    const kinds = r.coverage.filter((c) => c.kind === 'file').map((c) => (c.meta as { kind?: string })?.kind).filter(Boolean);
    expect(kinds).toEqual(expect.arrayContaining(['doc', 'sheet', 'slides']));
    void f;
  });

  it('DRV-2: a tracked sheet the Sheets API rejects (400) is skipped with an error mark, not a failed run', async () => {
    const sheetId = '1SheetId000000000000000000000';
    const { g } = setup();
    g.routes.get_spreadsheet_info = () => {
      const text = 'API error in get_spreadsheet_info: <HttpError 400 when requesting https://sheets.googleapis.com/v4/spreadsheets/x returned "This operation is not supported for this document">';
      throw new GoogleCallError('get_spreadsheet_info', classifyGoogleError(text), text);
    };
    const f = new DriveFetcher({ google: g, me: ME, store: new MemoryDigestStore(), clock: () => now, linked: async () => [{ id: sheetId, kind: 'sheet' as const }] });
    const r = await f.fetch('tracked', null, WINDOW, { signal });
    expect(r.coverage.find((c) => c.ref === sheetId)?.meta).toMatchObject({ sampled: false, error: 'bad_request' });
    expect(r.coverage.find((c) => c.ref === DECK)?.meta).toMatchObject({ sampled: true }); // the rest of the run went on
  });

  it('only calls read tools', async () => {
    const { f, g } = setup();
    await f.fetch('tracked', null, WINDOW, { signal });
    expect(new Set(g.calls.map((c) => c.tool))).toEqual(new Set(['search_drive_files', 'get_presentation']));
  });

  it('listForReconcile returns tracked-eligible files in the window as file coverage', async () => {
    const { f } = setup();
    const l = await f.listForReconcile!('tracked', { from: '2026-03-10T00:00:00.000Z', to: '2026-03-10T23:00:00.000Z' }, { signal });
    expect(l.map((c) => c.ref)).toEqual([DECK]);
    expect(l[0]!.kind).toBe('file');
  });
});

describe('FileDigestStore', () => {
  it('persists samples, content-addressed lookup and history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cc-digest-'));
    try {
      const s = new FileDigestStore(dir);
      const mk = (v: string, at: string): DriveSample => ({ fileId: DECK, sampledAt: at, modifiedTime: at, digest: d(v) });
      await s.put(mk('v1', '2026-03-10T10:00:00.000Z'));
      await s.put(mk('v2', '2026-03-10T11:00:00.000Z'));
      expect((await s.latest(DECK))!.digest.digestHash).toBe(d('v2').digestHash);
      expect((await s.getByHash(DECK, d('v1').digestHash))!.sampledAt).toBe('2026-03-10T10:00:00.000Z');
      expect((await s.history(DECK)).length).toBe(2);
      expect(await s.getByHash(DECK, 'nope')).toBeNull();
      expect(await s.latest('missing')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
