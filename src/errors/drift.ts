/**
 * Parser drift (08 CONN-9, R5): a source answered with text the parser no longer understands. Non-empty tool text
 * that parses to zero items throws `ParseDrift`; the classifier reads it as DATA.PARSE_DRIFT, which pauses that scope
 * and stops retrying (retrying a format change only re-bills it), and Health says "the format changed; report it".
 *
 * The Google parsers (src/connectors/google/parse.ts) have their own class of the same name and message shape;
 * `isParseDrift` accepts either, by name, so a bundle boundary never breaks the check.
 */
export class ParseDrift extends Error {
  constructor(
    public readonly parser: string,
    detail: string,
  ) {
    super(`parser drift in ${parser}: ${detail}`);
    this.name = 'ParseDrift';
  }
}

export function isParseDrift(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof ParseDrift) return true;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name === 'ParseDrift') return true;
  return typeof err === 'string' ? /\bParseDrift\b|parser drift in /.test(err) : typeof e.message === 'string' && /parser drift in /.test(e.message);
}
