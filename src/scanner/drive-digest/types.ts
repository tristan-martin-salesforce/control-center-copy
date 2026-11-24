/** Drive forward-sampling types (R-UI-15, brief 09 §6). No revision-history API exists, so we sample and diff. */

export type DriveFileKind = 'slides' | 'doc' | 'sheet' | 'other';

export interface DriveUser {
  name?: string;
  email?: string;
}

export interface SlideDigest {
  objectId: string;
  n: number;
  elementCount: number;
  title: string;
  titleHash: string;
  textHash: string;
  chars: number;
  /** Capped slide text, kept for diffs (retention: 30 days, see FileDigestStore.pruneText). */
  text: string;
}

export interface SectionDigest {
  /** `heading#occurrence`, stable when the same heading repeats. */
  key: string;
  heading: string;
  level: number;
  hash: string;
  chars: number;
  text: string;
}

export interface SheetDigest {
  name: string;
  size?: string;
  hash: string;
  chars: number;
  text: string;
}

export interface DriveDigest {
  kind: DriveFileKind;
  fileId: string;
  title: string;
  slides?: SlideDigest[];
  sections?: SectionDigest[];
  sheets?: SheetDigest[];
  /** Tabs of the sheet not read this sample (past maxSheetTabs); the change list says so instead of hiding them. */
  sheetsNotRead?: number;
  /** Files whose content we cannot read as text (pdf, pptx upload…): digest is size + modifiedTime only. */
  opaque?: { size?: number; mimeType?: string };
  /** Hash of the structural content only (never modifiedTime or user). Equal hash means "no change we can see". */
  digestHash: string;
}

export interface DriveSample {
  fileId: string;
  sampledAt: string;
  modifiedTime: string;
  lastModifyingUser?: DriveUser;
  digest: DriveDigest;
}

export interface TextDelta {
  before: string;
  after: string;
  /** Lines present only in the new text / only in the old text (each capped, the first MAX_LINES). */
  linesAdded: string[];
  linesRemoved: string[];
  /** How many lines were added / removed in all, when more than the lists show (caps audit 2026-11-21). */
  linesAddedTotal?: number;
  linesRemovedTotal?: number;
}

export interface SlideChange extends TextDelta {
  objectId: string;
  n: number;
  nBefore: number;
  titleBefore: string;
  titleAfter: string;
  elementCountBefore: number;
  elementCountAfter: number;
  /** What differed: title, body text, number of elements. */
  kinds: Array<'title' | 'text' | 'elements'>;
}

export interface SectionChange extends TextDelta {
  key: string;
  heading: string;
}

export interface SheetChange extends TextDelta {
  name: string;
}

export interface DriveChange {
  kind: DriveFileKind;
  from: { modifiedTime: string; digestHash: string; sampledAt: string; user?: DriveUser };
  to: { modifiedTime: string; digestHash: string; sampledAt: string; user?: DriveUser };
  slides?: {
    countBefore: number;
    countAfter: number;
    added: Array<{ objectId: string; n: number; title: string; text: string }>;
    removed: Array<{ objectId: string; n: number; title: string; text: string }>;
    changed: SlideChange[];
    moved: Array<{ objectId: string; from: number; to: number; title: string }>;
  };
  sections?: {
    added: Array<{ key: string; heading: string; text: string }>;
    removed: Array<{ key: string; heading: string; text: string }>;
    changed: SectionChange[];
  };
  sheets?: {
    added: Array<{ name: string }>;
    removed: Array<{ name: string }>;
    changed: SheetChange[];
  };
  opaque?: { sizeBefore?: number; sizeAfter?: number };
  counts: { added: number; removed: number; changed: number; moved: number };
  /** One line the skill can quote. */
  summary: string;
  /** Things this diff cannot see, so the judge says "cannot tell" instead of guessing (R-UI-15). */
  limits: string[];
}

/** Persistence for samples. In-memory and file implementations here; BE-1 may add a Postgres one. */
export interface DigestStore {
  put(sample: DriveSample): Promise<void>;
  /** Exact sample by digest hash (content-addressed: re-running a killed fetch is idempotent). */
  getByHash(fileId: string, digestHash: string): Promise<DriveSample | null>;
  latest(fileId: string): Promise<DriveSample | null>;
  history(fileId: string, limit?: number): Promise<DriveSample[]>;
}
