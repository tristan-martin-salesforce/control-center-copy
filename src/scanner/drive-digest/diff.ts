/**
 * Diff two Drive samples into a structured change list (R-UI-15).
 * Pure and deterministic. `diffSamples` returns null when the digests are identical (no change we can see).
 */
import type { DriveChange, DriveDigest, DriveSample, SectionChange, SheetChange, SlideChange, TextDelta } from './types';

// Payload bounds of one change entry (it is stored on the source item and read by the classifier); a cut list carries
// its total, so nothing is hidden without a count.
const CAP = 600;
const LINE_CAP = 200;
const MAX_LINES = 8;

const cap = (s: string, n = CAP) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function textDelta(before: string, after: string): TextDelta {
  const b = before.split('\n').map((l) => l.trim()).filter(Boolean);
  const a = after.split('\n').map((l) => l.trim()).filter(Boolean);
  const bs = new Set(b);
  const as = new Set(a);
  const added = a.filter((l) => !bs.has(l));
  const removed = b.filter((l) => !as.has(l));
  return {
    before: cap(before),
    after: cap(after),
    linesAdded: added.slice(0, MAX_LINES).map((l) => cap(l, LINE_CAP)),
    linesRemoved: removed.slice(0, MAX_LINES).map((l) => cap(l, LINE_CAP)),
    ...(added.length > MAX_LINES ? { linesAddedTotal: added.length } : {}),
    ...(removed.length > MAX_LINES ? { linesRemovedTotal: removed.length } : {}),
  };
}

/** Indexes (into `seq`) of a longest increasing subsequence. O(n^2), fine for decks under ~200 slides. */
function lisIndexes(seq: number[]): Set<number> {
  const n = seq.length;
  const len = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  let best = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (seq[j]! < seq[i]! && len[j]! + 1 > len[i]!) {
        len[i] = len[j]! + 1;
        prev[i] = j;
      }
    }
    if (n && len[i]! > len[best]!) best = i;
  }
  const out = new Set<number>();
  for (let i = n ? best : -1; i >= 0; i = prev[i]!) out.add(i);
  return out;
}

function diffSlides(a: DriveDigest, b: DriveDigest): DriveChange['slides'] {
  const as = a.slides ?? [];
  const bs = b.slides ?? [];
  const aMap = new Map(as.map((s) => [s.objectId, s]));
  const bMap = new Map(bs.map((s) => [s.objectId, s]));
  const added = bs.filter((s) => !aMap.has(s.objectId)).map((s) => ({ objectId: s.objectId, n: s.n, title: s.title, text: cap(s.text) }));
  const removed = as.filter((s) => !bMap.has(s.objectId)).map((s) => ({ objectId: s.objectId, n: s.n, title: s.title, text: cap(s.text) }));
  const changed: SlideChange[] = [];
  for (const s of bs) {
    const o = aMap.get(s.objectId);
    if (!o) continue;
    const kinds: SlideChange['kinds'] = [];
    if (o.titleHash !== s.titleHash) kinds.push('title');
    if (o.textHash !== s.textHash) kinds.push('text');
    if (o.elementCount !== s.elementCount) kinds.push('elements');
    if (!kinds.length) continue;
    changed.push({
      objectId: s.objectId,
      n: s.n,
      nBefore: o.n,
      titleBefore: o.title,
      titleAfter: s.title,
      elementCountBefore: o.elementCount,
      elementCountAfter: s.elementCount,
      kinds,
      ...textDelta(o.text, s.text),
    });
  }
  // Moves: order of the slides present in both, compared with an LIS so one move is one move.
  const common = as.filter((s) => bMap.has(s.objectId)).map((s) => s.objectId);
  const posInB = common.map((id) => bs.findIndex((s) => s.objectId === id));
  const keep = lisIndexes(posInB);
  const moved = common
    .map((id, i) => ({ id, i }))
    .filter(({ i }) => !keep.has(i))
    .map(({ id }) => ({ objectId: id, from: aMap.get(id)!.n, to: bMap.get(id)!.n, title: bMap.get(id)!.title }));
  return { countBefore: as.length, countAfter: bs.length, added, removed, changed, moved };
}

function diffSections(a: DriveDigest, b: DriveDigest): DriveChange['sections'] {
  const as = a.sections ?? [];
  const bs = b.sections ?? [];
  const aMap = new Map(as.map((s) => [s.key, s]));
  const bMap = new Map(bs.map((s) => [s.key, s]));
  const changed: SectionChange[] = [];
  for (const s of bs) {
    const o = aMap.get(s.key);
    if (o && o.hash !== s.hash) changed.push({ key: s.key, heading: s.heading, ...textDelta(o.text, s.text) });
  }
  return {
    added: bs.filter((s) => !aMap.has(s.key)).map((s) => ({ key: s.key, heading: s.heading, text: cap(s.text) })),
    removed: as.filter((s) => !bMap.has(s.key)).map((s) => ({ key: s.key, heading: s.heading, text: cap(s.text) })),
    changed,
  };
}

