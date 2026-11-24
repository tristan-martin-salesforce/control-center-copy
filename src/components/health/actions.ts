'use client';
/**
 * Connector actions shared by the Health page and the `connector` Details renderer.
 *  - Re-auth follows `reauth.kind` (brief 09): Google in-app, Slack/Org62 "Open Terminal" with the exact
 *    command (POST /connectors/:id/reauth asks the server to open it; the client never shells out), VDP the
 *    refresh script plus MFA notes. The command is always copyable.
 *  - Rescan uses the existing POST /connectors/:id/scan and then shows the scan run's REAL state from the
 *    ledger (queued, running, auth failed…), never an assumed success.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { Connector, ScanRun } from '@/contract';
import { ApiError, api } from '@/client/api';
import { toast } from '@/client/toast';
import { copyToClipboard } from '@/components/panels/bits';
import { errorCode, problemOf, problemToast } from '@/client/health-setup';
import { reauthErrorToast, reauthToastCopy } from './derive';

const SCAN_WORD: Record<ScanRun['status'], string> = {
  queued: 'queued',
  running: 'running',
  ok: 'complete',
  partial: 'partial',
  auth_failed: 'auth failed',
  transient_failed: 'failed, will retry',
  budget_exceeded: 'over budget',
  aborted: 'aborted',
};

export function useConnectorActions() {
  const qc = useQueryClient();
  /** The scan run each connector's last Rescan created (its live state comes from GET /scans). */
  const [started, setStarted] = useState<Record<string, string>>({});
  const refresh = useCallback(() => {
    for (const t of ['health', 'scans', 'jobs', 'event_log']) void qc.invalidateQueries({ queryKey: [t] });
  }, [qc]);

  const reauth = useMutation({
    mutationFn: (c: Connector) => api('reauthConnector', { params: { id: c.id }, body: {} }),
    onSuccess: (res, c) => {
      const kind = (res.action ?? c.reauth)?.kind ?? 'instructions';
      const copy = reauthToastCopy(c, kind);
      toast({ key: `reauth-${c.id}`, tone: 'info', title: copy.title, body: copy.body });
    },
    // the catalog's words for what failed, never the raw error text (01 UI-7)
    onError: (e: ApiError, c) => toast(reauthErrorToast(c, problemOf(errorCode(e), { source: c.label }).title)),
    onSettled: refresh,
  });

  const scan = useMutation({
    mutationFn: (c: Connector) => api('scanConnector', { params: { id: c.id }, body: {} }),
    onSuccess: (res, c) => {
      setStarted((s) => ({ ...s, [c.id]: res.entity.id }));
      const failed = res.entity.status === 'auth_failed';
      toast({
        key: `scan-${c.id}`,
        tone: failed ? 'warning' : 'info',
        title: failed ? `${c.label} needs re-auth first` : `Rescan ${c.label}: ${SCAN_WORD[res.entity.status]}`,
        body: failed ? 'The scan was recorded as failed in the ledger.' : 'Its state updates in the scan ledger.',
      });
    },
    onError: (e: ApiError, c) => toast(problemToast(e, { key: `scan-${c.id}`, source: c.label, title: `Couldn’t rescan ${c.label}` })),
    onSettled: refresh,
  });

  /** Org62 only: re-read my logged Events and my DCs by Id now (the read-back reconcile; edits and deletions there). */
  const recheck = useMutation({
    mutationFn: (c: Connector) => api('scanConnector', { params: { id: c.id }, body: { scope: 'readback' } }),
    onSuccess: (res, c) => {
      setStarted((s) => ({ ...s, [c.id]: res.entity.id }));
      const failed = res.entity.status === 'auth_failed';
      toast({
        key: `recheck-${c.id}`,
        tone: failed ? 'warning' : 'info',
        title: failed ? `${c.label} needs re-auth first` : `Re-checking ${c.label} records: ${SCAN_WORD[res.entity.status]}`,
        body: failed ? 'The check was recorded as failed in the ledger.' : 'Edits and deletions made in Org62 reach Time and Deals when it finishes.',
      });
    },
    onError: (e: ApiError, c) => toast(problemToast(e, { key: `recheck-${c.id}`, source: c.label, title: `Couldn’t re-check ${c.label}` })),
    onSettled: refresh,
  });

  const copy = useCallback(async (command: string, c: Pick<Connector, 'id' | 'label'>) => {
    const ok = await copyToClipboard(command);
    toast({ key: `copy-${c.id}`, tone: ok ? 'success' : 'error', title: ok ? 'Command copied' : 'Couldn’t copy', body: ok ? `Paste it into Terminal to re-auth ${c.label}.` : 'Select the command and copy it by hand.' });
    return ok;
  }, []);

  const scanning = (id: string) => scan.isPending && scan.variables?.id === id;
  const reauthing = (id: string) => reauth.isPending && reauth.variables?.id === id;
  const rechecking = (id: string) => recheck.isPending && recheck.variables?.id === id;

  return { reauth, scan, recheck, copy, started, scanning, reauthing, rechecking };
}
