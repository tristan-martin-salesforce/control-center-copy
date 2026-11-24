'use client';
/**
 * Patch several activity rows in one go (Time ▸ Log hours): Approve N, Set opp for these N rows, Set type for these
 * N rows. Each row goes through PATCH /activity/:id (optimistic, version-checked, the same route as the row's own
 * autosave), four at a time with progress; one toast at the end with one Undo for the batch (every row's audit). A
 * row that fails is rolled back and named with its reason in an error toast that stays; the others keep their change.
 */
import { useCallback, useRef, useState } from 'react';
import type { ActivityEntry } from '@/contract';
import { api } from '@/client/api';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { toast, toastStore } from '@/client/toast';
import { errorText } from '@/lib/error-text';
import type { FixPatch } from './path-derive';

/** Rows patched at once by a bulk fix: fast, without flooding the server. */
export const BULK_CONCURRENCY = 4;

export interface BulkFailure {
  id: string;
  label: string;
  why: string;
}

/** "Thu 13 · Customer sync" : the row a failure names. */
export function rowLabel(e: Pick<ActivityEntry, 'date' | 'description'>): string {
  return `${e.date} · ${e.description || 'Activity row'}`;
}

/** Every failed row with its reason, one per line (the first 8, then how many more, all in the count). */
export function failureLines(f: readonly BulkFailure[], max = 8): string {
  const lines = f.slice(0, max).map((x) => `${x.label}: ${x.why}`);
  if (f.length > max) lines.push(`and ${f.length - max} more, each back as it was`);
  return lines.join('\n');
}

/** Run `fn` over `items`, at most `limit` at a time, in order of start. */
export async function runPool<T>(items: readonly T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/** What a row shows at once besides the patch (a picked opp's name and account). */
export type Shown = Partial<Pick<ActivityEntry, 'oppName' | 'accountName'>>;

export interface BulkSpec {
  /** Toast key: one toast per kind of batch. */
  key: string;
  title: (done: number) => string;
  body?: string;
}

/**
 * R3-9: the rows the user's own answers gave an opp (an Accept or a pick through this hook). The time → DC ripple
 * (ToLogView `useDcRipple`) re-runs the DC suggestions only for these, never for a refetch that brings a scanner's opp.
 */
const answered = new Map<string, 'pending' | 'landed'>();
/** Before the PATCH: the row's opp is the user's answer (the optimistic row is not "seen" until it lands). */
export function answerStart(id: string, patch: { oppId?: string | null; target?: { kind: string } }): void {
  if (patch.oppId || patch.target?.kind === 'opp') answered.set(id, 'pending');
}
/** After the PATCH: landed, or forgotten when it failed (the row is back as it was). */
export function answerEnd(id: string, ok: boolean): void {
  if (!answered.has(id)) return;
  if (ok) answered.set(id, 'landed');
  else answered.delete(id);
}
/** The answered rows not yet seen with their opp. */
export function answeredRows(): ReadonlyMap<string, 'pending' | 'landed'> {
  return answered;
}
/** Forget answered rows once a read shows them with their opp. */
export function clearAnswered(ids: Iterable<string>): void {
  for (const id of ids) answered.delete(id);
}

export function usePatchRows() {
  const shown = useRef(new Map<string, Shown>());
  const m = useOptimisticMutation({
    route: 'patchActivity',
    topics: ['time'],
    optimistic: (input, cache) => cache.patchEntity(input.params.id, (e) => ({ ...e, ...(input.body?.patch ?? {}), ...(shown.current.get(input.params.id) ?? {}) })),
  });
  const [busy, setBusy] = useState(false);

  /** Patch one row now (a Needs-you fix): optimistic, no toast unless it fails. */
  const one = useCallback(
    // D-103 (c): `target` (the account itself) rides the same patch
    async (e: ActivityEntry, patch: FixPatch & { target?: { kind: 'opp' | 'account' | 'internal'; id: string } }, extra?: Shown): Promise<boolean> => {
      if (extra) shown.current.set(e.id, extra);
      answerStart(e.id, patch);
      try {
        await m.mutateAsync({ params: { id: e.id }, body: { ifVersion: m.versionOf(e.id) ?? e.version, patch } });
        answerEnd(e.id, true);
        return true;
      } catch {
        answerEnd(e.id, false);
        toast({ key: 'time:fix-err', tone: 'error', durationMs: null, title: "Couldn't save that row", body: 'It is back as it was. Try again, or edit it in the week’s rows.' });
        return false;
      } finally {
        shown.current.delete(e.id);
      }
    },
    [m],
  );

  /**
   * Patch many rows as one batch (2026-11-13 audit C7): four at a time, with a progress toast ("Setting opp · 12 of
   * 40"), then one toast with one Undo for every row that landed, and one error toast that names each row that did not,
   * with why (it stays until dismissed).
   */
  const many = useCallback(
    async (rows: readonly ActivityEntry[], patchOf: (e: ActivityEntry) => FixPatch, spec: BulkSpec, extra?: Shown | ((e: ActivityEntry) => Shown | undefined)): Promise<number> => {
      setBusy(true);
      const audits: string[] = [];
      const failures: BulkFailure[] = [];
      let done = 0;
      const progressKey = `${spec.key}-progress`;
      const report = () => {
        if (rows.length > BULK_CONCURRENCY) toast({ key: progressKey, tone: 'info', durationMs: null, title: `${spec.title(rows.length)}: ${done + failures.length} of ${rows.length}`, body: 'Saving in batches of four…' });
      };
      report();
      await runPool(rows, BULK_CONCURRENCY, async (e) => {
        // what the row shows at once: one value for every row, or each row's own (an accepted suggestion's opp)
        const show = typeof extra === 'function' ? extra(e) : extra;
        if (show) shown.current.set(e.id, show);
        const p = patchOf(e);
        answerStart(e.id, p);
        try {
          const res = await m.mutateAsync({ params: { id: e.id }, body: { ifVersion: m.versionOf(e.id) ?? e.version, patch: p } });
          answerEnd(e.id, true);
          if (res.auditId) audits.push(res.auditId);
          done++;
        } catch (err) {
          answerEnd(e.id, false);
          failures.push({ id: e.id, label: rowLabel(e), why: errorText(err, 160) });
        } finally {
          shown.current.delete(e.id);
          report();
        }
      });
      toastStore.dismissKey(progressKey);
      setBusy(false);
      if (done)
        toast({
          key: spec.key,
          tone: 'success',
          title: spec.title(done),
          body: spec.body,
          undo: audits.length
            ? {
                run: async () => {
                  for (const a of audits) await api('undoAudit', { params: { id: a }, body: {} });
                },
              }
            : undefined,
        });
      if (failures.length) toast({ key: `${spec.key}-err`, tone: 'error', durationMs: null, title: `${failures.length} ${failures.length === 1 ? 'row' : 'rows'} couldn't be saved`, body: failureLines(failures) });
      return done;
    },
    [m],
  );

  return { one, many, busy };
}
