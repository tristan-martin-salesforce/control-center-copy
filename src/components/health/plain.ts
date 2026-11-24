/**
 * Plain words for the lines the server writes on Health's Ranking and Resolution check rows (01-ui-audit UI-6): a
 * seller reads "the new ranking" and "watch only", never an engine version ("priority@2") or "shadow". The server's
 * wording stays as it is for logs and the docs; this runs where Health renders it.
 */
const SWAPS: ReadonlyArray<[RegExp, (m: string, ...g: string[]) => string]> = [
  [/\(priority@2 is off\)/g, () => '(the new ranking is off)'],
  [/\bpriority@1(?:\.1)?\b/g, () => 'your current ranking'],
  [/\bpriority@2 in shadow\b/g, () => 'the new ranking, previewed beside your list'],
  [/\bpriority@2 on\b/g, () => 'the new ranking, as your list'],
  [/\bpriority@2 off\b/g, () => 'the new ranking is off'],
  [/\bpriority@2\b/g, () => 'the new ranking'],
  [/\bagrees (\d(?:\.\d+)?) on the Top 3\b/g, (_m, x) => `agrees on ${Math.round(Number(x) * 100)}% of the Top 3`],
  [/\s*\(shadow\)/g, () => ' (watch only)'],
  [/\bin shadow\b/g, () => 'watching only'],
];

export function healthPlain(s: string): string;
export function healthPlain(s: string | null | undefined): string | null;
export function healthPlain(s: string | null | undefined): string | null {
  if (!s) return s ?? null;
  let out = s;
  for (const [re, to] of SWAPS) out = out.replace(re, to as (m: string, ...g: string[]) => string);
  return out;
}
