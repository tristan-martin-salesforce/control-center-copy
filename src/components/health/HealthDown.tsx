'use client';
/**
 * Health when GET /health itself fails (11 R6, PKG-5): ask the DB-free GET /doctor what broke. The database down
 * (DEP.DB.DOWN / DEP.DB.MISSING) or a stale worker heartbeat (DEP.WORKER.*) renders the catalog's words with the start
 * command in a copy box; anything else falls back to the generic retry. app/global-error.tsx stays the fallback for a
 * page that can't render at all.
 */
import type { ReactNode } from 'react';
import { appDownView, type DownView } from '@/client/health-setup';
import { useApi } from '@/client/hooks';
import { CommandBlock } from '@/components/panels/bits';
import { Button } from '@/ui';
import { CodeChip } from './SetupTab';

export function AppDownView({ down, onRetry }: { down: DownView; onRetry?: () => void }) {
  return (
    <article role="alert" data-health-down={down.code} className="rounded-lg border border-danger-200 bg-danger-50 px-5 py-4 shadow-[inset_3px_0_0_var(--color-danger-500)]">
      <h2 className="text-lead font-bold text-danger-700">
        <span aria-hidden>✕ </span>
        {down.title}
      </h2>
      <p className="mt-1 max-w-[68ch] text-body text-fg">{down.text}</p>
      <p className="mt-1 max-w-[68ch] text-body text-fg">
        <b>Next step:</b> {down.nextStep}
      </p>
      {down.command ? <CommandBlock className="mt-3 max-w-[60rem]" command={down.command} note="Run it in Terminal, then reload this page." /> : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {onRetry ? (
          <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        <CodeChip code={down.code} />
      </div>
    </article>
  );
}

/** GET /health failed: the doctor's answer when it names the cause, else `fallback`. */
export function HealthDown({ fallback, onRetry }: { fallback: ReactNode; onRetry: () => void }) {
  const db = useApi('getDoctor', { query: { only: 'db' } }, { retry: false, staleTime: 15_000 });
  const needFull = db.isFetched && !db.data?.database;
  const full = useApi('getDoctor', { query: {} }, { retry: false, staleTime: 60_000, enabled: needFull });
  const down = appDownView(db.data?.database ? db.data : full.data);
  if (down) return <AppDownView down={down} onRetry={onRetry} />;
  return <>{fallback}</>;
}
