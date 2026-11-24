'use client';
/**
 * Notices a newer build than the one this tab runs (after `npm run update` or a redeploy). A deploy restarts the web
 * app, so the live stream drops and comes back: it checks GET /version then (onLiveReconnect), whenever the tab comes
 * back into view, and every 10 minutes as a safety net. When the server's sha differs from the bundle's:
 *  - every in-app navigation becomes a full page load (router.ts `markStaleBuild`), so an old tab never silently fails
 *    to load a page whose code chunks are gone;
 *  - a sticky toast offers "Reload".
 * A failed code-chunk load (the same cause, caught first) reloads once per build.
 */
import { useEffect } from 'react';
import { api } from '@/client/api';
import { toast } from '@/client/toast';
import { onLiveReconnect, SAFETY_NET_MS } from '@/client/live';
import { CLIENT_BUILD } from '@/components/feedback/context';
import { markStaleBuild } from './router';

const EVERY_MS = 2 * SAFETY_NET_MS;
const CHUNK_ERROR = /ChunkLoadError|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i;
const RELOADED_KEY = 'cc.reloadedForChunkError';

/** True when the server runs another build than this bundle (both shas known). */
export function isNewerBuild(clientSha: string | null | undefined, serverSha: string | null | undefined): boolean {
  return Boolean(clientSha && serverSha && clientSha !== serverSha);
}

export function BuildWatch() {
  useEffect(() => {
    const mine = CLIENT_BUILD.sha;
    if (!mine) return; // dev builds carry no sha
    let told = false;
    const check = async () => {
      if (told || document.visibilityState !== 'visible') return;
      const v = await api('getVersion', {}).catch(() => null);
      if (!v || !isNewerBuild(mine, v.sha)) return;
      told = true;
      markStaleBuild();
      toast({ key: 'new-build', tone: 'info', title: 'Command Center was updated', body: `Version ${v.version} is ready. Reload to use it; the next page you open loads it too.`, durationMs: null, action: { label: 'Reload', onClick: () => window.location.reload() } });
    };
    const onChunkError = (msg: string) => {
      if (!CHUNK_ERROR.test(msg)) return;
      markStaleBuild();
      if (sessionStorage.getItem(RELOADED_KEY) === mine) return; // once per build: never a reload loop
      sessionStorage.setItem(RELOADED_KEY, mine);
      window.location.reload();
    };
    const onError = (e: ErrorEvent) => onChunkError(String(e.message ?? e.error?.message ?? ''));
    const onRejection = (e: PromiseRejectionEvent) => onChunkError(String((e.reason as { message?: string } | undefined)?.message ?? e.reason ?? ''));
    const onVisible = () => void check();
    const t = setInterval(() => void check(), EVERY_MS);
    const offReconnect = onLiveReconnect(() => void check());
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    void check();
    return () => {
      clearInterval(t);
      offReconnect();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
