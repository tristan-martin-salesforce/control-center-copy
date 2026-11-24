/**
 * The ledger's content hash, in the shared layer so an engine can stamp `contentHash` without importing `db`
 * (CONTRIBUTING "Where code goes"). `src/db/ledger.ts` re-exports it under the same name.
 */
import { createHash } from 'node:crypto';

/** sha256 of the parts (first 32 hex chars): what makes two calls "the same call". */
export function ledgerHash(...parts: Array<string | number | boolean | null | undefined>): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(`${p ?? ''}\u0000`);
  return h.digest('hex').slice(0, 32);
}
