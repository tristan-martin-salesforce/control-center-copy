/**
 * Plain words for text the server writes (a use case's why, what Accept stages, a row's issue), applied where
 * Activity renders it (D-87; tests/time/plain-words.test.ts). The server's own wording stays as it is for logs, the
 * Assistant and the docs; on screen a seller reads "batch", never "canvas", and no decision id or API name.
 */
import { plainIssue as rawIssue, plainIssues as rawIssues } from '@/lib/time-issues';

const SWAPS: ReadonlyArray<[RegExp, string]> = [
  [/\btell Slackbot "Execute this canvas"/g, 'send it to Org62 via Slackbot'],
  [/\b(on|in) (?:your|the) next (?:logging )?canvas\b/g, 'in your next batch'],
  [/\brides? (?:your|the) next (?:logging )?canvas\b/g, 'goes in your next batch'],
  [/\b(?:on|in) a (?:logging |private )?canvas\b/g, 'in a batch'],
  [/\blogging canvas(es)?\b/gi, 'batch$1'],
  [/\bcanvases\b/g, 'batches'],
  [/\bCanvases\b/g, 'Batches'],
  [/\bcanvas\b/g, 'batch'],
  [/\bCanvas\b/g, 'Batch'],
  [/\bverified by read-?back\b/gi, 'checked in Org62'],
  [/\bread-?back\b/gi, 'Org62 check'],
  [/\bWhatId\b/g, 'opportunity'],
  [/\bUse_Case__c\b/g, 'Org62 use case'],
  [/\s*\(D-\d+(?:[^)]*)?\)/g, ''],
];

export function plainWords(s: string): string;
export function plainWords(s: string | null | undefined): string | null;
export function plainWords(s: string | null | undefined): string | null {
  if (!s) return s ?? null;
  let out = s;
  for (const [re, to] of SWAPS) out = out.replace(re, to);
  return out;
}

/** A row's issue in plain words (src/lib/time-issues, then the swaps above). */
export function plainIssue(issue: string, e?: Parameters<typeof rawIssue>[1]): string | null {
  return plainWords(rawIssue(issue, e));
}

/** A row's issues in plain words. */
export function plainIssues(e: Parameters<typeof rawIssues>[0], keep?: Parameters<typeof rawIssues>[1]): string[] {
  return rawIssues(e, keep).map((s) => plainWords(s));
}
