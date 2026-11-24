/**
 * Builds structured digests from the text the Google read tools return.
 *  - Slides: per-slide title + text hash + element count (object ids are the identity for add/remove/move).
 *  - Docs:   per-heading section hashes (cut at `# Transcript`).
 *  - Sheets: per-tab hashes of the values.
 * Text is stored redacted and capped; hashes are computed on the raw normalized text so a redaction rule change cannot
 * hide an edit.
 */
import { parseDocSections, parsePresentation } from '@/connectors/google/parse';
import { redact } from '@/connectors/redact';
import { h16, normalizeText, sha1, truncate } from '@/connectors/util';
import type { DriveDigest, SectionDigest, SheetDigest, SlideDigest } from './types';

const TEXT_CAP = 3000;

const store = (s: string) => truncate(redact(s).text, TEXT_CAP);

export function digestPresentation(fileId: string, text: string): DriveDigest {
  const p = parsePresentation(text);
  const slides: SlideDigest[] = p.slides.map((s) => {
    const lines = s.lines.map((l) => l.trim()).filter(Boolean);
    const title = lines[0] ?? '';
    const body = lines.join('\n');
    return {
      objectId: s.objectId,
      n: s.n,
      elementCount: s.elementCount,
      title: redact(title).text.slice(0, 160),
      titleHash: h16(normalizeText(title)),
      textHash: h16(normalizeText(body)),
      chars: body.length,
      text: store(body),
    };
  });
  const digestHash = sha1('slides', ...slides.map((s) => `${s.objectId}|${s.elementCount}|${s.titleHash}|${s.textHash}`));
  return { kind: 'slides', fileId, title: redact(p.title ?? '').text, slides, digestHash };
}

export function digestDoc(fileId: string, title: string, markdown: string): DriveDigest {
  const secs = parseDocSections(markdown, true);
  const seen = new Map<string, number>();
  const sections: SectionDigest[] = secs.map((s) => {
    const base = s.heading || '(preamble)';
    const occ = (seen.get(base) ?? 0) + 1;
    seen.set(base, occ);
    return {
      key: `${base}#${occ}`,
      heading: redact(base).text,
      level: s.level,
      hash: h16(normalizeText(s.text)),
      chars: s.text.length,
      text: store(s.text),
    };
  });
  const digestHash = sha1('doc', ...sections.map((s) => `${s.key}|${s.level}|${s.hash}`));
  return { kind: 'doc', fileId, title: redact(title).text, sections, digestHash };
}

export function digestSheet(fileId: string, title: string, tabs: Array<{ name: string; size?: string; values: string }>, notRead = 0): DriveDigest {
  const sheets: SheetDigest[] = tabs.map((t) => ({
    name: redact(t.name).text,
    size: t.size,
    hash: h16(normalizeText(t.values)),
    chars: t.values.length,
    text: store(t.values),
  }));
  const digestHash = sha1('sheet', ...sheets.map((s) => `${s.name}|${s.size ?? ''}|${s.hash}`));
  return { kind: 'sheet', fileId, title: redact(title).text, sheets, ...(notRead > 0 ? { sheetsNotRead: notRead } : {}), digestHash };
}

export function digestOpaque(fileId: string, title: string, size: number | undefined, mimeType: string | undefined): DriveDigest {
  return { kind: 'other', fileId, title: redact(title).text, opaque: { size, mimeType }, digestHash: sha1('opaque', String(size ?? ''), mimeType ?? '') };
}

export function kindFromMime(mime: string | undefined): 'slides' | 'doc' | 'sheet' | 'other' {
  if (!mime) return 'other';
  if (mime === 'application/vnd.google-apps.presentation') return 'slides';
  if (mime === 'application/vnd.google-apps.document') return 'doc';
  if (mime === 'application/vnd.google-apps.spreadsheet') return 'sheet';
  return 'other';
}
