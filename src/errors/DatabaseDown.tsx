'use client';
/**
 * The database-down explanation on app/global-error.tsx (11 R6, PKG-5): GET /api/v1/doctor?only=db answers without
 * the database, and when Postgres is the cause the page says so in the catalog's words (DEP.DB.DOWN) with the start
 * command to copy. Plain elements only: the root layout (and its stylesheet) did not render.
 */
/** The doctor route's `database` block (src/contract/health.ts DoctorPayload). */
export interface DatabaseDownInfo {
  code: string;
  title: string;
  text: string;
  nextStep: string;
  command: string | null;
}

/** Asks the DB-free doctor route whether the database is what broke; null when it isn't (or the route can't answer). */
export async function fetchDatabaseDown(fetchFn: typeof fetch = fetch): Promise<DatabaseDownInfo | null> {
  try {
    const r = await fetchFn('/api/v1/doctor?only=db', { cache: 'no-store' });
    if (!r.ok) return null;
    const body = (await r.json()) as { database?: DatabaseDownInfo | null };
    return body.database && typeof body.database.title === 'string' ? body.database : null;
  } catch {
    return null;
  }
}

/** The database-down explanation: the catalog's title, text and the command (copyable). */
export function DatabaseDown({ db, onCopy, copied }: { db: DatabaseDownInfo; onCopy?: () => void; copied?: boolean }) {
  return (
    <section data-testid="db-down" data-code={db.code}>
      <h1>{db.title}.</h1>
      <p>{db.text}</p>
      <p>{db.nextStep}</p>
      {db.command ? (
        <div className="row">
          <code>{db.command}</code>
          <button type="button" onClick={onCopy}>
            Copy command
          </button>
          <span aria-live="polite">{copied ? 'Copied.' : ''}</span>
        </div>
      ) : null}
    </section>
  );
}
