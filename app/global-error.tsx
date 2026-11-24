'use client';
/**
 * The last-resort error page (PKG-5, R9): it replaces the root layout when rendering fails outright (the database is
 * down, a server component threw). Plain words, Retry and Copy details; the error's own text is never rendered (it
 * can be a whole HTML page, a stack, or a customer's name), only copied when the user asks, as plain text.
 * It can't rely on the app's stylesheet (the root layout didn't render), so its few styles are inline.
 *
 * 11 R6: it asks GET /api/v1/doctor?only=db (which answers without the database) and, when the database is the cause,
 * says so in the catalog's words (DEP.DB.DOWN: "The database isn't running") with the start command to copy.
 */
import { useEffect, useState } from 'react';

import { DatabaseDown, fetchDatabaseDown, type DatabaseDownInfo } from '@/errors/DatabaseDown';

const CSS = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #181818; --muted: #5c5c5c; --line: #c9c9c9; --accent: #0b5cab; }
@media (prefers-color-scheme: dark) { :root { --bg: #16181d; --fg: #f3f3f3; --muted: #aeaeae; --line: #3e3e3c; --accent: #78b0fd; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 34rem; margin: 18vh auto 0; padding: 0 16px; }
h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
p { color: var(--muted); margin: 0 0 1.25rem; }
.row { display: flex; gap: .75rem; flex-wrap: wrap; align-items: center; }
button { font: inherit; border-radius: .375rem; padding: .5rem 1rem; cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--fg); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

/** What "Copy details" puts on the clipboard: plain text, tags stripped, clipped; no stack. */
function detailsOf(error: Error & { digest?: string }): string {
  const plain = String(error?.message ?? '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return [
    'Command Center: the page failed to load',
    `when: ${new Date().toISOString()}`,
    `page: ${typeof location === 'undefined' ? '' : location.pathname}`,
    `version: ${process.env.NEXT_PUBLIC_CC_VERSION ?? '?'}${process.env.NEXT_PUBLIC_CC_GIT_SHA ? ` · ${process.env.NEXT_PUBLIC_CC_GIT_SHA}` : ''}${Number(process.env.NEXT_PUBLIC_CC_GIT_DIRTY) > 0 ? ' · modified' : ''}`,
    `error: ${error?.name ?? 'Error'}${error?.digest ? ` (digest ${error.digest})` : ''}`,
    plain ? `message: ${plain}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const [db, setDb] = useState<DatabaseDownInfo | null>(null);
  const [cmdCopied, setCmdCopied] = useState(false);
  useEffect(() => {
    let live = true;
    void fetchDatabaseDown().then((d) => live && setDb(d));
    return () => {
      live = false;
    };
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(detailsOf(error));
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <html lang="en">
      <head>
        <title>Command Center</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <main role="alert" data-testid="global-error">
          {db ? (
            <DatabaseDown
              db={db}
              copied={cmdCopied}
              onCopy={() => void navigator.clipboard.writeText(db.command ?? '').then(() => setCmdCopied(true), () => setCmdCopied(false))}
            />
          ) : (
            <>
              <h1>Something went wrong loading Command Center.</h1>
              <p>Retry usually fixes it. If it keeps happening, copy the details and send them with a bug report; check that the app and its database are running (npm run doctor).</p>
            </>
          )}
          <div className="row">
            <button type="button" className="primary" onClick={() => reset()}>
              Retry
            </button>
            <button type="button" onClick={() => void copy()}>
              Copy details
            </button>
            <span aria-live="polite">{copied === 'done' ? 'Copied.' : copied === 'failed' ? 'Could not copy.' : ''}</span>
          </div>
        </main>
      </body>
    </html>
  );
}