function diffSheets(a: DriveDigest, b: DriveDigest): DriveChange['sheets'] {
  const as = a.sheets ?? [];
  const bs = b.sheets ?? [];
  const aMap = new Map(as.map((s) => [s.name, s]));
  const bMap = new Map(bs.map((s) => [s.name, s]));
  const changed: SheetChange[] = [];
  for (const s of bs) {
    const o = aMap.get(s.name);
    if (o && (o.hash !== s.hash || o.size !== s.size)) changed.push({ name: s.name, ...textDelta(o.text, s.text) });
  }
  return {
    added: bs.filter((s) => !aMap.has(s.name)).map((s) => ({ name: s.name })),
    removed: as.filter((s) => !bMap.has(s.name)).map((s) => ({ name: s.name })),
    changed,
  };
}

const LIMITS: Record<string, string[]> = {
  slides: [
    'Image, logo, chart-image and formatting-only changes are not visible in the text digest; only a change in the number of elements on a slide hints at them.',
    'Only the last editor at sample time is known; edits between samples are merged into one change.',
  ],
  doc: ['Formatting, comments and image changes are not visible in the text digest.', 'Only the last editor at sample time is known.'],
  sheet: ['Formulas, formatting and charts are not visible; only displayed values per tab are hashed.', 'Only the last editor at sample time is known.'],
  other: ['Content of this file type cannot be read; only size changes are visible.'],
};

export type DigestDiff = Pick<DriveChange, 'slides' | 'sections' | 'sheets' | 'opaque' | 'counts' | 'summary' | 'limits'>;

export function diffDigests(a: DriveDigest, b: DriveDigest): DigestDiff | null {
  if (a.digestHash === b.digestHash) return null;
  const out: DigestDiff = { counts: { added: 0, removed: 0, changed: 0, moved: 0 }, summary: '', limits: LIMITS[b.kind] ?? [] };
  const parts: string[] = [];
  if (b.kind === 'slides') {
    const s = diffSlides(a, b)!;
    out.slides = s;
    out.counts = { added: s.added.length, removed: s.removed.length, changed: s.changed.length, moved: s.moved.length };
    if (s.added.length) parts.push(`${s.added.length} slide${s.added.length > 1 ? 's' : ''} added`);
    if (s.removed.length) parts.push(`${s.removed.length} removed`);
    if (s.changed.length) parts.push(`${s.changed.length} changed (${s.changed.map((c) => `#${c.n}`).slice(0, 8).join(', ')})`);
    if (s.moved.length) parts.push(`${s.moved.length} moved`);
  } else if (b.kind === 'doc') {
    const s = diffSections(a, b)!;
    out.sections = s;
    out.counts = { added: s.added.length, removed: s.removed.length, changed: s.changed.length, moved: 0 };
    if (s.added.length) parts.push(`${s.added.length} section${s.added.length > 1 ? 's' : ''} added`);
    if (s.removed.length) parts.push(`${s.removed.length} removed`);
    if (s.changed.length) parts.push(`${s.changed.length} changed (${s.changed.map((c) => c.heading || 'preamble').slice(0, 5).join('; ')})`);
  } else if (b.kind === 'sheet') {
    const s = diffSheets(a, b)!;
    out.sheets = s;
    out.counts = { added: s.added.length, removed: s.removed.length, changed: s.changed.length, moved: 0 };
    if (s.added.length) parts.push(`${s.added.length} tab added`);
    if (s.removed.length) parts.push(`${s.removed.length} tab removed`);
    if (s.changed.length) parts.push(`${s.changed.length} tab changed (${s.changed.map((c) => c.name).join(', ')})`);
    if (b.sheetsNotRead) parts.push(`${b.sheetsNotRead} more tab${b.sheetsNotRead > 1 ? 's' : ''} not read`);
  } else {
    out.opaque = { sizeBefore: a.opaque?.size, sizeAfter: b.opaque?.size };
    out.counts = { added: 0, removed: 0, changed: 1, moved: 0 };
    parts.push(`file size ${a.opaque?.size ?? '?'} -> ${b.opaque?.size ?? '?'}`);
  }
  out.summary = parts.join(', ') || 'content changed';
  return out;
}

/** Diff of two samples; null means "digest unchanged" (no item should be emitted). */
export function diffSamples(prev: DriveSample, curr: DriveSample): DriveChange | null {
  const d = diffDigests(prev.digest, curr.digest);
  if (!d) return null;
  return {
    kind: curr.digest.kind,
    from: { modifiedTime: prev.modifiedTime, digestHash: prev.digest.digestHash, sampledAt: prev.sampledAt, user: prev.lastModifyingUser },
    to: { modifiedTime: curr.modifiedTime, digestHash: curr.digest.digestHash, sampledAt: curr.sampledAt, user: curr.lastModifyingUser },
    ...d,
  };
}
